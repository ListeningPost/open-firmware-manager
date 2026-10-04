import { promises as dns } from 'node:dns'
import { isDid } from './uri.js'

export interface DidDocument {
  id: string
  alsoKnownAs?: string[]
  verificationMethod?: Array<{ id: string; type: string; publicKeyMultibase?: string }>
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>
}

export interface ResolvedIdentity {
  did: string
  handle?: string
  pds: string
  document: DidDocument
}

function normalizePds(pds: string): string {
  return pds.replace(/\/$/, '')
}

export async function resolveHandle(
  handle: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const h = handle.replace(/^@/, '').trim().toLowerCase()
  try {
    const txts = await dns.resolveTxt(`_atproto.${h}`)
    for (const row of txts) {
      const joined = row.join('')
      const m = /^did=(did:.+)$/.exec(joined)
      if (m?.[1] && isDid(m[1])) return m[1]
    }
  } catch {
    /* fall through */
  }
  try {
    const res = await fetchImpl(`https://${h}/.well-known/atproto-did`, {
      headers: { accept: 'text/plain' },
    })
    if (res.ok) {
      const did = (await res.text()).trim()
      if (isDid(did)) return did
    }
  } catch {
    /* fall through */
  }
  throw new Error(`could not resolve handle ${handle} to a DID`)
}

export async function resolveDidDocument(
  did: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DidDocument> {
  if (!isDid(did)) throw new Error(`not a DID: ${did}`)
  if (did.startsWith('did:plc:')) {
    const res = await fetchImpl(`https://plc.directory/${did}`)
    if (!res.ok) throw new Error(`plc resolve failed: ${res.status}`)
    return (await res.json()) as DidDocument
  }
  if (did.startsWith('did:web:')) {
    const rest = did.slice('did:web:'.length)
    const segs = rest.split(':').map((s) => decodeURIComponent(s))
    const host = segs[0]!
    const path =
      segs.length === 1
        ? '/.well-known/did.json'
        : `/${segs.slice(1).join('/')}/did.json`
    const res = await fetchImpl(`https://${host}${path}`)
    if (!res.ok) throw new Error(`did:web resolve failed: ${res.status}`)
    return (await res.json()) as DidDocument
  }
  throw new Error(`unsupported DID method: ${did}`)
}

export function pdsFromDidDocument(doc: DidDocument): string {
  const svc = doc.service?.find(
    (s) =>
      s.type === 'AtprotoPersonalDataServer' ||
      s.id.endsWith('#atproto_pds') ||
      s.id === '#atproto_pds',
  )
  if (!svc?.serviceEndpoint) {
    throw new Error(`DID ${doc.id} has no AtprotoPersonalDataServer`)
  }
  return normalizePds(svc.serviceEndpoint)
}

export async function resolveIdentity(
  identifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedIdentity> {
  const did = identifier.startsWith('did:')
    ? identifier
    : await resolveHandle(identifier, fetchImpl)
  const document = await resolveDidDocument(did, fetchImpl)
  const pds = pdsFromDidDocument(document)
  const aka = document.alsoKnownAs?.find((x) => x.startsWith('at://'))
  return {
    did: document.id,
    handle: aka ? aka.slice('at://'.length) : undefined,
    pds,
    document,
  }
}
