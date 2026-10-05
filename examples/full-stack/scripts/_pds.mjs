#!/usr/bin/env node
/**
 * Small read/write helpers for the demo shell scripts, so they need no jq.
 * Talks plain XRPC to the local PDS (OFW_PDS, default http://127.0.0.1:2583).
 */
const PDS = (process.env.OFW_PDS || 'http://127.0.0.1:2583').replace(/\/$/, '')
const COL = {
  release: 'app.openfirmware.firmware.release',
  gate: 'app.openfirmware.firmware.gate',
  channel: 'app.openfirmware.firmware.channel',
  ack: 'app.openfirmware.firmware.pipelineAck',
}

async function xrpcGet(nsid, params) {
  const u = new URL(`${PDS}/xrpc/${nsid}`)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
  const res = await fetch(u, { signal: AbortSignal.timeout(8000) })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { message: text }
  }
  return { ok: res.ok, status: res.status, json }
}

async function xrpcPost(nsid, body, token) {
  const res = await fetch(`${PDS}/xrpc/${nsid}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${nsid} ${res.status} ${JSON.stringify(json)}`)
  return json
}

async function listRecords(repo, collection) {
  const out = []
  let cursor
  for (let i = 0; i < 200; i++) {
    const r = await xrpcGet('com.atproto.repo.listRecords', { repo, collection, limit: '100', cursor })
    if (!r.ok) throw new Error(`listRecords ${collection} ${r.status} ${JSON.stringify(r.json)}`)
    out.push(...(r.json.records || []))
    if (!r.json.cursor || r.json.cursor === cursor || !(r.json.records || []).length) break
    cursor = r.json.cursor
  }
  return out
}

async function getRecord(repo, collection, rkey) {
  const r = await xrpcGet('com.atproto.repo.getRecord', { repo, collection, rkey })
  return r.ok ? r.json : null
}

function semverParts(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function cmpParts(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const commands = {
  /** did <handle> */
  async did([handle]) {
    const r = await xrpcGet('com.atproto.identity.resolveHandle', { handle })
    if (!r.ok || !r.json.did) throw new Error(`cannot resolve ${handle}: ${JSON.stringify(r.json)}`)
    console.log(r.json.did)
  },

  /**
   * next-version <publisherDid> <product>
   * One patch above the highest version ever published for the product, so a
   * demo can be repeated without colliding with (immutable) earlier releases.
   */
  async 'next-version'([did, product]) {
    let max = [1, 0, 0]
    for (const r of await listRecords(did, COL.release)) {
      if (r.value?.product !== product) continue
      const p = semverParts(r.value.version)
      if (p && cmpParts(p, max) > 0) max = p
    }
    // Releases from before this scheme used a timestamp as the minor version.
    console.log(`${max[0]}.${max[1]}.${max[2] + 1}`)
  },

  /** live-version <publisherDid> <product> <channel> : what the channel pointer names */
  async 'live-version'([did, product, channel]) {
    const rkey = `${product}-${channel}`
    const rec = await getRecord(did, COL.channel, rkey)
    console.log(rec?.value?.version ?? '')
  },

  /** gate <publisherDid> <rkey> : gate state, or "missing" */
  async gate([did, rkey]) {
    const rec = await getRecord(did, COL.gate, rkey)
    console.log(rec?.value?.state ?? 'missing')
  },

  /** release-ref <publisherDid> <rkey> : "<uri> <cid>" */
  async 'release-ref'([did, rkey]) {
    const rec = await getRecord(did, COL.release, rkey)
    if (!rec) throw new Error(`no release ${rkey}`)
    console.log(`${rec.uri} ${rec.cid}`)
  },

  /**
   * wait-acks <publisherDid> <rkey> <attesterDid> <stages,csv> <timeoutSec>
   * Prints each stage as the attester's ack for this exact release CID appears.
   */
  async 'wait-acks'([did, rkey, attester, stagesCsv, timeout]) {
    const rel = await getRecord(did, COL.release, rkey)
    if (!rel) throw new Error(`no release ${rkey}`)
    const stages = stagesCsv.split(',')
    const seen = new Set()
    const deadline = Date.now() + Number(timeout || 60) * 1000
    for (;;) {
      const acks = (await listRecords(attester, COL.ack)).filter(
        (a) => a.value?.release?.uri === rel.uri && a.value?.release?.cid === rel.cid,
      )
      for (const a of acks.sort((x, y) => (x.value.createdAt < y.value.createdAt ? -1 : 1))) {
        const key = `${a.value.stage}`
        if (seen.has(key)) continue
        seen.add(key)
        console.log(`   ack  stage=${a.value.stage}  result=${a.value.result}  by=${attester}`)
        console.log(`        ${a.uri}`)
      }
      if (stages.every((s) => seen.has(s))) return
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for acks (${stages.filter((s) => !seen.has(s)).join(', ')} missing). Is pipeline-runner up? docker compose logs pipeline-runner`,
        )
      }
      await sleep(300)
    }
  },

  /** message <demoSiteUrl> : what the demo site is serving right now */
  async message([base]) {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/message`, {
      signal: AbortSignal.timeout(5000),
    })
    console.log((await res.json()).message)
  },

  /**
   * tamper-release <identifier> <rkey> <newSha256Hex>
   * What an attacker with the publisher's PDS password can do WITHOUT ofw:
   * rewrite an already-published release record in place (password from
   * OFW_PASSWORD). Prints "<old cid> <new cid>".
   */
  async 'tamper-release'([identifier, rkey, sha]) {
    const sess = await xrpcPost('com.atproto.server.createSession', {
      identifier,
      password: process.env.OFW_PASSWORD,
    })
    const rec = await getRecord(sess.did, COL.release, rkey)
    if (!rec) throw new Error(`no release ${rkey}`)
    const value = { ...rec.value, imageSha256: sha, changelog: 'rewritten in place' }
    const put = await xrpcPost(
      'com.atproto.repo.putRecord',
      { repo: sess.did, collection: COL.release, rkey, record: value },
      sess.accessJwt,
    )
    console.log(`${rec.cid} ${put.cid}`)
  },
}

const [cmd, ...args] = process.argv.slice(2)
if (!commands[cmd]) {
  console.error(`usage: _pds.mjs <${Object.keys(commands).join('|')}> …`)
  process.exit(64)
}
commands[cmd](args).catch((e) => {
  console.error(`_pds ${cmd}: ${e.message || e}`)
  process.exit(1)
})
