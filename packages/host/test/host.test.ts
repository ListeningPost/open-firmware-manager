import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AtpClient } from '@open-firmware/atproto-lite'
import { OpenFirmwareHost, ReleaseExistsError } from '../src/index.js'
import { COLLECTIONS } from '@open-firmware/core'

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

type Store = Map<string, { cid: string; value: Record<string, unknown> }>

async function fakeHost(): Promise<{
  host: OpenFirmwareHost
  store: Store
  file: (text: string) => Promise<string>
  uploads: () => number
}> {
    const store: Store = new Map()
    let blobs = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('createSession')) {
        return jsonRes(200, {
          did: 'did:plc:pub',
          handle: 'pub.test',
          accessJwt: 'a',
          refreshJwt: 'r',
        })
      }
      if (url.endsWith('uploadBlob')) {
        blobs++
        return jsonRes(200, {
          blob: {
            $type: 'blob',
            ref: { $link: `bafk${blobs}` },
            mimeType: 'application/octet-stream',
            size: (init?.body as Uint8Array)?.byteLength ?? 0,
          },
        })
      }
      if (url.includes('getRecord')) {
        const u = new URL(url)
        const key = `${u.searchParams.get('collection')}/${u.searchParams.get('rkey')}`
        const hit = store.get(key)
        if (!hit) return jsonRes(400, { error: 'RecordNotFound' })
        return jsonRes(200, {
          uri: `at://did:plc:pub/${key}`,
          cid: hit.cid,
          value: hit.value,
        })
      }
      if (url.includes('listRecords')) {
        const u = new URL(url)
        const prefix = `${u.searchParams.get('collection')}/`
        return jsonRes(200, {
          records: [...store.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => ({ uri: `at://did:plc:pub/${k}`, cid: v.cid, value: v.value })),
        })
      }
      if (url.endsWith('createRecord') || url.endsWith('putRecord')) {
        const payload = JSON.parse(String(init?.body)) as {
          collection: string
          rkey?: string
          record: Record<string, unknown>
          swapRecord?: string
        }
        const rkey = payload.rkey ?? `tid${store.size}`
        const key = `${payload.collection}/${rkey}`
        if (payload.swapRecord && store.get(key)?.cid !== payload.swapRecord) {
          return jsonRes(400, { error: 'InvalidSwap' })
        }
        if (url.endsWith('createRecord') && store.has(key)) {
          return jsonRes(400, { error: 'InvalidRequest', message: 'Record already exists' })
        }
        const cid = `bafy${store.size + 1}`
        store.set(key, { cid, value: payload.record })
        return jsonRes(200, {
          uri: `at://did:plc:pub/${key}`,
          cid,
        })
      }
      return jsonRes(404, { error: 'NotFound' })
    }

    const client = new AtpClient({ pds: 'http://pds.test', fetch: fetchImpl })
    await client.login('pub.test', 'pw')
    const host = OpenFirmwareHost.wrap(client)
    const dir = await mkdtemp(path.join(tmpdir(), 'ofw-host-'))
    let n = 0
    const file = async (text: string) => {
      const p = path.join(dir, `f${n++}.bin`)
      await writeFile(p, Buffer.from(text))
      return p
    }
    return { host, store, file, uploads: () => blobs }
}

describe('OpenFirmwareHost', () => {
  it('writes an immutable release with parts and a channel pointer', async () => {
    const { host, store, file } = await fakeHost()
    const res = await host.publishRelease({
      product: 'demo',
      version: '1.0.0',
      file: await file('hello-open-firmware'),
      chunkSize: 8,
      skipPipeline: true,
    })
    expect(res.gateState).toBe('ready')
    expect(res.partCount).toBeGreaterThan(0)
    const rel = store.get(`${COLLECTIONS.release}/demo-1.0.0-stable`)
    expect(rel?.value.parts).toBeTruthy()
    expect(Array.isArray(rel?.value.parts)).toBe(true)
    expect(rel?.value).not.toHaveProperty('status')
    const ch = store.get(`${COLLECTIONS.channel}/demo-stable`)
    expect(ch?.value.release).toBeTruthy()
  })

  it('refuses to republish an existing version and leaves the record untouched', async () => {
    const { host, store, file, uploads } = await fakeHost()
    await host.publishRelease({
      product: 'demo',
      version: '1.0.0',
      file: await file('original-bytes'),
      skipPipeline: true,
    })
    const key = `${COLLECTIONS.release}/demo-1.0.0-stable`
    const before = store.get(key)!
    const uploadsBefore = uploads()

    const again = host.publishRelease({
      product: 'demo',
      version: '1.0.0',
      file: await file('different-bytes'),
      skipPipeline: true,
    })
    await expect(again).rejects.toBeInstanceOf(ReleaseExistsError)
    await expect(again).rejects.toMatchObject({ code: 'RELEASE_EXISTS' })
    expect(store.get(key)).toBe(before)
    expect(uploads()).toBe(uploadsBefore)
  })

  it('a new version of the same product still publishes and moves the pointer', async () => {
    const { host, store, file } = await fakeHost()
    await host.publishRelease({
      product: 'demo',
      version: '1.0.0',
      file: await file('one'),
      skipPipeline: true,
    })
    const second = await host.publishRelease({
      product: 'demo',
      version: '1.0.1',
      file: await file('two'),
      skipPipeline: true,
    })
    const ch = store.get(`${COLLECTIONS.channel}/demo-stable`)
    expect(ch?.value.version).toBe('1.0.1')
    expect(ch?.value.release).toEqual(second.release)
  })

  it.each([
    ['product', '../evil'],
    ['version', '1.0.0/..'],
  ])('rejects an unsafe %s at publish time', async (field, value) => {
    const { host, file } = await fakeHost()
    await expect(
      host.publishRelease({
        product: 'demo',
        version: '1.0.0',
        file: await file('x'),
        skipPipeline: true,
        [field]: value,
      }),
    ).rejects.toThrow(/must match/)
  })

  it('pipeline: promotes only on acks bound to the current release CID', async () => {
    const { host, store, file } = await fakeHost()
    const res = await host.publishRelease({
      product: 'demo',
      version: '2.0.0',
      file: await file('strict'),
      requiredPipelineStages: ['build'],
    })
    expect(res.gateState).toBe('awaiting-pipeline')
    const gateKey = `${COLLECTIONS.gate}/${res.rkey}`

    // An ack left over from different bytes under the same URI.
    store.set(`${COLLECTIONS.pipelineAck}/stale`, {
      cid: 'bafystale',
      value: {
        $type: COLLECTIONS.pipelineAck,
        release: { uri: res.release.uri, cid: 'bafy-old-bytes' },
        stage: 'build',
        result: 'passed',
        createdAt: new Date().toISOString(),
        actor: 'did:plc:pub',
      },
    })
    await expect(host.tryPromoteRelease(res.rkey)).resolves.toBeNull()
    expect(store.get(gateKey)?.value.state).toBe('awaiting-pipeline')

    await host.postPipelineAck({ releaseRkey: res.rkey, stage: 'build', result: 'passed' })
    expect(store.get(gateKey)?.value.state).toBe('ready')
    expect(store.get(`${COLLECTIONS.channel}/demo-stable`)?.value.version).toBe('2.0.0')
  })
})
