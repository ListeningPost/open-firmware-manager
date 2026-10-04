/**
 * Untrusted AppView index for Open Firmware.
 * Clients must still getRecord the author PDS and run Phase A/B.
 */
import { AtpClient, parseAtUri, publicClient } from '@open-firmware/atproto-lite'
import { COLLECTIONS, channelRkey } from '@open-firmware/core'
import http from 'node:http'

export interface IndexedRelease {
  uri: string
  cid: string
  repo: string
  product: string
  version: string
  channel: string
  imageSha256?: string
  imageSize?: number
}

export class FirmwareAppView {
  private releases: IndexedRelease[] = []

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async ingestPublisher(pds: string, did: string): Promise<number> {
    const client = publicClient(pds, this.fetchImpl)
    const channels = await client.listRecords(did, COLLECTIONS.channel)
    let n = 0
    for (const ch of channels) {
      const rel = ch.value.release as { uri?: string; cid?: string }
      if (!rel?.uri) continue
      const parsed = parseAtUri(rel.uri)
      this.upsert({
        uri: rel.uri,
        cid: rel.cid ?? '',
        repo: parsed.did,
        product: String(ch.value.product),
        version: String(ch.value.version),
        channel: String(ch.value.channel),
      })
      n++
    }
    return n
  }

  upsert(row: IndexedRelease): void {
    this.releases = this.releases.filter((r) => r.uri !== row.uri)
    this.releases.push(row)
  }

  getLatest(product: string, channel = 'stable', repo?: string): IndexedRelease | undefined {
    return this.releases
      .filter(
        (r) =>
          r.product === product &&
          r.channel === channel &&
          (!repo || r.repo === repo),
      )
      .sort((a, b) => a.version < b.version ? 1 : -1)[0]
  }

  listReleases(filter: {
    product?: string
    channel?: string
    repo?: string
    limit?: number
    cursor?: string
  }): { releases: IndexedRelease[]; cursor?: string } {
    let rows = this.releases.filter((r) => {
      if (filter.product && r.product !== filter.product) return false
      if (filter.channel && r.channel !== filter.channel) return false
      if (filter.repo && r.repo !== filter.repo) return false
      return true
    })
    const start = filter.cursor ? Number(filter.cursor) || 0 : 0
    const limit = Math.min(filter.limit ?? 50, 100)
    const slice = rows.slice(start, start + limit)
    const next = start + slice.length
    return {
      releases: slice,
      cursor: next < rows.length ? String(next) : undefined,
    }
  }

  getRelease(uri: string): IndexedRelease | undefined {
    return this.releases.find((r) => r.uri === uri)
  }

  listen(port: number): http.Server {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`)
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      try {
        if (url.pathname === '/xrpc/app.openfirmware.firmware.getLatest') {
          const product = url.searchParams.get('product')
          if (!product) return send(400, { error: 'InvalidRequest', message: 'product required' })
          const hit = this.getLatest(
            product,
            url.searchParams.get('channel') || 'stable',
            url.searchParams.get('repo') || undefined,
          )
          if (!hit) return send(404, { error: 'NotFound' })
          return send(200, hit)
        }
        if (url.pathname === '/xrpc/app.openfirmware.firmware.listReleases') {
          return send(
            200,
            this.listReleases({
              product: url.searchParams.get('product') || undefined,
              channel: url.searchParams.get('channel') || undefined,
              repo: url.searchParams.get('repo') || undefined,
              limit: url.searchParams.get('limit')
                ? Number(url.searchParams.get('limit'))
                : undefined,
              cursor: url.searchParams.get('cursor') || undefined,
            }),
          )
        }
        if (url.pathname === '/xrpc/app.openfirmware.firmware.getRelease') {
          const uri = url.searchParams.get('uri')
          if (!uri) return send(400, { error: 'InvalidRequest' })
          const hit = this.getRelease(uri)
          if (!hit) return send(404, { error: 'NotFound' })
          return send(200, hit)
        }
        if (url.pathname === '/healthz') return send(200, { ok: true })
        return send(404, { error: 'MethodNotImplemented' })
      } catch (e) {
        return send(500, { error: 'InternalServerError', message: String(e) })
      }
    })
    server.listen(port)
    return server
  }
}

export { channelRkey, AtpClient }
