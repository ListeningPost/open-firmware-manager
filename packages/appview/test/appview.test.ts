import { describe, expect, it } from 'vitest'
import { FirmwareAppView } from '../src/index.js'

describe('FirmwareAppView', () => {
  it('serves getLatest from ingested pointers', () => {
    const av = new FirmwareAppView()
    av.upsert({
      uri: 'at://did:plc:a/app.openfirmware.firmware.release/demo-1.0.0-stable',
      cid: 'bafy',
      repo: 'did:plc:a',
      product: 'demo',
      version: '1.0.0',
      channel: 'stable',
    })
    expect(av.getLatest('demo')?.version).toBe('1.0.0')
    const listed = av.listReleases({ product: 'demo' })
    expect(listed.releases).toHaveLength(1)
  })

  it('getLatest orders versions by semver, not as strings', () => {
    const av = new FirmwareAppView()
    for (const version of ['1.9.0', '1.10.0', '1.2.0', 'not-a-version']) {
      av.upsert({
        uri: `at://did:plc:a/app.openfirmware.firmware.release/demo-${version}-stable`,
        cid: 'bafy',
        repo: 'did:plc:a',
        product: 'demo',
        version,
        channel: 'stable',
      })
    }
    expect(av.getLatest('demo')?.version).toBe('1.10.0')
  })
})
