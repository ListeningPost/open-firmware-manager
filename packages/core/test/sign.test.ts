import { describe, expect, it } from 'vitest'
import { generateOemKey, signRelease, verifyOemSignature } from '../src/sign/index.js'

describe('OEM signatures', () => {
  it('round-trips', () => {
    const oem = generateOemKey()
    const meta = {
      product: 'cam',
      version: '1.2.3',
      channel: 'stable' as const,
      imageSha256: 'ab'.repeat(32),
      imageSize: 99,
    }
    const sig = signRelease(oem.privateKeyPem, meta, oem.publicKey, 'factory-1')
    const ok = verifyOemSignature({ ...meta, oemSignature: sig }, [oem.publicKey])
    expect(ok.ok).toBe(true)
  })

  it('fails when the image hash is retargeted', () => {
    const oem = generateOemKey()
    const meta = {
      product: 'cam',
      version: '1.2.3',
      channel: 'stable' as const,
      imageSha256: 'ab'.repeat(32),
      imageSize: 99,
    }
    const sig = signRelease(oem.privateKeyPem, meta, oem.publicKey)
    const bad = verifyOemSignature(
      { ...meta, imageSha256: 'cd'.repeat(32), oemSignature: sig },
      [oem.publicKey],
    )
    expect(bad.ok).toBe(false)
  })

  it('fails closed when no trusted keys are configured', () => {
    const oem = generateOemKey()
    const meta = {
      product: 'cam',
      version: '1.2.3',
      channel: 'stable' as const,
      imageSha256: 'ab'.repeat(32),
      imageSize: 99,
    }
    const sig = signRelease(oem.privateKeyPem, meta, oem.publicKey)
    const res = verifyOemSignature({ ...meta, oemSignature: sig }, [])
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/no trusted OEM keys/)
  })

  it('rejects a valid signature from a key that is not trusted', () => {
    const oem = generateOemKey()
    const attacker = generateOemKey()
    const meta = {
      product: 'cam',
      version: '1.2.3',
      channel: 'stable' as const,
      imageSha256: 'ab'.repeat(32),
      imageSize: 99,
    }
    const sig = signRelease(attacker.privateKeyPem, meta, attacker.publicKey)
    const res = verifyOemSignature({ ...meta, oemSignature: sig }, [oem.publicKey])
    expect(res.ok).toBe(false)
  })
})
