import { createHash } from 'node:crypto'

const SHA256_HEX = /^[a-f0-9]{64}$/i

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value)
}

export function sha256Hex(data: Uint8Array | Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function sha256HexEqual(a: string, b: string): boolean {
  if (!isSha256Hex(a) || !isSha256Hex(b)) return false
  const aa = a.toLowerCase()
  const bb = b.toLowerCase()
  if (aa.length !== bb.length) return false
  let out = 0
  for (let i = 0; i < aa.length; i++) {
    out |= aa.charCodeAt(i) ^ bb.charCodeAt(i)
  }
  return out === 0
}
