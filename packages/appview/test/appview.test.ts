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
})
