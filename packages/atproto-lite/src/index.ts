/**
 * Minimal AT Protocol client — production path uses only vanilla XRPC.
 */

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

export interface AtpClientOptions {
  pds: string
  userAgent?: string
  fetch?: typeof fetch
}

function normalizePds(pds: string): string {
  return pds.replace(/\/$/, '')
}

export class AtpClient {
  readonly pds: string
  private session: Session | null = null
  private readonly fetchImpl: typeof fetch
  private readonly userAgent: string

  constructor(opts: AtpClientOptions) {
    this.pds = normalizePds(opts.pds)
    this.fetchImpl = opts.fetch ?? fetch
    this.userAgent = opts.userAgent ?? 'open-firmware/0.1'
  }

  get did(): string {
    if (!this.session) throw new Error('not logged in')
    return this.session.did
  }

  get accessJwt(): string {
    if (!this.session) throw new Error('not logged in')
    return this.session.accessJwt
  }

  async login(identifier: string, password: string): Promise<Session> {
    const res = await this.fetchImpl(
      `${this.pds}/xrpc/com.atproto.server.createSession`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': this.userAgent,
        },
        body: JSON.stringify({ identifier, password }),
      },
    )
    if (!res.ok) {
      throw new Error(`createSession failed: ${res.status} ${await res.text()}`)
    }
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
      refreshJwt: body.refreshJwt,
    }
    return this.session
  }

  /** Public/unauthenticated XRPC GET */
  async getJson(pathAndQuery: string): Promise<unknown> {
    const url = pathAndQuery.startsWith('http')
      ? pathAndQuery
      : `${this.pds}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`
    const res = await this.fetchImpl(url, {
      headers: { 'user-agent': this.userAgent },
    })
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`)
    }
    return res.json()
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    if (!this.session) throw new Error('not logged in')
    return {
      authorization: `Bearer ${this.session.accessJwt}`,
      'user-agent': this.userAgent,
      ...extra,
    }
  }

  async uploadBlob(data: Uint8Array, mimeType: string): Promise<BlobRef> {
    const res = await this.fetchImpl(`${this.pds}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: this.authHeaders({ 'content-type': mimeType }),
      body: Buffer.from(data),
    })
    if (!res.ok) {
      throw new Error(`uploadBlob failed: ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as { blob: BlobRef }
    return body.blob
  }

  async createRecord(
    collection: string,
    record: Record<string, unknown>,
    rkey?: string,
  ): Promise<StrongRef> {
    const payload: Record<string, unknown> = {
      repo: this.did,
      collection,
      record,
    }
    if (rkey) payload.rkey = rkey
    const res = await this.fetchImpl(
      `${this.pds}/xrpc/com.atproto.repo.createRecord`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload),
      },
    )
    if (!res.ok) {
      throw new Error(
        `createRecord ${collection} failed: ${res.status} ${await res.text()}`,
      )
    }
    return (await res.json()) as StrongRef
  }

  async putRecord(
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ): Promise<StrongRef> {
    const res = await this.fetchImpl(`${this.pds}/xrpc/com.atproto.repo.putRecord`, {
      method: 'POST',
      headers: this.authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        repo: this.did,
        collection,
        rkey,
        record,
      }),
    })
    if (!res.ok) {
      throw new Error(
        `putRecord ${collection}/${rkey} failed: ${res.status} ${await res.text()}`,
      )
    }
    return (await res.json()) as StrongRef
  }

  async getRecord(
    repo: string,
    collection: string,
    rkey: string,
  ): Promise<{ uri: string; cid: string; value: Record<string, unknown> }> {
    const u = new URL(`${this.pds}/xrpc/com.atproto.repo.getRecord`)
    u.searchParams.set('repo', repo)
    u.searchParams.set('collection', collection)
    u.searchParams.set('rkey', rkey)
    const data = (await this.getJson(u.toString())) as {
      uri: string
      cid: string
      value: Record<string, unknown>
    }
    return data
  }

  async listRecords(
    repo: string,
    collection: string,
    limit = 50,
  ): Promise<Array<{ uri: string; cid: string; value: Record<string, unknown> }>> {
    const u = new URL(`${this.pds}/xrpc/com.atproto.repo.listRecords`)
    u.searchParams.set('repo', repo)
    u.searchParams.set('collection', collection)
    u.searchParams.set('limit', String(limit))
    const data = (await this.getJson(u.toString())) as {
      records?: Array<{ uri: string; cid: string; value: Record<string, unknown> }>
    }
    return data.records ?? []
  }

  async getBlob(did: string, cid: string): Promise<Uint8Array> {
    const u = new URL(`${this.pds}/xrpc/com.atproto.sync.getBlob`)
    u.searchParams.set('did', did)
    u.searchParams.set('cid', cid)
    const res = await this.fetchImpl(u.toString(), {
      headers: { 'user-agent': this.userAgent },
    })
    if (!res.ok) {
      throw new Error(`getBlob failed: ${res.status} ${await res.text()}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }
}

/** Create a read-only client (no login). */
export function publicClient(pds: string): AtpClient {
  return new AtpClient({ pds })
}
