/**
 * Private control plane for Open Firmware fleet management.
 * Public AT is for releases/identity; secrets go through sealed jobs here.
 *
 * This module is the HTTP handler only (no listen, no env) so it can be
 * driven in-process by tests; see index.ts for the entrypoint.
 */
import type http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import {
  FileStore,
  newId,
  type JoinRequest,
  type JobRecord,
  type StoreData,
} from './store.js'
import {
  deviceFingerprint,
  fingerprintMnemonic,
  fromB64url,
  sealForDevice,
  signJob,
  verifyDevicePayload,
} from '@open-firmware/iot'

export interface ControlPlaneOptions {
  store: FileStore
  /** Value for Access-Control-Allow-Origin. Unset: no cross-origin access. */
  corsOrigin?: string
  /** Allowed clock skew for device-signed requests (default 5 minutes). */
  maxSkewMs?: number
  /** Largest accepted request body (default 64 KiB). */
  maxBodyBytes?: number
  /** Cap on unapproved join requests held at once (default 1000). */
  maxPendingJoins?: number
  /** Pending joins older than this can no longer be approved (default 24 h). */
  joinTtlMs?: number
  now?: () => number
}

/** Approved / denied / expired joins kept for the admin's history view. */
const MAX_JOIN_HISTORY = 500
const MAX_ACK_ERROR_CHARS = 500
const MAX_PASSWORD_CHARS = 256

const RE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const RE_FINGERPRINT = /^[0-9a-f]{64}$/
const RE_KEY = /^[A-Za-z0-9_-]{43}$/
const RE_SIGNATURE = /^[A-Za-z0-9_-]{86}$/
const RE_NONCE = /^[A-Za-z0-9_-]{16,64}$/
const RE_KIND = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/
const RE_ID = /^[A-Za-z0-9_-]{1,64}$/

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function isStr(v: unknown, re: RegExp): v is string {
  return typeof v === 'string' && re.test(v)
}

function isRawKey(v: unknown): v is string {
  return isStr(v, RE_KEY) && fromB64url(v).length === 32
}

export function createControlPlane(opts: ControlPlaneOptions): http.RequestListener {
  const { store } = opts
  const corsOrigin = opts.corsOrigin || ''
  const maxSkewMs = opts.maxSkewMs ?? 5 * 60 * 1000
  const maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024
  const maxPendingJoins = opts.maxPendingJoins ?? 1000
  const joinTtlMs = opts.joinTtlMs ?? 24 * 60 * 60 * 1000
  const now = opts.now ?? Date.now

  /** `fingerprint|nonce` → expiry (ms) for device signatures already used. */
  const usedNonces = new Map<string, number>()

  function send(res: http.ServerResponse, status: number, body?: unknown) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (corsOrigin) {
      headers['access-control-allow-origin'] = corsOrigin
      headers['access-control-allow-headers'] =
        'content-type, authorization, x-ofw-fingerprint, x-ofw-timestamp, x-ofw-nonce, x-ofw-signature'
      headers['access-control-allow-methods'] = 'GET,POST,OPTIONS'
      if (corsOrigin !== '*') headers['vary'] = 'origin'
    }
    res.writeHead(status, headers)
    res.end(body === undefined ? undefined : JSON.stringify(body, null, 2))
  }

  async function readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += (c as Buffer).length
      if (size <= maxBodyBytes) {
        chunks.push(c as Buffer)
      } else if (size > maxBodyBytes * 16) {
        // Drained enough to answer a merely-too-big client cleanly; stop here.
        req.destroy()
        throw new HttpError(413, 'request body too large')
      }
    }
    if (size > maxBodyBytes) throw new HttpError(413, 'request body too large')
    return Buffer.concat(chunks).toString('utf8')
  }

  async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const text = await readBody(req)
    let body: unknown
    try {
      body = JSON.parse(text || '{}')
    } catch {
      throw new HttpError(400, 'invalid JSON body')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'JSON object body required')
    }
    return body as Record<string, unknown>
  }

  function requireAdmin(req: http.IncomingMessage, data: StoreData): void {
    const h = req.headers.authorization || ''
    const token = h.startsWith('Bearer ') ? h.slice(7) : ''
    const ok =
      token.length > 0 && data.adminToken.length > 0 && safeEqual(token, data.adminToken)
    if (!ok) throw new HttpError(401, 'admin token required')
  }

  function joinExpired(j: JoinRequest): boolean {
    if (j.status !== 'pending') return false
    const at = Date.parse(j.receivedAt ?? j.createdAt)
    return !Number.isFinite(at) || now() - at > joinTtlMs
  }

  /** Expire stale pending joins and bound the history. Call inside store.update. */
  function sweepJoins(d: StoreData): void {
    for (const j of d.joins) if (joinExpired(j)) j.status = 'expired'
    let history = 0
    d.joins = d.joins.filter((j) => j.status === 'pending' || ++history <= MAX_JOIN_HISTORY)
  }

  /**
   * Authenticate a device-signed request: fresh timestamp, active enrollment,
   * valid signature, and a nonce that has not been used before.
   */
  function verifyDevice(
    req: http.IncomingMessage,
    data: StoreData,
    method: string,
    path: string,
    bodyStatus?: string,
  ): { fingerprint: string } {
    const fail = new HttpError(401, 'device auth failed')
    const fingerprint = req.headers['x-ofw-fingerprint']
    const ts = req.headers['x-ofw-timestamp']
    const nonce = req.headers['x-ofw-nonce']
    const sig = req.headers['x-ofw-signature']
    if (
      !isStr(fingerprint, RE_FINGERPRINT) ||
      !isStr(ts, /^\d{1,16}$/) ||
      !isStr(nonce, RE_NONCE) ||
      !isStr(sig, RE_SIGNATURE)
    ) {
      throw fail
    }
    const t = Number(ts)
    if (Math.abs(now() - t) > maxSkewMs) throw fail
    const enr = data.enrollments.find(
      (e) => e.fingerprint === fingerprint && e.status === 'active',
    )
    if (!enr) throw fail
    let payload = `${method} ${path}|${fingerprint}|${ts}|${nonce}`
    if (bodyStatus !== undefined) payload += `|${bodyStatus}`
    if (!verifyDevicePayload(enr.ed25519PublicKey, payload, sig)) throw fail

    // Only authenticated requests reach here, so strangers cannot fill the map.
    for (const [k, exp] of usedNonces) if (exp < now()) usedNonces.delete(k)
    const key = `${fingerprint}|${nonce}`
    if (usedNonces.has(key)) throw new HttpError(401, 'device auth failed: nonce replayed')
    usedNonces.set(key, t + maxSkewMs)
    return { fingerprint }
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', 'http://control.invalid')
    const { pathname } = url
    const method = req.method || 'GET'

    if (method === 'OPTIONS') return send(res, 204)

    if (method === 'GET' && pathname === '/healthz') {
      return send(res, 200, { ok: true })
    }

    const data = await store.load()

    if (method === 'GET' && pathname === '/v1/meta') {
      return send(res, 200, {
        adminTokenHint: 'set Authorization: Bearer <OFW_ADMIN_TOKEN>',
        // Public half of the job-signing key, for pinning at the factory.
        controlPublicKey: data.controlKey.ed25519PublicKey,
        joins: data.joins.length,
        enrollments: data.enrollments.length,
        jobs: data.jobs.length,
      })
    }

    // Device: join request
    if (method === 'POST' && pathname === '/v1/join') {
      const body = await readJson(req)
      if (
        !isStr(body.product, RE_LABEL) ||
        !isStr(body.serial, RE_LABEL) ||
        !isStr(body.fingerprint, RE_FINGERPRINT) ||
        typeof body.mnemonic !== 'string' ||
        body.mnemonic.length > 128 ||
        !isRawKey(body.ed25519PublicKey) ||
        !isRawKey(body.x25519PublicKey) ||
        !isStr(body.agentVersion, RE_LABEL) ||
        typeof body.createdAt !== 'string' ||
        body.createdAt.length > 40 ||
        !isStr(body.signature, RE_SIGNATURE)
      ) {
        throw new HttpError(400, 'invalid join request fields')
      }
      const { product, serial, fingerprint, ed25519PublicKey, x25519PublicKey } = body
      const { agentVersion, createdAt } = body
      const payload = JSON.stringify({
        product,
        serial,
        fingerprint,
        mnemonic: body.mnemonic,
        ed25519PublicKey,
        x25519PublicKey,
        agentVersion,
        createdAt,
      })
      if (!verifyDevicePayload(ed25519PublicKey, payload, body.signature)) {
        throw new HttpError(401, 'invalid signature')
      }
      if (deviceFingerprint(product, ed25519PublicKey) !== fingerprint) {
        throw new HttpError(400, 'fingerprint does not match product|publicKey')
      }
      const created = Date.parse(createdAt)
      if (!Number.isFinite(created) || Math.abs(now() - created) > maxSkewMs) {
        throw new HttpError(400, 'createdAt outside allowed clock skew')
      }
      let result: { code: number; id: string } | undefined
      await store.update((d) => {
        sweepJoins(d)
        const pending = d.joins.filter((j) => j.status === 'pending')
        const existing = pending.find((j) => j.fingerprint === fingerprint)
        if (existing) {
          result = { code: 200, id: existing.id }
          return
        }
        if (pending.length >= maxPendingJoins) {
          throw new HttpError(429, 'too many pending join requests')
        }
        const join: JoinRequest = {
          id: newId('join'),
          product,
          serial,
          fingerprint,
          // What the admin compares against the device sticker must come from
          // the key being approved, not from whatever the client typed.
          mnemonic: fingerprintMnemonic(fingerprint),
          ed25519PublicKey,
          x25519PublicKey,
          agentVersion,
          createdAt,
          receivedAt: new Date(now()).toISOString(),
          status: 'pending',
        }
        d.joins.unshift(join)
        result = { code: 201, id: join.id }
      })
      return send(res, result!.code, { id: result!.id, status: 'pending' })
    }

    // Admin: list pending joins
    if (method === 'GET' && pathname === '/v1/join-requests') {
      requireAdmin(req, data)
      const status = url.searchParams.get('status') || 'pending'
      const list = data.joins
        .map((j) => (joinExpired(j) ? { ...j, status: 'expired' as const } : j))
        .filter((j) => (status === 'all' ? true : j.status === status))
      return send(res, 200, { joins: list })
    }

    // Admin: approve / deny — only a join that is still pending
    const decision = /^\/v1\/join-requests\/([^/]+)\/(approve|deny)$/.exec(pathname)
    if (method === 'POST' && decision) {
      requireAdmin(req, data)
      await readBody(req)
      const [, id, action] = decision
      let enrollmentId = ''
      await store.update((d) => {
        const j = d.joins.find((x) => x.id === id)
        if (!j) throw new HttpError(404, 'not found')
        if (joinExpired(j)) j.status = 'expired'
        if (j.status !== 'pending') {
          throw new HttpError(409, `join request is ${j.status}, not pending`)
        }
        if (action === 'deny') {
          j.status = 'denied'
          j.deniedAt = new Date(now()).toISOString()
          return
        }
        j.status = 'approved'
        j.approvedAt = new Date(now()).toISOString()
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
          createdAt: new Date(now()).toISOString(),
        }
        j.enrollmentId = enr.id
        enrollmentId = enr.id
        d.enrollments.push(enr)
      })
      return send(res, 200, action === 'approve' ? { ok: true, enrollmentId } : { ok: true })
    }

    // Public-ish: device lookup by fingerprint
    if (method === 'GET' && pathname.startsWith('/v1/devices/by-fingerprint/')) {
      const fp = decodeURIComponent(pathname.slice('/v1/devices/by-fingerprint/'.length))
      const enr = data.enrollments.find((e) => e.fingerprint === fp)
      if (!enr) {
        return send(res, 200, { enrolled: false })
      }
      return send(res, 200, {
        enrolled: enr.status === 'active',
        enrollmentId: enr.id,
        status: enr.status,
        // Devices pin this at enrollment and only accept jobs it signed.
        controlPublicKey: data.controlKey.ed25519PublicKey,
      })
    }

    // Admin: list devices
    if (method === 'GET' && pathname === '/v1/devices') {
      requireAdmin(req, data)
      return send(res, 200, { devices: data.enrollments })
    }

    // Admin: create sealed, signed job
    if (method === 'POST' && pathname === '/v1/jobs') {
      requireAdmin(req, data)
      const body = await readJson(req)
      const { fingerprint, kind } = body
      const payload = (body.payload ?? {}) as Record<string, unknown>
      if (
        !isStr(fingerprint, RE_FINGERPRINT) ||
        !isStr(kind, RE_KIND) ||
        kind.length > 64 ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        throw new HttpError(400, 'invalid job: fingerprint, kind and payload object required')
      }
      if (kind === 'firmware.apply' || payload.firmwareBase64) {
        throw new HttpError(
          400,
          'unsigned firmware.apply is not allowed; use firmware.offer with a verified releaseUri',
        )
      }
      if (kind === 'credential.set' || kind === 'credential.rotate') {
        const pw = payload.password
        if (typeof pw !== 'string' || !pw || pw.length > MAX_PASSWORD_CHARS) {
          throw new HttpError(400, `${kind} requires a non-empty password`)
        }
      }
      if (kind === 'firmware.offer') {
        if (typeof payload.releaseUri !== 'string' || typeof payload.imageSha256 !== 'string') {
          throw new HttpError(400, 'firmware.offer requires releaseUri and imageSha256')
        }
      }
      const enr = data.enrollments.find(
        (e) => e.fingerprint === fingerprint && e.status === 'active',
      )
      if (!enr) throw new HttpError(404, 'device not enrolled')
      // `kind` last: the payload must not be able to override the signed kind.
      const sealed = sealForDevice(enr.x25519PublicKey, JSON.stringify({ ...payload, kind }))
      const id = newId('job')
      const issuedAt = new Date(now()).toISOString()
      const job: JobRecord = {
        id,
        fingerprint,
        kind,
        sealed,
        issuedAt,
        signature: signJob(data.controlKey.ed25519PrivateKeyPem, {
          fingerprint,
          jobId: id,
          kind,
          issuedAt,
          sealed,
        }),
        status: 'pending',
        createdAt: issuedAt,
        summary: `${kind} for ${fingerprint.slice(0, 12)}…`,
      }
      await store.update((d) => {
        d.jobs.unshift(job)
      })
      return send(res, 201, { id: job.id, summary: job.summary })
    }

    // Admin: list jobs
    if (method === 'GET' && pathname === '/v1/jobs') {
      requireAdmin(req, data)
      const safe = data.jobs.map(({ sealed: _s, signature: _g, ...rest }) => rest)
      return send(res, 200, { jobs: safe })
    }

    // Device: pull pending jobs
    if (method === 'GET' && pathname === '/v1/devices/me/jobs') {
      const auth = verifyDevice(req, data, 'GET', '/v1/devices/me/jobs')
      const pending = data.jobs.filter(
        (j) => j.fingerprint === auth.fingerprint && j.status === 'pending',
      )
      return send(res, 200, {
        jobs: pending.map((j) => ({
          id: j.id,
          kind: j.kind,
          sealed: j.sealed,
          issuedAt: j.issuedAt,
          signature: j.signature,
          createdAt: j.createdAt,
        })),
      })
    }

    // Device: ack job
    const ack = /^\/v1\/jobs\/([^/]+)\/ack$/.exec(pathname)
    if (method === 'POST' && ack) {
      const id = ack[1]!
      if (!RE_ID.test(id)) throw new HttpError(404, 'not found')
      const body = await readJson(req)
      const status =
        body.status === 'ok' ? 'ok' : body.status === 'unsupported' ? 'unsupported' : 'failed'
      const auth = verifyDevice(req, data, 'POST', `/v1/jobs/${id}/ack`, status)
      await store.update((d) => {
        const j = d.jobs.find((x) => x.id === id)
        if (!j || j.fingerprint !== auth.fingerprint) throw new HttpError(404, 'not found')
        if (j.status !== 'pending') throw new HttpError(409, 'job already acked')
        j.status = `acked_${status}`
        j.ackedAt = new Date(now()).toISOString()
        if (typeof body.error === 'string' && body.error) {
          j.error = body.error.slice(0, MAX_ACK_ERROR_CHARS)
        }
      })
      return send(res, 200, { ok: true })
    }

    return send(res, 404, { error: 'not found' })
  }

  return (req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) return res.end()
      if (e instanceof HttpError) return send(res, e.status, { error: e.message })
      console.error('control plane error:', e)
      // Internal detail (paths, parser messages) stays in the server log.
      send(res, 500, { error: 'internal error' })
    })
  }
}
