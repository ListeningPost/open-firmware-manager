import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import type { OemSignature, ReleaseMeta } from '../types/index.js'

export interface OemKeyPair {
  publicKey: string
  privateKeyPem: string
}

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

export function generateOemKey(): OemKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    publicKey: b64url(raw),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/**
 * Canonical bytes signed by the OEM key.
 * Independent of PDS CIDs so a repo rewrite cannot retarget the signature
 * without also knowing the OEM key.
 */
export function canonicalReleaseBytes(input: {
  product: string
  version: string
  channel: string
  imageSha256: string
  imageSize: number
}): Uint8Array {
  const line = `v1|${input.product}|${input.version}|${input.channel}|${input.imageSha256.toLowerCase()}|${input.imageSize}`
  return new TextEncoder().encode(line)
}

export function signRelease(
  privateKeyPem: string,
  input: {
    product: string
    version: string
    channel: string
    imageSha256: string
    imageSize: number
  },
  publicKey: string,
  keyId?: string,
): OemSignature {
  const key = createPrivateKey(privateKeyPem)
  const sig = sign(null, Buffer.from(canonicalReleaseBytes(input)), key)
  const out: OemSignature = {
    alg: 'ed25519',
    publicKey,
    sig: b64url(sig),
  }
  if (keyId) out.keyId = keyId
  return out
}

export function verifyOemSignature(
  release: Pick<
    ReleaseMeta,
    'product' | 'version' | 'channel' | 'imageSha256' | 'imageSize' | 'oemSignature'
  >,
  trustedKeys: string[],
): { ok: boolean; reason?: string } {
  const sig = release.oemSignature
  if (!sig) return { ok: false, reason: 'missing oemSignature' }
  if (sig.alg !== 'ed25519') return { ok: false, reason: `unsupported alg ${sig.alg}` }
  if (trustedKeys.length > 0 && !trustedKeys.includes(sig.publicKey)) {
    return { ok: false, reason: 'oem public key is not in trustedOemKeys' }
  }
  try {
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
    const raw = fromB64url(sig.publicKey)
    if (raw.length !== 32) return { ok: false, reason: 'oem public key must be 32 bytes' }
    const key = createPublicKey({
      key: Buffer.concat([spkiPrefix, raw]),
      format: 'der',
      type: 'spki',
    })
    const ok = verify(
      null,
      Buffer.from(canonicalReleaseBytes(release)),
      key,
      fromB64url(sig.sig),
    )
    return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'verify failed' }
  }
}
