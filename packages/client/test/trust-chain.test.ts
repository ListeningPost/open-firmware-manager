import { describe, expect, it } from 'vitest'
import { OpenFirmwareClient, type ClientOptions } from '../src/index.js'
import { blobCidFromBytes } from '@open-firmware/atproto-lite'
import {
  COLLECTIONS,
  chunkBytes,
  generateOemKey,
  signRelease,
} from '@open-firmware/core'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const AUTHOR = 'did:plc:author'
const CI = 'did:plc:ci'
const RKEY = 'demo-1.0.0-stable'
const RELEASE_URI = `at://${AUTHOR}/${COLLECTIONS.release}/${RKEY}`
const RELEASE_CID = 'bafyrel'

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Stored {
  cid: string
  value: Record<string, unknown>
}

/**
 * In-memory PDS. `records` is keyed by `${did}/${collection}/${rkey}`.
 * Like a hostile server, getRecord ignores the `cid` query parameter.
 */
class FakePds {
  records = new Map<string, Stored>()
  blobs = new Map<string, Uint8Array>()
  /** Return a Response (or throw) to hijack a request. */
  intercept?: (url: URL) => Response | undefined
  calls: string[] = []

  put(did: string, collection: string, rkey: string, value: Record<string, unknown>, cid: string) {
    this.records.set(`${did}/${collection}/${rkey}`, { cid, value })
  }

  delete(did: string, collection: string, rkey: string) {
    this.records.delete(`${did}/${collection}/${rkey}`)
  }

  fetch: typeof fetch = async (input) => {
    const url = new URL(String(input))
    const q = url.searchParams
    this.calls.push(
      `${url.pathname.split('/').pop()}:${q.get('collection') ?? q.get('cid') ?? ''}`,
    )
    const hijacked = this.intercept?.(url)
    if (hijacked) return hijacked
    if (url.pathname.endsWith('com.atproto.repo.getRecord')) {
      const key = `${q.get('repo')}/${q.get('collection')}/${q.get('rkey')}`
      const hit = this.records.get(key)
      if (!hit) {
        return jsonRes(400, {
          error: 'RecordNotFound',
          message: `Could not locate record: at://${key}`,
        })
      }
      return jsonRes(200, { uri: `at://${key}`, cid: hit.cid, value: hit.value })
    }
    if (url.pathname.endsWith('com.atproto.repo.listRecords')) {
      const prefix = `${q.get('repo')}/${q.get('collection')}/`
      const records = [...this.records.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ uri: `at://${k}`, cid: v.cid, value: v.value }))
      return jsonRes(200, { records })
    }
    if (url.pathname.endsWith('com.atproto.sync.getBlob')) {
      const data = this.blobs.get(q.get('cid') ?? '')
      if (!data) return jsonRes(404, { error: 'BlobNotFound' })
      return new Response(data, { status: 200 })
    }
    return jsonRes(404, { error: 'NotFound' })
  }
}

interface Fixture {
  pds: FakePds
  payload: Uint8Array
  release: Record<string, unknown>
  blobCids: string[]
  client: (opts?: Partial<ClientOptions>) => OpenFirmwareClient
  outDir: string
}

/** A complete, ready, pointer-published release that installs cleanly. */
async function fixture(
  over: Record<string, unknown> = {},
): Promise<Fixture> {
  const pds = new FakePds()
  const payload = new Uint8Array(40).map((_, i) => i)
  const planned = chunkBytes(payload, { chunkSize: 16 })
  const parts = []
  const blobCids: string[] = []
  for (const c of planned.chunks) {
    const cid = await blobCidFromBytes(c.data)
    blobCids.push(cid)
    pds.blobs.set(cid, c.data)
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
  const release: Record<string, unknown> = {
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
    ...over,
  }
  pds.put(AUTHOR, COLLECTIONS.release, RKEY, release, RELEASE_CID)
  pds.put(
    AUTHOR,
    COLLECTIONS.gate,
    RKEY,
    {
      $type: COLLECTIONS.gate,
      release: { uri: RELEASE_URI, cid: RELEASE_CID },
      state: 'ready',
      updatedAt: new Date().toISOString(),
    },
    'bafygate',
  )
  pds.put(
    AUTHOR,
    COLLECTIONS.channel,
    'demo-stable',
    {
      $type: COLLECTIONS.channel,
      product: 'demo',
      channel: 'stable',
      version: '1.0.0',
      updatedAt: new Date().toISOString(),
      release: { uri: RELEASE_URI, cid: RELEASE_CID },
    },
    'bafych',
  )
  const outDir = await mkdtemp(path.join(tmpdir(), 'ofw-trust-'))
  return {
    pds,
    payload,
    release,
    blobCids,
    outDir,
    client: (opts = {}) =>
      new OpenFirmwareClient({
        pds: 'http://pds.test',
        authorDid: AUTHOR,
        fetch: pds.fetch,
        ...opts,
      }),
  }
}

function setGate(pds: FakePds, state: string, cid = RELEASE_CID) {
  pds.put(
    AUTHOR,
    COLLECTIONS.gate,
    RKEY,
    {
      $type: COLLECTIONS.gate,
      release: { uri: RELEASE_URI, cid },
      state,
      updatedAt: new Date().toISOString(),
    },
    'bafygate2',
  )
}

function setPointer(pds: FakePds, over: Record<string, unknown>) {
  const cur = pds.records.get(`${AUTHOR}/${COLLECTIONS.channel}/demo-stable`)!
  pds.put(AUTHOR, COLLECTIONS.channel, 'demo-stable', { ...cur.value, ...over }, 'bafych2')
}

function addAck(
  pds: FakePds,
  repo: string,
  stage: string,
  result: string,
  cid = RELEASE_CID,
) {
  pds.put(
    repo,
    COLLECTIONS.pipelineAck,
    `ack-${stage}-${pds.records.size}`,
    {
      $type: COLLECTIONS.pipelineAck,
      release: { uri: RELEASE_URI, cid },
      stage,
      result,
      createdAt: '2026-01-02T00:00:00Z',
      actor: repo,
    },
    `bafyack${pds.records.size}`,
  )
}

describe('happy path', () => {
  it('pullIfNewer follows the pointer, verifies, and writes the image', async () => {
    const f = await fixture()
    const applied = await f.client().pullIfNewer({ product: 'demo', outDir: f.outDir })
    expect(applied?.version).toBe('1.0.0')
    expect(applied?.cid).toBe(RELEASE_CID)
    expect(applied?.path).toBe(path.join(f.outDir, 'demo-1.0.0.bin'))
    expect(new Uint8Array(await readFile(applied!.path))).toEqual(f.payload)
  })

  it('pullIfNewer returns null when already on the pointed version', async () => {
    const f = await fixture()
    await expect(
      f.client().pullIfNewer({ product: 'demo', currentVersion: '1.0.0', outDir: f.outDir }),
    ).resolves.toBeNull()
  })
})

describe('tampered content', () => {
  it('rejects a part whose bytes were swapped', async () => {
    const f = await fixture()
    f.pds.blobs.set(f.blobCids[1]!, new Uint8Array(16).fill(0xee))
    await expect(
      f.client().pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/part 1 digest mismatch/)
  })

  it('rejects a part that is longer than the release declares', async () => {
    const f = await fixture()
    f.pds.blobs.set(f.blobCids[0]!, new Uint8Array(4096))
    await expect(
      f.client().pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toMatchObject({ error: 'BlobTooLarge' })
  })

  it('rejects a truncated part', async () => {
    const f = await fixture()
    f.pds.blobs.set(f.blobCids[0]!, new Uint8Array(3))
    await expect(
      f.client().pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/part 0 length mismatch/)
  })
})

describe('channel pointer binding', () => {
  it('rejects a pointer that names a different product', async () => {
    const f = await fixture()
    setPointer(f.pds, { product: 'other' })
    await expect(f.client().resolveLatest({ product: 'demo' })).rejects.toThrow(
      /channel pointer mismatch/,
    )
  })

  it('rejects a pointer whose release is for a different product', async () => {
    const f = await fixture({ product: 'door-lock' })
    await expect(
      f.client().pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/channel pointer mismatch.*door-lock/)
  })

  it('rejects a pointer whose release is on a different channel', async () => {
    const f = await fixture({ channel: 'dev' })
    await expect(
      f.client().pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/channel pointer mismatch.*dev/)
  })

  it('rejects a pointer to a non-release collection', async () => {
    const f = await fixture()
    setPointer(f.pds, {
      release: { uri: `at://${AUTHOR}/${COLLECTIONS.gate}/${RKEY}`, cid: 'bafygate' },
    })
    await expect(f.client().resolveLatest({ product: 'demo' })).rejects.toThrow(
      /not a release URI/,
    )
  })

  it('rejects a pointer to an untrusted author', async () => {
    const f = await fixture()
    setPointer(f.pds, {
      release: { uri: `at://did:plc:evil/${COLLECTIONS.release}/${RKEY}`, cid: 'x' },
    })
    await expect(f.client().resolveLatest({ product: 'demo' })).rejects.toThrow(
      /trustedAuthors/,
    )
  })

  it('rejects a stale pointer and one that hides its age', async () => {
    const f = await fixture()
    setPointer(f.pds, { updatedAt: '2020-01-01T00:00:00Z', maxAgeSec: 10 ** 12 })
    const client = f.client({ maxChannelAgeSec: 3600 })
    await expect(client.resolveLatest({ product: 'demo' })).rejects.toThrow(/stale/)
    setPointer(f.pds, { updatedAt: undefined })
    await expect(client.resolveLatest({ product: 'demo' })).rejects.toThrow(/updatedAt/)
  })
})

describe('gate', () => {
  it.each(['awaiting-pipeline', 'failed', 'bogus-state'])(
    'does not install when the gate is %s',
    async (state) => {
      const f = await fixture()
      setGate(f.pds, state)
      const client = f.client()
      await expect(client.resolveLatest({ product: 'demo' })).resolves.toBeNull()
      await expect(
        client.pullIfNewer({ product: 'demo', outDir: f.outDir }),
      ).resolves.toBeNull()
      await expect(
        client.downloadVerified(RELEASE_URI, { outDir: f.outDir }),
      ).rejects.toThrow(/not installable/)
    },
  )

  it('fails closed when the gate fetch returns a server error', async () => {
    const f = await fixture()
    f.pds.intercept = (url) =>
      url.searchParams.get('collection') === COLLECTIONS.gate
        ? jsonRes(500, { error: 'InternalServerError', message: 'boom' })
        : undefined
    const client = f.client()
    await expect(client.resolveLatest({ product: 'demo' })).rejects.toThrow(
      /gate check failed/,
    )
    await expect(
      client.pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/gate check failed/)
    await expect(
      client.downloadVerified(RELEASE_URI, { outDir: f.outDir }),
    ).rejects.toThrow(/gate check failed/)
    expect(f.pds.calls.some((c) => c.startsWith('com.atproto.sync.getBlob'))).toBe(false)
  })

  it('fails closed when the gate fetch throws (network error / timeout)', async () => {
    const f = await fixture()
    f.pds.intercept = (url) => {
      if (url.searchParams.get('collection') === COLLECTIONS.gate) {
        throw new TypeError('fetch failed')
      }
      return undefined
    }
    await expect(
      f.client().pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/gate check failed/)
  })

  it('fails closed on a rate-limit style 400 that is not record-not-found', async () => {
    const f = await fixture()
    f.pds.intercept = (url) =>
      url.searchParams.get('collection') === COLLECTIONS.gate
        ? jsonRes(400, { error: 'InvalidRequest', message: 'bad repo' })
        : undefined
    await expect(
      f.client().pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/gate check failed/)
  })

  it('a missing gate is acceptable only when following the channel pointer', async () => {
    const f = await fixture()
    f.pds.delete(AUTHOR, COLLECTIONS.gate, RKEY)
    const client = f.client()
    const applied = await client.pullIfNewer({ product: 'demo', outDir: f.outDir })
    expect(applied?.version).toBe('1.0.0')
    await expect(
      client.downloadVerified(RELEASE_URI, { outDir: f.outDir }),
    ).rejects.toThrow(/not installable.*awaiting-pipeline/)
  })

  it('rejects a gate that vouches for a different release CID', async () => {
    const f = await fixture()
    setGate(f.pds, 'ready', 'bafyold')
    await expect(
      f.client().pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/gate record does not reference/)
  })
})

describe('OEM signature', () => {
  const signed = (key: { privateKeyPem: string; publicKey: string }, f: Fixture) => ({
    ...f.release,
    oemSignature: signRelease(
      key.privateKeyPem,
      {
        product: 'demo',
        version: '1.0.0',
        channel: 'stable',
        imageSha256: String(f.release.imageSha256),
        imageSize: Number(f.release.imageSize),
      },
      key.publicKey,
    ),
  })

  it('accepts a release signed by a trusted key', async () => {
    const oem = generateOemKey()
    const f = await fixture()
    f.pds.put(AUTHOR, COLLECTIONS.release, RKEY, signed(oem, f), RELEASE_CID)
    const applied = await f
      .client({ trustedOemKeys: [oem.publicKey] })
      .pullIfNewer({ product: 'demo', outDir: f.outDir })
    expect(applied?.version).toBe('1.0.0')
  })

  it('rejects an unsigned release when trusted keys are configured', async () => {
    const oem = generateOemKey()
    const f = await fixture()
    await expect(
      f
        .client({ trustedOemKeys: [oem.publicKey] })
        .pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/OEM_SIG_MISSING/)
    expect(f.pds.calls.some((c) => c.startsWith('com.atproto.sync.getBlob'))).toBe(false)
  })

  it('rejects a release signed by an untrusted key', async () => {
    const oem = generateOemKey()
    const attacker = generateOemKey()
    const f = await fixture()
    f.pds.put(AUTHOR, COLLECTIONS.release, RKEY, signed(attacker, f), RELEASE_CID)
    await expect(
      f
        .client({ trustedOemKeys: [oem.publicKey] })
        .pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/OEM_SIG_INVALID/)
  })

  it('rejects a self-signed release when a signature is required but no keys are trusted', async () => {
    const attacker = generateOemKey()
    const f = await fixture()
    f.pds.put(AUTHOR, COLLECTIONS.release, RKEY, signed(attacker, f), RELEASE_CID)
    await expect(
      f
        .client({ requireOemSignature: true })
        .pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/OEM_SIG_INVALID/)
  })

  it('rejects a trusted signature replayed onto a different image', async () => {
    const oem = generateOemKey()
    const f = await fixture()
    const rec = signed(oem, f)
    f.pds.put(
      AUTHOR,
      COLLECTIONS.release,
      RKEY,
      { ...rec, imageSha256: 'cd'.repeat(32) },
      RELEASE_CID,
    )
    await expect(
      f
        .client({ trustedOemKeys: [oem.publicKey] })
        .pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/OEM_SIG_INVALID/)
  })
})

describe('CID pinning', () => {
  it('rejects when the server returns a record other than the one the pointer pins', async () => {
    const f = await fixture()
    setPointer(f.pds, { release: { uri: RELEASE_URI, cid: 'bafyold' } })
    await expect(
      f.client().pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/release CID mismatch/)
  })

  it('downloadVerified honours an explicit CID pin', async () => {
    const f = await fixture()
    const client = f.client()
    await expect(
      client.downloadVerified(RELEASE_URI, { outDir: f.outDir, cid: 'bafyother' }),
    ).rejects.toThrow(/release CID mismatch/)
    const ok = await client.downloadVerified(RELEASE_URI, {
      outDir: f.outDir,
      cid: RELEASE_CID,
    })
    expect(ok.cid).toBe(RELEASE_CID)
  })

  it('pullIfNewer does not re-fetch the release without the pin', async () => {
    const f = await fixture()
    await f.client().pullIfNewer({ product: 'demo', outDir: f.outDir })
    const releaseFetches = f.pds.calls.filter(
      (c) => c === `com.atproto.repo.getRecord:${COLLECTIONS.release}`,
    )
    expect(releaseFetches).toHaveLength(1)
  })
})

describe('pipeline acks and attesters', () => {
  const strict = {
    requirePipelineAcks: true,
    pipelinePolicy: 'strict',
    requiredPipelineStages: ['build', 'test'],
  }

  it('acks issued for an earlier CID of the same URI do not count', async () => {
    const f = await fixture(strict)
    addAck(f.pds, AUTHOR, 'build', 'passed', 'bafyold')
    addAck(f.pds, AUTHOR, 'test', 'passed', 'bafyold')
    const client = f.client()
    await expect(client.resolveLatest({ product: 'demo' })).resolves.toBeNull()
    await expect(
      client.downloadVerified(RELEASE_URI, { outDir: f.outDir }),
    ).rejects.toThrow(/PIPELINE_INCOMPLETE/)
  })

  it('acks for the current CID do count', async () => {
    const f = await fixture(strict)
    addAck(f.pds, AUTHOR, 'build', 'passed')
    addAck(f.pds, AUTHOR, 'test', 'passed')
    const applied = await f.client().pullIfNewer({ product: 'demo', outDir: f.outDir })
    expect(applied?.version).toBe('1.0.0')
  })

  it('configured attesters are enforced even when the release says skipped', async () => {
    const f = await fixture()
    const client = f.client({ attesterDids: [CI] })
    await expect(client.resolveLatest({ product: 'demo' })).resolves.toBeNull()
    await expect(
      client.downloadVerified(RELEASE_URI, { outDir: f.outDir }),
    ).rejects.toThrow(/PIPELINE_INCOMPLETE/)
  })

  it('publisher self-acks do not satisfy configured attesters', async () => {
    const f = await fixture()
    addAck(f.pds, AUTHOR, 'build', 'passed')
    addAck(f.pds, AUTHOR, 'test', 'passed')
    await expect(
      f.client({ attesterDids: [CI] }).resolveLatest({ product: 'demo' }),
    ).resolves.toBeNull()
  })

  it('attester acks satisfy the consumer policy', async () => {
    const f = await fixture()
    addAck(f.pds, CI, 'build', 'passed')
    addAck(f.pds, CI, 'test', 'passed')
    const applied = await f
      .client({ attesterDids: [CI] })
      .pullIfNewer({ product: 'demo', outDir: f.outDir })
    expect(applied?.version).toBe('1.0.0')
  })

  it('consumer requiredPipelineStages cannot be narrowed by the release', async () => {
    const f = await fixture({ ...strict, requiredPipelineStages: ['lint'] })
    addAck(f.pds, CI, 'lint', 'passed')
    await expect(
      f
        .client({ attesterDids: [CI], requiredPipelineStages: ['build', 'security-scan'] })
        .resolveLatest({ product: 'demo' }),
    ).resolves.toBeNull()
  })
})

describe('record-supplied names and sizes', () => {
  it.each([
    ['product', '../../etc/cron.d/x'],
    ['product', 'a/b'],
    ['product', '.hidden'],
    ['product', ''],
    ['version', '1.0.0/../../x'],
    ['version', '..'],
    ['version', 'a\\b'],
  ])('rejects unsafe %s %j', async (field, value) => {
    const f = await fixture({ [field]: value })
    await expect(
      f.client().downloadVerified(RELEASE_URI, { outDir: f.outDir }),
    ).rejects.toThrow(/not a safe name/)
  })

  it('rejects an unknown artifact kind', async () => {
    const f = await fixture({ kind: 'rootkit' })
    await expect(
      f.client().downloadVerified(RELEASE_URI, { outDir: f.outDir }),
    ).rejects.toThrow(/unknown artifact kind/)
  })

  it('rejects an image larger than maxImageBytes before downloading', async () => {
    const f = await fixture()
    await expect(
      f.client({ maxImageBytes: 39 }).pullIfNewer({ product: 'demo', outDir: f.outDir }),
    ).rejects.toThrow(/IMAGE_TOO_LARGE/)
    expect(f.pds.calls.some((c) => c.startsWith('com.atproto.sync.getBlob'))).toBe(false)
  })
})
