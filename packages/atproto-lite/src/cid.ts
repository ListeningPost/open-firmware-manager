import { createHash } from 'node:crypto'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31]
  }
  return out
}

/**
 * CIDv1 + raw (0x55) + sha2-256 — the AT Protocol blob CID (`bafk…`).
 */
export function blobCidFromBytesSync(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest()
  const mh = new Uint8Array(34)
  mh[0] = 0x12
  mh[1] = 32
  mh.set(digest, 2)
  const cid = new Uint8Array(2 + mh.length)
  cid[0] = 0x01
  cid[1] = 0x55
  cid.set(mh, 2)
  return `b${base32Encode(cid)}`
}

export async function blobCidFromBytes(bytes: Uint8Array): Promise<string> {
  return blobCidFromBytesSync(bytes)
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function blobLink(blob: unknown): string | undefined {
  if (!blob || typeof blob !== 'object') return undefined
  const b = blob as { ref?: { $link?: string } | string; cid?: string }
  if (typeof b.ref === 'string') return b.ref
  if (b.ref && typeof b.ref === 'object' && typeof b.ref.$link === 'string') {
    return b.ref.$link
  }
  if (typeof b.cid === 'string') return b.cid
  return undefined
}

export async function assertBlobCid(bytes: Uint8Array, expected: string): Promise<void> {
  const got = blobCidFromBytesSync(bytes)
  if (got !== expected) {
    throw new Error(`blob CID mismatch: expected ${expected} got ${got}`)
  }
}
