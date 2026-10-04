import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AtpClient } from '@open-firmware/atproto-lite'
import { OpenFirmwareHost } from '../src/index.js'
import { COLLECTIONS } from '@open-firmware/core'

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('OpenFirmwareHost', () => {
  it('writes an immutable release with parts and a channel pointer', async () => {
    const store = new Map<string, { cid: string; value: Record<string, unknown> }>()
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
    const file = path.join(dir, 'a.bin')
    await writeFile(file, Buffer.from('hello-open-firmware'))

    const res = await host.publishRelease({
      product: 'demo',
      version: '1.0.0',
      file,
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
})
