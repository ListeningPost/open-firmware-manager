import {
  AtpClient,
  XRPCError,
  blobCidFromBytes,
  blobLink,
  parseAtUri,
  publicClient,
} from '@open-firmware/atproto-lite'
import {
  COLLECTIONS,
  assembleChunks,
  auditReleaseChain,
  channelRkey,
  isReleaseInstallable,
  mayApplyVersion,
  sha256Hex,
  sha256HexEqual,
  type ArtifactKind,
  type ChainAuditReport,
  type ChunkMeta,
  type GateState,
  type PipelineAckRecord,
  type ReleaseMeta,
} from '@open-firmware/core'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface ClientOptions {
  pds: string
  authorDid: string
  trustedAuthors?: string[]
  trustedOemKeys?: string[]
  requireOemSignature?: boolean
  maxChannelAgeSec?: number
  attesterDids?: string[]
  fetch?: typeof fetch
  /** Emergency only. Use OFW_CONSUMER_SKIP_PIPELINE, never OFW_SKIP_PIPELINE. */
  skipPipelineCheck?: boolean
}

export interface ResolveLatestOptions {
  product: string
  channel?: string
  skipPipelineCheck?: boolean
}

export interface AuditOptions {
  freeSpaceBytes?: number
  requireReady?: boolean
  skipPipelineCheck?: boolean
  probeBlobs?: boolean
}

export interface DownloadOptions extends AuditOptions {
  outDir?: string
  outPath?: string
}

export interface AppliedRelease {
  uri: string
  cid: string
  version: string
  product: string
  kind: ArtifactKind
  imageSha256: string
  path: string
  audit: ChainAuditReport
}

export class OpenFirmwareClient {
  readonly pds: string
  readonly authorDid: string
  readonly trustedAuthors: Set<string>
  readonly trustedOemKeys: string[]
  readonly requireOemSignature: boolean
  readonly maxChannelAgeSec?: number
  readonly attesterDids?: string[]
  private readonly reader: AtpClient
  private readonly skipPipelineCheck: boolean

  constructor(opts: ClientOptions) {
    this.pds = opts.pds
    this.authorDid = opts.authorDid
    this.trustedAuthors = new Set(opts.trustedAuthors ?? [opts.authorDid])
    this.trustedOemKeys = opts.trustedOemKeys ?? []
    this.requireOemSignature = opts.requireOemSignature ?? false
    this.maxChannelAgeSec = opts.maxChannelAgeSec
    this.attesterDids = opts.attesterDids
    this.reader = publicClient(opts.pds, opts.fetch)
    this.skipPipelineCheck = opts.skipPipelineCheck ?? false
  }

  async listPipelineAcks(releaseUri: string): Promise<PipelineAckRecord[]> {
    const repos = new Set<string>([this.authorDid, ...(this.attesterDids ?? [])])
    const out: PipelineAckRecord[] = []
    for (const repo of repos) {
      const records = await this.reader.listRecords(repo, COLLECTIONS.pipelineAck)
      for (const r of records) {
        const rel = r.value.release as { uri?: string; cid?: string } | undefined
        if (rel?.uri !== releaseUri) continue
        const authorDid = parseAtUri(r.uri).did
        out.push({
          release: r.value.release as PipelineAckRecord['release'],
          stage: String(r.value.stage),
          stageId: r.value.stageId as string | undefined,
          result: r.value.result as PipelineAckRecord['result'],
          createdAt: String(r.value.createdAt),
          runUrl: r.value.runUrl as string | undefined,
          commit: r.value.commit as string | undefined,
          summary: r.value.summary as string | undefined,
          actor: String(r.value.actor ?? authorDid),
          uri: r.uri,
          cid: r.cid,
          authorDid,
        })
      }
    }
    return out
  }

  async resolveLatest(
    opts: ResolveLatestOptions,
  ): Promise<{ uri: string; cid: string; value: Record<string, unknown> } | null> {
    const channel = opts.channel ?? 'stable'
    const skipPipe = opts.skipPipelineCheck ?? this.skipPipelineCheck
    let pointer
    try {
      pointer = await this.reader.getRecord(
        this.authorDid,
        COLLECTIONS.channel,
        channelRkey(opts.product, channel),
      )
    } catch (e) {
      if (e instanceof XRPCError && e.isMissingRecord) return null
      throw e
    }
    if (pointer.value.$type && pointer.value.$type !== COLLECTIONS.channel) {
      throw new Error(`unexpected $type ${pointer.value.$type}`)
    }
    if (this.maxChannelAgeSec && typeof pointer.value.updatedAt === 'string') {
      const age =
        Date.now() - Date.parse(String(pointer.value.updatedAt))
      const bound =
        typeof pointer.value.maxAgeSec === 'number'
          ? Number(pointer.value.maxAgeSec)
          : this.maxChannelAgeSec
      if (Number.isFinite(age) && age / 1000 > bound) {
        throw new Error(`channel pointer is stale (${Math.round(age / 1000)}s)`)
      }
    }
    const rel = pointer.value.release as { uri?: string; cid?: string }
    if (!rel?.uri || !rel.cid) return null
    const loaded = await this.loadRelease(rel.uri, rel.cid)
    const acks = await this.listPipelineAcks(loaded.uri)
    const gate = isReleaseInstallable(loaded.meta, acks, {
      skipPipelineCheck: skipPipe,
      attesterDids: this.attesterDids,
    })
    if (!gate.installable) return null
    return { uri: loaded.uri, cid: loaded.cid, value: loaded.value }
  }

  async loadRelease(
    releaseUri: string,
    cid?: string,
  ): Promise<{
    uri: string
    cid: string
    value: Record<string, unknown>
    meta: ReleaseMeta
    chunks: ChunkMeta[]
  }> {
    const parsed = parseAtUri(releaseUri)
    if (!this.trustedAuthors.has(parsed.did)) {
      throw new Error(`author ${parsed.did} not in trustedAuthors`)
    }
    const rec = await this.reader.getRecord(
      parsed.did,
      parsed.collection,
      parsed.rkey,
      cid,
    )
    if (rec.value.$type && rec.value.$type !== COLLECTIONS.release) {
      throw new Error(`unexpected $type ${rec.value.$type}`)
    }
    const authorDid = parsed.did
    let status: GateState = 'ready'
    try {
      const gate = await this.reader.getRecord(
        authorDid,
        COLLECTIONS.gate,
        parsed.rkey,
      )
      status = String(gate.value.state) as GateState
    } catch {
      status = 'ready'
    }

    const parts = Array.isArray(rec.value.parts)
      ? (rec.value.parts as Array<Record<string, unknown>>)
      : []
    const chunks: ChunkMeta[] = parts.map((p) => ({
      seq: Number(p.seq),
      sha256: String(p.sha256),
      byteOffset: Number(p.byteOffset),
      byteLength: Number(p.byteLength),
      blobCid: blobLink(p.blob),
      blobSize:
        typeof (p.blob as { size?: number })?.size === 'number'
          ? (p.blob as { size: number }).size
          : undefined,
      authorDid,
    }))

    const meta: ReleaseMeta = {
      version: String(rec.value.version),
      product: String(rec.value.product),
      kind: rec.value.kind as ReleaseMeta['kind'],
      imageSha256: String(rec.value.imageSha256),
      imageSize: Number(rec.value.imageSize),
      chunkCount: chunks.length,
      channel: rec.value.channel as ReleaseMeta['channel'],
      status,
      authorDid,
      uri: rec.uri,
      cid: rec.cid,
      requirePipelineAcks: Boolean(rec.value.requirePipelineAcks),
      requiredPipelineStages: rec.value.requiredPipelineStages as
        | string[]
        | undefined,
      pipelinePolicy: rec.value.pipelinePolicy as ReleaseMeta['pipelinePolicy'],
      oemSignature: rec.value.oemSignature as ReleaseMeta['oemSignature'],
      createdAt: rec.value.createdAt as string | undefined,
    }

    return { uri: rec.uri, cid: rec.cid, value: rec.value, meta, chunks }
  }

  async auditRelease(
    releaseUri: string,
    opts: AuditOptions = {},
  ): Promise<ChainAuditReport & { release: ReleaseMeta; chunks: ChunkMeta[] }> {
    const loaded = await this.loadRelease(releaseUri)
    const availability: Record<string, { available: boolean; size?: number; cid?: string }> =
      {}
    if (opts.probeBlobs) {
      for (const c of loaded.chunks) {
        if (!c.blobCid) continue
        try {
          const bytes = await this.reader.getBlob(loaded.meta.authorDid, c.blobCid)
          const cid = await blobCidFromBytes(bytes)
          availability[c.blobCid] = {
            available: true,
            size: bytes.byteLength,
            cid,
          }
        } catch {
          availability[c.blobCid] = { available: false }
        }
      }
    }
    const report = auditReleaseChain(loaded.meta, loaded.chunks, {
      freeSpaceBytes: opts.freeSpaceBytes,
      requireReady: opts.requireReady ?? true,
      requireBlobAvailability: Boolean(opts.probeBlobs),
      blobAvailability: availability,
      trustedOemKeys: this.trustedOemKeys,
      requireOemSignature: this.requireOemSignature,
      expectedType: COLLECTIONS.release,
      recordType: loaded.value.$type as string | undefined,
    })
    return { ...report, release: loaded.meta, chunks: loaded.chunks }
  }

  async downloadVerified(
    releaseUri: string,
    opts: DownloadOptions = {},
  ): Promise<AppliedRelease> {
    const loaded = await this.loadRelease(releaseUri)
    const skipPipe = opts.skipPipelineCheck ?? this.skipPipelineCheck
    const acks = await this.listPipelineAcks(loaded.uri)
    const gate = isReleaseInstallable(loaded.meta, acks, {
      skipPipelineCheck: skipPipe,
      attesterDids: this.attesterDids,
    })
    if (!gate.installable) {
      throw new Error(`not installable: ${gate.reason}`)
    }

    const audited = auditReleaseChain(loaded.meta, loaded.chunks, {
      freeSpaceBytes: opts.freeSpaceBytes,
      requireReady: opts.requireReady ?? true,
      trustedOemKeys: this.trustedOemKeys,
      requireOemSignature: this.requireOemSignature,
      expectedType: COLLECTIONS.release,
      recordType: loaded.value.$type as string | undefined,
    })
    if (!audited.ok) {
      const err = new Error(
        `Phase A failed: ${audited.issues.map((i) => i.code).join(', ')}`,
      )
      ;(err as Error & { audit: typeof audited }).audit = audited
      throw err
    }

    const downloaded: Array<{ seq: number; data: Uint8Array }> = []
    for (const c of audited.chunks) {
      if (!c.blobCid) throw new Error(`part ${c.seq} missing blob CID`)
      const data = await this.reader.getBlob(loaded.meta.authorDid, c.blobCid)
      if (data.byteLength !== c.byteLength) {
        throw new Error(`part ${c.seq} length mismatch`)
      }
      if (!sha256HexEqual(sha256Hex(data), c.sha256)) {
        throw new Error(`part ${c.seq} digest mismatch`)
      }
      const cid = await blobCidFromBytes(data)
      if (cid !== c.blobCid) {
        throw new Error(`part ${c.seq} blob CID mismatch`)
      }
      downloaded.push({ seq: c.seq, data })
    }

    const image = assembleChunks(downloaded, {
      imageSha256: audited.release.imageSha256,
      imageSize: audited.release.imageSize,
    })

    const outPath =
      opts.outPath ??
      path.join(
        opts.outDir ?? '/tmp/open-firmware',
        `${audited.release.product}-${audited.release.version}.bin`,
      )
    await mkdir(path.dirname(outPath), { recursive: true })
    await writeFile(outPath, image)

    return {
      uri: audited.release.uri!,
      cid: audited.release.cid!,
      version: audited.release.version,
      product: audited.release.product,
      kind: audited.release.kind,
      imageSha256: audited.release.imageSha256,
      path: outPath,
      audit: audited,
    }
  }

  async pullIfNewer(
    opts: ResolveLatestOptions & {
      currentVersion?: string
      allowDowngrade?: boolean
    } & DownloadOptions,
  ): Promise<AppliedRelease | null> {
    const latest = await this.resolveLatest(opts)
    if (!latest) return null
    const version = String(latest.value.version)
    if (
      opts.currentVersion &&
      !mayApplyVersion(version, opts.currentVersion, {
        allowDowngrade: opts.allowDowngrade,
      })
    ) {
      return null
    }
    return this.downloadVerified(latest.uri, opts)
  }
}

export type ApplyHandler = (artifact: AppliedRelease) => Promise<void>
