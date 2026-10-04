/**
 * Control plane entrypoint: environment → options → listen.
 */
import http from 'node:http'
import { createControlPlane } from './app.js'
import { FileStore } from './store.js'

function envNumber(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`ignoring ${name}=${raw}: not a positive number`)
    return undefined
  }
  return n
}

const PORT = Number(process.env.PORT || 8787)
const DATA_FILE = process.env.DATA_FILE || '/data/control-store.json'
const CORS_ORIGIN = process.env.OFW_CORS_ORIGIN || ''

// OFW_ADMIN_TOKEN, when set, always wins over the token in an existing store.
const store = new FileStore(DATA_FILE, { adminToken: process.env.OFW_ADMIN_TOKEN })

const server = http.createServer(
  createControlPlane({
    store,
    corsOrigin: CORS_ORIGIN,
    maxSkewMs: envNumber('OFW_AUTH_SKEW_MS'),
    maxBodyBytes: envNumber('OFW_MAX_BODY_BYTES'),
    maxPendingJoins: envNumber('OFW_MAX_PENDING_JOINS'),
    joinTtlMs: envNumber('OFW_JOIN_TTL_MS'),
  }),
)

server.listen(PORT, async () => {
  const data = await store.load()
  console.log(`control plane listening on :${PORT}`)
  console.log(`job-signing public key (pin on devices): ${data.controlKey.ed25519PublicKey}`)
  if (CORS_ORIGIN === '*') {
    console.warn('WARNING: OFW_CORS_ORIGIN=* lets any website call this API from a browser')
  }
  if (process.env.OFW_REVEAL_ADMIN_TOKEN === '1') {
    console.log(`admin token: ${data.adminToken}`)
  } else if (process.env.OFW_ADMIN_TOKEN) {
    console.log('admin token taken from OFW_ADMIN_TOKEN')
  } else {
    console.log(
      'admin token was generated; set OFW_ADMIN_TOKEN, or OFW_REVEAL_ADMIN_TOKEN=1 to print it here',
    )
  }
})
