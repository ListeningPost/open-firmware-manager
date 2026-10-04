import { readFile } from 'node:fs/promises'
import {
  factoryReset,
  loadFactoryProfile,
  loadJobGuard,
  loadUserState,
  publicIdentity,
  recordJobSeen,
  saveUserState,
  writePrivateFile,
  type FactoryProfile,
  type JobStatus,
  type UserState,
} from './factory.js'
import { devicePaths } from './factory.js'
import {
  b64url,
  openSealed,
  signDevicePayload,
  verifyJobSignature,
  type SignedJob,
} from './crypto.js'
import { createHash, randomBytes } from 'node:crypto'

export interface JoinRequestBody {
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

export interface ControlClient {
  baseUrl: string
  fetchImpl?: typeof fetch
}

/** A `firmware.offer` job: a pointer to a release, never the bytes. */
export interface FirmwareOffer {
  releaseUri: string
  imageSha256: string
  version?: string
  cid?: string
}

export interface IotDeviceAgentOptions {
  /**
   * Called for each authenticated `firmware.offer`. Wire this to the update
   * client (e.g. `OpenFirmwareClient.downloadVerified` + `applyFirmwareBytes`);
   * resolve once the update is installed, throw to report failure. Without a
   * handler the offer is acked `unsupported` — never `ok`.
   */
  onFirmwareOffer?: (offer: FirmwareOffer) => Promise<void>
}

export interface JobResult {
  id: string
  kind: string
  status: JobStatus
  error?: string
  /** Refused before decryption: unsigned, wrong signer, malformed, or too old. */
  rejected?: boolean
  /** Seen before; the original outcome is reported again, nothing was applied. */
  replayed?: boolean
  /** Whether the control plane accepted the ack. */
  acked: boolean
}

type JobOutcome = Pick<JobResult, 'status' | 'error' | 'replayed'>

/** Thrown for a valid job this device has no way to carry out. */
export class UnsupportedJobError extends Error {}

type JobPayload = {
  kind: string
  password?: string
  version?: string
  releaseUri?: string
  cid?: string
  imageSha256?: string
}

async function api(
  baseUrl: string,
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`
  const res = await fetchImpl(url, init)
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`${init?.method || 'GET'} ${path} → ${res.status} ${text}`)
  }
  return json
}

/**
 * Signed device request headers. The nonce makes every signature single-use
 * on the control plane.
 */
function deviceAuthHeaders(
  profile: FactoryProfile,
  method: string,
  path: string,
  status?: string,
): Record<string, string> {
  const ts = String(Date.now())
  const nonce = b64url(randomBytes(16))
  let payload = `${method} ${path}|${profile.fingerprint}|${ts}|${nonce}`
  if (status !== undefined) payload += `|${status}`
  return {
    'x-ofw-fingerprint': profile.fingerprint,
    'x-ofw-timestamp': ts,
    'x-ofw-nonce': nonce,
    'x-ofw-signature': signDevicePayload(profile.keys.ed25519PrivateKeyPem, payload),
  }
}

export class IotDeviceAgent {
  constructor(
    public readonly root: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly opts: IotDeviceAgentOptions = {},
  ) {}

  async profile(): Promise<FactoryProfile> {
    return loadFactoryProfile(this.root)
  }

  async state(): Promise<UserState> {
    return loadUserState(this.root)
  }

  async identity() {
    return publicIdentity(await this.profile())
  }

  async factoryReset() {
    return factoryReset(this.root)
  }

  /**
   * Build a signed join request and POST to control plane.
   */
  async requestJoin(): Promise<{ joinId: string; body: JoinRequestBody }> {
    const profile = await this.profile()
    const createdAt = new Date().toISOString()
    const body: Omit<JoinRequestBody, 'signature'> = {
      product: profile.product,
      serial: profile.serial,
      fingerprint: profile.fingerprint,
      mnemonic: profile.mnemonic,
      ed25519PublicKey: profile.keys.ed25519PublicKey,
      x25519PublicKey: profile.keys.x25519PublicKey,
      agentVersion: profile.agentVersion,
      createdAt,
    }
    const payload = JSON.stringify(body)
    const signature = signDevicePayload(profile.keys.ed25519PrivateKeyPem, payload)
    const full: JoinRequestBody = { ...body, signature }

    const res = (await api(
      profile.controlEndpoint,
      '/v1/join',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(full),
      },
      this.fetchImpl,
    )) as { id: string }

    const state = await this.state()
    state.joinRequestId = res.id
    state.status = 'awaiting_enrollment'
    await saveUserState(this.root, state)
    return { joinId: res.id, body: full }
  }

  /**
   * Poll enrollment status from control plane.
   *
   * The control plane's job-signing key is pinned here: a factory-pinned key
   * (`profile.controlPublicKey`) must match what the endpoint presents;
   * otherwise the key presented at first enrollment is pinned until the next
   * factory reset (trust on first use).
   */
  async refreshEnrollment(): Promise<UserState> {
    const profile = await this.profile()
    const state = await this.state()
    const res = (await api(
      profile.controlEndpoint,
      `/v1/devices/by-fingerprint/${profile.fingerprint}`,
      undefined,
      this.fetchImpl,
    )) as {
      enrolled?: boolean
      enrollmentId?: string
      status?: string
      controlPublicKey?: string
    }

    if (res.enrolled) {
      const pinned = profile.controlPublicKey ?? state.controlPublicKey
      if (pinned) {
        if (res.controlPublicKey !== pinned) {
          throw new Error(
            'control plane key does not match the pinned key — refusing enrollment',
          )
        }
      } else {
        if (!res.controlPublicKey) {
          throw new Error('control plane did not present a job-signing key')
        }
        state.controlPublicKey = res.controlPublicKey
      }
      state.enrolled = true
      state.enrollmentId = res.enrollmentId
      state.status = 'enrolled'
      await saveUserState(this.root, state)
    }
    return state
  }

  /**
   * Pull sealed jobs, authenticate, decrypt, apply. Returns the ids of jobs
   * that were applied successfully; see {@link pullJobs} for every outcome.
   */
  async pullAndApplyJobs(): Promise<string[]> {
    const results = await this.pullJobs()
    return results.filter((r) => r.status === 'ok' && !r.replayed).map((r) => r.id)
  }

  /**
   * Pull jobs and report what happened to each. A job is only opened if it is
   * signed by the pinned control-plane key for this device and has not been
   * seen before; anything else is refused without being decrypted.
   */
  async pullJobs(): Promise<JobResult[]> {
    const profile = await this.profile()
    const controlKey = profile.controlPublicKey ?? (await this.state()).controlPublicKey
    if (!controlKey) {
      throw new Error('no control plane key pinned — enroll first or provision one at the factory')
    }
    const path = '/v1/devices/me/jobs'
    const res = (await api(
      profile.controlEndpoint,
      `${path}?fingerprint=${encodeURIComponent(profile.fingerprint)}`,
      { headers: deviceAuthHeaders(profile, 'GET', path) },
      this.fetchImpl,
    )) as { jobs?: Array<Partial<SignedJob>> }

    const results: JobResult[] = []
    for (const job of res.jobs ?? []) {
      const id = typeof job.id === 'string' ? job.id : ''
      const kind = typeof job.kind === 'string' ? job.kind : ''
      let outcome: JobOutcome
      try {
        outcome = await this.processJob(profile, controlKey, job)
      } catch (e) {
        // Not authentic: refuse, and do not ack — an ack would let a forged
        // job with a real job's id change that job's status on the server.
        results.push({
          id,
          kind,
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
          rejected: true,
          acked: false,
        })
        continue
      }
      const acked = await this.ack(profile, id, outcome.status, outcome.error)
      results.push({ id, kind, ...outcome, acked })
    }
    return results
  }

  /**
   * Authenticate one job, then apply it at most once. Throws if the job is
   * not authentic; otherwise returns what happened when it was applied.
   */
  private async processJob(
    profile: FactoryProfile,
    controlKey: string,
    job: Partial<SignedJob>,
  ): Promise<JobOutcome> {
    const { id, kind, issuedAt, sealed, signature } = job
    if (typeof signature !== 'string' || !signature) {
      throw new Error('job is not signed by the control plane')
    }
    if (
      typeof id !== 'string' ||
      typeof kind !== 'string' ||
      typeof issuedAt !== 'string' ||
      !sealed ||
      typeof sealed.epk !== 'string' ||
      typeof sealed.nonce !== 'string' ||
      typeof sealed.ct !== 'string'
    ) {
      throw new Error('malformed job')
    }
    const fields = { fingerprint: profile.fingerprint, jobId: id, kind, issuedAt, sealed }
    if (!verifyJobSignature(controlKey, fields, signature)) {
      throw new Error('job signature invalid')
    }
    const issuedMs = Date.parse(issuedAt)
    if (!Number.isFinite(issuedMs)) throw new Error('job issuedAt invalid')

    const guard = await loadJobGuard(this.root)
    const seen = guard.seen.find((s) => s.id === id)
    if (seen) {
      // Already handled (e.g. our ack was lost). Report the original outcome
      // again, but never apply twice.
      return {
        status: seen.status,
        error: 'job already processed (replay) — not applied again',
        replayed: true,
      }
    }
    if (issuedMs <= guard.floor) throw new Error('job older than replay window (replay)')

    let outcome: JobOutcome
    try {
      const plain = openSealed(profile.keys.x25519PrivateKeyPem, sealed)
      const payload = JSON.parse(plain.toString('utf8')) as JobPayload
      if (payload.kind !== kind) throw new Error('sealed job kind does not match signed kind')
      await this.applyJob(payload)
      outcome = { status: 'ok' }
    } catch (e) {
      outcome = {
        status: e instanceof UnsupportedJobError ? 'unsupported' : 'failed',
        error: e instanceof Error ? e.message : String(e),
      }
    }
    // Authentic job: remember it whatever the outcome, so it runs at most once.
    await recordJobSeen(this.root, { id, issuedAt: issuedMs, status: outcome.status })
    return outcome
  }

  private async ack(
    profile: FactoryProfile,
    jobId: string,
    status: JobStatus,
    error?: string,
  ): Promise<boolean> {
    const path = `/v1/jobs/${encodeURIComponent(jobId)}/ack`
    try {
      await api(
        profile.controlEndpoint,
        path,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...deviceAuthHeaders(profile, 'POST', path, status),
          },
          body: JSON.stringify(error ? { status, error } : { status }),
        },
        this.fetchImpl,
      )
      return true
    } catch {
      return false
    }
  }

  private async applyJob(payload: JobPayload): Promise<void> {
    if (payload.kind === 'credential.set' || payload.kind === 'credential.rotate') {
      if (typeof payload.password !== 'string' || !payload.password) {
        throw new Error('password missing')
      }
      const state = await this.state()
      state.password = payload.password
      state.passwordRotated = true
      await saveUserState(this.root, state)
      return
    }
    if (payload.kind === 'firmware.apply') {
      throw new Error(
        'unsigned firmware.apply is disabled; use firmware.offer + OpenFirmwareClient.downloadVerified',
      )
    }
    if (payload.kind === 'firmware.offer') {
      if (typeof payload.releaseUri !== 'string' || typeof payload.imageSha256 !== 'string') {
        throw new Error('firmware.offer requires releaseUri and imageSha256')
      }
      if (!payload.releaseUri || !payload.imageSha256) {
        throw new Error('firmware.offer requires releaseUri and imageSha256')
      }
      // The offer is only a pointer. Bytes must be pulled and verified by the
      // embedding application; without that we must not claim success.
      if (!this.opts.onFirmwareOffer) {
        throw new UnsupportedJobError(
          'firmware.offer is not supported: no onFirmwareOffer handler configured',
        )
      }
      await this.opts.onFirmwareOffer({
        releaseUri: payload.releaseUri,
        imageSha256: payload.imageSha256,
        ...(payload.version !== undefined ? { version: payload.version } : {}),
        ...(payload.cid !== undefined ? { cid: payload.cid } : {}),
      })
      return
    }
    throw new UnsupportedJobError(`unknown job kind ${payload.kind}`)
  }

  /** Apply a local firmware file (for synthetic OTA tests via client path). */
  async applyFirmwareBytes(bytes: Uint8Array, version: string): Promise<void> {
    const paths = devicePaths(this.root)
    await writePrivateFile(paths.firmwareImage, bytes)
    const state = await this.state()
    state.firmwareVersion = version
    state.appliedFirmwareSha256 = createHash('sha256').update(bytes).digest('hex')
    await saveUserState(this.root, state)
  }

  async readFirmware(): Promise<Buffer | null> {
    try {
      return await readFile(devicePaths(this.root).firmwareImage)
    } catch {
      return null
    }
  }
}
