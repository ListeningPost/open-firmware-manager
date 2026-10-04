import { describe, expect, it } from 'vitest'
import { OpenFirmwareClient } from '../src/index.js'
import { blobCidFromBytes } from '@open-firmware/atproto-lite'
import { COLLECTIONS, chunkBytes, sha256Hex } from '@open-firmware/core'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('OpenFirmwareClient', () => {
  it('resolves via channel pointer and verifies blob CID + digest', async () => {
    const payload = new Uint8Array(40).fill(7)
    const planned = chunkBytes(payload, { chunkSize: 16 })
    const parts = []
    for (const c of planned.chunks) {
      const cid = await blobCidFromBytes(c.data)
      parts.push({
        seq: c.seq,
        blob: {
          $type: 'blob',
          ref: { $link: cid },
          mimeType: 'application/octet-stream',
          size: c.byteLength,
        },
        sha256: c.sha256,
        byteOffset: c.byteOffset,
        byteLength: c.byteLength,
      })
    }
    const releaseUri =
      'at://did:plc:author/app.openfirmware.firmware.release/demo-1.0.0-stable'
    const releaseValue = {
      $type: COLLECTIONS.release,
      version: '1.0.0',
      product: 'demo',
      kind: 'package',
      createdAt: '2026-01-01T00:00:00Z',
      imageSha256: planned.imageSha256,
      imageSize: planned.imageSize,
      channel: 'stable',
      parts,
      requirePipelineAcks: false,
      pipelinePolicy: 'skipped',
    }

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('getRecord')) {
        const u = new URL(url)
        const col = u.searchParams.get('collection')
        const rkey = u.searchParams.get('rkey')
        if (col === COLLECTIONS.channel) {
          return jsonRes(200, {
            uri: `at://did:plc:author/${col}/${rkey}`,
            cid: 'bafych',
            value: {
              $type: COLLECTIONS.channel,
              product: 'demo',
              channel: 'stable',
              version: '1.0.0',
              updatedAt: new Date().toISOString(),
              release: { uri: releaseUri, cid: 'bafyrel' },
            },
          })
        }
        if (col === COLLECTIONS.release) {
          return jsonRes(200, {
            uri: releaseUri,
            cid: 'bafyrel',
            value: releaseValue,
          })
        }
        if (col === COLLECTIONS.gate) {
          return jsonRes(200, {
            uri: `at://did:plc:author/${col}/${rkey}`,
            cid: 'bafygate',
            value: {
              $type: COLLECTIONS.gate,
              release: { uri: releaseUri, cid: 'bafyrel' },
              state: 'ready',
              updatedAt: new Date().toISOString(),
            },
          })
        }
        return jsonRes(400, { error: 'RecordNotFound' })
      }
      if (url.includes('listRecords')) {
        return jsonRes(200, { records: [] })
      }
      if (url.includes('getBlob')) {
        const u = new URL(url)
        const cid = u.searchParams.get('cid')
        const part = parts.find((p) => p.blob.ref.$link === cid)
        if (!part) return jsonRes(404, { error: 'BlobNotFound' })
        const chunk = planned.chunks.find((c) => c.seq === part.seq)!
        return new Response(chunk.data, { status: 200 })
      }
      return jsonRes(404, { error: 'NotFound' })
    }

    const client = new OpenFirmwareClient({
      pds: 'http://pds.test',
      authorDid: 'did:plc:author',
      fetch: fetchImpl,
    })

    const latest = await client.resolveLatest({ product: 'demo' })
    expect(latest?.uri).toBe(releaseUri)

    const dir = await mkdtemp(path.join(tmpdir(), 'ofw-dl-'))
    const applied = await client.downloadVerified(releaseUri, { outDir: dir })
    expect(applied.imageSha256).toBe(planned.imageSha256)
    expect(applied.version).toBe('1.0.0')
    expect(sha256Hex(payload)).toBe(planned.imageSha256)
  })

  it('resolveLatest returns null when the channel pointer is missing', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'Could not locate record: at://did:plc:author/app.openfirmware.firmware.channel/demo-stable',
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      )
    const client = new OpenFirmwareClient({
      pds: 'http://pds.test',
      authorDid: 'did:plc:author',
      fetch: fetchImpl,
    })
    await expect(client.resolveLatest({ product: 'demo' })).resolves.toBeNull()
  })

  it('rejects untrusted DID in the at-uri', async () => {
    const client = new OpenFirmwareClient({
      pds: 'http://pds.test',
      authorDid: 'did:plc:author',
      trustedAuthors: ['did:plc:author'],
    })
    await expect(
      client.loadRelease(
        'at://did:plc:evil/app.openfirmware.firmware.release/x',
      ),
    ).rejects.toThrow(/trustedAuthors/)
  })
})
