import { sha256Hex } from '../hash/index.js'
import type { ChunkPlan } from '../types/index.js'

export interface ChunkFileOptions {
  /** Chunk size in bytes. Default 512 KiB. */
  chunkSize?: number
}

/**
 * Split a payload into ordered chunk plans with digests.
 * Pure / local — no network. Used by host publish and tests.
 */
export function chunkBytes(
  data: Uint8Array,
  options: ChunkFileOptions = {},
): { chunks: ChunkPlan[]; imageSha256: string; imageSize: number } {
  const chunkSize = options.chunkSize ?? 512 * 1024
  if (chunkSize < 1) {
    throw new Error('chunkSize must be >= 1')
  }

  const imageSha256 = sha256Hex(data)
  const imageSize = data.byteLength
  const chunks: ChunkPlan[] = []

  if (imageSize === 0) {
    return { chunks, imageSha256, imageSize }
  }

  let offset = 0
  let seq = 0
  while (offset < imageSize) {
    const end = Math.min(offset + chunkSize, imageSize)
    const slice = data.subarray(offset, end)
    chunks.push({
      seq,
      byteOffset: offset,
      byteLength: slice.byteLength,
      sha256: sha256Hex(slice),
      data: slice,
    })
    offset = end
    seq++
  }

  return { chunks, imageSha256, imageSize }
}

/**
 * Reassemble chunk payloads in seq order and verify full-image digest.
 */
export function assembleChunks(
  chunks: Array<{ seq: number; data: Uint8Array }>,
  expected?: { imageSha256?: string; imageSize?: number },
): Uint8Array {
  const ordered = [...chunks].sort((a, b) => a.seq - b.seq)
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.seq !== i) {
      throw new Error(`assembleChunks: missing or out-of-order seq at ${i}`)
    }
  }

  const total = ordered.reduce((n, c) => n + c.data.byteLength, 0)
  if (expected?.imageSize !== undefined && expected.imageSize !== total) {
    throw new Error(
      `assembleChunks: size mismatch expected ${expected.imageSize} got ${total}`,
    )
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const c of ordered) {
    out.set(c.data, offset)
    offset += c.data.byteLength
  }

  if (expected?.imageSha256) {
    const got = sha256Hex(out)
    if (got.toLowerCase() !== expected.imageSha256.toLowerCase()) {
      throw new Error('assembleChunks: imageSha256 mismatch')
    }
  }

  return out
}
