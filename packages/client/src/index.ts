import { AtpClient, publicClient } from '@open-firmware/atproto-lite'
import {
  COLLECTIONS,
  auditReleaseChain,
  assembleChunks,
  sha256Hex,
  sha256HexEqual,
  mayApplyVersion,
  isReleaseInstallable,
  type ArtifactKind,
  type ChainAuditReport,
  type ChunkMeta,
  type PipelineAckRecord,
  type ReleaseMeta,
} from '@open-firmware/core'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export interface ClientOptions {
  /** Author / OEM PDS that hosts releases */
  pds: string
  /** Author DID (repo) */
  authorDid: string
  trustedAuthors?: string[]
  /**
   * Force-skip pipeline/CI ack checks even when the release requires them.
   * Default false.
   */
  skipPipelineCheck?: boolean
}

export interface ResolveLatestOptions {
  product: string
  channel?: string
  /** Also skip pipeline when selecting installable releases */
  skipPipelineCheck?: boolean
}

export interface AuditOptions {
  freeSpaceBytes?: number
  requireReady?: boolean
  skipPipelineCheck?: boolean
}

export interface DownloadOptions extends AuditOptions {
  /** Directory to write assembled artifact */
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

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

function blobCid(blob: unknown): string | undefined {
  if (!blob || typeof blob !== 'object') return undefined
  const b = blob as { ref?: { $link?: string } | string; size?: number }
  if (typeof b.ref === 'string') return b.ref
  return b.ref?.$link
}

/**
 * Production IoT/edge client — no Docker dependency.
 * Apply is always via caller-provided hooks.
 */
export class OpenFirmwareClient {
  readonly pds: string
  readonly authorDid: string
  readonly trustedAuthors: Set<string>
  private readonly reader: AtpClient

  private readonly skipPipelineCheck: boolean

  constructor(opts: ClientOptions) {
    this.pds = opts.pds
    this.authorDid = opts.authorDid
    this.trustedAuthors = new Set(opts.trustedAuthors ?? [opts.authorDid])
    this.reader = publicClient(opts.pds)
    this.skipPipelineCheck = opts.skipPipelineCheck ?? false
  }

  async listPipelineAcks(releaseUri: string): Promise<PipelineAckRecord[]> {
    const records = await this.reader.listRecords(
      this.authorDid,
      COLLECTIONS.pipelineAck,
      100,
    )
    return records
      .filter((r) => {
        const rel = r.value.release as { uri?: string } | undefined
        return rel?.uri === releaseUri
      })
      .map((r) => ({
        release: r.value.release as PipelineAckRecord['release'],
        stage: String(r.value.stage),
        stageId: r.value.stageId as string | undefined,
        result: r.value.result as PipelineAckRecord['result'],
        createdAt: String(r.value.createdAt),
        runUrl: r.value.runUrl as string | undefined,
        commit: r.value.commit as string | undefined,
        summary: r.value.summary as string | undefined,
        actor: r.value.actor as string | undefined,
        uri: r.uri,
        cid: r.cid,
        authorDid: this.authorDid,
      }))
  }

  async resolveLatest(
    opts: ResolveLatestOptions,
  ): Promise<{
    uri: string
    cid: string
    value: Record<string, unknown>
  } | null> {
    const records = await this.reader.listRecords(
      this.authorDid,
      COLLECTIONS.release,
      50,
    )
    const channel = opts.channel ?? 'stable'
    const skipPipe =
      opts.skipPipelineCheck ?? this.skipPipelineCheck
    const candidates = records
      .filter(
        (r) =>
          r.value.product === opts.product &&
          r.value.channel === channel &&
          r.value.status === 'ready',
      )
      .sort((a, b) =>
        cmpSemver(String(b.value.version), String(a.value.version)),
      )

    for (const top of candidates) {
      const meta: ReleaseMeta = {
        version: String(top.value.version),
        product: String(top.value.product),
        kind: top.value.kind as ReleaseMeta['kind'],
        imageSha256: String(top.value.imageSha256),
        imageSize: Number(top.value.imageSize),
        chunkCount: Number(top.value.chunkCount),
        channel: top.value.channel as ReleaseMeta['channel'],
        status: top.value.status as ReleaseMeta['status'],
        authorDid: this.authorDid,
        uri: top.uri,
        cid: top.cid,
        requirePipelineAcks: Boolean(top.value.requirePipelineAcks),
        requiredPipelineStages: top.value.requiredPipelineStages as
          | string[]
          | undefined,
        pipelinePolicy: top.value.pipelinePolicy as ReleaseMeta['pipelinePolicy'],
      }
      const acks = await this.listPipelineAcks(top.uri)
      const gate = isReleaseInstallable(meta, acks, {
        skipPipelineCheck: skipPipe,
      })
      if (gate.installable) return top
    }
    return null
  }

  async loadChain(releaseUri: string): Promise<{
    release: ReleaseMeta
    chunks: ChunkMeta[]
    releaseCid: string
  }> {
    const records = await this.reader.listRecords(
      this.authorDid,
      COLLECTIONS.release,
      50,
    )
    const rel = records.find((r) => r.uri === releaseUri)
    if (!rel) throw new Error(`release not found: ${releaseUri}`)

    if (!this.trustedAuthors.has(this.authorDid)) {
      throw new Error(`author ${this.authorDid} not in trustedAuthors`)
    }

    const v = rel.value
    const release: ReleaseMeta = {
      version: String(v.version),
      product: String(v.product),
      kind: v.kind as ReleaseMeta['kind'],
      imageSha256: String(v.imageSha256),
      imageSize: Number(v.imageSize),
      chunkCount: Number(v.chunkCount),
      channel: v.channel as ReleaseMeta['channel'],
      status: v.status as ReleaseMeta['status'],
      authorDid: this.authorDid,
      uri: rel.uri,
      cid: rel.cid,
    }

    const chunkRecs = await this.reader.listRecords(
      this.authorDid,
      COLLECTIONS.chunk,
      100,
    )
    const chunks: ChunkMeta[] = chunkRecs
      .filter((r) => {
        const reply = r.value.reply as
          | { root?: { uri?: string }; parent?: { uri?: string } }
          | undefined
        return reply?.root?.uri === releaseUri
      })
      .map((r) => {
        const reply = r.value.reply as {
          root?: { uri?: string }
          parent?: { uri?: string }
        }
        return {
          seq: Number(r.value.seq),
          sha256: String(r.value.sha256),
          byteOffset: Number(r.value.byteOffset),
          byteLength: Number(r.value.byteLength),
          blobCid: blobCid(r.value.blob),
          blobSize:
            typeof (r.value.blob as { size?: number })?.size === 'number'
              ? (r.value.blob as { size: number }).size
              : undefined,
          authorDid: this.authorDid,
          rootUri: reply.root?.uri,
          parentUri: reply.parent?.uri,
          uri: r.uri,
          cid: r.cid,
        }
      })
      .sort((a, b) => a.seq - b.seq)

    return { release, chunks, releaseCid: rel.cid }
  }

  async auditRelease(
    releaseUri: string,
    opts: AuditOptions = {},
  ): Promise<ChainAuditReport & { release: ReleaseMeta; chunks: ChunkMeta[] }> {
    const { release, chunks } = await this.loadChain(releaseUri)
    const availability: Record<string, { available: boolean; size?: number }> =
      {}
    for (const c of chunks) {
      if (!c.blobCid) continue
      try {
        const bytes = await this.reader.getBlob(this.authorDid, c.blobCid)
        availability[c.blobCid] = { available: true, size: bytes.byteLength }
        ;(c as ChunkMeta & { _bytes?: Uint8Array })._bytes = bytes
      } catch {
        availability[c.blobCid] = { available: false }
      }
    }
    const report = auditReleaseChain(release, chunks, {
      freeSpaceBytes: opts.freeSpaceBytes,
      requireReady: opts.requireReady ?? true,
      requireBlobAvailability: true,
      blobAvailability: availability,
    })
    return { ...report, release, chunks }
  }

  async downloadVerified(
    releaseUri: string,
    opts: DownloadOptions = {},
  ): Promise<AppliedRelease> {
    const audited = await this.auditRelease(releaseUri, opts)
    if (!audited.ok) {
      const err = new Error(
        `Phase A failed: ${audited.issues.map((i) => i.code).join(', ')}`,
      )
      ;(err as Error & { audit: typeof audited }).audit = audited
      throw err
    }

    const downloaded: Array<{ seq: number; data: Uint8Array }> = []
    for (const c of audited.chunks) {
      const cached = (c as ChunkMeta & { _bytes?: Uint8Array })._bytes
      const data =
        cached ??
        (await this.reader.getBlob(this.authorDid, c.blobCid!))
      if (data.byteLength !== c.byteLength) {
        throw new Error(`chunk ${c.seq} length mismatch`)
      }
      if (!sha256HexEqual(sha256Hex(data), c.sha256)) {
        throw new Error(`chunk ${c.seq} digest mismatch`)
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

  /**
   * If newer than currentVersion, audit+download. Returns null if nothing new.
   */
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
