import { isSha256Hex } from '../hash/index.js'
import type {
  AuditIssue,
  ChainAuditReport,
  ChunkMeta,
  ReleaseMeta,
} from '../types/index.js'

export interface AuditOptions {
  /** Free bytes on the target volume; if set, enforces preflight. */
  freeSpaceBytes?: number
  /** Extra staging overhead added to required bytes (default 0). */
  stagingOverheadBytes?: number
  /** Require release.status === 'ready'. Default true. */
  requireReady?: boolean
  /**
   * Optional map of blobCid → available size (from probes).
   * Missing keys when probeBlobs was requested should be passed as availability flags separately.
   */
  blobAvailability?: Record<string, { available: boolean; size?: number }>
  /** If true, missing availability entries count as BLOB_UNAVAILABLE when blobCid set. */
  requireBlobAvailability?: boolean
}

/**
 * Phase A: BitTorrent-style metadata integrity suite.
 * Does not download payload bodies — only validates the plan of the download.
 */
export function auditReleaseChain(
  release: ReleaseMeta,
  chunks: ChunkMeta[],
  options: AuditOptions = {},
): ChainAuditReport {
  const issues: AuditIssue[] = []
  const requireReady = options.requireReady ?? true
  const overhead = options.stagingOverheadBytes ?? 0
  const requiredBytes = release.imageSize + overhead

  const push = (code: AuditIssue['code'], message: string, seq?: number) => {
    issues.push(seq === undefined ? { code, message } : { code, message, seq })
  }

  if (requireReady && release.status !== 'ready') {
    push(
      'INCOMPLETE_PUBLISH',
      `release status is "${release.status}", expected "ready"`,
    )
  }

  if (!isSha256Hex(release.imageSha256)) {
    push('DIGEST_INVALID', 'release.imageSha256 is not a 64-char hex SHA-256')
  }

  if (release.chunkCount === 0) {
    if (release.imageSize !== 0) {
      push(
        'COUNT_MISMATCH',
        `chunkCount is 0 but imageSize is ${release.imageSize}`,
      )
    }
    if (chunks.length !== 0) {
      push(
        'COUNT_MISMATCH',
        `chunkCount is 0 but ${chunks.length} chunk(s) provided`,
      )
    }
  }

  if (chunks.length !== release.chunkCount) {
    push(
      'COUNT_MISMATCH',
      `expected ${release.chunkCount} chunk(s), got ${chunks.length}`,
    )
  }

  if (release.maxImageBytes !== undefined && release.imageSize > release.maxImageBytes) {
    push(
      'IMAGE_TOO_LARGE',
      `imageSize ${release.imageSize} exceeds maxImageBytes ${release.maxImageBytes}`,
    )
  }

  if (
    options.freeSpaceBytes !== undefined &&
    requiredBytes > options.freeSpaceBytes
  ) {
    push(
      'INSUFFICIENT_SPACE',
      `need ${requiredBytes} bytes (image + overhead), free ${options.freeSpaceBytes}`,
    )
  }

  const bySeq = new Map<number, ChunkMeta>()
  for (const c of chunks) {
    if (bySeq.has(c.seq)) {
      push('SEQ_DUPLICATE', `duplicate seq ${c.seq}`, c.seq)
    } else {
      bySeq.set(c.seq, c)
    }
  }

  const ordered: ChunkMeta[] = []
  for (let seq = 0; seq < release.chunkCount; seq++) {
    const c = bySeq.get(seq)
    if (!c) {
      push('SEQ_GAP', `missing chunk seq ${seq}`, seq)
      continue
    }
    ordered.push(c)
  }

  // Author continuity + digests + blob size
  for (const c of ordered) {
    if (c.authorDid && c.authorDid !== release.authorDid) {
      push(
        'AUTHOR_MISMATCH',
        `chunk seq ${c.seq} author ${c.authorDid} != release author ${release.authorDid}`,
        c.seq,
      )
    }
    if (!c.sha256 || !isSha256Hex(c.sha256)) {
      push(
        c.sha256 ? 'DIGEST_INVALID' : 'DIGEST_MISSING',
        `chunk seq ${c.seq} has invalid or missing sha256`,
        c.seq,
      )
    }
    if (c.blobSize !== undefined && c.blobSize !== c.byteLength) {
      push(
        'BLOB_SIZE_MISMATCH',
        `chunk seq ${c.seq} blob.size ${c.blobSize} != byteLength ${c.byteLength}`,
        c.seq,
      )
    }
    if (options.requireBlobAvailability && c.blobCid) {
      const av = options.blobAvailability?.[c.blobCid]
      if (!av?.available) {
        push(
          'BLOB_UNAVAILABLE',
          `chunk seq ${c.seq} blob ${c.blobCid} not available`,
          c.seq,
        )
      } else if (av.size !== undefined && av.size !== c.byteLength) {
        push(
          'BLOB_SIZE_MISMATCH',
          `chunk seq ${c.seq} available size ${av.size} != byteLength ${c.byteLength}`,
          c.seq,
        )
      }
    }
  }

  // Layout arithmetic + chain linkage when refs present
  let expectedOffset = 0
  let sumLengths = 0
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i]!
    sumLengths += c.byteLength

    if (c.byteOffset !== expectedOffset) {
      push(
        'LAYOUT_INVALID',
        `chunk seq ${c.seq} byteOffset ${c.byteOffset} expected ${expectedOffset}`,
        c.seq,
      )
    }
    expectedOffset += c.byteLength

    if (release.uri && c.rootUri && c.rootUri !== release.uri) {
      push(
        'CHAIN_BROKEN',
        `chunk seq ${c.seq} root uri does not match release`,
        c.seq,
      )
    }

    if (i === 0) {
      if (release.uri && c.parentUri && c.parentUri !== release.uri) {
        push(
          'CHAIN_BROKEN',
          `chunk seq 0 parent should be release uri`,
          0,
        )
      }
    } else {
      const prev = ordered[i - 1]!
      if (c.parentUri && prev.uri && c.parentUri !== prev.uri) {
        push(
          'CHAIN_BROKEN',
          `chunk seq ${c.seq} parent does not match previous chunk`,
          c.seq,
        )
      }
      if (c.parentCid && prev.cid && c.parentCid !== prev.cid) {
        push(
          'CHAIN_BROKEN',
          `chunk seq ${c.seq} parent cid does not match previous chunk`,
          c.seq,
        )
      }
    }
  }

  if (ordered.length > 0 && sumLengths !== release.imageSize) {
    push(
      'SIZE_MISMATCH',
      `sum(byteLength)=${sumLengths} != imageSize=${release.imageSize}`,
    )
  }

  if (release.chunkCount > 0 && ordered.length === 0) {
    push('EMPTY_CHAIN', 'no valid chunks to form a download plan')
  }

  return {
    ok: issues.length === 0,
    release,
    chunks: ordered,
    issues,
    requiredBytes,
    freeSpaceBytes: options.freeSpaceBytes,
  }
}
