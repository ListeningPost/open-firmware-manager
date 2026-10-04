export interface ParsedAtUri {
  did: string
  collection: string
  rkey: string
}

export function parseAtUri(uri: string): ParsedAtUri {
  if (!uri.startsWith('at://')) {
    throw new Error(`not an at-uri: ${uri}`)
  }
  const rest = uri.slice('at://'.length)
  const parts = rest.split('/')
  if (parts.length < 3 || !parts[0]?.startsWith('did:') || !parts[1] || !parts[2]) {
    throw new Error(`malformed at-uri: ${uri}`)
  }
  return {
    did: parts[0],
    collection: parts[1],
    rkey: decodeURIComponent(parts.slice(2).join('/')),
  }
}

export function isDid(value: string): boolean {
  return /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value)
}

export function makeAtUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${encodeURIComponent(rkey).replace(/%2E/g, '.')}`
}
