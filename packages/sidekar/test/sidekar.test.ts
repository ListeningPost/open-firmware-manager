import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidekar, type SidekarConfig } from '../src/index.js'
import type { AppliedRelease } from '@open-firmware/client'
import {
  COLLECTIONS,
  chunkBytes,
  generateOemKey,
  signRelease,
} from '@open-firmware/core'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const AUTHOR = 'did:plc:author'
const CI = 'did:plc:ci'
const PAYLOAD = new TextEncoder().encode('hello from release payload, v1')

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** CIDv1 / raw / sha2-256, base32 — what a PDS assigns to an uploaded blob. */
function blobCid(data: Uint8Array): string {
  const bytes = Buffer.concat([
    Buffer.from([0x01, 0x55, 0x12, 0x20]),
    createHash('sha256').update(data).digest(),
  ])
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  let out = 'b'
  for (let i = 0; i < bits.length; i += 5) {
    out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  }
  return out
}

interface World {
  records: Map<string, { cid: string; value: Record<string, unknown> }>
  blobs: Map<string, Uint8Array>
  fetch: typeof fetch
  workDir: string
  target: string
  exec: ReturnType<typeof vi.fn>
  sidekar: (over?: Partial<SidekarConfig>) => Sidekar
  ack: (repo: string, stage: string) => void
  releaseUri: string
}

/** A PDS holding one ready, pointer-published release of `demo`. */
async function world(
  release: Record<string, unknown> = {},
  opts: { gate?: string; oem?: { privateKeyPem: string; publicKey: string } } = {},
): Promise<World> {
  const version = String(release.version ?? '1.0.0')
  const rkey = `demo-${version}-stable`
  const releaseUri = `at://${AUTHOR}/${COLLECTIONS.release}/${rkey}`
  const records: World['records'] = new Map()
  const blobs: World['blobs'] = new Map()
  const planned = chunkBytes(PAYLOAD, { chunkSize: 8 })
  const parts = planned.chunks.map((c) => {
    const cid = blobCid(c.data)
    blobs.set(cid, c.data)
    return {
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
    }
  })
  const value: Record<string, unknown> = {
    $type: COLLECTIONS.release,
    version,
    product: 'demo',
    kind: 'package',
    createdAt: '2026-01-01T00:00:00Z',
    imageSha256: planned.imageSha256,
    imageSize: planned.imageSize,
    channel: 'stable',
    parts,
    requirePipelineAcks: false,
    pipelinePolicy: 'skipped',
    ...release,
  }
  if (opts.oem) {
    value.oemSignature = signRelease(
      opts.oem.privateKeyPem,
      {
        product: 'demo',
        version,
        channel: 'stable',
        imageSha256: planned.imageSha256,
        imageSize: planned.imageSize,
      },
      opts.oem.publicKey,
    )
  }
  records.set(`${AUTHOR}/${COLLECTIONS.release}/${rkey}`, { cid: 'bafyrel', value })
  records.set(`${AUTHOR}/${COLLECTIONS.gate}/${rkey}`, {
    cid: 'bafygate',
    value: {
      $type: COLLECTIONS.gate,
      release: { uri: releaseUri, cid: 'bafyrel' },
      state: opts.gate ?? 'ready',
      updatedAt: new Date().toISOString(),
    },
  })
  records.set(`${AUTHOR}/${COLLECTIONS.channel}/demo-stable`, {
    cid: 'bafych',
    value: {
      $type: COLLECTIONS.channel,
      product: 'demo',
      channel: 'stable',
      version,
      updatedAt: new Date().toISOString(),
      release: { uri: releaseUri, cid: 'bafyrel' },
    },
  })

  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input))
    const q = url.searchParams
    if (url.pathname.endsWith('getRecord')) {
      const key = `${q.get('repo')}/${q.get('collection')}/${q.get('rkey')}`
      const hit = records.get(key)
      if (!hit) return jsonRes(400, { error: 'RecordNotFound' })
      return jsonRes(200, { uri: `at://${key}`, cid: hit.cid, value: hit.value })
    }
    if (url.pathname.endsWith('listRecords')) {
      const prefix = `${q.get('repo')}/${q.get('collection')}/`
      return jsonRes(200, {
        records: [...records.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({ uri: `at://${k}`, cid: v.cid, value: v.value })),
      })
    }
    if (url.pathname.endsWith('getBlob')) {
      const data = blobs.get(q.get('cid') ?? '')
      if (!data) return jsonRes(404, { error: 'BlobNotFound' })
      return new Response(data, { status: 200 })
    }
    return jsonRes(404, { error: 'NotFound' })
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'ofw-sidekar-'))
  const target = path.join(workDir, 'site', 'message.txt')
  const exec = vi.fn(async () => {})
  return {
    records,
    blobs,
    fetch: fetchImpl,
    workDir,
    target,
    exec,
    releaseUri,
    ack: (repo, stage) => {
      records.set(`${repo}/${COLLECTIONS.pipelineAck}/a${records.size}`, {
        cid: `bafyack${records.size}`,
        value: {
          $type: COLLECTIONS.pipelineAck,
          release: { uri: releaseUri, cid: 'bafyrel' },
          stage,
          result: 'passed',
          createdAt: '2026-01-02T00:00:00Z',
          actor: repo,
        },
      })
    },
    sidekar: (over = {}) =>
      new Sidekar({
        pds: 'http://pds.test',
        authorDid: AUTHOR,
        product: 'demo',
        workDir,
        packageTargetPath: target,
        exec,
        fetch: fetchImpl,
        ...over,
      }),
  }
}

async function expectNothingApplied(w: World, s: Sidekar) {
  expect(existsSync(w.target)).toBe(false)
  expect(w.exec).not.toHaveBeenCalled()
  expect(await s.readState()).toEqual({})
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('Sidekar.tick — apply', () => {
  it('verifies and applies a package release, then records state', async () => {
    const w = await world()
    const s = w.sidekar()
    const art = await s.tick()
    expect(art?.version).toBe('1.0.0')
    expect(new Uint8Array(await readFile(w.target))).toEqual(PAYLOAD)
    expect(await s.readState()).toMatchObject({
      appliedVersion: '1.0.0',
      appliedUri: w.releaseUri,
      appliedCid: 'bafyrel',
    })
    expect(w.exec).not.toHaveBeenCalled()
  })

  it('does not re-apply the version it is already on', async () => {
    const w = await world()
    const s = w.sidekar()
    await s.tick()
    const handler = vi.fn(async () => {})
    s.setApplyHandler('package', handler)
    await expect(s.tick()).resolves.toBeNull()
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not downgrade', async () => {
    const w = await world()
    const s = w.sidekar()
    await s.writeState({ appliedVersion: '2.0.0' })
    await expect(s.tick()).resolves.toBeNull()
    expect(existsSync(w.target)).toBe(false)
  })

  it('container kind runs docker load (and compose up) through the exec hook', async () => {
    const w = await world({ kind: 'container' })
    const s = w.sidekar({ composeProjectDir: '/srv/app' })
    const art = await s.tick()
    expect(w.exec).toHaveBeenNthCalledWith(1, 'docker', ['load', '-i', art!.path])
    expect(w.exec).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['compose', 'up', '-d', '--remove-orphans'],
      '/srv/app',
    )
    expect(art!.path.startsWith(path.join(w.workDir, 'downloads') + path.sep)).toBe(true)
    expect((await s.readState()).appliedVersion).toBe('1.0.0')
  })

  it('container kind is refused when dockerLoad is disabled', async () => {
    const w = await world({ kind: 'container' })
    const s = w.sidekar({ dockerLoad: false })
    await expect(s.tick()).rejects.toThrow(/dockerLoad/)
    await expectNothingApplied(w, s)
  })

  it('does not record state when the apply step fails, so the next tick retries', async () => {
    const w = await world({ kind: 'container' })
    w.exec.mockRejectedValueOnce(new Error('docker load exited 1'))
    const s = w.sidekar()
    await expect(s.tick()).rejects.toThrow(/docker load exited 1/)
    expect(await s.readState()).toEqual({})
    const art = await s.tick()
    expect(art?.version).toBe('1.0.0')
    expect((await s.readState()).appliedVersion).toBe('1.0.0')
  })

  it('uses a custom apply handler when one is registered', async () => {
    const w = await world({ kind: 'firmware' })
    const s = w.sidekar()
    const flash = vi.fn(async (_: AppliedRelease) => {})
    s.setApplyHandler('firmware', flash)
    await s.tick()
    expect(flash).toHaveBeenCalledOnce()
    expect(flash.mock.calls[0]![0].imageSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('Sidekar.tick — refusals', () => {
  it.each(['awaiting-pipeline', 'failed'])(
    'does nothing while the gate is %s',
    async (gate) => {
      const w = await world({}, { gate })
      const s = w.sidekar()
      await expect(s.tick()).resolves.toBeNull()
      await expectNothingApplied(w, s)
    },
  )

  it('refuses an unsigned release when trusted OEM keys are configured', async () => {
    const oem = generateOemKey()
    const w = await world()
    const s = w.sidekar({ trustedOemKeys: [oem.publicKey] })
    await expect(s.tick()).rejects.toThrow(/OEM_SIG_MISSING/)
    await expectNothingApplied(w, s)
  })

  it('refuses a release signed by a key that is not trusted', async () => {
    const oem = generateOemKey()
    const attacker = generateOemKey()
    const w = await world({}, { oem: attacker })
    const s = w.sidekar({ trustedOemKeys: [oem.publicKey] })
    await expect(s.tick()).rejects.toThrow(/OEM_SIG_INVALID/)
    await expectNothingApplied(w, s)
  })

  it('refuses a self-signed release when a signature is required without trusted keys', async () => {
    const attacker = generateOemKey()
    const w = await world({}, { oem: attacker })
    const s = w.sidekar({ requireOemSignature: true })
    await expect(s.tick()).rejects.toThrow(/OEM_SIG_INVALID/)
    await expectNothingApplied(w, s)
  })

  it('applies a release signed by a trusted OEM key', async () => {
    const oem = generateOemKey()
    const w = await world({}, { oem })
    const s = w.sidekar({ trustedOemKeys: [oem.publicKey] })
    expect((await s.tick())?.version).toBe('1.0.0')
  })

  it('with attesterDids, waits for attester acks even if the release declares no pipeline', async () => {
    const w = await world()
    const s = w.sidekar({ attesterDids: [CI] })
    await expect(s.tick()).resolves.toBeNull()

    // The publisher vouching for itself is not attestation.
    w.ack(AUTHOR, 'build')
    w.ack(AUTHOR, 'test')
    await expect(s.tick()).resolves.toBeNull()
    await expectNothingApplied(w, s)

    w.ack(CI, 'build')
    w.ack(CI, 'test')
    expect((await s.tick())?.version).toBe('1.0.0')
  })

  it('refuses tampered bytes', async () => {
    const w = await world()
    const first = [...w.blobs.keys()][0]!
    w.blobs.set(first, new Uint8Array(8).fill(0x41))
    const s = w.sidekar()
    await expect(s.tick()).rejects.toThrow(/digest mismatch/)
    await expectNothingApplied(w, s)
  })

  it('refuses a release for another product behind this product’s pointer', async () => {
    const w = await world({ product: 'other' })
    const s = w.sidekar()
    await expect(s.tick()).rejects.toThrow(/channel pointer mismatch/)
    await expectNothingApplied(w, s)
  })

  it('refuses a release whose product would escape the work dir', async () => {
    const w = await world({ product: '../../outside' })
    const s = w.sidekar()
    await expect(s.tick()).rejects.toThrow(/not a safe name/)
    await expectNothingApplied(w, s)
  })

  it('refuses an image over maxImageBytes', async () => {
    const w = await world()
    const s = w.sidekar({ maxImageBytes: 4 })
    await expect(s.tick()).rejects.toThrow(/IMAGE_TOO_LARGE/)
    await expectNothingApplied(w, s)
  })
})

describe('Sidekar apply dispatch (client stubbed)', () => {
  async function withArtifact(over: Partial<AppliedRelease>) {
    const w = await world()
    const s = w.sidekar()
    const file = path.join(w.workDir, 'art.bin')
    await writeFile(file, 'x')
    const art = {
      uri: w.releaseUri,
      cid: 'bafyrel',
      version: '1.0.0',
      product: 'demo',
      kind: 'package',
      imageSha256: 'a'.repeat(64),
      path: file,
      audit: {} as AppliedRelease['audit'],
      ...over,
    } as AppliedRelease
    vi.spyOn(s.client, 'pullIfNewer').mockResolvedValue(art)
    return { w, s }
  }

  it('rejects an unknown artifact kind instead of treating it as a package', async () => {
    const { w, s } = await withArtifact({ kind: 'mystery' as AppliedRelease['kind'] })
    await expect(s.tick()).rejects.toThrow(/no apply handler for kind mystery/)
    await expectNothingApplied(w, s)
  })

  it('rejects an artifact for a different product', async () => {
    const { w, s } = await withArtifact({ product: 'other' })
    await expect(s.tick()).rejects.toThrow(/refusing to apply other/)
    await expectNothingApplied(w, s)
  })

  it('bundle kind is applied as a package', async () => {
    const { w, s } = await withArtifact({ kind: 'bundle' })
    await s.tick()
    expect(await readFile(w.target, 'utf8')).toBe('x')
  })
})

describe('Sidekar config', () => {
  it('rejects an unsafe product name', () => {
    expect(
      () =>
        new Sidekar({ pds: 'http://pds.test', authorDid: AUTHOR, product: '../x' }),
    ).toThrow(/not a safe name/)
  })

  it('requires an OEM signature by default once trusted keys are set', async () => {
    const w = await world()
    expect(w.sidekar({ trustedOemKeys: ['k'] }).client.requireOemSignature).toBe(true)
    expect(w.sidekar().client.requireOemSignature).toBe(false)
    expect(w.sidekar({ attesterDids: [CI] }).client.pipelinePolicy).toBe('strict')
  })
})
