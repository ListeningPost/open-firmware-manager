import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  IotDeviceAgent,
  devicePaths,
  factoryReset,
  generateControlSigningKey,
  generateDeviceKeys,
  initFactoryProfile,
  loadUserState,
  saveUserState,
  sealForDevice,
  signJob,
  verifyDevicePayload,
  type ControlSigningKey,
  type FactoryProfile,
  type FirmwareOffer,
  type SignedJob,
} from '../src/index.js'

/** Minimal stand-in for the control plane: serves a fixed job list, records acks. */
function fakeControl(jobs: () => unknown[]) {
  const acks: Array<{ id: string; status: string; error?: string }> = []
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ url: url.pathname, headers: (init?.headers ?? {}) as Record<string, string> })
    const ack = /^\/v1\/jobs\/([^/]+)\/ack$/.exec(url.pathname)
    if (ack) {
      acks.push({ id: ack[1]!, ...JSON.parse(String(init?.body)) })
      return new Response('{"ok":true}', { status: 200 })
    }
    if (url.pathname === '/v1/devices/me/jobs') {
      return new Response(JSON.stringify({ jobs: jobs() }), { status: 200 })
    }
    return new Response('{"error":"not found"}', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, acks, requests }
}

let seq = 0
function makeJob(
  control: ControlSigningKey,
  profile: FactoryProfile,
  payload: Record<string, unknown>,
  over: { kind?: string; fingerprint?: string; issuedAt?: string } = {},
): SignedJob {
  const kind = over.kind ?? String(payload.kind)
  const id = `job_${++seq}`
  const issuedAt = over.issuedAt ?? new Date(Date.now() + seq).toISOString()
  const sealed = sealForDevice(profile.keys.x25519PublicKey, JSON.stringify(payload))
  const signature = signJob(control.ed25519PrivateKeyPem, {
    fingerprint: over.fingerprint ?? profile.fingerprint,
    jobId: id,
    kind,
    issuedAt,
    sealed,
  })
  return { id, kind, issuedAt, sealed, signature }
}

describe('IotDeviceAgent job authentication', () => {
  let root: string
  let control: ControlSigningKey
  let profile: FactoryProfile

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ofw-agent-'))
    control = generateControlSigningKey()
    profile = await initFactoryProfile(root, {
      product: 'camera-x1',
      serial: 'EMU-T1',
      factorySecret: 'test-secret',
      controlPublicKey: control.ed25519PublicKey,
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const setPw = (password: string) => ({ kind: 'credential.set', password })

  it('applies a job signed by the pinned control plane and acks ok', async () => {
    const job = makeJob(control, profile, setPw('new-pass'))
    const { fetchImpl, acks, requests } = fakeControl(() => [job])
    const agent = new IotDeviceAgent(root, fetchImpl)

    expect(await agent.pullAndApplyJobs()).toEqual([job.id])
    expect((await agent.state()).password).toBe('new-pass')
    expect(acks).toEqual([{ id: job.id, status: 'ok' }])

    // Device requests carry a single-use nonce that is covered by the signature.
    const h = requests[0]!.headers
    expect(h['x-ofw-nonce']).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    const signed = `GET /v1/devices/me/jobs|${profile.fingerprint}|${h['x-ofw-timestamp']}|${h['x-ofw-nonce']}`
    expect(verifyDevicePayload(profile.keys.ed25519PublicKey, signed, h['x-ofw-signature']!)).toBe(true)
  })

  it('rejects an unsigned job (anonymous seal to the device key)', async () => {
    const sealed = sealForDevice(profile.keys.x25519PublicKey, JSON.stringify(setPw('x')))
    const unsigned = { id: 'job_evil', kind: 'credential.set', sealed }
    const { fetchImpl, acks } = fakeControl(() => [unsigned])
    const agent = new IotDeviceAgent(root, fetchImpl)

    const [r] = await agent.pullJobs()
    expect(r).toMatchObject({ status: 'failed', rejected: true, acked: false })
    expect(r!.error).toMatch(/not signed/)
    expect((await agent.state()).password).toBe(profile.defaultPassword)
    expect(acks).toEqual([])
    expect(await agent.pullAndApplyJobs()).toEqual([])
  })

  it('rejects a job signed by a different key', async () => {
    const attacker = generateControlSigningKey()
    const { fetchImpl, acks } = fakeControl(() => [makeJob(attacker, profile, setPw('x'))])
    const agent = new IotDeviceAgent(root, fetchImpl)

    const [r] = await agent.pullJobs()
    expect(r).toMatchObject({ status: 'failed', rejected: true })
    expect(r!.error).toMatch(/signature invalid/)
    expect((await agent.state()).password).toBe(profile.defaultPassword)
    expect(acks).toEqual([])
  })

  it('rejects a job the control plane signed for another device', async () => {
    const other = 'f'.repeat(64)
    const job = makeJob(control, profile, setPw('x'), { fingerprint: other })
    const agent = new IotDeviceAgent(root, fakeControl(() => [job]).fetchImpl)
    expect((await agent.pullJobs())[0]).toMatchObject({ rejected: true })
    expect((await agent.state()).password).toBe(profile.defaultPassword)
  })

  it('rejects tampered ciphertext, kind, id and issuedAt', async () => {
    const good = makeJob(control, profile, setPw('x'))
    const swapped = sealForDevice(profile.keys.x25519PublicKey, JSON.stringify(setPw('evil')))
    const flipped = Buffer.from(good.sealed.ct, 'base64url')
    flipped[0]! ^= 1
    const tampered = [
      { ...good, sealed: swapped },
      { ...good, sealed: { ...good.sealed, ct: flipped.toString('base64url') } },
      { ...good, kind: 'credential.rotate' },
      { ...good, id: 'job_other' },
      { ...good, issuedAt: new Date(Date.now() + 60_000).toISOString() },
    ]
    const { fetchImpl, acks } = fakeControl(() => tampered)
    const agent = new IotDeviceAgent(root, fetchImpl)

    const results = await agent.pullJobs()
    expect(results).toHaveLength(tampered.length)
    for (const r of results) expect(r).toMatchObject({ status: 'failed', rejected: true })
    expect((await agent.state()).password).toBe(profile.defaultPassword)
    expect(acks).toEqual([])
  })

  it('fails a job whose sealed kind differs from the signed kind', async () => {
    const job = makeJob(control, profile, setPw('x'), { kind: 'firmware.offer' })
    const agent = new IotDeviceAgent(root, fakeControl(() => [job]).fetchImpl)
    const [r] = await agent.pullJobs()
    expect(r!.status).toBe('failed')
    expect(r!.error).toMatch(/kind does not match/)
    expect((await agent.state()).password).toBe(profile.defaultPassword)
  })

  it('does not apply a replayed job twice', async () => {
    const job = makeJob(control, profile, setPw('from-job'))
    const { fetchImpl, acks } = fakeControl(() => [job])
    const agent = new IotDeviceAgent(root, fetchImpl)
    expect(await agent.pullAndApplyJobs()).toEqual([job.id])

    const state = await loadUserState(root)
    state.password = 'changed-locally'
    await saveUserState(root, state)

    const [r] = await agent.pullJobs()
    expect(r).toMatchObject({ status: 'ok', replayed: true })
    expect(await agent.pullAndApplyJobs()).toEqual([])
    expect((await agent.state()).password).toBe('changed-locally')
    // The original outcome is re-acked (covers a lost ack), never a new one.
    expect(acks.every((a) => a.status === 'ok')).toBe(true)
  })

  it('still refuses a replayed job after factory reset', async () => {
    const job = makeJob(control, profile, setPw('old-admin-pass'))
    const agent = new IotDeviceAgent(root, fakeControl(() => [job]).fetchImpl)
    await agent.pullAndApplyJobs()

    await factoryReset(root)
    expect(await agent.pullAndApplyJobs()).toEqual([])
    expect((await agent.state()).password).toBe(profile.defaultPassword)
  })

  it('refuses to pull jobs with no control-plane key pinned', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'ofw-agent-'))
    try {
      await initFactoryProfile(bare, { product: 'camera-x1', serial: 'S', factorySecret: 's' })
      const agent = new IotDeviceAgent(bare, fakeControl(() => []).fetchImpl)
      await expect(agent.pullJobs()).rejects.toThrow(/no control plane key pinned/)
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  describe('firmware.offer', () => {
    const offer = {
      kind: 'firmware.offer',
      version: '3.1.0',
      releaseUri: 'at://did:plc:test/app.openfirmware.firmware.release/x',
      cid: 'bafy',
      imageSha256: 'ab'.repeat(32),
    }

    it('reports unsupported — not ok — when no handler is wired', async () => {
      const job = makeJob(control, profile, offer)
      const { fetchImpl, acks } = fakeControl(() => [job])
      const agent = new IotDeviceAgent(root, fetchImpl)

      const [r] = await agent.pullJobs()
      expect(r).toMatchObject({ id: job.id, status: 'unsupported', acked: true })
      expect(acks[0]).toMatchObject({ id: job.id, status: 'unsupported' })
      expect((await agent.state()).firmwareVersion).toBe('0.0.0')
    })

    it('hands the offer to onFirmwareOffer and acks ok when it resolves', async () => {
      const seen: FirmwareOffer[] = []
      const job = makeJob(control, profile, offer)
      const { fetchImpl, acks } = fakeControl(() => [job])
      const agent: IotDeviceAgent = new IotDeviceAgent(root, fetchImpl, {
        onFirmwareOffer: async (o) => {
          seen.push(o)
          await agent.applyFirmwareBytes(Buffer.from('fw'), o.version!)
        },
      })

      expect(await agent.pullAndApplyJobs()).toEqual([job.id])
      const { kind: _k, ...expected } = offer
      expect(seen).toEqual([expected])
      expect(acks).toEqual([{ id: job.id, status: 'ok' }])
      expect((await agent.state()).firmwareVersion).toBe('3.1.0')
    })

    it('acks failed when the handler throws', async () => {
      const job = makeJob(control, profile, offer)
      const { fetchImpl, acks } = fakeControl(() => [job])
      const agent = new IotDeviceAgent(root, fetchImpl, {
        onFirmwareOffer: async () => {
          throw new Error('digest mismatch')
        },
      })
      expect(await agent.pullAndApplyJobs()).toEqual([])
      expect(acks).toEqual([{ id: job.id, status: 'failed', error: 'digest mismatch' }])
    })
  })
})

describe('control-plane key pinning at enrollment', () => {
  let root: string
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const enrollmentFetch = (controlPublicKey: string | undefined) =>
    (async () =>
      new Response(
        JSON.stringify({ enrolled: true, enrollmentId: 'enr_1', status: 'active', controlPublicKey }),
      )) as unknown as typeof fetch

  it('pins the key presented at first enrollment and refuses a different one later', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ofw-agent-'))
    await initFactoryProfile(root, { product: 'p', serial: 's', factorySecret: 'x' })
    const first = generateControlSigningKey().ed25519PublicKey

    const state = await new IotDeviceAgent(root, enrollmentFetch(first)).refreshEnrollment()
    expect(state).toMatchObject({ enrolled: true, controlPublicKey: first })

    const other = generateControlSigningKey().ed25519PublicKey
    await expect(
      new IotDeviceAgent(root, enrollmentFetch(other)).refreshEnrollment(),
    ).rejects.toThrow(/does not match the pinned key/)
  })

  it('refuses enrollment when the endpoint key differs from the factory pin', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ofw-agent-'))
    await initFactoryProfile(root, {
      product: 'p',
      serial: 's',
      factorySecret: 'x',
      controlPublicKey: generateControlSigningKey().ed25519PublicKey,
    })
    const rogue = generateControlSigningKey().ed25519PublicKey
    const agent = new IotDeviceAgent(root, enrollmentFetch(rogue))
    await expect(agent.refreshEnrollment()).rejects.toThrow(/does not match the pinned key/)
    expect((await agent.state()).enrolled).toBe(false)
  })

  it('refuses enrollment when no key is presented and none is pinned', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ofw-agent-'))
    await initFactoryProfile(root, { product: 'p', serial: 's', factorySecret: 'x' })
    const agent = new IotDeviceAgent(root, enrollmentFetch(undefined))
    await expect(agent.refreshEnrollment()).rejects.toThrow(/did not present/)
  })
})

describe('factory profile at rest', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ofw-agent-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('never persists the fleet factory secret, only what was derived from it', async () => {
    const secret = 'fleet-wide-secret-do-not-store'
    const profile = await initFactoryProfile(root, { product: 'p', serial: 's', factorySecret: secret })
    const paths = devicePaths(root)
    const onDisk = await readFile(paths.factoryProfile, 'utf8')
    expect(onDisk).not.toContain(secret)
    expect(JSON.parse(onDisk)).not.toHaveProperty('factorySecret')
    expect(profile.defaultPassword).toHaveLength(16)
    const { state } = await factoryReset(root)
    expect(state.password).toBe(profile.defaultPassword)
  })

  it.skipIf(process.platform === 'win32')('writes device state owner-only', async () => {
    await initFactoryProfile(root, { product: 'p', serial: 's', factorySecret: 'x' })
    const agent = new IotDeviceAgent(root)
    await agent.applyFirmwareBytes(Buffer.from('fw'), '1.0.0')
    await factoryReset(root)
    await agent.applyFirmwareBytes(Buffer.from('fw'), '1.0.0')
    const paths = devicePaths(root)
    for (const f of [paths.factoryProfile, paths.userState, paths.firmwareImage]) {
      expect((await stat(f)).mode & 0o777, f).toBe(0o600)
    }
    for (const d of [paths.factoryDir, paths.userDir]) {
      expect((await stat(d)).mode & 0o777, d).toBe(0o700)
    }
  })

  it('warns loudly when the default dev factory secret is used', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await initFactoryProfile(root, { product: 'p', serial: 's' })
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toMatch(/INSECURE DEFAULT FACTORY SECRET/)

    warn.mockClear()
    await initFactoryProfile(root, { product: 'p', serial: 's', factorySecret: 'real' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('generateDeviceKeys and control keys use the same raw encoding', () => {
    expect(generateControlSigningKey().ed25519PublicKey).toHaveLength(
      generateDeviceKeys().ed25519PublicKey.length,
    )
  })
})
