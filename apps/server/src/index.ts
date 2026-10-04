/**
 * Private control plane for Open Firmware fleet management.
 * Public AT is for releases/identity; secrets go through sealed jobs here.
 */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { FileStore, newId, type JoinRequest, type JobRecord } from './store.js'
import {
  deviceFingerprint,
  sealForDevice,
  verifyDevicePayload,
} from '@open-firmware/iot'

const PORT = Number(process.env.PORT || 8787)
const DATA_FILE = process.env.DATA_FILE || '/data/control-store.json'
const ALLOW_ORIGIN = process.env.OFW_CORS_ORIGIN || '*'
const MAX_SKEW_MS = Number(process.env.OFW_AUTH_SKEW_MS || 5 * 60 * 1000)
const store = new FileStore(DATA_FILE)

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-headers':
      'content-type, authorization, x-ofw-fingerprint, x-ofw-timestamp, x-ofw-signature',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(JSON.stringify(body, null, 2))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function requireAdmin(req: http.IncomingMessage, adminToken: string): boolean {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  return token.length > 0 && adminToken.length > 0 && safeEqual(token, adminToken)
}

function timestampFresh(ts: string): boolean {
  const n = Number(ts)
  if (!Number.isFinite(n)) return false
  return Math.abs(Date.now() - n) <= MAX_SKEW_MS
}

async function verifyDevice(
  req: http.IncomingMessage,
  method: string,
  path: string,
  bodyStatus?: string,
): Promise<{ fingerprint: string } | null> {
  const fingerprint = String(req.headers['x-ofw-fingerprint'] || '')
  const ts = String(req.headers['x-ofw-timestamp'] || '')
  const sig = String(req.headers['x-ofw-signature'] || '')
  if (!fingerprint || !ts || !sig) return null
  if (!timestampFresh(ts)) return null
  const data = await store.load()
  const enr = data.enrollments.find(
    (e) => e.fingerprint === fingerprint && e.status === 'active',
  )
  const pub = enr?.ed25519PublicKey
  if (!pub) return null
  const payload =
    bodyStatus !== undefined
      ? `${method} ${path}|${fingerprint}|${ts}|${bodyStatus}`
      : `${method} ${path}|${fingerprint}|${ts}`
  if (!verifyDevicePayload(pub, payload, sig)) return null
  return { fingerprint }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  if (req.method === 'OPTIONS') {
    return json(res, 204, {})
  }

  try {
    const data = await store.load()

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true })
    }

    if (req.method === 'GET' && url.pathname === '/v1/meta') {
      return json(res, 200, {
        adminTokenHint: 'set Authorization: Bearer <OFW_ADMIN_TOKEN>',
        adminToken: process.env.OFW_REVEAL_ADMIN_TOKEN === '1' ? data.adminToken : undefined,
        joins: data.joins.length,
        enrollments: data.enrollments.length,
        jobs: data.jobs.length,
      })
    }

    // Device: join request
    if (req.method === 'POST' && url.pathname === '/v1/join') {
      const body = JSON.parse(await readBody(req)) as {
        product: string
        serial: string
        fingerprint: string
        mnemonic: string
        ed25519PublicKey: string
        x25519PublicKey: string
        agentVersion: string
        createdAt: string
        signature: string
      }
      const payload = JSON.stringify({
        product: body.product,
        serial: body.serial,
        fingerprint: body.fingerprint,
        mnemonic: body.mnemonic,
        ed25519PublicKey: body.ed25519PublicKey,
        x25519PublicKey: body.x25519PublicKey,
        agentVersion: body.agentVersion,
        createdAt: body.createdAt,
      })
      if (
        !verifyDevicePayload(body.ed25519PublicKey, payload, body.signature)
      ) {
        return json(res, 401, { error: 'invalid signature' })
      }
      const expectedFp = deviceFingerprint(body.product, body.ed25519PublicKey)
      if (expectedFp !== body.fingerprint) {
        return json(res, 400, { error: 'fingerprint does not match product|publicKey' })
      }
      const existing = data.joins.find(
        (j) => j.fingerprint === body.fingerprint && j.status === 'pending',
      )
      if (existing) {
        return json(res, 200, { id: existing.id, status: existing.status })
      }
      const join: JoinRequest = {
        id: newId('join'),
        product: body.product,
        serial: body.serial,
        fingerprint: body.fingerprint,
        mnemonic: body.mnemonic,
        ed25519PublicKey: body.ed25519PublicKey,
        x25519PublicKey: body.x25519PublicKey,
        agentVersion: body.agentVersion,
        createdAt: body.createdAt,
        status: 'pending',
      }
      await store.update((d) => {
        d.joins.unshift(join)
      })
      return json(res, 201, { id: join.id, status: 'pending' })
    }

    // Admin: list pending joins
    if (req.method === 'GET' && url.pathname === '/v1/join-requests') {
      if (!requireAdmin(req, data.adminToken)) {
        return json(res, 401, { error: 'admin token required' })
      }
      const status = url.searchParams.get('status') || 'pending'
      const list = data.joins.filter((j) =>
        status === 'all' ? true : j.status === status,
      )
      return json(res, 200, { joins: list })
    }

    // Admin: approve
    if (
      req.method === 'POST' &&
      url.pathname.startsWith('/v1/join-requests/') &&
      url.pathname.endsWith('/approve')
    ) {
      if (!requireAdmin(req, data.adminToken)) {
        return json(res, 401, { error: 'admin token required' })
      }
      const id = url.pathname.split('/')[3]
      let enrollmentId = ''
      await store.update((d) => {
        const j = d.joins.find((x) => x.id === id)
        if (!j) throw new Error('not found')
        j.status = 'approved'
        j.approvedAt = new Date().toISOString()
        // re-activate if previously enrolled same fingerprint
        d.enrollments = d.enrollments.filter((e) => e.fingerprint !== j.fingerprint)
        const enr = {
          id: newId('enr'),
          fingerprint: j.fingerprint,
          product: j.product,
          serial: j.serial,
          ed25519PublicKey: j.ed25519PublicKey,
          x25519PublicKey: j.x25519PublicKey,
          status: 'active' as const,
          labels: [],
          createdAt: new Date().toISOString(),
        }
        j.enrollmentId = enr.id
        enrollmentId = enr.id
        d.enrollments.push(enr)
      })
      return json(res, 200, { ok: true, enrollmentId })
    }

    // Admin: deny
    if (
      req.method === 'POST' &&
      url.pathname.startsWith('/v1/join-requests/') &&
      url.pathname.endsWith('/deny')
    ) {
      if (!requireAdmin(req, data.adminToken)) {
        return json(res, 401, { error: 'admin token required' })
      }
      const id = url.pathname.split('/')[3]
      await store.update((d) => {
        const j = d.joins.find((x) => x.id === id)
        if (!j) throw new Error('not found')
        j.status = 'denied'
        j.deniedAt = new Date().toISOString()
      })
      return json(res, 200, { ok: true })
    }

    // Public-ish: device lookup by fingerprint
    if (req.method === 'GET' && url.pathname.startsWith('/v1/devices/by-fingerprint/')) {
      const fp = decodeURIComponent(url.pathname.slice('/v1/devices/by-fingerprint/'.length))
      const enr = data.enrollments.find((e) => e.fingerprint === fp)
      if (!enr) {
        return json(res, 200, { enrolled: false })
      }
      return json(res, 200, {
        enrolled: enr.status === 'active',
        enrollmentId: enr.id,
        status: enr.status,
      })
    }

    // Admin: list devices
    if (req.method === 'GET' && url.pathname === '/v1/devices') {
      if (!requireAdmin(req, data.adminToken)) {
        return json(res, 401, { error: 'admin token required' })
      }
      return json(res, 200, { devices: data.enrollments })
    }

    // Admin: create sealed job
    if (req.method === 'POST' && url.pathname === '/v1/jobs') {
      if (!requireAdmin(req, data.adminToken)) {
        return json(res, 401, { error: 'admin token required' })
      }
      const body = JSON.parse(await readBody(req)) as {
        fingerprint: string
        kind: string
        payload: Record<string, unknown>
      }
      if (body.kind === 'firmware.apply' || body.payload?.firmwareBase64) {
        return json(res, 400, {
          error:
            'unsigned firmware.apply is not allowed; use firmware.offer with a verified releaseUri',
        })
      }
      const enr = data.enrollments.find(
        (e) => e.fingerprint === body.fingerprint && e.status === 'active',
      )
      if (!enr) return json(res, 404, { error: 'device not enrolled' })
      const sealed = sealForDevice(
        enr.x25519PublicKey,
        JSON.stringify({ kind: body.kind, ...body.payload }),
      )
      const job: JobRecord = {
        id: newId('job'),
        fingerprint: body.fingerprint,
        kind: body.kind,
        sealed,
        status: 'pending',
        createdAt: new Date().toISOString(),
        summary: `${body.kind} for ${body.fingerprint.slice(0, 12)}…`,
      }
      await store.update((d) => {
        d.jobs.unshift(job)
      })
      return json(res, 201, { id: job.id, summary: job.summary })
    }

    // Admin: list jobs
    if (req.method === 'GET' && url.pathname === '/v1/jobs') {
      if (!requireAdmin(req, data.adminToken)) {
        return json(res, 401, { error: 'admin token required' })
      }
      const safe = data.jobs.map(({ sealed: _s, ...rest }) => rest)
      return json(res, 200, { jobs: safe })
    }

    // Device: pull pending jobs
    if (req.method === 'GET' && url.pathname === '/v1/devices/me/jobs') {
      const path = '/v1/devices/me/jobs'
      const auth = await verifyDevice(req, 'GET', path)
      if (!auth) return json(res, 401, { error: 'device auth failed' })
      const pending = data.jobs.filter(
        (j) => j.fingerprint === auth.fingerprint && j.status === 'pending',
      )
      return json(res, 200, {
        jobs: pending.map((j) => ({
          id: j.id,
          kind: j.kind,
          sealed: j.sealed,
          createdAt: j.createdAt,
        })),
      })
    }

    // Device: ack job
    if (
      req.method === 'POST' &&
      url.pathname.startsWith('/v1/jobs/') &&
      url.pathname.endsWith('/ack')
    ) {
      const id = url.pathname.split('/')[3]
      const body = JSON.parse(await readBody(req) || '{}') as {
        status: string
        error?: string
      }
      const status = body.status === 'ok' ? 'ok' : 'failed'
      const auth = await verifyDevice(
        req,
        'POST',
        `/v1/jobs/${id}/ack`,
        status,
      )
      if (!auth) return json(res, 401, { error: 'device auth failed' })
      await store.update((d) => {
        const j = d.jobs.find((x) => x.id === id)
        if (!j || j.fingerprint !== auth.fingerprint) throw new Error('not found')
        j.status = status === 'ok' ? 'acked_ok' : 'acked_failed'
        j.ackedAt = new Date().toISOString()
        if (body.error) j.error = body.error
      })
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'not found' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const code = msg === 'not found' ? 404 : 500
    return json(res, code, { error: msg })
  }
})

server.listen(PORT, async () => {
  const data = await store.load()
  console.log(`control plane listening on :${PORT}`)
  if (process.env.OFW_REVEAL_ADMIN_TOKEN === '1') {
    console.log(`admin token: ${data.adminToken}`)
  } else {
    console.log('admin token is set (OFW_REVEAL_ADMIN_TOKEN=1 to print)')
  }
})
