import { describe, expect, it } from 'vitest'
import { assembleChunks, chunkBytes } from '../src/chunk/index.js'
import { sha256Hex } from '../src/hash/index.js'

describe('chunkBytes / assembleChunks', () => {
  it('round-trips a multi-chunk payload', () => {
    const data = new Uint8Array(1000)
    for (let i = 0; i < data.length; i++) data[i] = i % 256

    const { chunks, imageSha256, imageSize } = chunkBytes(data, {
      chunkSize: 300,
    })
    expect(chunks).toHaveLength(4)
    expect(imageSize).toBe(1000)
    expect(imageSha256).toBe(sha256Hex(data))
    expect(chunks[0]!.byteOffset).toBe(0)
    expect(chunks[1]!.byteOffset).toBe(300)

    const out = assembleChunks(
      chunks.map((c) => ({ seq: c.seq, data: c.data })),
      { imageSha256, imageSize },
    )
    expect(out).toEqual(data)
  })

  it('handles empty payload', () => {
    const { chunks, imageSize } = chunkBytes(new Uint8Array(0))
    expect(chunks).toHaveLength(0)
    expect(imageSize).toBe(0)
  })

  it('rejects assemble with gap', () => {
    expect(() =>
      assembleChunks([
        { seq: 0, data: new Uint8Array([1]) },
        { seq: 2, data: new Uint8Array([2]) },
      ]),
    ).toThrow(/missing or out-of-order/)
  })
})
