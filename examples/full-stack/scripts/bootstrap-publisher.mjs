/**
 * Create publisher account on the local PDS and write credentials + DID for Sidekar.
 * Runs as a one-shot compose service.
 */
import fs from 'node:fs'

const PDS_URL = (process.env.PDS_URL || 'http://pds:2583').replace(/\/$/, '')
const HANDLE = process.env.OFW_HANDLE || 'publisher.pds.test'
const EMAIL = process.env.OFW_EMAIL || 'publisher@mail.test'
const PASSWORD = process.env.OFW_PASSWORD || 'publisher-pass-change-me'
const OUT_DIR = process.env.OUT_DIR || '/config'

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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  console.log('bootstrap: waiting for PDS', PDS_URL)
  await waitHealth()
  console.log('bootstrap: PDS healthy')

  let did
  const createRes = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: HANDLE, email: EMAIL, password: PASSWORD }),
  })
  const createBody = await createRes.json()

  if (createRes.ok && createBody.did) {
    did = createBody.did
    console.log('bootstrap: created', HANDLE, '→', did)
  } else {
    console.log('bootstrap: createAccount:', createBody.error || createBody.message || createBody)
    const sessRes = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: HANDLE, password: PASSWORD }),
    })
    const sess = await sessRes.json()
    if (!sessRes.ok || !sess.did) {
      throw new Error(`login failed: ${JSON.stringify(sess)}`)
    }
    did = sess.did
    console.log('bootstrap: existing', HANDLE, '→', did)
  }

  // Host-reachable PDS URL for ofw on the laptop
  const hostPds = process.env.HOST_PDS_URL || 'http://127.0.0.1:2583'

  fs.writeFileSync(`${OUT_DIR}/author.did`, did + '\n')
  fs.writeFileSync(
    `${OUT_DIR}/publisher.env`,
    [
      '# Local demo publisher — do not use in production',
      `OFW_PDS=${hostPds}`,
      `OFW_IDENTIFIER=${HANDLE}`,
      `OFW_PASSWORD=${PASSWORD}`,
      `OFW_AUTHOR_DID=${did}`,
      `AUTHOR_DID=${did}`,
      `PDS_URL=${hostPds}`,
      '',
    ].join('\n'),
  )

  console.log('bootstrap: wrote', `${OUT_DIR}/author.did`, 'and publisher.env')
  console.log('bootstrap: done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
