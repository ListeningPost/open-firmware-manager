/**
 * Admin utility client for the private control plane.
 */

export interface UtilityConfig {
  controlUrl: string
  adminToken: string
  fetchImpl?: typeof fetch
}

export class OpenFirmwareUtility {
  constructor(private readonly cfg: UtilityConfig) {}

  private async req(path: string, init?: RequestInit): Promise<unknown> {
    const url = `${this.cfg.controlUrl.replace(/\/$/, '')}${path}`
    const res = await (this.cfg.fetchImpl ?? fetch)(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.cfg.adminToken}`,
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
    })
    const text = await res.text()
    const json = text ? JSON.parse(text) : {}
    if (!res.ok) throw new Error(`${path} → ${res.status} ${text}`)
    return json
  }

  listPendingJoins() {
    return this.req('/v1/join-requests?status=pending') as Promise<{
      joins: Array<{
        id: string
        product: string
        serial: string
        fingerprint: string
        mnemonic: string
        status: string
      }>
    }>
  }

  approveJoin(joinId: string) {
    return this.req(`/v1/join-requests/${joinId}/approve`, {
      method: 'POST',
      body: '{}',
    }) as Promise<{ ok: boolean; enrollmentId: string }>
  }

  denyJoin(joinId: string) {
    return this.req(`/v1/join-requests/${joinId}/deny`, {
      method: 'POST',
      body: '{}',
    }) as Promise<{ ok: boolean }>
  }

  listDevices() {
    return this.req('/v1/devices') as Promise<{
      devices: Array<{
        id: string
        fingerprint: string
        product: string
        serial: string
        status: string
      }>
    }>
  }

  setPassword(fingerprint: string, password: string) {
    return this.req('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({
        fingerprint,
        kind: 'credential.set',
        payload: { password },
      }),
    }) as Promise<{ id: string; summary: string }>
  }

  pushFirmware(
    fingerprint: string,
    opts: { version: string; firmwareBase64: string },
  ) {
    return this.req('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({
        fingerprint,
        kind: 'firmware.apply',
        payload: {
          version: opts.version,
          firmwareBase64: opts.firmwareBase64,
        },
      }),
    }) as Promise<{ id: string; summary: string }>
  }

  listJobs() {
    return this.req('/v1/jobs') as Promise<{
      jobs: Array<{
        id: string
        fingerprint: string
        kind: string
        status: string
        summary: string
      }>
    }>
  }
}
