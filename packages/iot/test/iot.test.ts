import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  factoryReset,
  fingerprintMnemonic,
  generateDeviceKeys,
  initFactoryProfile,
  loadFactoryProfile,
  loadUserState,
  openSealed,
  sealForDevice,
  deviceFingerprint,
} from '../src/index.js'

describe('@open-firmware/iot', () => {
  it('generates stable fingerprint and mnemonic', () => {
    const keys = generateDeviceKeys()
    const fp1 = deviceFingerprint('camera-x1', keys.ed25519PublicKey)
    const fp2 = deviceFingerprint('camera-x1', keys.ed25519PublicKey)
    expect(fp1).toBe(fp2)
    expect(fp1).toHaveLength(64)
    const m = fingerprintMnemonic(fp1)
    expect(m.split('-')).toHaveLength(6)
  })

  it('seals and opens jobs for device', () => {
    const keys = generateDeviceKeys()
    const env = sealForDevice(keys.x25519PublicKey, JSON.stringify({ password: 's3cret' }))
    const plain = openSealed(keys.x25519PrivateKeyPem, env)
    expect(JSON.parse(plain.toString()).password).toBe('s3cret')
  })

  it('factory reset restores defaults and keeps fingerprint', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ofw-iot-'))
    try {
      const profile = await initFactoryProfile(root, {
        product: 'camera-x1',
        serial: 'EMU-001',
        factorySecret: 'secret',
      })
      const state = await loadUserState(root)
      state.password = 'changed'
      state.passwordRotated = true
      state.enrolled = true
      state.firmwareVersion = '9.9.9'
      const { saveUserState } = await import('../src/factory.js')
      await saveUserState(root, state)

      const { profile: p2, state: s2 } = await factoryReset(root)
      expect(p2.fingerprint).toBe(profile.fingerprint)
      expect(s2.password).toBe(profile.defaultPassword)
      expect(s2.enrolled).toBe(false)
      expect(s2.firmwareVersion).toBe('0.0.0')
      expect(s2.status).toBe('awaiting_enrollment')

      const again = await loadFactoryProfile(root)
      expect(again.fingerprint).toBe(profile.fingerprint)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
