import {
  AtpClient,
  XRPCError,
  parseAtUri,
  type StrongRef,
} from '@open-firmware/atproto-lite'
import {
  COLLECTIONS,
  DEFAULT_CHUNK_SIZE,
  MAX_BLOB_BYTES,
  channelRkey,
  chunkBytes,
  releaseRkey,
  signRelease,
  stageKey,
  type ArtifactKind,
  type ApplyRuntime,
  type PipelineAckResult,
  type PipelinePolicy,
  type PipelineStage,
  type ReleaseChannel,
} from '@open-firmware/core'
import { readFile } from 'node:fs/promises'

export interface HostLoginOptions {
  pds: string
  identifier: string
  password: string
}

export interface PublishReleaseOptions {
  product: string
  version: string
  channel?: ReleaseChannel
  kind?: ArtifactKind
  file: string
  chunkSize?: number
  mimeType?: string
  changelog?: string
  platform?: string
  runtime?: ApplyRuntime
  onProgress?: (msg: string) => void
  skipPipeline?: boolean
  requiredPipelineStages?: string[]
  pipelinePolicy?: PipelinePolicy
  oemPrivateKeyPem?: string
  oemPublicKey?: string
  oemKeyId?: string
}

export interface PublishResult {
  release: StrongRef
  rkey: string
  channelRkey: string
  authorDid: string
  imageSha256: string
  imageSize: number
  partCount: number
  gateState: string
}

export interface PipelineAckOptions {
  releaseRkey: string
  /** Release author repo. Defaults to the logged-in DID. CI attesters pass the publisher DID. */
  authorDid?: string
  stage: PipelineStage | string
  stageId?: string
  result: PipelineAckResult
  runUrl?: string
  commit?: string
  summary?: string
  promoteIfComplete?: boolean
  /** When promoting, only count acks from these DIDs (CI attesters). */
  attesterDids?: string[]
}

export class OpenFirmwareHost {
  private constructor(public readonly client: AtpClient) {}

  static wrap(client: AtpClient): OpenFirmwareHost {
    return new OpenFirmwareHost(client)
  }

  static async login(opts: HostLoginOptions): Promise<OpenFirmwareHost> {
    const client = new AtpClient({ pds: opts.pds })
    await client.login(opts.identifier, opts.password)
    return OpenFirmwareHost.wrap(client)
  }

  get did(): string {
    return this.client.did
  }

  /**
   * Upload blobs, then create the immutable release once.
   * Gate + channel are sidecar records updated with swapRecord.
   */
  async publishRelease(opts: PublishReleaseOptions): Promise<PublishResult> {
    const channel = opts.channel ?? 'stable'
    const kind = opts.kind ?? 'package'
    const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE
    if (chunkSize > MAX_BLOB_BYTES) {
      throw new Error(`chunkSize ${chunkSize} exceeds blob cap ${MAX_BLOB_BYTES}`)
    }
    const mimeType = opts.mimeType ?? 'application/octet-stream'
    const runtime = opts.runtime ?? (kind === 'firmware' ? 'iot' : 'sidekar')
    const log = opts.onProgress ?? (() => {})

    const stages = opts.requiredPipelineStages ?? []
    const skipPipeline =
      opts.skipPipeline ??
      (stages.length === 0 && opts.pipelinePolicy !== 'strict')
    const requirePipelineAcks = !skipPipeline
    const pipelinePolicy: PipelinePolicy =
      opts.pipelinePolicy ?? (skipPipeline ? 'skipped' : 'strict')

    const bytes = new Uint8Array(await readFile(opts.file))
    const planned = chunkBytes(bytes, { chunkSize })
    const rkey = releaseRkey(opts.product, opts.version, channel)
    const chRkey = channelRkey(opts.product, channel)
    const now = new Date().toISOString()

    const parts: Array<Record<string, unknown>> = []
    for (const c of planned.chunks) {
      log(`upload blob seq=${c.seq} (${c.byteLength} bytes)`)
      const blob = await this.client.uploadBlob(c.data, mimeType)
      parts.push({
        seq: c.seq,
        blob,
        sha256: c.sha256,
        byteOffset: c.byteOffset,
        byteLength: c.byteLength,
      })
    }

    const releaseRecord: Record<string, unknown> = {
      $type: COLLECTIONS.release,
      version: opts.version,
      product: opts.product,
      kind,
      createdAt: now,
      imageSha256: planned.imageSha256,
      imageSize: planned.imageSize,
      chunkSize,
      mimeType,
      channel,
      parts,
      runtime,
      requirePipelineAcks,
      pipelinePolicy,
    }
    if (stages.length) {
      releaseRecord.requiredPipelineStages = stages
    } else if (requirePipelineAcks) {
      releaseRecord.requiredPipelineStages = ['build', 'test']
    }
    if (opts.changelog) releaseRecord.changelog = opts.changelog
    if (opts.platform) releaseRecord.platform = opts.platform
    if (opts.oemPrivateKeyPem && opts.oemPublicKey) {
      releaseRecord.oemSignature = signRelease(
        opts.oemPrivateKeyPem,
        {
          product: opts.product,
          version: opts.version,
          channel,
          imageSha256: planned.imageSha256,
          imageSize: planned.imageSize,
        },
        opts.oemPublicKey,
        opts.oemKeyId,
      )
    }

    log(`creating immutable release ${rkey}`)
    let releaseRef: StrongRef
    try {
      const existing = await this.client.getRecord(
        this.did,
        COLLECTIONS.release,
        rkey,
      )
      releaseRef = await this.client.putRecord(
        COLLECTIONS.release,
        rkey,
        releaseRecord,
        { swapRecord: existing.cid },
      )
    } catch (e) {
      if (isMissingRecord(e)) {
        releaseRef = await this.client.createRecord(
          COLLECTIONS.release,
          releaseRecord,
          rkey,
        )
      } else {
        throw e
      }
    }

    const gateState = skipPipeline ? 'ready' : 'awaiting-pipeline'
    await this.upsertSidecar(
      COLLECTIONS.gate,
      rkey,
      {
        $type: COLLECTIONS.gate,
        release: { uri: releaseRef.uri, cid: releaseRef.cid },
        state: gateState,
        updatedAt: new Date().toISOString(),
      },
    )

    if (skipPipeline) {
      await this.upsertSidecar(COLLECTIONS.channel, chRkey, {
        $type: COLLECTIONS.channel,
        product: opts.product,
        channel,
        release: { uri: releaseRef.uri, cid: releaseRef.cid },
        version: opts.version,
        updatedAt: new Date().toISOString(),
      })
      try {
        await this.client.createRecord(COLLECTIONS.releaseSeal, {
          $type: COLLECTIONS.releaseSeal,
          release: { uri: releaseRef.uri, cid: releaseRef.cid },
          partCount: planned.chunks.length,
          imageSha256: planned.imageSha256,
          createdAt: new Date().toISOString(),
        })
      } catch {
        /* seal optional */
      }
    }

    await this.ensureDeclaration(opts.product)

    return {
      release: releaseRef,
      rkey,
      channelRkey: chRkey,
      authorDid: this.did,
      imageSha256: planned.imageSha256,
      imageSize: planned.imageSize,
      partCount: planned.chunks.length,
      gateState,
    }
  }

  async postPipelineAck(opts: PipelineAckOptions): Promise<StrongRef> {
    const authorDid = opts.authorDid ?? this.did
    const rec = await this.client.getRecord(
      authorDid,
      COLLECTIONS.release,
      opts.releaseRkey,
    )
    const ack: Record<string, unknown> = {
      $type: COLLECTIONS.pipelineAck,
      release: { uri: rec.uri, cid: rec.cid },
      stage: opts.stage,
      result: opts.result,
      createdAt: new Date().toISOString(),
      actor: this.did,
    }
    if (opts.stageId) ack.stageId = opts.stageId
    if (opts.runUrl) ack.runUrl = opts.runUrl
    if (opts.commit) ack.commit = opts.commit
    if (opts.summary) ack.summary = opts.summary

    const ref = await this.client.createRecord(COLLECTIONS.pipelineAck, ack)

    const canWriteGate = authorDid === this.did
    if (opts.result === 'failed' && canWriteGate) {
      await this.upsertSidecar(COLLECTIONS.gate, opts.releaseRkey, {
        $type: COLLECTIONS.gate,
        release: { uri: rec.uri, cid: rec.cid },
        state: 'failed',
        updatedAt: new Date().toISOString(),
        reason: `stage ${opts.stage} failed`,
      })
    } else if (
      canWriteGate &&
      opts.promoteIfComplete !== false &&
      (opts.result === 'passed' || opts.result === 'skipped')
    ) {
      await this.tryPromoteRelease(opts.releaseRkey, {
        attesterDids: opts.attesterDids,
      })
    }
    return ref
  }

  async skipPipelineAndPromote(releaseRkey: string): Promise<StrongRef> {
    const rec = await this.client.getRecord(
      this.did,
      COLLECTIONS.release,
      releaseRkey,
    )
    const v = rec.value
    return this.markReady(releaseRkey, rec.uri, rec.cid, v, 'pipeline skipped by publisher')
  }

  async tryPromoteRelease(
    releaseRkey: string,
    opts: { attesterDids?: string[] } = {},
  ): Promise<StrongRef | null> {
    const rec = await this.client.getRecord(
      this.did,
      COLLECTIONS.release,
      releaseRkey,
    )
    const v = rec.value
    const require = Boolean(v.requirePipelineAcks)
    const policy = String(v.pipelinePolicy || (require ? 'strict' : 'skipped'))
    if (policy === 'skipped' || !require) {
      return this.markReady(releaseRkey, rec.uri, rec.cid, v)
    }

    const stages = (v.requiredPipelineStages as string[] | undefined) ?? [
      'build',
      'test',
    ]
    const repos = opts.attesterDids?.length
      ? [...new Set(opts.attesterDids)]
      : [this.did]
    const acks = (
      await Promise.all(
        repos.map((repo) => this.client.listRecords(repo, COLLECTIONS.pipelineAck)),
      )
    ).flat()
    const relevant = acks.filter((a) => {
      if ((a.value.release as { uri?: string } | undefined)?.uri !== rec.uri) {
        return false
      }
      if (opts.attesterDids?.length) {
        try {
          const did = parseAckDid(a.uri, a.value.actor)
          if (did && !opts.attesterDids.includes(did)) return false
        } catch {
          return false
        }
      }
      return true
    })
    const latest = new Map<string, string>()
    const sorted = [...relevant].sort((a, b) =>
      String(a.value.createdAt) < String(b.value.createdAt) ? -1 : 1,
    )
    for (const a of sorted) {
      latest.set(
        stageKey({
          stage: String(a.value.stage),
          stageId: a.value.stageId as string | undefined,
          result: a.value.result as 'passed' | 'failed' | 'skipped',
          createdAt: String(a.value.createdAt),
          release: a.value.release as { uri: string; cid: string },
          actor: String(a.value.actor ?? ''),
        }),
        String(a.value.result),
      )
    }
    for (const s of stages) {
      const r = latest.get(s)
      if (r !== 'passed' && r !== 'skipped') return null
    }

    return this.markReady(releaseRkey, rec.uri, rec.cid, v)
  }

  private async markReady(
    releaseRkey: string,
    uri: string,
    cid: string,
    v: Record<string, unknown>,
    reason?: string,
  ): Promise<StrongRef> {
    const gate: Record<string, unknown> = {
      $type: COLLECTIONS.gate,
      release: { uri, cid },
      state: 'ready',
      updatedAt: new Date().toISOString(),
    }
    if (reason) gate.reason = reason
    await this.upsertSidecar(COLLECTIONS.gate, releaseRkey, gate)
    return this.upsertSidecar(
      COLLECTIONS.channel,
      channelRkey(String(v.product), String(v.channel ?? 'stable')),
      {
        $type: COLLECTIONS.channel,
        product: v.product,
        channel: v.channel ?? 'stable',
        release: { uri, cid },
        version: v.version,
        updatedAt: new Date().toISOString(),
      },
    )
  }

  private async upsertSidecar(
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ): Promise<StrongRef> {
    try {
      const existing = await this.client.getRecord(this.did, collection, rkey)
      return await this.client.putRecord(collection, rkey, record, {
        swapRecord: existing.cid,
      })
    } catch (e) {
      if (isMissingRecord(e)) {
        return this.client.createRecord(collection, record, rkey)
      }
      throw e
    }
  }

  private async ensureDeclaration(product: string): Promise<void> {
    try {
      const rec = await this.client.getRecord(
        this.did,
        COLLECTIONS.declaration,
        'self',
      )
      const products = new Set<string>(
        Array.isArray(rec.value.products)
          ? (rec.value.products as string[])
          : [],
      )
      products.add(product)
      await this.client.putRecord(
        COLLECTIONS.declaration,
        'self',
        {
          ...rec.value,
          $type: COLLECTIONS.declaration,
          products: [...products],
        },
        { swapRecord: rec.cid },
      )
    } catch (e) {
      if (isMissingRecord(e)) {
        await this.client.createRecord(
          COLLECTIONS.declaration,
          {
            $type: COLLECTIONS.declaration,
            products: [product],
            createdAt: new Date().toISOString(),
          },
          'self',
        )
        return
      }
      throw e
    }
  }
}

function isMissingRecord(e: unknown): boolean {
  return e instanceof XRPCError && e.isMissingRecord
}

function parseAckDid(uri: string, actor: unknown): string | undefined {
  try {
    return parseAtUri(uri).did
  } catch {
    return typeof actor === 'string' ? actor : undefined
  }
}

export { releaseRkey, channelRkey }
