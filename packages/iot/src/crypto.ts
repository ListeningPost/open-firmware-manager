import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto'
import { WORDLIST } from './words.js'

export interface DeviceKeyMaterial {
  /** Raw 32-byte Ed25519 public key (base64url) */
  ed25519PublicKey: string
  /** PKCS8 PEM for Ed25519 private key */
  ed25519PrivateKeyPem: string
  /** Raw 32-byte X25519 public key (base64url) for sealing */
  x25519PublicKey: string
  /** PKCS8 PEM for X25519 private key */
  x25519PrivateKeyPem: string
}

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  return Buffer.from(b64, 'base64')
}

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function generateDeviceKeys(): DeviceKeyMaterial {
  const ed = generateKeyPairSync('ed25519')
  const x = generateKeyPairSync('x25519')
  const edPub = ed.publicKey.export({ type: 'spki', format: 'der' })
  // SPKI for ed25519: last 32 bytes are raw key
  const edRaw = edPub.subarray(edPub.length - 32)
  const xPub = x.publicKey.export({ type: 'spki', format: 'der' })
  const xRaw = xPub.subarray(xPub.length - 32)
  return {
    ed25519PublicKey: b64url(edRaw),
    ed25519PrivateKeyPem: ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    x25519PublicKey: b64url(xRaw),
    x25519PrivateKeyPem: x.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** Stable device fingerprint from product + public identity key. */
export function deviceFingerprint(product: string, ed25519PublicKey: string): string {
  return sha256Hex(`${product}|${ed25519PublicKey}`)
}

/** 6-word mnemonic from fingerprint (human sticker, not the private key). */
export function fingerprintMnemonic(fingerprintHex: string): string {
  const bytes = Buffer.from(fingerprintHex.slice(0, 32), 'hex')
  const words: string[] = []
  for (let i = 0; i < 6; i++) {
    const idx = bytes[i]! % WORDLIST.length
    words.push(WORDLIST[idx]!)
  }
  return words.join('-')
}

/** Per-device factory default password (reset-stable). */
export function factoryDefaultPassword(
  factorySecret: string,
  serial: string,
): string {
  return sha256Hex(`${factorySecret}|${serial}|ofw-factory`).slice(0, 16)
}

export function signDevicePayload(
  privateKeyPem: string,
  payload: string | Buffer,
): string {
  const key = createPrivateKey(privateKeyPem)
  const sig = sign(null, Buffer.from(payload), key)
  return b64url(sig)
}

export function verifyDevicePayload(
  ed25519PublicKeyB64: string,
  payload: string | Buffer,
  signatureB64: string,
): boolean {
  // Rebuild SPKI from raw 32-byte key
  const raw = fromB64url(ed25519PublicKeyB64)
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
  const der = Buffer.concat([spkiPrefix, raw])
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  return verify(null, Buffer.from(payload), key, fromB64url(signatureB64))
}

export interface SealedEnvelope {
  v: 1
  /** Ephemeral X25519 public key (base64url) */
  epk: string
  /** AES-GCM nonce */
  nonce: string
  /** Ciphertext + tag */
  ct: string
}

/**
 * Seal a JSON-serializable job so only the device X25519 private key can open it.
 * Hybrid: ephemeral X25519 ECDH → AES-256-GCM.
 */
export function sealForDevice(
  deviceX25519PublicKeyB64: string,
  plaintext: Buffer | string,
): SealedEnvelope {
  const eph = generateKeyPairSync('x25519')
  const raw = fromB64url(deviceX25519PublicKeyB64)
  const spkiPrefix = Buffer.from('302a300506032b656e032100', 'hex') // x25519 OID
  const theirPub = createPublicKey({
    key: Buffer.concat([spkiPrefix, raw]),
    format: 'der',
    type: 'spki',
  })
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: theirPub,
  })
  const key = createHash('sha256').update(shared).digest()
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const pt = Buffer.from(plaintext)
  const enc = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  const ephPubDer = eph.publicKey.export({ type: 'spki', format: 'der' })
  const ephRaw = ephPubDer.subarray(ephPubDer.length - 32)
  return {
    v: 1,
    epk: b64url(ephRaw),
    nonce: b64url(nonce),
    ct: b64url(Buffer.concat([enc, tag])),
  }
}

export function openSealed(
  deviceX25519PrivateKeyPem: string,
  envelope: SealedEnvelope,
): Buffer {
  const priv = createPrivateKey(deviceX25519PrivateKeyPem)
  const epkRaw = fromB64url(envelope.epk)
  const spkiPrefix = Buffer.from('302a300506032b656e032100', 'hex')
  const ephPub = createPublicKey({
    key: Buffer.concat([spkiPrefix, epkRaw]),
    format: 'der',
    type: 'spki',
  })
  const shared = diffieHellman({ privateKey: priv, publicKey: ephPub })
  const key = createHash('sha256').update(shared).digest()
  const nonce = fromB64url(envelope.nonce)
  const data = fromB64url(envelope.ct)
  const tag = data.subarray(data.length - 16)
  const enc = data.subarray(0, data.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()])
}
