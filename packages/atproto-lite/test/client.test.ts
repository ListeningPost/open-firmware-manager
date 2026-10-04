import { describe, expect, it } from 'vitest'
import { AtpClient, XRPCError } from '../src/index.js'
import { parseAtUri } from '../src/uri.js'
import { blobCidFromBytes } from '../src/cid.js'

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('XRPCError.isMissingRecord', () => {
  it('treats PDS InvalidRequest locate-record as missing', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonRes(400, {
        error: 'InvalidRequest',
        message: 'Could not locate record: at://did:plc:x/col/rk',
      })
    const c = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    try {
      await c.getRecord('did:plc:x', 'col', 'rk')
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(XRPCError)
      expect((e as XRPCError).isMissingRecord).toBe(true)
    }
  })
})

describe('parseAtUri', () => {
  it('parses did collection rkey', () => {
    const p = parseAtUri(
      'at://did:plc:abc/app.openfirmware.firmware.release/cam-1.0.0-stable',
    )
    expect(p.did).toBe('did:plc:abc')
    expect(p.collection).toBe('app.openfirmware.firmware.release')
    expect(p.rkey).toBe('cam-1.0.0-stable')
  })
})

describe('AtpClient', () => {
  it('stops if the PDS repeats the same cursor', async () => {
    let n = 0
    const fetchImpl: typeof fetch = async () => {
      n++
      return jsonRes(200, {
        records: [{ uri: `at://did:plc:x/col/${n}`, cid: 'c', value: {} }],
        cursor: 'stuck',
      })
    }
    const c = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    const recs = await c.listRecords('did:plc:x', 'col')
    expect(n).toBeLessThan(5)
    expect(recs.length).toBeGreaterThan(0)
  })

  it('paginates listRecords until cursor is absent', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('cursor=page2')) {
        return jsonRes(200, {
          records: [{ uri: 'at://did:plc:x/col/b', cid: 'c2', value: { n: 2 } }],
        })
      }
      return jsonRes(200, {
        records: [{ uri: 'at://did:plc:x/col/a', cid: 'c1', value: { n: 1 } }],
        cursor: 'page2',
      })
    }
    const c = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    const recs = await c.listRecords('did:plc:x', 'app.openfirmware.firmware.release')
    expect(recs).toHaveLength(2)
    expect(calls.some((u) => u.includes('cursor=page2'))).toBe(true)
  })

  it('refreshes on 401 and retries', async () => {
    let sessionCalls = 0
    let putCalls = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('com.atproto.server.createSession')) {
        return jsonRes(200, {
          did: 'did:plc:me',
          handle: 'me.test',
          accessJwt: 'access-1',
          refreshJwt: 'refresh-1',
        })
      }
      if (url.endsWith('com.atproto.server.refreshSession')) {
        sessionCalls++
        return jsonRes(200, {
          did: 'did:plc:me',
          handle: 'me.test',
          accessJwt: 'access-2',
          refreshJwt: 'refresh-2',
        })
      }
      if (url.endsWith('com.atproto.repo.putRecord')) {
        putCalls++
        const auth = (init?.headers as Record<string, string>)?.authorization
        if (auth === 'Bearer access-1') {
          return jsonRes(401, { error: 'ExpiredToken', message: 'expired' })
        }
        return jsonRes(200, { uri: 'at://did:plc:me/col/r', cid: 'bafy' })
      }
      return jsonRes(404, { error: 'NotFound' })
    }
    const c = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    await c.login('me.test', 'pw')
    const ref = await c.putRecord('app.openfirmware.firmware.channel', 'p-stable', {
      $type: 'app.openfirmware.firmware.channel',
    })
    expect(ref.cid).toBe('bafy')
    expect(sessionCalls).toBe(1)
    expect(putCalls).toBe(2)
    expect(c.accessJwt).toBe('access-2')
  })

  it('does not refresh on InvalidToken', async () => {
    let refreshCalls = 0
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('refreshSession')) {
        refreshCalls++
        return jsonRes(200, {
          did: 'did:plc:me',
          handle: 'me',
          accessJwt: 'new',
        })
      }
      return jsonRes(401, { error: 'InvalidToken', message: 'bad' })
    }
    const c = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    c.resume({
      pds: 'http://pds.test',
      did: 'did:plc:me',
      handle: 'me',
      accessJwt: 'a',
      refreshJwt: 'r',
    })
    await expect(c.putRecord('col', 'rk', {})).rejects.toMatchObject({
      error: 'InvalidToken',
    })
    expect(refreshCalls).toBe(0)
  })

  it('throws XRPCError with lexicon error name', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonRes(400, { error: 'InvalidSwap', message: 'cid mismatch' })
    const c = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    c.resume({
      pds: 'http://pds.test',
      did: 'did:plc:me',
      handle: 'me',
      accessJwt: 'a',
    })
    try {
      await c.putRecord('col', 'rk', {}, { swapRecord: 'old' })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(XRPCError)
      expect((e as XRPCError).error).toBe('InvalidSwap')
    }
  })

  it('sends Authorization on GET after login', async () => {
    let sawAuth = false
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('createSession')) {
        return jsonRes(200, {
          did: 'did:plc:me',
          handle: 'me',
          accessJwt: 'tok',
        })
      }
      const h = init?.headers as Record<string, string>
      if (h?.authorization === 'Bearer tok') sawAuth = true
      return jsonRes(200, {
        uri: 'at://did:plc:me/col/rk',
        cid: 'c',
        value: {},
      })
    }
    const c = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    await c.login('me', 'pw')
    await c.getRecord('did:plc:me', 'col', 'rk')
    expect(sawAuth).toBe(true)
  })
})

describe('getBlob size cap', () => {
  it('returns the bytes when under the cap', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    const c = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    const got = await c.getBlob('did:plc:a', 'bafk', { maxBytes: 3 })
    expect([...got]).toEqual([1, 2, 3])
  })

  it('rejects on an oversized Content-Length', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          pull(ctrl) {
            ctrl.enqueue(new Uint8Array(8))
            ctrl.close()
          },
        }),
        { status: 200, headers: { 'content-length': '1000000' } },
      )
    const c = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    await expect(
      c.getBlob('did:plc:a', 'bafk', { maxBytes: 16 }),
    ).rejects.toMatchObject({ error: 'BlobTooLarge' })
  })

  it('stops streaming once the cap is exceeded when no length is declared', async () => {
    let sent = 0
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          pull(ctrl) {
            sent++
            ctrl.enqueue(new Uint8Array(10))
          },
        }),
        { status: 200 },
      )
    const c = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    await expect(
      c.getBlob('did:plc:a', 'bafk', { maxBytes: 25 }),
    ).rejects.toMatchObject({ error: 'BlobTooLarge' })
    expect(sent).toBeLessThan(10)
  })
})

describe('blob CID', () => {
  it('is CIDv1 raw sha2-256', async () => {
    const cid = await blobCidFromBytes(new Uint8Array([1, 2, 3, 4]))
    expect(cid.startsWith('bafk')).toBe(true)
  })
})
