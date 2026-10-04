import { describe, expect, it } from 'vitest'
import { OpenFirmwareUtility } from '../src/index.js'
import { USAGE, runCli } from '../src/run.js'

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** Records every request and answers from a route table (default: `{}` 200). */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }> = {}) {
  const calls: Recorded[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const route = routes[`${method} ${new URL(url).pathname}`]
    const body = route?.body ?? {}
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: route?.status ?? 200,
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function io() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } }
}

const FP = 'ab'.repeat(32)

describe('OpenFirmwareUtility request building', () => {
  const make = (routes?: Parameters<typeof fakeFetch>[0], controlUrl = 'http://ctl.test:8787/') => {
    const f = fakeFetch(routes)
    const util = new OpenFirmwareUtility({ controlUrl, adminToken: 'tok', fetchImpl: f.fetchImpl })
    return { util, calls: f.calls }
  }

  it('sends the bearer token and JSON content type, and trims the trailing slash', async () => {
    const { util, calls } = make({ 'GET /v1/devices': { body: { devices: [] } } })
    await util.listDevices()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: 'http://ctl.test:8787/v1/devices', method: 'GET' })
    expect(calls[0]!.headers.authorization).toBe('Bearer tok')
    expect(calls[0]!.headers['content-type']).toBe('application/json')
  })

  it('lists only pending joins', async () => {
    const { util, calls } = make({ 'GET /v1/join-requests': { body: { joins: [] } } })
    await util.listPendingJoins()
    expect(calls[0]!.url).toBe('http://ctl.test:8787/v1/join-requests?status=pending')
  })

  it('approve and deny POST to the escaped join id', async () => {
    const { util, calls } = make()
    await util.approveJoin('join_1')
    await util.denyJoin('a/b?c')
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://ctl.test:8787/v1/join-requests/join_1/approve',
    })
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'http://ctl.test:8787/v1/join-requests/a%2Fb%3Fc/deny',
    })
  })

  it('setPassword enqueues a credential.set job', async () => {
    const { util, calls } = make()
    await util.setPassword(FP, 'p@ss "quoted"')
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://ctl.test:8787/v1/jobs' })
    expect(calls[0]!.body).toEqual({
      fingerprint: FP,
      kind: 'credential.set',
      payload: { password: 'p@ss "quoted"' },
    })
  })

  it('offerFirmware enqueues a firmware.offer pointer, never bytes', async () => {
    const { util, calls } = make()
    const offer = { version: '2.0.0', releaseUri: 'at://x/y/z', cid: 'bafy', imageSha256: 'cd'.repeat(32) }
    await util.offerFirmware(FP, { ...offer, firmwareBase64: 'YQ==' } as typeof offer)
    expect(calls[0]!.body).toEqual({ fingerprint: FP, kind: 'firmware.offer', payload: offer })
  })

  it('getMeta reads the control public key', async () => {
    const { util, calls } = make({ 'GET /v1/meta': { body: { controlPublicKey: 'KEY' } } })
    expect((await util.getMeta()).controlPublicKey).toBe('KEY')
    expect(calls[0]!.url).toBe('http://ctl.test:8787/v1/meta')
  })

  it('surfaces HTTP errors with path, status and body', async () => {
    const { util } = make({ 'GET /v1/jobs': { status: 401, body: { error: 'admin token required' } } })
    await expect(util.listJobs()).rejects.toThrow(/\/v1\/jobs → 401 .*admin token required/)
  })
})

describe('ofw-util argument handling', () => {
  const env = { OFW_CONTROL_URL: 'http://ctl.test', OFW_ADMIN_TOKEN: 'tok' }

  it('prints usage for no command and for help, without any request', async () => {
    for (const argv of [[], ['help']]) {
      const f = fakeFetch()
      const t = io()
      expect(await runCli(argv, {}, t.io, f.fetchImpl)).toBe(0)
      expect(t.out).toEqual([USAGE])
      expect(f.calls).toHaveLength(0)
    }
  })

  it('fails on an unknown command', async () => {
    const f = fakeFetch()
    const t = io()
    expect(await runCli(['frobnicate'], env, t.io, f.fetchImpl)).toBe(1)
    expect(t.err.join('\n')).toMatch(/unknown command: frobnicate/)
    expect(f.calls).toHaveLength(0)
  })

  it('requires OFW_ADMIN_TOKEN for admin commands and makes no request without it', async () => {
    const f = fakeFetch()
    const t = io()
    expect(await runCli(['list-devices'], { OFW_CONTROL_URL: 'http://ctl.test' }, t.io, f.fetchImpl)).toBe(1)
    expect(t.err[0]).toMatch(/OFW_ADMIN_TOKEN/)
    expect(f.calls).toHaveLength(0)
  })

  it('defaults the control URL to localhost:8787', async () => {
    const f = fakeFetch({ 'GET /v1/jobs': { body: { jobs: [] } } })
    expect(await runCli(['list-jobs'], { OFW_ADMIN_TOKEN: 'tok' }, io().io, f.fetchImpl)).toBe(0)
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:8787/v1/jobs')
  })

  it.each([
    [['approve'], /usage: ofw-util approve <joinId>/],
    [['deny'], /usage: ofw-util deny <joinId>/],
    [['set-password'], /usage: ofw-util set-password/],
    [['set-password', FP], /usage: ofw-util set-password/],
  ])('%j reports missing arguments without calling the server', async (argv, re) => {
    const f = fakeFetch()
    const t = io()
    expect(await runCli(argv, env, t.io, f.fetchImpl)).toBe(1)
    expect(t.err.join('\n')).toMatch(re)
    expect(f.calls).toHaveLength(0)
  })

  it('approve prints the enrollment id', async () => {
    const f = fakeFetch({
      'POST /v1/join-requests/join_9/approve': { body: { ok: true, enrollmentId: 'enr_9' } },
    })
    const t = io()
    expect(await runCli(['approve', 'join_9'], env, t.io, f.fetchImpl)).toBe(0)
    expect(t.out).toEqual(['approved enr_9'])
    expect(f.calls[0]!.headers.authorization).toBe('Bearer tok')
  })

  it('deny posts to the deny route', async () => {
    const f = fakeFetch()
    const t = io()
    expect(await runCli(['deny', 'join_9'], env, t.io, f.fetchImpl)).toBe(0)
    expect(f.calls[0]!.url).toBe('http://ctl.test/v1/join-requests/join_9/deny')
    expect(t.out).toEqual(['denied join_9'])
  })

  it('set-password passes fingerprint and password through unchanged', async () => {
    const f = fakeFetch({ 'POST /v1/jobs': { status: 201, body: { id: 'job_1', summary: 's' } } })
    const t = io()
    expect(await runCli(['set-password', FP, 'new secret'], env, t.io, f.fetchImpl)).toBe(0)
    expect(f.calls[0]!.body).toEqual({
      fingerprint: FP,
      kind: 'credential.set',
      payload: { password: 'new secret' },
    })
    expect(t.out).toEqual(['job job_1 s'])
  })

  it('list-pending shows the server-derived mnemonic, and (none) when empty', async () => {
    const join = { id: 'join_1', product: 'cam', serial: 'S1', mnemonic: 'a-b-c-d-e-f', fingerprint: FP }
    const f = fakeFetch({ 'GET /v1/join-requests': { body: { joins: [join] } } })
    const t = io()
    expect(await runCli(['list-pending'], env, t.io, f.fetchImpl)).toBe(0)
    expect(t.out).toEqual([`join_1\tcam\tS1\ta-b-c-d-e-f\t${FP.slice(0, 16)}…`])

    const empty = io()
    const g = fakeFetch({ 'GET /v1/join-requests': { body: { joins: [] } } })
    expect(await runCli(['list-pending'], env, empty.io, g.fetchImpl)).toBe(0)
    expect(empty.out).toEqual(['(none)'])
  })

  it('control-key prints the key to pin and needs no admin token', async () => {
    const f = fakeFetch({ 'GET /v1/meta': { body: { controlPublicKey: 'PINME' } } })
    const t = io()
    expect(await runCli(['control-key'], { OFW_CONTROL_URL: 'http://ctl.test' }, t.io, f.fetchImpl)).toBe(0)
    expect(t.out).toEqual(['PINME'])
  })

  it('returns 1 and prints the server error when a request fails', async () => {
    const f = fakeFetch({ 'GET /v1/devices': { status: 401, body: { error: 'admin token required' } } })
    const t = io()
    expect(await runCli(['list-devices'], env, t.io, f.fetchImpl)).toBe(1)
    expect(t.err.join('\n')).toMatch(/401/)
  })
})
