/**
 * Minimal stand-in for a did:plc directory, for the offline demo stack only.
 *
 * The PDS registers each new account by POSTing a signed genesis operation to
 * the directory and later resolves the DID document from it. The public
 * directory (plc.directory) would make the demo depend on the internet and
 * would fill it with throwaway demo accounts, so this service accepts the
 * operation and serves the matching DID document from local storage.
 *
 * It does NOT verify operation signatures or keep an audit log. Never use it
 * outside this example.
 */
import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.env.PORT || 2582)
const DATA_FILE = process.env.DATA_FILE || '/data/plc.json'

/** did -> list of operations, oldest first */
let ops = {}
try {
  ops = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
} catch {
  // first start
}

function save() {
  const tmp = `${DATA_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(ops))
  fs.renameSync(tmp, DATA_FILE)
}

function log(...a) {
  console.log(new Date().toISOString(), '[mock-plc]', ...a)
}

function didDocument(did, op) {
  const key = String(op.verificationMethods?.atproto || '').replace(/^did:key:/, '')
  const pds = op.services?.atproto_pds
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
      'https://w3id.org/security/suites/secp256k1-2019/v1',
    ],
    id: did,
    alsoKnownAs: op.alsoKnownAs || [],
    verificationMethod: key
      ? [{ id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: key }]
      : [],
    service: pds
      ? [{ id: '#atproto_pds', type: pds.type, serviceEndpoint: pds.endpoint }]
      : [],
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://plc')
    const [first, second, third] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    try {
      if (url.pathname === '/_health') return send(res, 200, { version: 'mock-plc' })

      if (req.method === 'POST' && first?.startsWith('did:plc:') && !second) {
        const chunks = []
        let size = 0
        for await (const c of req) {
          size += c.length
          if (size > 64 * 1024) return send(res, 413, { message: 'operation too large' })
          chunks.push(c)
        }
        const op = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!op || typeof op !== 'object' || typeof op.type !== 'string') {
          return send(res, 400, { message: 'not an operation' })
        }
        ;(ops[first] ||= []).push(op)
        save()
        log('registered', first, (op.alsoKnownAs || []).join(','))
        return send(res, 200, {})
      }

      if (req.method === 'GET' && first?.startsWith('did:plc:')) {
        const list = ops[first]
        const last = list?.[list.length - 1]
        if (!last || last.type === 'plc_tombstone') {
          return send(res, 404, { message: `DID not registered: ${first}` })
        }
        if (!second) return send(res, 200, didDocument(first, last))
        if (second === 'data') {
          return send(res, 200, {
            did: first,
            verificationMethods: last.verificationMethods,
            rotationKeys: last.rotationKeys,
            alsoKnownAs: last.alsoKnownAs,
            services: last.services,
          })
        }
        if (second === 'log' && third === 'last') return send(res, 200, last)
        if (second === 'log') return send(res, 200, list)
      }
      send(res, 404, { message: 'not found' })
    } catch (e) {
      send(res, 400, { message: String(e?.message || e) })
    }
  })
  .listen(PORT, () => log(`listening on :${PORT} (demo only; data in ${DATA_FILE})`))
