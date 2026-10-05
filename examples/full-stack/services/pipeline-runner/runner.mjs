/**
 * Demo CI attester (NOT Sidekar, NOT the publisher).
 *
 * Watches the publisher's repo for gates in `awaiting-pipeline`, "runs" each
 * required stage, and records the result as a pipelineAck in ITS OWN repo,
 * logged in as an independent account (ci-attester.pds.test). Each ack names the
 * release URI and CID, so it can never vouch for different bytes.
 *
 * It holds no publisher credentials, so it cannot change the gate or the
 * channel: promotion stays a publisher action (`ofw pipeline-promote
 * --attester-did <this DID>`), and Sidekar re-checks these acks itself.
 *
 * Any real CI does the same with `ofw pipeline-ack --author-did <publisher>`.
 *
 * Env:
 *   ONCE=1            process pending gates once and exit
 *   AUTO_ACK=0        only log; leave the acks to an external CI
 *   STAGE_DELAY_MS    pretend-work per stage (default 1200)
 */
import fs from 'node:fs'
import http from 'node:http'

const PDS_URL = (process.env.PDS_URL || process.env.OFW_PDS || 'http://pds:2583').replace(
  /\/$/,
  '',
)
const AUTHOR_DID_FILE = process.env.AUTHOR_DID_FILE || '/config/author.did'
const POLL_MS = Number(process.env.POLL_MS || 4000)
const STAGE_DELAY_MS = Number(process.env.STAGE_DELAY_MS || 1200)
const ONCE = process.env.ONCE === '1'
const AUTO_ACK = process.env.AUTO_ACK !== '0'
const DEFAULT_STAGES = (process.env.STAGES || 'build,test')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const CI_IDENTIFIER = process.env.OFW_CI_IDENTIFIER || 'ci-attester.pds.test'
const CI_PASSWORD = process.env.OFW_CI_PASSWORD || 'ci-pass-change-me'

const COL_RELEASE = 'app.openfirmware.firmware.release'
const COL_ACK = 'app.openfirmware.firmware.pipelineAck'
const COL_GATE = 'app.openfirmware.firmware.gate'

function log(...a) {
  console.log(new Date().toISOString(), '[ci-runner]', ...a)
}

function readAuthorDid() {
  if (process.env.AUTHOR_DID || process.env.OFW_AUTHOR_DID) {
    return process.env.AUTHOR_DID || process.env.OFW_AUTHOR_DID
  }
  try {
    return fs.readFileSync(AUTHOR_DID_FILE, 'utf8').trim() || null
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

/** CI account session; re-created when the PDS rejects the token. */
let session = null

async function login() {
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: CI_IDENTIFIER, password: CI_PASSWORD }),
  })
  if (!res.ok) throw new Error(`CI login as ${CI_IDENTIFIER} failed: ${await res.text()}`)
  session = await res.json()
  log('logged in as', CI_IDENTIFIER, session.did)
  return session
}

async function createAck(record) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = session || (await login())
    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.accessJwt}`,
      },
      body: JSON.stringify({ repo: s.did, collection: COL_ACK, record }),
    })
    if (res.ok) return res.json()
    const text = await res.text()
    if (attempt === 0 && (res.status === 401 || /ExpiredToken|InvalidToken/.test(text))) {
      session = null
      continue
    }
    throw new Error(`createRecord pipelineAck ${res.status} ${text}`)
  }
  throw new Error('createRecord pipelineAck: could not authenticate')
}

/** Gates already reported as waiting, so AUTO_ACK=0 does not repeat itself. */
const reported = new Set()
let idleLogged = false

async function processOnce() {
  const authorDid = readAuthorDid()
  if (!authorDid) {
    log('waiting for the publisher DID')
    return 0
  }

  const gates = await listRecords(authorDid, COL_GATE)
  const awaiting = gates.filter((g) => g.value?.state === 'awaiting-pipeline')
  if (!awaiting.length) {
    if (!idleLogged) log('idle: no release is awaiting the pipeline')
    idleLogged = true
    return 0
  }
  idleLogged = false

  const s = session || (await login())
  const myAcks = await listRecords(s.did, COL_ACK)

  let n = 0
  for (const gate of awaiting) {
    const rkey = gate.uri.split('/').pop()
    const relRes = await fetch(
      `${PDS_URL}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(authorDid)}&collection=${encodeURIComponent(COL_RELEASE)}&rkey=${encodeURIComponent(rkey)}`,
    )
    if (!relRes.ok) continue
    const rel = await relRes.json()
    // Attest the record the gate was created for, and only if it is still that record.
    if (gate.value?.release?.uri !== rel.uri || gate.value?.release?.cid !== rel.cid) {
      log('skip', rkey, '- gate does not reference the current release record')
      continue
    }
    const required = rel.value.requiredPipelineStages?.length
      ? rel.value.requiredPipelineStages
      : DEFAULT_STAGES
    const have = new Set(
      myAcks
        .filter((a) => a.value?.release?.uri === rel.uri && a.value?.release?.cid === rel.cid)
        .map((a) => String(a.value.stage)),
    )
    const todo = required.filter((stage) => !have.has(stage))
    if (!todo.length) continue // attested; waiting for the publisher to promote

    if (!AUTO_ACK) {
      if (!reported.has(rel.cid)) {
        log(rkey, 'needs', todo.join(','), '- AUTO_ACK=0, leaving it to external CI')
        reported.add(rel.cid)
      }
      continue
    }

    log('picked up', rkey, `v${rel.value.version}`, '- stages:', todo.join(', '))
    for (const stage of todo) {
      log(`  running ${stage} ...`)
      await new Promise((r) => setTimeout(r, STAGE_DELAY_MS))
      await createAck({
        $type: COL_ACK,
        release: { uri: rel.uri, cid: rel.cid },
        stage,
        result: 'passed',
        createdAt: new Date().toISOString(),
        summary: `demo CI: ${stage} passed`,
        actor: s.did,
      })
      log(`  ${stage} passed -> ack written to the CI repo (${s.did})`)
      n++
    }
    log('attested', rkey, '- the publisher can now promote it')
  }
  return n
}

if (!ONCE) {
  const healthPort = Number(process.env.HEALTH_PORT || 9091)
  http
    .createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          role: 'ci-attester',
          identity: CI_IDENTIFIER,
          did: session?.did ?? null,
          note: 'independent CI account; writes acks only, cannot promote or install',
          autoAck: AUTO_ACK,
        }),
      )
    })
    .listen(healthPort, () => log('health on :' + healthPort))
}

async function loop() {
  log('starting', { PDS_URL, CI_IDENTIFIER, AUTO_ACK, ONCE, STAGES: DEFAULT_STAGES.join(',') })
  let lastError = ''
  for (;;) {
    try {
      await processOnce()
      lastError = ''
    } catch (e) {
      const msg = String(e?.message || e)
      if (msg !== lastError) log('error', msg)
      lastError = msg
      if (ONCE) process.exit(1)
    }
    if (ONCE) {
      log('ONCE mode exit')
      process.exit(0)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

loop()
