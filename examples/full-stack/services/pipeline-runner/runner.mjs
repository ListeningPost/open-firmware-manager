/**
 * Generic pipeline / CI runner (NOT Sidekar).
 *
 * Watches the PDS for gates in awaiting-pipeline, simulates build+test,
 * and posts pipeline-ack records. Any external CI can do the same with ofw.
 *
 * Modes:
 *   ONCE=1          — process pending once and exit
 *   AUTO_ACK=1      — default: auto-pass build+test (demo)
 *   AUTO_ACK=0      — only log; wait for external ofw pipeline-ack
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'

const PDS_URL = (process.env.PDS_URL || process.env.OFW_PDS || 'http://pds:2583').replace(
  /\/$/,
  '',
)
const AUTHOR_DID_FILE = process.env.AUTHOR_DID_FILE || '/config/author.did'
const POLL_MS = Number(process.env.POLL_MS || 4000)
const ONCE = process.env.ONCE === '1'
const AUTO_ACK = process.env.AUTO_ACK !== '0'
const STAGES = (process.env.STAGES || 'build,test')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const OFW_BIN = process.env.OFW_BIN || 'ofw'
const IDENTIFIER = process.env.OFW_IDENTIFIER || 'publisher.pds.test'
const PASSWORD = process.env.OFW_PASSWORD || 'publisher-pass-change-me'
const HOST_PDS = process.env.HOST_PDS_URL || PDS_URL

const COL_RELEASE = 'app.openfirmware.firmware.release'
const COL_ACK = 'app.openfirmware.firmware.pipelineAck'
const COL_GATE = 'app.openfirmware.firmware.gate'
const COL_CHANNEL = 'app.openfirmware.firmware.channel'

function log(...a) {
  console.log(new Date().toISOString(), '[pipeline-runner]', ...a)
}

function readAuthorDid() {
  if (process.env.AUTHOR_DID || process.env.OFW_AUTHOR_DID) {
    return process.env.AUTHOR_DID || process.env.OFW_AUTHOR_DID
  }
  try {
    return fs.readFileSync(AUTHOR_DID_FILE, 'utf8').trim()
  } catch {
    return null
  }
}

async function listRecords(repo, collection) {
  const out = []
  let cursor
  const seen = new Set()
  for (let i = 0; i < 1000; i++) {
    const u = new URL(`${PDS_URL}/xrpc/com.atproto.repo.listRecords`)
    u.searchParams.set('repo', repo)
    u.searchParams.set('collection', collection)
    u.searchParams.set('limit', '100')
    if (cursor) u.searchParams.set('cursor', cursor)
    const res = await fetch(u)
    if (!res.ok) throw new Error(`listRecords ${collection} ${res.status}`)
    const j = await res.json()
    out.push(...(j.records || []))
    const next = j.cursor
    if (!next || next === cursor || seen.has(next)) break
    seen.add(next)
    cursor = next
  }
  return out
}

function rkeyFromUri(uri) {
  return uri.split('/').pop()
}

function ofwAck(rkey, stage, result) {
  // Prefer host ofw when mounted; otherwise use HTTP session via a tiny inline approach
  // We shell to ofw if available, else use createSession + createRecord via fetch.
  const which = spawnSync('which', [OFW_BIN], { encoding: 'utf8' })
  if (which.status === 0) {
    const args = [
      'pipeline-ack',
      '--pds',
      HOST_PDS,
      '--identifier',
      IDENTIFIER,
      '--password',
      PASSWORD,
      '--rkey',
      rkey,
      '--stage',
      stage,
      '--result',
      result,
      '--summary',
      `pipeline-runner auto ${stage}`,
    ]
    const r = spawnSync(OFW_BIN, args, { encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(r.stderr || r.stdout || `ofw failed ${r.status}`)
    }
    return r.stdout
  }
  return postAckViaXrpc(rkey, stage, result)
}

async function postAckViaXrpc(rkey, stage, result) {
  const sessRes = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD }),
  })
  if (!sessRes.ok) throw new Error(`createSession ${await sessRes.text()}`)
  const sess = await sessRes.json()

  const getRes = await fetch(
    `${PDS_URL}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(sess.did)}&collection=${encodeURIComponent(COL_RELEASE)}&rkey=${encodeURIComponent(rkey)}`,
  )
  if (!getRes.ok) throw new Error(`getRecord ${await getRes.text()}`)
  const rec = await getRes.json()

  const ack = {
    $type: COL_ACK,
    release: { uri: rec.uri, cid: rec.cid },
    stage,
    result,
    createdAt: new Date().toISOString(),
    summary: `pipeline-runner auto ${stage}`,
    actor: sess.did,
  }
  const createRes = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sess.accessJwt}`,
    },
    body: JSON.stringify({
      repo: sess.did,
      collection: COL_ACK,
      record: ack,
    }),
  })
  if (!createRes.ok) throw new Error(`createRecord ack ${await createRes.text()}`)

  // promote if complete
  const acks = await listRecords(sess.did, COL_ACK, 100)
  const required = rec.value.requiredPipelineStages?.length
    ? rec.value.requiredPipelineStages
    : STAGES
  const latest = new Map()
  for (const a of acks
    .filter((x) => x.value?.release?.uri === rec.uri)
    .sort((a, b) =>
      String(a.value.createdAt) < String(b.value.createdAt) ? -1 : 1,
    )) {
    latest.set(String(a.value.stage), String(a.value.result))
  }
  // include the one we just posted
  latest.set(stage, result)

  let allOk = true
  for (const s of required) {
    const r = latest.get(s)
    if (r !== 'passed' && r !== 'skipped') allOk = false
  }
  async function putSidecar(collection, sidecarRkey, record) {
    const existing = await fetch(
      `${PDS_URL}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(sess.did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(sidecarRkey)}`,
    )
    const prev = existing.ok ? await existing.json() : null
    const body = {
      repo: sess.did,
      collection,
      rkey: sidecarRkey,
      record,
    }
    if (prev?.cid) body.swapRecord = prev.cid
    const method = prev ? 'putRecord' : 'createRecord'
    if (!prev) body.rkey = sidecarRkey
    const r = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sess.accessJwt}`,
      },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`${method} ${collection} ${await r.text()}`)
  }

  if (result === 'failed') {
    await putSidecar(COL_GATE, rkey, {
      $type: COL_GATE,
      release: { uri: rec.uri, cid: rec.cid },
      state: 'failed',
      updatedAt: new Date().toISOString(),
    })
    return 'failed'
  }
  if (allOk) {
    await putSidecar(COL_GATE, rkey, {
      $type: COL_GATE,
      release: { uri: rec.uri, cid: rec.cid },
      state: 'ready',
      updatedAt: new Date().toISOString(),
    })
    const product = rec.value.product
    const channel = rec.value.channel || 'stable'
    const chRkey = `${product}-${channel}`.replace(/[^A-Za-z0-9._~-]+/g, '-')
    await putSidecar(COL_CHANNEL, chRkey, {
      $type: COL_CHANNEL,
      product,
      channel,
      release: { uri: rec.uri, cid: rec.cid },
      version: rec.value.version,
      updatedAt: new Date().toISOString(),
    })
    return 'promoted'
  }
  return 'acked'
}

async function processOnce() {
  const authorDid = readAuthorDid()
  if (!authorDid) {
    log('waiting for AUTHOR_DID')
    return 0
  }

  const gates = await listRecords(authorDid, COL_GATE)
  const awaiting = gates.filter((g) => g.value?.state === 'awaiting-pipeline')
  if (!awaiting.length) {
    log('no awaiting-pipeline gates')
    return 0
  }

  let n = 0
  for (const gate of awaiting) {
    const rkey = rkeyFromUri(gate.uri)
    const relRes = await fetch(
      `${PDS_URL}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(authorDid)}&collection=${encodeURIComponent(COL_RELEASE)}&rkey=${encodeURIComponent(rkey)}`,
    )
    if (!relRes.ok) continue
    const rel = await relRes.json()
    const required = rel.value.requiredPipelineStages?.length
      ? rel.value.requiredPipelineStages
      : STAGES
    const acks = await listRecords(authorDid, COL_ACK)
    const mine = acks.filter((a) => a.value?.release?.uri === rel.uri)
    const have = new Map()
    for (const a of mine) {
      have.set(String(a.value.stage), String(a.value.result))
    }

    log('found', rkey, 'needs', required.join(','))

    if (!AUTO_ACK) {
      log('AUTO_ACK=0 — not posting; use external CI / ofw pipeline-ack')
      continue
    }

    for (const stage of required) {
      const cur = have.get(stage)
      if (cur === 'passed' || cur === 'skipped') continue
      log('simulating stage', stage, 'for', rkey)
      // pretend to "run" the stage
      await new Promise((r) => setTimeout(r, 400))
      const out = await ofwAck(rkey, stage, 'passed')
      log('ack', stage, typeof out === 'string' ? out.trim().split('\n').pop() : out)
      have.set(stage, 'passed')
      n++
    }
  }
  return n
}

const healthPort = Number(process.env.HEALTH_PORT || 9091)
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        role: 'pipeline-runner',
        note: 'CI/validator container — NOT Sidekar (installer)',
        autoAck: AUTO_ACK,
      }),
    )
  })
  .listen(healthPort, () => log('health on :' + healthPort))

async function loop() {
  log('starting', { PDS_URL, AUTO_ACK, ONCE, STAGES: STAGES.join(',') })
  log('role: generic CI/validator runner container — NOT Sidekar')
  for (;;) {
    try {
      await processOnce()
    } catch (e) {
      log('error', e.message || e)
    }
    if (ONCE) {
      log('ONCE mode exit')
      process.exit(0)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

loop()
