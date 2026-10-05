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
  DEFAULT_MAX_IMAGE_BYTES,
  assembleChunks,
  auditReleaseChain,
  channelRkey,
  isArtifactKind,
  isReleaseInstallable,
  isSafePathSegment,
  mayApplyVersion,
  sha256Hex,
  sha256HexEqual,
  type ArtifactKind,
  type ChainAuditReport,
  type ChunkMeta,
  type GateState,
  type PipelineAckRecord,
  type PipelineAuditOptions,
  type PipelinePolicy,
  type ReleaseMeta,
} from '@open-firmware/core'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface ClientOptions {
  pds: string
  authorDid: string
  trustedAuthors?: string[]
  /**
   * Pinned OEM public keys. When non-empty, every release must carry a valid
   * signature from one of them.
   */
  trustedOemKeys?: string[]
  /** Require an OEM signature; with no trusted keys nothing can verify. */
  requireOemSignature?: boolean
  maxChannelAgeSec?: number
  /** CI attester DIDs. When set, only their acks count and the pipeline is enforced. */
  attesterDids?: string[]
  /**
   * Consumer-side minimum pipeline policy. The release record can raise it but
   * not lower it. Defaults to 'strict' when attesterDids is set.
   */
  pipelinePolicy?: PipelinePolicy
  /** Consumer-side required stages; overrides the list in the release record. */
  requiredPipelineStages?: string[]
  /** Largest image this consumer will download. Default DEFAULT_MAX_IMAGE_BYTES. */
  maxImageBytes?: number
  fetch?: typeof fetch
  /** Emergency only. Use OFW_CONSUMER_SKIP_PIPELINE, never OFW_SKIP_PIPELINE. */
  skipPipelineCheck?: boolean
  /**
   * Called when the channel pointer names a release this consumer will not
   * install (gate not ready, or the pipeline policy is not satisfied), so an
   * operator can tell "refusing" apart from "nothing new".
   */
  onNotInstallable?: (info: NotInstallableInfo) => void
}

export interface NotInstallableInfo {
  uri: string
  cid: string
  product: string
  version: string
  reason: string
  issues: Array<{ code: string; message: string }>
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
  /** Pin the release record CID; a different CID is rejected. */
  cid?: string
}

interface LoadedRelease {
  uri: string
  cid: string
  value: Record<string, unknown>
  meta: ReleaseMeta
  chunks: ChunkMeta[]
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
  readonly pipelinePolicy?: PipelinePolicy
  readonly requiredPipelineStages?: string[]
  readonly maxImageBytes: number
  private readonly reader: AtpClient
  private readonly skipPipelineCheck: boolean
  private readonly onNotInstallable?: (info: NotInstallableInfo) => void

  constructor(opts: ClientOptions) {
    this.pds = opts.pds
    this.authorDid = opts.authorDid
    this.trustedAuthors = new Set(opts.trustedAuthors ?? [opts.authorDid])
    this.trustedOemKeys = opts.trustedOemKeys ?? []
    this.requireOemSignature = opts.requireOemSignature ?? false
    this.maxChannelAgeSec = opts.maxChannelAgeSec
    this.attesterDids = opts.attesterDids?.length ? opts.attesterDids : undefined
    this.pipelinePolicy =
      opts.pipelinePolicy ?? (this.attesterDids ? 'strict' : undefined)
    this.requiredPipelineStages = opts.requiredPipelineStages
    this.maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
    this.reader = publicClient(opts.pds, opts.fetch)
    this.skipPipelineCheck = opts.skipPipelineCheck ?? false
    this.onNotInstallable = opts.onNotInstallable
  }

  private pipelineOptions(skipPipelineCheck?: boolean): PipelineAuditOptions {
    return {
      skipPipelineCheck: skipPipelineCheck ?? this.skipPipelineCheck,
      attesterDids: this.attesterDids,
      consumerMinPolicy: this.pipelinePolicy,
      requiredStages: this.requiredPipelineStages,
    }
  }

  /**
   * Acks for a release from the author and attester repos. With `releaseCid`,
   * only acks bound to that exact record version are returned.
   */
  async listPipelineAcks(
    releaseUri: string,
    releaseCid?: string,
  ): Promise<PipelineAckRecord[]> {
    const repos = new Set<string>([
      parseAtUri(releaseUri).did,
      ...(this.attesterDids ?? []),
    ])
    const out: PipelineAckRecord[] = []
    for (const repo of repos) {
      const records = await this.reader.listRecords(repo, COLLECTIONS.pipelineAck)
      for (const r of records) {
        const rel = r.value.release as { uri?: string; cid?: string } | undefined
        if (rel?.uri !== releaseUri) continue
        if (releaseCid && rel.cid !== releaseCid) continue
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
    const loaded = await this.resolveLatestLoaded(opts)
    if (!loaded) return null
    return { uri: loaded.uri, cid: loaded.cid, value: loaded.value }
  }

  private async resolveLatestLoaded(
    opts: ResolveLatestOptions,
  ): Promise<LoadedRelease | null> {
    const channel = opts.channel ?? 'stable'
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
    // channelRkey is lossy, so the rkey alone does not prove what this points at.
    if (pointer.value.product !== opts.product || pointer.value.channel !== channel) {
      throw new Error(
        `channel pointer mismatch: wanted ${opts.product}/${channel}, pointer is for ${String(pointer.value.product)}/${String(pointer.value.channel)}`,
      )
    }
    if (this.maxChannelAgeSec) {
      const age = Date.now() - Date.parse(String(pointer.value.updatedAt))
      if (!Number.isFinite(age)) {
        throw new Error('channel pointer has no valid updatedAt; cannot check staleness')
      }
      const declared = pointer.value.maxAgeSec
      const bound =
        typeof declared === 'number' && declared > 0
          ? Math.min(declared, this.maxChannelAgeSec)
          : this.maxChannelAgeSec
      if (age / 1000 > bound) {
        throw new Error(`channel pointer is stale (${Math.round(age / 1000)}s)`)
      }
    }
    const rel = pointer.value.release as { uri?: string; cid?: string }
    if (!rel?.uri || !rel.cid) return null
    const loaded = await this.loadPinned(rel.uri, rel.cid, true)
    if (loaded.meta.product !== opts.product || loaded.meta.channel !== channel) {
      throw new Error(
        `channel pointer mismatch: wanted ${opts.product}/${channel}, release is ${loaded.meta.product}/${String(loaded.meta.channel)}`,
      )
    }
    const acks = await this.listPipelineAcks(loaded.uri, loaded.cid)
    const gate = isReleaseInstallable(
      loaded.meta,
      acks,
      this.pipelineOptions(opts.skipPipelineCheck),
    )
    if (!gate.installable) {
      this.onNotInstallable?.({
        uri: loaded.uri,
        cid: loaded.cid,
        product: loaded.meta.product,
        version: loaded.meta.version,
        reason: gate.reason ?? 'not installable',
        issues: gate.pipeline.issues.map((i) => ({ code: i.code, message: i.message })),
      })
      return null
    }
    return loaded
  }

  /**
   * Load a release record and its gate. Pass `cid` to pin the record version.
   * A release with no gate record is reported as not ready.
   */
  async loadRelease(releaseUri: string, cid?: string): Promise<LoadedRelease> {
    return this.loadPinned(releaseUri, cid, false)
  }

  /**
   * @param viaChannel the URI+CID came from the channel pointer, which is only
   * written once a release is ready, so a missing gate record is acceptable.
   */
  private async loadPinned(
    releaseUri: string,
    cid: string | undefined,
    viaChannel: boolean,
  ): Promise<LoadedRelease> {
    const parsed = parseAtUri(releaseUri)
    if (!this.trustedAuthors.has(parsed.did)) {
      throw new Error(`author ${parsed.did} not in trustedAuthors`)
    }
    if (parsed.collection !== COLLECTIONS.release) {
      throw new Error(`not a release URI: collection ${parsed.collection}`)
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
    if (rec.uri !== releaseUri) {
      throw new Error(`release URI mismatch: asked ${releaseUri}, got ${rec.uri}`)
    }
    if (cid && rec.cid !== cid) {
      throw new Error(`release CID mismatch: pinned ${cid}, got ${rec.cid}`)
    }
    if (!isSafePathSegment(rec.value.product)) {
      throw new Error('release product is not a safe name')
    }
    if (!isSafePathSegment(rec.value.version)) {
      throw new Error('release version is not a safe name')
    }
    if (!isArtifactKind(rec.value.kind)) {
      throw new Error(`unknown artifact kind ${String(rec.value.kind)}`)
    }
    const authorDid = parsed.did

    let gate
    try {
      gate = await this.reader.getRecord(authorDid, COLLECTIONS.gate, parsed.rkey)
    } catch (e) {
      // Only a definite "no such record" may be defaulted. Timeouts, 5xx and
      // anything else must not turn into an installable release.
      if (!(e instanceof XRPCError && e.isMissingRecord)) {
        throw new Error(
          `gate check failed for ${releaseUri}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        )
      }
    }
    let status: GateState
    if (gate) {
      const ref = gate.value.release as { uri?: string; cid?: string } | undefined
      if (ref?.uri !== rec.uri || ref?.cid !== rec.cid) {
        throw new Error(`gate record does not reference release ${rec.uri} @ ${rec.cid}`)
      }
      status = String(gate.value.state) as GateState
    } else {
      status = viaChannel ? 'ready' : 'awaiting-pipeline'
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
      version: rec.value.version,
      product: rec.value.product,
      kind: rec.value.kind,
      imageSha256: String(rec.value.imageSha256),
      imageSize: Number(rec.value.imageSize),
      chunkCount: chunks.length,
      channel: rec.value.channel as ReleaseMeta['channel'],
      maxImageBytes: this.maxImageBytes,
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
    const loaded = await this.loadRelease(releaseUri, opts.cid)
    const availability: Record<string, { available: boolean; size?: number; cid?: string }> =
      {}
    if (opts.probeBlobs) {
      for (const c of loaded.chunks) {
        if (!c.blobCid) continue
        try {
          const bytes = await this.reader.getBlob(loaded.meta.authorDid, c.blobCid, {
            maxBytes: this.partCap(c),
          })
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

  /** Never buffer more than the part declares, or than the image cap. */
  private partCap(c: ChunkMeta): number {
    const declared = Number.isSafeInteger(c.byteLength) ? c.byteLength : 0
    return Math.max(0, Math.min(declared, this.maxImageBytes))
  }

  /**
   * Download and verify a release by URI. This does not go through the channel
   * pointer, so the release must have a gate record in state "ready". Pass
   * `opts.cid` to pin the exact record version.
   */
  async downloadVerified(
    releaseUri: string,
    opts: DownloadOptions = {},
  ): Promise<AppliedRelease> {
    const loaded = await this.loadRelease(releaseUri, opts.cid)
    return this.downloadLoaded(loaded, opts)
  }

  private async downloadLoaded(
    loaded: LoadedRelease,
    opts: DownloadOptions,
  ): Promise<AppliedRelease> {
    const acks = await this.listPipelineAcks(loaded.uri, loaded.cid)
    const gate = isReleaseInstallable(
      loaded.meta,
      acks,
      this.pipelineOptions(opts.skipPipelineCheck),
    )
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
      const data = await this.reader.getBlob(loaded.meta.authorDid, c.blobCid, {
        maxBytes: this.partCap(c),
      })
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
    const latest = await this.resolveLatestLoaded(opts)
    if (!latest) return null
    const version = latest.meta.version
    if (
      opts.currentVersion &&
      !mayApplyVersion(version, opts.currentVersion, {
        allowDowngrade: opts.allowDowngrade,
      })
    ) {
      return null
    }
    // Reuse the record pinned by the channel pointer; reloading by URI alone
    // would drop the CID pin.
    return this.downloadLoaded(latest, { ...opts, cid: latest.cid })
  }
}

export type ApplyHandler = (artifact: AppliedRelease) => Promise<void>
