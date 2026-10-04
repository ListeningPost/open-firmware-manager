import { XRPCError } from './error.js'
import { resolveIdentity } from './identity.js'
import { parseAtUri } from './uri.js'

export interface Session {
  pds: string
  did: string
  handle: string
  accessJwt: string
  refreshJwt?: string
}

export interface BlobRef {
  $type?: string
  ref: { $link: string }
  mimeType: string
  size: number
}

export interface StrongRef {
  uri: string
  cid: string
}

export interface RecordValue {
  uri: string
  cid: string
  value: Record<string, unknown>
}

export interface AtpClientOptions {
  pds?: string
  userAgent?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

function normalizePds(pds: string): string {
  return pds.replace(/\/$/, '')
}

export class AtpClient {
  pds: string
  private session: Session | null = null
  private readonly fetchImpl: typeof fetch
  private readonly userAgent: string
  private readonly timeoutMs: number
  private refreshing: Promise<void> | null = null

  constructor(opts: AtpClientOptions = {}) {
    this.pds = opts.pds ? normalizePds(opts.pds) : ''
    this.fetchImpl = opts.fetch ?? fetch
    this.userAgent = opts.userAgent ?? 'open-firmware/0.1'
    this.timeoutMs = opts.timeoutMs ?? 120_000
  }

  get did(): string {
    if (!this.session) throw new Error('not logged in')
    return this.session.did
  }

  get accessJwt(): string {
    if (!this.session) throw new Error('not logged in')
    return this.session.accessJwt
  }

  get hasSession(): boolean {
    return this.session !== null
  }

  resume(session: Session): void {
    this.session = session
    this.pds = normalizePds(session.pds)
  }

  /**
   * Discover the PDS for a handle or DID and point this client at it.
   */
  async discover(identifier: string): Promise<void> {
    const id = await resolveIdentity(identifier, this.fetchImpl)
    this.pds = id.pds
  }

  async login(identifier: string, password: string): Promise<Session> {
    if (!this.pds) {
      try {
        await this.discover(identifier)
      } catch {
        throw new Error('pds URL required when handle/DID cannot be resolved')
      }
    }
    const body = await this.postJson<{
      did: string
      handle: string
      accessJwt: string
      refreshJwt?: string
    }>('com.atproto.server.createSession', { identifier, password }, false)
    this.session = {
      pds: this.pds,
      did: body.did,
      handle: body.handle,
      accessJwt: body.accessJwt,
      refreshJwt: body.refreshJwt,
    }
    return this.session
  }

  async refreshSession(): Promise<Session> {
    if (!this.session?.refreshJwt) {
      throw new XRPCError({
        status: 401,
        error: 'ExpiredToken',
        message: 'no refreshJwt',
      })
    }
    const res = await this.rawFetch(
      'POST',
      'com.atproto.server.refreshSession',
      undefined,
      undefined,
      { authorization: `Bearer ${this.session.refreshJwt}` },
    )
    if (!res.ok) throw await XRPCError.fromResponse(res, 'com.atproto.server.refreshSession')
    const body = (await res.json()) as {
      did: string
      handle: string
      accessJwt: string
      refreshJwt?: string
    }
    this.session = {
      pds: this.pds,
      did: body.did,
      handle: body.handle,
      accessJwt: body.accessJwt,
      refreshJwt: body.refreshJwt ?? this.session.refreshJwt,
    }
    return this.session
  }

  async uploadBlob(data: Uint8Array, mimeType: string): Promise<BlobRef> {
    const res = await this.request(
      'POST',
      'com.atproto.repo.uploadBlob',
      undefined,
      data,
      mimeType,
      true,
    )
    const body = (await res.json()) as { blob: BlobRef }
    return body.blob
  }

  async createRecord(
    collection: string,
    record: Record<string, unknown>,
    rkey?: string,
    opts: { swapCommit?: string; validate?: boolean } = {},
  ): Promise<StrongRef> {
    const payload: Record<string, unknown> = {
      repo: this.did,
      collection,
      record,
    }
    if (rkey) payload.rkey = rkey
    if (opts.swapCommit) payload.swapCommit = opts.swapCommit
    if (opts.validate !== undefined) payload.validate = opts.validate
    return this.postJson<StrongRef>('com.atproto.repo.createRecord', payload, true)
  }

  async putRecord(
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
    opts: { swapRecord?: string; swapCommit?: string; validate?: boolean } = {},
  ): Promise<StrongRef> {
    const payload: Record<string, unknown> = {
      repo: this.did,
      collection,
      rkey,
      record,
    }
    if (opts.swapRecord) payload.swapRecord = opts.swapRecord
    if (opts.swapCommit) payload.swapCommit = opts.swapCommit
    if (opts.validate !== undefined) payload.validate = opts.validate
    return this.postJson<StrongRef>('com.atproto.repo.putRecord', payload, true)
  }

  async deleteRecord(
    collection: string,
    rkey: string,
    opts: { swapRecord?: string; swapCommit?: string } = {},
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      repo: this.did,
      collection,
      rkey,
    }
    if (opts.swapRecord) payload.swapRecord = opts.swapRecord
    if (opts.swapCommit) payload.swapCommit = opts.swapCommit
    await this.postJson('com.atproto.repo.deleteRecord', payload, true)
  }

  async getRecord(
    repo: string,
    collection: string,
    rkey: string,
    cid?: string,
  ): Promise<RecordValue> {
    const params: Record<string, string> = { repo, collection, rkey }
    if (cid) params.cid = cid
    return this.getJson<RecordValue>('com.atproto.repo.getRecord', params)
  }

  async getRecordByUri(uri: string, cid?: string): Promise<RecordValue> {
    const parsed = parseAtUri(uri)
    return this.getRecord(parsed.did, parsed.collection, parsed.rkey, cid)
  }

  /**
   * Fetch every page of listRecords. Default limit 100 (PDS max).
   */
  async listRecords(
    repo: string,
    collection: string,
    opts: { limit?: number; reverse?: boolean } = {},
  ): Promise<RecordValue[]> {
    const out: RecordValue[] = []
    let cursor: string | undefined
    const limit = opts.limit ?? 100
    const seen = new Set<string>()
    for (let pageNo = 0; pageNo < 1000; pageNo++) {
      const params: Record<string, string> = {
        repo,
        collection,
        limit: String(Math.min(limit, 100)),
      }
      if (opts.reverse !== undefined) params.reverse = opts.reverse ? 'true' : 'false'
      if (cursor) params.cursor = cursor
      const page = await this.getJson<{
        records?: RecordValue[]
        cursor?: string
      }>('com.atproto.repo.listRecords', params)
      out.push(...(page.records ?? []))
      const next = page.cursor
      if (!next || next === cursor || seen.has(next)) break
      seen.add(next)
      cursor = next
    }
    return out
  }

  async getBlob(did: string, cid: string): Promise<Uint8Array> {
    const res = await this.request(
      'GET',
      'com.atproto.sync.getBlob',
      { did, cid },
      undefined,
      undefined,
      false,
    )
    return new Uint8Array(await res.arrayBuffer())
  }

  async describeServer(): Promise<{
    availableUserDomains?: string[]
    inviteCodeRequired?: boolean
    blobUploadLimit?: number
  }> {
    return this.getJson('com.atproto.server.describeServer')
  }

  private async getJson<T>(
    nsid: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const res = await this.request('GET', nsid, params, undefined, undefined, false)
    return (await res.json()) as T
  }

  private async postJson<T>(
    nsid: string,
    body: unknown,
    auth: boolean,
  ): Promise<T> {
    const res = await this.request(
      'POST',
      nsid,
      undefined,
      JSON.stringify(body),
      'application/json',
      auth,
    )
    return (await res.json()) as T
  }

  private async request(
    method: string,
    nsid: string,
    params?: Record<string, string>,
    body?: Uint8Array | string,
    contentType?: string,
    auth = false,
  ): Promise<Response> {
    const send = () =>
      this.rawFetch(method, nsid, params, body, this.headers(contentType, auth))
    let res = await send()
    if (!res.ok) {
      const err = await XRPCError.fromResponse(res, nsid)
      if (err.isExpiredToken && this.session?.refreshJwt) {
        await this.refreshOnce()
        res = await send()
        if (!res.ok) throw await XRPCError.fromResponse(res, nsid)
        return res
      }
      throw err
    }
    return res
  }

  private async refreshOnce(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.refreshSession()
        .then(() => undefined)
        .finally(() => {
          this.refreshing = null
        })
    }
    await this.refreshing
  }

  private headers(
    contentType?: string,
    auth = false,
  ): Record<string, string> {
    const h: Record<string, string> = { 'user-agent': this.userAgent }
    if (contentType) h['content-type'] = contentType
    if ((auth || this.session) && this.session) {
      h.authorization = `Bearer ${this.session.accessJwt}`
    }
    return h
  }

  private async rawFetch(
    method: string,
    nsid: string,
    params?: Record<string, string>,
    body?: Uint8Array | string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    if (!this.pds) throw new Error('pds URL not set')
    const u = new URL(`${this.pds}/xrpc/${nsid}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    }
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(u.toString(), {
        method,
        headers,
        body,
        signal: ac.signal,
      })
    } catch (e) {
      if (ac.signal.aborted) {
        throw new XRPCError({
          status: 0,
          error: 'Timeout',
          message: `${nsid} timed out after ${this.timeoutMs}ms`,
          nsid,
        })
      }
      throw e
    } finally {
      clearTimeout(t)
    }
  }
}

export function publicClient(pds: string, fetchImpl?: typeof fetch): AtpClient {
  return new AtpClient({ pds, fetch: fetchImpl })
}
