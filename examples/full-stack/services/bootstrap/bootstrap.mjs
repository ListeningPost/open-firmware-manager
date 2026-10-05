/**
 * One-shot: create the two demo accounts on the local PDS and write their
 * DIDs to the shared /config volume.
 *
 *   publisher.pds.test  owns releases, gates and the channel pointer
 *   ci-attester.pds.test         independent CI attester; only writes pipeline acks
 *
 * Safe to run again: existing accounts are logged in to instead.
 */
import fs from 'node:fs'

const PDS_URL = (process.env.PDS_URL || 'http://pds:2583').replace(/\/$/, '')
const OUT_DIR = process.env.OUT_DIR || '/config'

const ACCOUNTS = [
  {
    role: 'publisher',
    file: 'author.did',
    handle: process.env.OFW_HANDLE || 'publisher.pds.test',
    email: process.env.OFW_EMAIL || 'publisher@mail.test',
    password: process.env.OFW_PASSWORD || 'publisher-pass-change-me',
  },
  {
    role: 'ci-attester',
    file: 'attester.did',
    handle: process.env.OFW_CI_HANDLE || 'ci-attester.pds.test',
    email: process.env.OFW_CI_EMAIL || 'ci@mail.test',
    password: process.env.OFW_CI_PASSWORD || 'ci-pass-change-me',
  },
]

async function post(nsid, body) {
  const res = await fetch(`${PDS_URL}/xrpc/${nsid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json = {}
  try {
    json = await res.json()
  } catch {
    // non-JSON error body
  }
  return { ok: res.ok, status: res.status, json }
}

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${PDS_URL}/xrpc/_health`)
      if (r.ok) return
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`PDS not healthy at ${PDS_URL}`)
}

async function ensureAccount(a) {
  // The PDS can answer health checks a moment before account creation works.
  let last
  for (let attempt = 1; attempt <= 10; attempt++) {
    const created = await post('com.atproto.server.createAccount', {
      handle: a.handle,
      email: a.email,
      password: a.password,
    })
    if (created.ok && created.json.did) {
      console.log(`bootstrap: created ${a.role} ${a.handle} -> ${created.json.did}`)
      return created.json.did
    }
    const session = await post('com.atproto.server.createSession', {
      identifier: a.handle,
      password: a.password,
    })
    if (session.ok && session.json.did) {
      console.log(`bootstrap: existing ${a.role} ${a.handle} -> ${session.json.did}`)
      return session.json.did
    }
    last = `createAccount ${created.status} ${JSON.stringify(created.json)}; createSession ${session.status} ${JSON.stringify(session.json)}`
    console.log(`bootstrap: ${a.handle} not ready (attempt ${attempt}): ${last}`)
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`could not create or log in ${a.handle}: ${last}`)
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  console.log('bootstrap: waiting for PDS', PDS_URL)
  await waitHealth()
  for (const a of ACCOUNTS) {
    const did = await ensureAccount(a)
    // Write-then-rename so readers never see a half-written file.
    const target = `${OUT_DIR}/${a.file}`
    fs.writeFileSync(`${target}.tmp`, did + '\n')
    fs.renameSync(`${target}.tmp`, target)
  }
  console.log(`bootstrap: wrote ${ACCOUNTS.map((a) => `${OUT_DIR}/${a.file}`).join(', ')}`)
  console.log('bootstrap: done')
}

main().catch((e) => {
  console.error('bootstrap: FAILED', e.message || e)
  process.exit(1)
})
