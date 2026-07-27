import { describe, expect, it } from 'vitest'
import {
  auditPipelineAcks,
  isReleaseInstallable,
} from '../src/pipeline/index.js'
import type { PipelineAckRecord, ReleaseMeta } from '../src/types/index.js'

function baseRelease(
  over: Partial<ReleaseMeta> = {},
): ReleaseMeta {
  return {
    version: '1.0.0',
    product: 'app',
    kind: 'package',
    imageSha256: 'a'.repeat(64),
    imageSize: 10,
    chunkCount: 1,
    channel: 'stable',
    status: 'ready',
    authorDid: 'did:plc:author',
    uri: 'at://did:plc:author/app.openfirmware.firmware.release/app-1.0.0-stable',
    requirePipelineAcks: true,
    requiredPipelineStages: ['build', 'test'],
    pipelinePolicy: 'strict',
    ...over,
  }
}

function ack(
  stage: string,
  result: 'passed' | 'failed' | 'skipped',
  t = '2026-01-01T00:00:00Z',
): PipelineAckRecord {
  return {
    release: {
      uri: 'at://did:plc:author/app.openfirmware.firmware.release/app-1.0.0-stable',
      cid: 'bafy',
    },
    stage,
    result,
    createdAt: t,
  }
}

describe('auditPipelineAcks', () => {
  it('fails strict when stages missing', () => {
    const r = auditPipelineAcks(baseRelease(), [])
    expect(r.ok).toBe(false)
    expect(r.missingStages).toEqual(['build', 'test'])
  })

  it('passes strict when all stages passed', () => {
    const r = auditPipelineAcks(baseRelease(), [
      ack('build', 'passed', '2026-01-01T01:00:00Z'),
      ack('test', 'passed', '2026-01-01T02:00:00Z'),
    ])
    expect(r.ok).toBe(true)
    expect(r.missingStages).toEqual([])
  })

  it('fails when a stage failed', () => {
    const r = auditPipelineAcks(baseRelease(), [
      ack('build', 'passed'),
      ack('test', 'failed'),
    ])
    expect(r.ok).toBe(false)
    expect(r.failedStages).toContain('test')
  })

  it('allows skipPipelineCheck', () => {
    const r = auditPipelineAcks(baseRelease({ status: 'awaiting_pipeline' }), [], {
      skipPipelineCheck: true,
    })
    expect(r.policy).toBe('skipped')
    expect(r.ok).toBe(true)
  })

  it('skipped policy needs no acks', () => {
    const r = auditPipelineAcks(
      baseRelease({
        requirePipelineAcks: false,
        pipelinePolicy: 'skipped',
        requiredPipelineStages: [],
      }),
      [],
    )
    expect(r.ok).toBe(true)
    expect(r.requiredStages).toEqual([])
  })
})

describe('isReleaseInstallable', () => {
  it('requires status ready', () => {
    const r = isReleaseInstallable(
      baseRelease({ status: 'awaiting_pipeline' }),
      [ack('build', 'passed'), ack('test', 'passed')],
    )
    expect(r.installable).toBe(false)
  })

  it('installable when ready and pipeline ok', () => {
    const r = isReleaseInstallable(baseRelease({ status: 'ready' }), [
      ack('build', 'passed'),
      ack('test', 'passed'),
    ])
    expect(r.installable).toBe(true)
  })

  it('installable with skip even without acks', () => {
    const r = isReleaseInstallable(
      baseRelease({ status: 'ready' }),
      [],
      { skipPipelineCheck: true },
    )
    expect(r.installable).toBe(true)
  })
})
