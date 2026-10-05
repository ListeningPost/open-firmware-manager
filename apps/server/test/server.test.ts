import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  IotDeviceAgent,
  b64url,
  deviceFingerprint,
  fingerprintMnemonic,
  generateDeviceKeys,
  initFactoryProfile,
  signDevicePayload,
  verifyJobSignature,
  type DeviceKeyMaterial,
} from '@open-firmware/iot'
import { createControlPlane, type ControlPlaneOptions } from '../src/app.js'
import { FileStore } from '../src/store.js'

const ADMIN = 'test-admin-token'
const admin = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }

let dir: string
let storeFile: string
let store: FileStore
let server: http.Server | undefined
let base: string

/** Serve the handler on an ephemeral loopback port inside this process. */
async function start(opts: Partial<ControlPlaneOptions> = {}): Promise<void> {
  if (server) await new Promise((r) => server!.close(r))
  server = http.createServer(createControlPlane({ store, ...opts }))
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function call(
  method: string,
  p: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON keeps assertions readable
): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(base + p, {
    method,
    headers: opts.headers,
    body:
      opts.body === undefined
        ? undefined
        : typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers }
}

interface TestDevice {
  product: string
  serial: string
  keys: DeviceKeyMaterial
  fingerprint: string
}

function newDevice(serial = 'SN-1'): TestDevice {
  const keys = generateDeviceKeys()
  return {
    product: 'camera-x1',
    serial,
    keys,
    fingerprint: deviceFingerprint('camera-x1', keys.ed25519PublicKey),
  }
}

/** A join body signed the way the agent signs it; `over` is applied before signing. */
function joinBody(dev: TestDevice, over: Record<string, unknown> = {}) {
  const body = {
    product: dev.product,
    serial: dev.serial,
    fingerprint: dev.fingerprint,
    mnemonic: fingerprintMnemonic(dev.fingerprint),
    ed25519PublicKey: dev.keys.ed25519PublicKey,
    x25519PublicKey: dev.keys.x25519PublicKey,
    agentVersion: '0.1.0',
    createdAt: new Date().toISOString(),
    ...over,
  }
  const signature = signDevicePayload(dev.keys.ed25519PrivateKeyPem, JSON.stringify(body))
  return { ...body, signature }
}

function deviceHeaders(
  dev: TestDevice,
  method: string,
  p: string,
  over: { ts?: string; nonce?: string; status?: string; keyPem?: string } = {},
): Record<string, string> {
  const ts = over.ts ?? String(Date.now())
  const nonce = over.nonce ?? b64url(Buffer.from(`${Math.random()}-nonce-pad-xx`))
  let payload = `${method} ${p}|${dev.fingerprint}|${ts}|${nonce}`
  if (over.status !== undefined) payload += `|${over.status}`
  return {
    'content-type': 'application/json',
    'x-ofw-fingerprint': dev.fingerprint,
    'x-ofw-timestamp': ts,
    'x-ofw-nonce': nonce,
    'x-ofw-signature': signDevicePayload(over.keyPem ?? dev.keys.ed25519PrivateKeyPem, payload),
  }
}

async function enroll(dev: TestDevice): Promise<string> {
  const j = await call('POST', '/v1/join', { body: joinBody(dev) })
  expect(j.status).toBe(201)
  const a = await call('POST', `/v1/join-requests/${j.json.id}/approve`, { headers: admin })
  expect(a.status).toBe(200)
  return j.json.id
}

async function issuePassword(dev: TestDevice, password = 'new-pass'): Promise<string> {
  const r = await call('POST', '/v1/jobs', {
    headers: admin,
    body: { fingerprint: dev.fingerprint, kind: 'credential.set', payload: { password } },
  })
  expect(r.status).toBe(201)
  return r.json.id
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ofw-server-'))
  storeFile = path.join(dir, 'store.json')
  store = new FileStore(storeFile, { adminToken: ADMIN })
  await start()
})

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  server = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('public endpoints', () => {
  it('healthz answers without auth', async () => {
    expect((await call('GET', '/healthz')).json).toEqual({ ok: true })
  })

  it('/v1/meta never reveals the admin token, even with OFW_REVEAL_ADMIN_TOKEN=1', async () => {
    process.env.OFW_REVEAL_ADMIN_TOKEN = '1'
    try {
      const r = await call('GET', '/v1/meta')
      expect(r.status).toBe(200)
      expect(JSON.stringify(r.json)).not.toContain(ADMIN)
      expect(r.json).not.toHaveProperty('adminToken')
      expect(r.json.controlPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    } finally {
      delete process.env.OFW_REVEAL_ADMIN_TOKEN
    }
  })

  it('sends no CORS headers unless an origin is configured', async () => {
    const off = await call('GET', '/healthz', { headers: { origin: 'https://evil.example' } })
    expect(off.headers.get('access-control-allow-origin')).toBeNull()

    await start({ corsOrigin: 'https://admin.example' })
    const on = await call('GET', '/healthz', { headers: { origin: 'https://evil.example' } })
    expect(on.headers.get('access-control-allow-origin')).toBe('https://admin.example')
  })

  it('unknown routes are 404', async () => {
    expect((await call('GET', '/v1/nope')).status).toBe(404)
  })
})

describe('admin auth', () => {
  const adminRoutes: Array<[string, string]> = [
    ['GET', '/v1/join-requests'],
    ['POST', '/v1/join-requests/join_x/approve'],
    ['POST', '/v1/join-requests/join_x/deny'],
    ['GET', '/v1/devices'],
    ['GET', '/v1/jobs'],
    ['POST', '/v1/jobs'],
  ]

  it.each(adminRoutes)('%s %s requires the admin token', async (method, p) => {
    expect((await call(method, p)).status).toBe(401)
    const wrong = await call(method, p, { headers: { authorization: 'Bearer wrong-token' } })
    expect(wrong.status).toBe(401)
    const empty = await call(method, p, { headers: { authorization: 'Bearer ' } })
    expect(empty.status).toBe(401)
  })

  it('the env/option token wins over the token already in the store', async () => {
    const file = path.join(dir, 'old.json')
    await writeFile(file, JSON.stringify({ adminToken: 'stored-old-token' }))
    store = new FileStore(file, { adminToken: 'env-new-token' })
    await start()
    const old = await call('GET', '/v1/devices', {
      headers: { authorization: 'Bearer stored-old-token' },
    })
    expect(old.status).toBe(401)
    const cur = await call('GET', '/v1/devices', {
      headers: { authorization: 'Bearer env-new-token' },
    })
    expect(cur.status).toBe(200)
  })
})

describe('store', () => {
  it.skipIf(process.platform === 'win32')('is written owner-only', async () => {
    await store.load()
    expect((await stat(storeFile)).mode & 0o777).toBe(0o600)
  })

  it('persists the job-signing key across restarts', async () => {
    const first = (await store.load()).controlKey.ed25519PublicKey
    const again = new FileStore(storeFile, { adminToken: ADMIN })
    expect((await again.load()).controlKey.ed25519PublicKey).toBe(first)
  })

  it('adds a signing key to a store written by an older version', async () => {
    const file = path.join(dir, 'legacy.json')
    await writeFile(file, JSON.stringify({ joins: [], enrollments: [], jobs: [], adminToken: 't' }))
    const data = await new FileStore(file, { adminToken: '' }).load()
    expect(data.adminToken).toBe('t')
    expect(data.controlKey.ed25519PublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('POST /v1/join', () => {
  it('accepts a signed join and derives the mnemonic from the key, not the client', async () => {
    const dev = newDevice()
    const r = await call('POST', '/v1/join', {
      body: joinBody(dev, { mnemonic: 'totally-spoofed-sticker-words-here-ok' }),
    })
    expect(r.status).toBe(201)
    const list = await call('GET', '/v1/join-requests', { headers: admin })
    expect(list.json.joins).toHaveLength(1)
    expect(list.json.joins[0].mnemonic).toBe(fingerprintMnemonic(dev.fingerprint))
    expect(list.json.joins[0].status).toBe('pending')
  })

  it('is idempotent for a device that is already pending', async () => {
    const dev = newDevice()
    const a = await call('POST', '/v1/join', { body: joinBody(dev) })
    const b = await call('POST', '/v1/join', { body: joinBody(dev) })
    expect(b.status).toBe(200)
    expect(b.json.id).toBe(a.json.id)
  })

  it('rejects a bad signature', async () => {
    const dev = newDevice()
    const body = joinBody(dev)
    const r = await call('POST', '/v1/join', { body: { ...body, serial: 'SN-OTHER' } })
    expect(r.status).toBe(401)
  })

  it('rejects a fingerprint that does not belong to the submitted key', async () => {
    const dev = newDevice()
    const r = await call('POST', '/v1/join', {
      body: joinBody(dev, { fingerprint: newDevice().fingerprint }),
    })
    expect(r.status).toBe(400)
  })

  it('rejects a stale createdAt (captured join replayed later)', async () => {
    const dev = newDevice()
    const r = await call('POST', '/v1/join', {
      body: joinBody(dev, { createdAt: new Date(Date.now() - 3_600_000).toISOString() }),
    })
    expect(r.status).toBe(400)
  })

  it.each([
    ['missing key', { ed25519PublicKey: undefined }],
    ['short key', { x25519PublicKey: 'abc' }],
    ['non-string product', { product: 42 }],
    ['oversized serial', { serial: 'S'.repeat(65) }],
    ['markup in serial', { serial: '<script>alert(1)</script>' }],
    ['non-hex fingerprint', { fingerprint: 'z'.repeat(64) }],
    ['huge mnemonic', { mnemonic: 'm'.repeat(200) }],
  ])('rejects invalid fields: %s', async (_name, over) => {
    const body = { ...joinBody(newDevice()), ...over }
    expect((await call('POST', '/v1/join', { body })).status).toBe(400)
  })

  it('rejects non-JSON and non-object bodies', async () => {
    expect((await call('POST', '/v1/join', { body: '{not json' })).status).toBe(400)
    expect((await call('POST', '/v1/join', { body: '[1,2]' })).status).toBe(400)
  })

  it('caps pending joins', async () => {
    await start({ maxPendingJoins: 2 })
    expect((await call('POST', '/v1/join', { body: joinBody(newDevice('A')) })).status).toBe(201)
    expect((await call('POST', '/v1/join', { body: joinBody(newDevice('B')) })).status).toBe(201)
    const third = await call('POST', '/v1/join', { body: joinBody(newDevice('C')) })
    expect(third.status).toBe(429)
    const list = await call('GET', '/v1/join-requests', { headers: admin })
    expect(list.json.joins).toHaveLength(2)
  })

  it('rejects an oversized body with 413', async () => {
    await start({ maxBodyBytes: 1024 })
    const r = await call('POST', '/v1/join', {
      body: { ...joinBody(newDevice()), pad: 'x'.repeat(4096) },
    })
    expect(r.status).toBe(413)
    const list = await call('GET', '/v1/join-requests', { headers: admin })
    expect(list.json.joins).toHaveLength(0)
  })
})

describe('join approval', () => {
  it('approves a pending join exactly once', async () => {
    const dev = newDevice()
    const id = await enroll(dev)
    const again = await call('POST', `/v1/join-requests/${id}/approve`, { headers: admin })
    expect(again.status).toBe(409)
    const devices = await call('GET', '/v1/devices', { headers: admin })
    expect(devices.json.devices).toHaveLength(1)
    expect(devices.json.devices[0]).toMatchObject({ fingerprint: dev.fingerprint, status: 'active' })
  })

  it('cannot approve a denied join', async () => {
    const j = await call('POST', '/v1/join', { body: joinBody(newDevice()) })
    expect((await call('POST', `/v1/join-requests/${j.json.id}/deny`, { headers: admin })).status).toBe(200)
    const r = await call('POST', `/v1/join-requests/${j.json.id}/approve`, { headers: admin })
    expect(r.status).toBe(409)
    expect((await call('GET', '/v1/devices', { headers: admin })).json.devices).toHaveLength(0)
  })

  it('cannot approve an expired join', async () => {
    let t = Date.now()
    await start({ now: () => t, joinTtlMs: 60_000 })
    const j = await call('POST', '/v1/join', { body: joinBody(newDevice()) })
    t += 120_000
    const r = await call('POST', `/v1/join-requests/${j.json.id}/approve`, { headers: admin })
    expect(r.status).toBe(409)
  })

  it('404s an unknown join id', async () => {
    const r = await call('POST', '/v1/join-requests/join_nope/approve', { headers: admin })
    expect(r.status).toBe(404)
  })

  it('by-fingerprint reports enrollment and the key to pin', async () => {
    const dev = newDevice()
    const before = await call('GET', `/v1/devices/by-fingerprint/${dev.fingerprint}`)
    expect(before.json).toEqual({ enrolled: false })
    await enroll(dev)
    const after = await call('GET', `/v1/devices/by-fingerprint/${dev.fingerprint}`)
    const meta = await call('GET', '/v1/meta')
    expect(after.json).toMatchObject({
      enrolled: true,
      controlPublicKey: meta.json.controlPublicKey,
    })
  })
})

describe('jobs', () => {
  it('refuses jobs for a device that is not enrolled', async () => {
    const r = await call('POST', '/v1/jobs', {
      headers: admin,
      body: { fingerprint: newDevice().fingerprint, kind: 'credential.set', payload: { password: 'x' } },
    })
    expect(r.status).toBe(404)
  })

  it('validates job requests', async () => {
    const dev = newDevice()
    await enroll(dev)
    const post = (body: unknown) => call('POST', '/v1/jobs', { headers: admin, body })
    const fp = dev.fingerprint
    expect((await post({ fingerprint: fp, kind: 'firmware.apply', payload: {} })).status).toBe(400)
    expect(
      (await post({ fingerprint: fp, kind: 'x.y', payload: { firmwareBase64: 'YQ==' } })).status,
    ).toBe(400)
    expect((await post({ fingerprint: fp, kind: 'credential.set', payload: {} })).status).toBe(400)
    expect((await post({ fingerprint: fp, kind: 'firmware.offer', payload: {} })).status).toBe(400)
    expect((await post({ fingerprint: fp, kind: 'Not A Kind', payload: {} })).status).toBe(400)
    expect((await post({ kind: 'credential.set', payload: { password: 'x' } })).status).toBe(400)
  })

  it('delivers jobs signed by the control key and bound to device, id, kind and issuedAt', async () => {
    const dev = newDevice()
    await enroll(dev)
    const id = await issuePassword(dev)
    const p = '/v1/devices/me/jobs'
    const r = await call('GET', p, { headers: deviceHeaders(dev, 'GET', p) })
    expect(r.status).toBe(200)
    expect(r.json.jobs).toHaveLength(1)
    const job = r.json.jobs[0]
    expect(job.id).toBe(id)

    const key = (await call('GET', '/v1/meta')).json.controlPublicKey
    const fields = {
      fingerprint: dev.fingerprint,
      jobId: job.id,
      kind: job.kind,
      issuedAt: job.issuedAt,
      sealed: job.sealed,
    }
    expect(verifyJobSignature(key, fields, job.signature)).toBe(true)
    expect(verifyJobSignature(key, { ...fields, fingerprint: 'f'.repeat(64) }, job.signature)).toBe(false)
    expect(verifyJobSignature(key, { ...fields, kind: 'credential.rotate' }, job.signature)).toBe(false)
  })

  it('admin job listing omits sealed payloads', async () => {
    const dev = newDevice()
    await enroll(dev)
    await issuePassword(dev)
    const r = await call('GET', '/v1/jobs', { headers: admin })
    expect(r.json.jobs).toHaveLength(1)
    expect(r.json.jobs[0]).not.toHaveProperty('sealed')
    expect(r.json.jobs[0]).toMatchObject({ kind: 'credential.set', status: 'pending' })
  })
})

describe('device auth', () => {
  const p = '/v1/devices/me/jobs'
  let dev: TestDevice

  beforeEach(async () => {
    dev = newDevice()
    await enroll(dev)
  })

  it('rejects requests without device headers', async () => {
    expect((await call('GET', p)).status).toBe(401)
    expect((await call('GET', `${p}?fingerprint=${dev.fingerprint}`)).status).toBe(401)
  })

  it('rejects a signature from another key', async () => {
    const h = deviceHeaders(dev, 'GET', p, { keyPem: generateDeviceKeys().ed25519PrivateKeyPem })
    expect((await call('GET', p, { headers: h })).status).toBe(401)
  })

  it('rejects a device that is not enrolled', async () => {
    const stranger = newDevice('SN-2')
    const r = await call('GET', p, { headers: deviceHeaders(stranger, 'GET', p) })
    expect(r.status).toBe(401)
  })

  it('rejects a timestamp outside the skew window', async () => {
    const h = deviceHeaders(dev, 'GET', p, { ts: String(Date.now() - 10 * 60 * 1000) })
    expect((await call('GET', p, { headers: h })).status).toBe(401)
  })

  it('rejects a request without a nonce', async () => {
    const { 'x-ofw-nonce': _n, ...h } = deviceHeaders(dev, 'GET', p)
    expect((await call('GET', p, { headers: h })).status).toBe(401)
  })

  it('rejects a replayed signature inside the skew window', async () => {
    const h = deviceHeaders(dev, 'GET', p)
    expect((await call('GET', p, { headers: h })).status).toBe(200)
    const replay = await call('GET', p, { headers: h })
    expect(replay.status).toBe(401)
    expect(replay.json.error).toMatch(/replay/)
  })

  it('a signature for one route is not valid on another', async () => {
    const id = await issuePassword(dev)
    const h = deviceHeaders(dev, 'GET', p)
    const r = await call('POST', `/v1/jobs/${id}/ack`, { headers: h, body: { status: 'ok' } })
    expect(r.status).toBe(401)
  })

  it('acks are authenticated, bound to the status, and accepted once', async () => {
    const id = await issuePassword(dev)
    const ackPath = `/v1/jobs/${id}/ack`

    // Signed for "failed" but sent as "ok".
    const mismatched = await call('POST', ackPath, {
      headers: deviceHeaders(dev, 'POST', ackPath, { status: 'failed' }),
      body: { status: 'ok' },
    })
    expect(mismatched.status).toBe(401)

    // Another enrolled device cannot ack this device's job.
    const other = newDevice('SN-3')
    await enroll(other)
    const foreign = await call('POST', ackPath, {
      headers: deviceHeaders(other, 'POST', ackPath, { status: 'ok' }),
      body: { status: 'ok' },
    })
    expect(foreign.status).toBe(404)

    const ok = await call('POST', ackPath, {
      headers: deviceHeaders(dev, 'POST', ackPath, { status: 'ok' }),
      body: { status: 'ok' },
    })
    expect(ok.status).toBe(200)
    const twice = await call('POST', ackPath, {
      headers: deviceHeaders(dev, 'POST', ackPath, { status: 'ok' }),
      body: { status: 'ok' },
    })
    expect(twice.status).toBe(409)

    const jobs = await call('GET', '/v1/jobs', { headers: admin })
    expect(jobs.json.jobs[0].status).toBe('acked_ok')
  })
})

describe('end to end with the real device agent', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ofw-server-dev-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('join, approve, pin, signed job applied, offer reported unsupported', async () => {
    const meta = await call('GET', '/v1/meta')
    const profile = await initFactoryProfile(root, {
      product: 'camera-x1',
      serial: 'SN-E2E',
      factorySecret: 'test-secret',
      controlEndpoint: base,
      controlPublicKey: meta.json.controlPublicKey,
    })
    const agent = new IotDeviceAgent(root)
    const { joinId } = await agent.requestJoin()
    expect((await agent.refreshEnrollment()).enrolled).toBe(false)
    await call('POST', `/v1/join-requests/${joinId}/approve`, { headers: admin })
    expect((await agent.refreshEnrollment()).enrolled).toBe(true)

    const dev = { fingerprint: profile.fingerprint } as TestDevice
    const pwJob = await issuePassword(dev, 'rotated-1')
    expect(await agent.pullAndApplyJobs()).toEqual([pwJob])
    expect((await agent.state()).password).toBe('rotated-1')
    expect(await agent.pullAndApplyJobs()).toEqual([])

    const offer = await call('POST', '/v1/jobs', {
      headers: admin,
      body: {
        fingerprint: profile.fingerprint,
        kind: 'firmware.offer',
        payload: { releaseUri: 'at://did:plc:x/r/1', imageSha256: 'ab'.repeat(32), version: '2.0.0' },
      },
    })
    const [res] = await agent.pullJobs()
    expect(res).toMatchObject({ id: offer.json.id, status: 'unsupported', acked: true })

    const jobs = (await call('GET', '/v1/jobs', { headers: admin })).json.jobs
    const byId = Object.fromEntries(jobs.map((j: { id: string; status: string }) => [j.id, j.status]))
    expect(byId[pwJob]).toBe('acked_ok')
    expect(byId[offer.json.id]).toBe('acked_unsupported')
  })

  it('a device pinned to a different control key refuses this server', async () => {
    const rogueStore = new FileStore(path.join(dir, 'rogue.json'), { adminToken: 'r' })
    const pinned = (await rogueStore.load()).controlKey.ed25519PublicKey
    await initFactoryProfile(root, {
      product: 'camera-x1',
      serial: 'SN-PIN',
      factorySecret: 'test-secret',
      controlEndpoint: base,
      controlPublicKey: pinned,
    })
    const agent = new IotDeviceAgent(root)
    const { joinId } = await agent.requestJoin()
    await call('POST', `/v1/join-requests/${joinId}/approve`, { headers: admin })
    await expect(agent.refreshEnrollment()).rejects.toThrow(/pinned key/)
    expect((await agent.state()).enrolled).toBe(false)
  })

  it('the store on disk never contains job plaintext', async () => {
    const dev = newDevice()
    await enroll(dev)
    await issuePassword(dev, 'super-secret-password-123')
    expect(await readFile(storeFile, 'utf8')).not.toContain('super-secret-password-123')
  })
})
