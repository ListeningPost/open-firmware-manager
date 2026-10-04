import { isSha256Hex } from '../hash/index.js'
import { verifyOemSignature } from '../sign/index.js'
import type {
  AuditIssue,
  ChainAuditReport,
  ChunkMeta,
  ReleaseMeta,
} from '../types/index.js'

export interface AuditOptions {
  freeSpaceBytes?: number
  stagingOverheadBytes?: number
  /** Require gate state === 'ready'. Default true. */
  requireReady?: boolean
  blobAvailability?: Record<string, { available: boolean; size?: number; cid?: string }>
  requireBlobAvailability?: boolean
  /**
   * If non-empty, a valid OEM signature from one of these keys is required
   * (an unsigned release fails with OEM_SIG_MISSING).
   */
  trustedOemKeys?: string[]
  /** Require an OEM signature. Fails closed when no trusted keys are set. */
  requireOemSignature?: boolean
  expectedType?: string
  recordType?: string
}

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

  if (options.expectedType && options.recordType && options.recordType !== options.expectedType) {
    push('TYPE_MISMATCH', `record $type ${options.recordType} != ${options.expectedType}`)
  }

  if (requireReady && release.status !== 'ready') {
    push(
      'INCOMPLETE_PUBLISH',
      `gate state is "${release.status}", expected "ready"`,
    )
  }

  if (!isSha256Hex(release.imageSha256)) {
    push('DIGEST_INVALID', 'release.imageSha256 is not a 64-char hex SHA-256')
  }

  if (release.uri) {
    const did = didFromAtUri(release.uri)
    if (did && did !== release.authorDid) {
      push('AUTHOR_MISMATCH', `release URI did ${did} != authorDid ${release.authorDid}`)
    }
  }

  if (!Number.isSafeInteger(release.imageSize) || release.imageSize < 0) {
    push('SIZE_MISMATCH', `imageSize ${release.imageSize} is not a valid byte count`)
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
        `chunkCount is 0 but ${chunks.length} part(s) provided`,
      )
    }
  }

  if (chunks.length !== release.chunkCount) {
    push(
      'COUNT_MISMATCH',
      `expected ${release.chunkCount} part(s), got ${chunks.length}`,
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

  const trustedOemKeys = options.trustedOemKeys ?? []
  if (options.requireOemSignature || trustedOemKeys.length > 0) {
    if (!release.oemSignature) {
      push('OEM_SIG_MISSING', 'OEM signature required by policy')
    } else {
      const v = verifyOemSignature(release, trustedOemKeys)
      if (!v.ok) push('OEM_SIG_INVALID', v.reason ?? 'OEM signature invalid')
    }
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
      push('SEQ_GAP', `missing part seq ${seq}`, seq)
      continue
    }
    ordered.push(c)
  }

  for (const c of ordered) {
    if (c.authorDid && c.authorDid !== release.authorDid) {
      push(
        'AUTHOR_MISMATCH',
        `part seq ${c.seq} author ${c.authorDid} != release author ${release.authorDid}`,
        c.seq,
      )
    }
    if (!c.sha256 || !isSha256Hex(c.sha256)) {
      push(
        c.sha256 ? 'DIGEST_INVALID' : 'DIGEST_MISSING',
        `part seq ${c.seq} has invalid or missing sha256`,
        c.seq,
      )
    }
    if (!Number.isSafeInteger(c.byteLength) || c.byteLength < 0) {
      push(
        'LAYOUT_INVALID',
        `part seq ${c.seq} byteLength ${c.byteLength} is not a valid byte count`,
        c.seq,
      )
    }
    if (c.blobSize !== undefined && c.blobSize !== c.byteLength) {
      push(
        'BLOB_SIZE_MISMATCH',
        `part seq ${c.seq} blob.size ${c.blobSize} != byteLength ${c.byteLength}`,
        c.seq,
      )
    }
    if (options.requireBlobAvailability && c.blobCid) {
      const av = options.blobAvailability?.[c.blobCid]
      if (!av?.available) {
        push(
          'BLOB_UNAVAILABLE',
          `part seq ${c.seq} blob ${c.blobCid} not available`,
          c.seq,
        )
      } else if (av.size !== undefined && av.size !== c.byteLength) {
        push(
          'BLOB_SIZE_MISMATCH',
          `part seq ${c.seq} available size ${av.size} != byteLength ${c.byteLength}`,
          c.seq,
        )
      }
      if (av?.cid && c.blobCid && av.cid !== c.blobCid) {
        push(
          'BLOB_CID_MISMATCH',
          `part seq ${c.seq} computed CID ${av.cid} != record ${c.blobCid}`,
          c.seq,
        )
      }
    }
  }

  let expectedOffset = 0
  let sumLengths = 0
  for (const c of ordered) {
    sumLengths += c.byteLength
    if (c.byteOffset !== expectedOffset) {
      push(
        'LAYOUT_INVALID',
        `part seq ${c.seq} byteOffset ${c.byteOffset} expected ${expectedOffset}`,
        c.seq,
      )
    }
    expectedOffset += c.byteLength
  }

  if (ordered.length > 0 && sumLengths !== release.imageSize) {
    push(
      'SIZE_MISMATCH',
      `sum(byteLength)=${sumLengths} != imageSize=${release.imageSize}`,
    )
  }

  if (release.chunkCount > 0 && ordered.length === 0) {
    push('EMPTY_CHAIN', 'no valid parts to form a download plan')
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

export function didFromAtUri(uri: string): string | null {
  if (!uri.startsWith('at://')) return null
  const rest = uri.slice('at://'.length)
  const slash = rest.indexOf('/')
  const did = slash === -1 ? rest : rest.slice(0, slash)
  return did.startsWith('did:') ? did : null
}

export function parseAtUri(
  uri: string,
): { did: string; collection: string; rkey: string } | null {
  if (!uri.startsWith('at://')) return null
  const rest = uri.slice('at://'.length)
  const parts = rest.split('/')
  if (parts.length < 3) return null
  const did = parts[0]!
  const collection = parts[1]!
  const rkey = parts.slice(2).join('/')
  if (!did.startsWith('did:') || !collection || !rkey) return null
  return { did, collection, rkey }
}
