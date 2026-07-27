import { readFile, writeFile } from 'node:fs/promises'
import {
  factoryReset,
  loadFactoryProfile,
  loadUserState,
  publicIdentity,
  saveUserState,
  type FactoryProfile,
  type UserState,
} from './factory.js'
import { devicePaths } from './factory.js'
import { openSealed, signDevicePayload, type SealedEnvelope } from './crypto.js'
import { createHash } from 'node:crypto'

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

export class IotDeviceAgent {
  constructor(
    public readonly root: string,
    private readonly fetchImpl: typeof fetch = fetch,
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

  /** Poll enrollment status from control plane. */
  async refreshEnrollment(): Promise<UserState> {
    const profile = await this.profile()
    const state = await this.state()
    const res = (await api(
      profile.controlEndpoint,
      `/v1/devices/by-fingerprint/${profile.fingerprint}`,
      undefined,
      this.fetchImpl,
    )) as { enrolled?: boolean; enrollmentId?: string; status?: string }

    if (res.enrolled) {
      state.enrolled = true
      state.enrollmentId = res.enrollmentId
      state.status = 'enrolled'
      await saveUserState(this.root, state)
    }
    return state
  }

  /**
   * Pull sealed jobs, decrypt, apply (password / firmware package).
   */
  async pullAndApplyJobs(): Promise<string[]> {
    const profile = await this.profile()
    const applied: string[] = []
    const ts = String(Date.now())
    const sig = signDevicePayload(
      profile.keys.ed25519PrivateKeyPem,
      `GET /v1/devices/me/jobs|${profile.fingerprint}|${ts}`,
    )
    const jobs = (await api(
      profile.controlEndpoint,
      `/v1/devices/me/jobs?fingerprint=${encodeURIComponent(profile.fingerprint)}`,
      {
        headers: {
          'x-ofw-fingerprint': profile.fingerprint,
          'x-ofw-timestamp': ts,
          'x-ofw-signature': sig,
        },
      },
      this.fetchImpl,
    )) as { jobs: Array<{ id: string; kind: string; sealed: SealedEnvelope }> }

    for (const job of jobs.jobs ?? []) {
      try {
        const plain = openSealed(profile.keys.x25519PrivateKeyPem, job.sealed)
        const payload = JSON.parse(plain.toString('utf8')) as {
          kind: string
          password?: string
          firmwareBase64?: string
          version?: string
        }
        await this.applyJob(payload)
        const ackTs = String(Date.now())
        const ackSig = signDevicePayload(
          profile.keys.ed25519PrivateKeyPem,
          `POST /v1/jobs/${job.id}/ack|${profile.fingerprint}|${ackTs}|ok`,
        )
        await api(
          profile.controlEndpoint,
          `/v1/jobs/${job.id}/ack`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-ofw-fingerprint': profile.fingerprint,
              'x-ofw-timestamp': ackTs,
              'x-ofw-signature': ackSig,
            },
            body: JSON.stringify({ status: 'ok' }),
          },
          this.fetchImpl,
        )
        applied.push(job.id)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const ackTs = String(Date.now())
        const ackSig = signDevicePayload(
          profile.keys.ed25519PrivateKeyPem,
          `POST /v1/jobs/${job.id}/ack|${profile.fingerprint}|${ackTs}|failed`,
        )
        await api(
          profile.controlEndpoint,
          `/v1/jobs/${job.id}/ack`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-ofw-fingerprint': profile.fingerprint,
              'x-ofw-timestamp': ackTs,
              'x-ofw-signature': ackSig,
            },
            body: JSON.stringify({ status: 'failed', error: msg }),
          },
          this.fetchImpl,
        ).catch(() => {})
      }
    }
    return applied
  }

  private async applyJob(payload: {
    kind: string
    password?: string
    firmwareBase64?: string
    version?: string
  }): Promise<void> {
    const state = await this.state()
    const paths = devicePaths(this.root)
    if (payload.kind === 'credential.set' || payload.kind === 'credential.rotate') {
      if (!payload.password) throw new Error('password missing')
      state.password = payload.password
      state.passwordRotated = true
      await saveUserState(this.root, state)
      return
    }
    if (payload.kind === 'firmware.apply') {
      if (!payload.firmwareBase64) throw new Error('firmware missing')
      const buf = Buffer.from(payload.firmwareBase64, 'base64')
      await writeFile(paths.firmwareImage, buf)
      state.firmwareVersion = payload.version ?? 'unknown'
      state.appliedFirmwareSha256 = createHash('sha256').update(buf).digest('hex')
      await saveUserState(this.root, state)
      return
    }
    throw new Error(`unknown job kind ${payload.kind}`)
  }

  /** Apply a local firmware file (for synthetic OTA tests via client path). */
  async applyFirmwareBytes(bytes: Uint8Array, version: string): Promise<void> {
    const paths = devicePaths(this.root)
    await writeFile(paths.firmwareImage, bytes)
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
