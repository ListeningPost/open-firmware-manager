import { AtpClient, type StrongRef } from '@open-firmware/atproto-lite'
import {
  COLLECTIONS,
  chunkBytes,
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
  /** Path to artifact file */
  file: string
  chunkSize?: number
  mimeType?: string
  changelog?: string
  platform?: string
  runtime?: ApplyRuntime
  onProgress?: (msg: string) => void
  /**
   * Skip CI/pipeline gate: mark ready immediately after chunks.
   * Default true for backwards-compatible simple publishes.
   * Set false (or pass requiredPipelineStages) to wait for acks.
   */
  skipPipeline?: boolean
  /** Stages that must pass before ready (e.g. ['build','test']). Implies pipeline gate. */
  requiredPipelineStages?: string[]
  /** Override policy on the release record */
  pipelinePolicy?: PipelinePolicy
}

export interface PublishResult {
  release: StrongRef
  rkey: string
  authorDid: string
  imageSha256: string
  imageSize: number
  chunkCount: number
  status: string
  requirePipelineAcks: boolean
}

export interface PipelineAckOptions {
  /** Release rkey or full at-uri */
  releaseRkey: string
  stage: PipelineStage | string
  stageId?: string
  result: PipelineAckResult
  runUrl?: string
  commit?: string
  summary?: string
  /** If true and all required stages pass, set status=ready */
  promoteIfComplete?: boolean
}

function releaseRkey(product: string, version: string, channel: string): string {
  return `${product}-${version}-${channel}`.replace(/[^A-Za-z0-9._~-]+/g, '-')
}

export class OpenFirmwareHost {
  private constructor(public readonly client: AtpClient) {}

  static async login(opts: HostLoginOptions): Promise<OpenFirmwareHost> {
    const client = new AtpClient({ pds: opts.pds })
    await client.login(opts.identifier, opts.password)
    return new OpenFirmwareHost(client)
  }

  get did(): string {
    return this.client.did
  }

  /**
   * Publish a signed multi-chunk release to the author's PDS.
   *
   * Order:
   * 1. release(publishing)
   * 2. chunks
   * 3. either release(ready) if pipeline skipped,
   *    or release(awaiting_pipeline) until CI acks + promote
   */
  async publishRelease(opts: PublishReleaseOptions): Promise<PublishResult> {
    const channel = opts.channel ?? 'stable'
    const kind = opts.kind ?? 'package'
    const chunkSize = opts.chunkSize ?? 512 * 1024
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
    const now = new Date().toISOString()

    const releaseRecord: Record<string, unknown> = {
      $type: COLLECTIONS.release,
      version: opts.version,
      product: opts.product,
      kind,
      createdAt: now,
      imageSha256: planned.imageSha256,
      imageSize: planned.imageSize,
      chunkCount: planned.chunks.length,
      chunkSize,
      mimeType,
      channel,
      status: 'publishing',
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

    log(`creating release ${rkey} (publishing)`)
    let releaseRef: StrongRef
    try {
      releaseRef = await this.client.putRecord(
        COLLECTIONS.release,
        rkey,
        releaseRecord,
      )
    } catch {
      releaseRef = await this.client.createRecord(
        COLLECTIONS.release,
        releaseRecord,
        rkey,
      )
    }

    let prev: StrongRef = releaseRef
    const root = releaseRef

    for (const c of planned.chunks) {
      log(`upload blob seq=${c.seq} (${c.byteLength} bytes)`)
      const blob = await this.client.uploadBlob(c.data, mimeType)
      const chunkRecord = {
        $type: COLLECTIONS.chunk,
        reply: {
          root: { uri: root.uri, cid: root.cid },
          parent: { uri: prev.uri, cid: prev.cid },
        },
        seq: c.seq,
        blob,
        sha256: c.sha256,
        byteOffset: c.byteOffset,
        byteLength: c.byteLength,
        createdAt: new Date().toISOString(),
      }
      prev = await this.client.createRecord(COLLECTIONS.chunk, chunkRecord)
    }

    const nextStatus = skipPipeline ? 'ready' : 'awaiting_pipeline'
    releaseRecord.status = nextStatus
    log(
      skipPipeline
        ? 'pipeline skipped — sealing release (ready)'
        : 'chunks complete — awaiting_pipeline (CI acks required)',
    )
    const finalRef = await this.client.putRecord(
      COLLECTIONS.release,
      rkey,
      releaseRecord,
    )

    if (skipPipeline) {
      try {
        await this.client.createRecord(COLLECTIONS.releaseSeal, {
          $type: COLLECTIONS.releaseSeal,
          release: { uri: finalRef.uri, cid: finalRef.cid },
          chunkCount: planned.chunks.length,
          imageSha256: planned.imageSha256,
          createdAt: new Date().toISOString(),
        })
      } catch {
        // seal optional
      }
    }

    return {
      release: finalRef,
      rkey,
      authorDid: this.did,
      imageSha256: planned.imageSha256,
      imageSize: planned.imageSize,
      chunkCount: planned.chunks.length,
      status: nextStatus,
      requirePipelineAcks,
    }
  }

  /**
   * Post a pipeline acknowledgment (build/test/etc.) for a release.
   * Optionally promote to ready when all required stages have passed.
   */
  async postPipelineAck(opts: PipelineAckOptions): Promise<StrongRef> {
    const rec = await this.client.getRecord(
      this.did,
      COLLECTIONS.release,
      opts.releaseRkey,
    )
    const releaseUri = rec.uri
    const releaseCid = rec.cid
    const value = rec.value

    const ack = {
      $type: COLLECTIONS.pipelineAck,
      release: { uri: releaseUri, cid: releaseCid },
      stage: opts.stage,
      stageId: opts.stageId,
      result: opts.result,
      createdAt: new Date().toISOString(),
      runUrl: opts.runUrl,
      commit: opts.commit,
      summary: opts.summary,
      actor: this.did,
    }
    // strip undefined
    for (const k of Object.keys(ack) as (keyof typeof ack)[]) {
      if (ack[k] === undefined) delete ack[k]
    }

    const ref = await this.client.createRecord(COLLECTIONS.pipelineAck, ack)

    if (opts.promoteIfComplete !== false && opts.result === 'passed') {
      await this.tryPromoteRelease(opts.releaseRkey, value)
    }
    if (opts.result === 'failed') {
      await this.client.putRecord(COLLECTIONS.release, opts.releaseRkey, {
        ...value,
        status: 'failed',
      })
    }

    return ref
  }

  /**
   * Force-mark release ready (skip remaining pipeline checks).
   */
  async skipPipelineAndPromote(releaseRkey: string): Promise<StrongRef> {
    const rec = await this.client.getRecord(
      this.did,
      COLLECTIONS.release,
      releaseRkey,
    )
    const value = {
      ...rec.value,
      status: 'ready',
      requirePipelineAcks: false,
      pipelinePolicy: 'skipped',
    }
    return this.client.putRecord(COLLECTIONS.release, releaseRkey, value)
  }

  /**
   * Promote to ready if required pipeline stages all have passed/skipped acks.
   */
  async tryPromoteRelease(
    releaseRkey: string,
    value?: Record<string, unknown>,
  ): Promise<StrongRef | null> {
    const rec =
      value != null
        ? {
            uri: `at://${this.did}/${COLLECTIONS.release}/${releaseRkey}`,
            cid: '',
            value,
          }
        : await this.client.getRecord(this.did, COLLECTIONS.release, releaseRkey)

    const v = rec.value
    if (v.status === 'ready') return null

    const require = Boolean(v.requirePipelineAcks)
    const policy = String(v.pipelinePolicy || (require ? 'strict' : 'skipped'))
    if (policy === 'skipped' || !require) {
      return this.client.putRecord(COLLECTIONS.release, releaseRkey, {
        ...v,
        status: 'ready',
      })
    }

    const stages = (v.requiredPipelineStages as string[] | undefined) ?? [
      'build',
      'test',
    ]
    const acks = await this.client.listRecords(
      this.did,
      COLLECTIONS.pipelineAck,
      100,
    )
    const releaseUri = rec.uri.startsWith('at://')
      ? rec.uri
      : `at://${this.did}/${COLLECTIONS.release}/${releaseRkey}`

    const relevant = acks.filter((a) => {
      const rel = a.value.release as { uri?: string } | undefined
      return rel?.uri === releaseUri || rel?.uri?.endsWith(`/${releaseRkey}`)
    })

    const latest = new Map<string, string>()
    const sorted = [...relevant].sort((a, b) =>
      String(a.value.createdAt) < String(b.value.createdAt) ? -1 : 1,
    )
    for (const a of sorted) {
      const stage = String(a.value.stage)
      latest.set(stage, String(a.value.result))
    }

    for (const s of stages) {
      const r = latest.get(s)
      if (r !== 'passed' && r !== 'skipped') {
        return null
      }
    }

    return this.client.putRecord(COLLECTIONS.release, releaseRkey, {
      ...v,
      status: 'ready',
    })
  }
}

export { releaseRkey }
