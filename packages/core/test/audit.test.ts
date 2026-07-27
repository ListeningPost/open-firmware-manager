import { describe, expect, it } from 'vitest'
import { auditReleaseChain } from '../src/audit/index.js'
import { chunkBytes } from '../src/chunk/index.js'
import type { ChunkMeta, ReleaseMeta } from '../src/types/index.js'

function releaseFromChunks(
  data: Uint8Array,
  chunkSize: number,
  overrides: Partial<ReleaseMeta> = {},
): { release: ReleaseMeta; chunks: ChunkMeta[] } {
  const planned = chunkBytes(data, { chunkSize })
  const releaseUri = 'at://did:plc:author/app.openfirmware.firmware.release/r1'
  const release: ReleaseMeta = {
    version: '1.0.0',
    product: 'demo',
    kind: 'firmware',
    imageSha256: planned.imageSha256,
    imageSize: planned.imageSize,
    chunkCount: planned.chunks.length,
    channel: 'stable',
    status: 'ready',
    authorDid: 'did:plc:author',
    uri: releaseUri,
    cid: 'bafyrelease',
    ...overrides,
  }

  const chunks: ChunkMeta[] = planned.chunks.map((c, i) => {
    const uri = `at://did:plc:author/app.openfirmware.firmware.chunk/c${i}`
    const prevUri =
      i === 0 ? releaseUri : `at://did:plc:author/app.openfirmware.firmware.chunk/c${i - 1}`
    return {
      seq: c.seq,
      sha256: c.sha256,
      byteOffset: c.byteOffset,
      byteLength: c.byteLength,
      blobCid: `bafkchunk${i}`,
      blobSize: c.byteLength,
      authorDid: 'did:plc:author',
      rootUri: releaseUri,
      rootCid: 'bafyrelease',
      parentUri: prevUri,
      parentCid: i === 0 ? 'bafyrelease' : `bafychunk${i - 1}`,
      uri,
      cid: `bafychunk${i}`,
    }
  })

  return { release, chunks }
}

describe('auditReleaseChain (Phase A)', () => {
  it('passes a complete unbothered chain', () => {
    const data = new Uint8Array(500).fill(7)
    const { release, chunks } = releaseFromChunks(data, 200)
    const report = auditReleaseChain(release, chunks, {
      freeSpaceBytes: 10_000,
    })
    expect(report.ok).toBe(true)
    expect(report.issues).toHaveLength(0)
    expect(report.chunks).toHaveLength(3)
  })

  it('fails incomplete publish status', () => {
    const data = new Uint8Array(100).fill(1)
    const { release, chunks } = releaseFromChunks(data, 50, {
      status: 'publishing',
    })
    const report = auditReleaseChain(release, chunks)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === 'INCOMPLETE_PUBLISH')).toBe(
      true,
    )
  })

  it('fails broken parent chain', () => {
    const data = new Uint8Array(100).fill(1)
    const { release, chunks } = releaseFromChunks(data, 50)
    chunks[1]!.parentUri = 'at://did:plc:author/app.openfirmware.firmware.chunk/WRONG'
    const report = auditReleaseChain(release, chunks)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === 'CHAIN_BROKEN')).toBe(true)
  })

  it('fails count mismatch / seq gap', () => {
    const data = new Uint8Array(100).fill(1)
    const { release, chunks } = releaseFromChunks(data, 50)
    const report = auditReleaseChain(release, chunks.slice(0, 1))
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === 'COUNT_MISMATCH')).toBe(true)
    expect(report.issues.some((i) => i.code === 'SEQ_GAP')).toBe(true)
  })

  it('fails layout / size mismatch', () => {
    const data = new Uint8Array(100).fill(1)
    const { release, chunks } = releaseFromChunks(data, 50)
    chunks[1]!.byteOffset = 999
    const report = auditReleaseChain(release, chunks)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === 'LAYOUT_INVALID')).toBe(true)
  })

  it('fails insufficient space before download', () => {
    const data = new Uint8Array(1000).fill(2)
    const { release, chunks } = releaseFromChunks(data, 400)
    const report = auditReleaseChain(release, chunks, { freeSpaceBytes: 10 })
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === 'INSUFFICIENT_SPACE')).toBe(
      true,
    )
  })

  it('fails author mismatch on a chunk', () => {
    const data = new Uint8Array(80).fill(3)
    const { release, chunks } = releaseFromChunks(data, 40)
    chunks[0]!.authorDid = 'did:plc:attacker'
    const report = auditReleaseChain(release, chunks)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === 'AUTHOR_MISMATCH')).toBe(true)
  })

  it('fails blob availability probe', () => {
    const data = new Uint8Array(80).fill(3)
    const { release, chunks } = releaseFromChunks(data, 40)
    const report = auditReleaseChain(release, chunks, {
      requireBlobAvailability: true,
      blobAvailability: {
        [chunks[0]!.blobCid!]: { available: true, size: chunks[0]!.byteLength },
        // second blob missing
      },
    })
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.code === 'BLOB_UNAVAILABLE')).toBe(true)
  })
})
