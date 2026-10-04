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
    actor: 'did:plc:author',
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
    const r = auditPipelineAcks(baseRelease({ status: 'awaiting-pipeline' }), [], {
      skipPipelineCheck: true,
    })
    expect(r.policy).toBe('skipped')
    expect(r.ok).toBe(true)
  })

  it('when attesterDids is set, ignores publisher self-acks', () => {
    const r = auditPipelineAcks(
      baseRelease(),
      [
        { ...ack('build', 'passed'), authorDid: 'did:plc:author', actor: 'did:plc:author' },
        { ...ack('test', 'passed'), authorDid: 'did:plc:author', actor: 'did:plc:author' },
      ],
      { attesterDids: ['did:plc:ci'] },
    )
    expect(r.ok).toBe(false)
    expect(r.missingStages).toEqual(['build', 'test'])
  })

  it('when attesterDids is set, accepts CI acks', () => {
    const r = auditPipelineAcks(
      baseRelease(),
      [
        { ...ack('build', 'passed'), authorDid: 'did:plc:ci', actor: 'did:plc:ci' },
        { ...ack('test', 'passed'), authorDid: 'did:plc:ci', actor: 'did:plc:ci' },
      ],
      { attesterDids: ['did:plc:ci'] },
    )
    expect(r.ok).toBe(true)
  })

  it('ignores acks that point at a different release', () => {
    const r = auditPipelineAcks(baseRelease(), [
      {
        ...ack('build', 'passed'),
        release: { uri: 'at://did:plc:author/app.openfirmware.firmware.release/other', cid: 'x' },
      },
      ack('build', 'passed'),
      ack('test', 'passed'),
    ])
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

describe('consumer-side pipeline policy', () => {
  const unguarded = () =>
    baseRelease({
      requirePipelineAcks: false,
      pipelinePolicy: 'skipped',
      requiredPipelineStages: [],
    })

  it('consumerMinPolicy cannot be lowered by the release record', () => {
    const r = auditPipelineAcks(unguarded(), [], {
      consumerMinPolicy: 'strict',
      attesterDids: ['did:plc:ci'],
    })
    expect(r.policy).toBe('strict')
    expect(r.ok).toBe(false)
    expect(r.missingStages).toEqual(['build', 'test'])
  })

  it('consumerMinPolicy is satisfied by attester acks', () => {
    const r = auditPipelineAcks(
      unguarded(),
      [
        { ...ack('build', 'passed'), authorDid: 'did:plc:ci' },
        { ...ack('test', 'passed'), authorDid: 'did:plc:ci' },
      ],
      { consumerMinPolicy: 'strict', attesterDids: ['did:plc:ci'] },
    )
    expect(r.ok).toBe(true)
  })

  it('consumer requiredStages override the release list', () => {
    const r = auditPipelineAcks(
      baseRelease({ requiredPipelineStages: ['lint'] }),
      [ack('lint', 'passed')],
      { requiredStages: ['build', 'security-scan'] },
    )
    expect(r.ok).toBe(false)
    expect(r.missingStages).toEqual(['build', 'security-scan'])
  })

  it('a release may still raise the policy above the consumer floor', () => {
    const r = auditPipelineAcks(baseRelease(), [], {
      consumerMinPolicy: 'optional',
    })
    expect(r.policy).toBe('strict')
  })

  it('ignores acks bound to a different release CID', () => {
    const r = auditPipelineAcks(baseRelease({ cid: 'bafynew' }), [
      ack('build', 'passed'),
      ack('test', 'passed'),
    ])
    expect(r.ok).toBe(false)
    expect(r.missingStages).toEqual(['build', 'test'])
  })

  it('accepts acks bound to the same release CID', () => {
    const r = auditPipelineAcks(baseRelease({ cid: 'bafy' }), [
      ack('build', 'passed'),
      ack('test', 'passed'),
    ])
    expect(r.ok).toBe(true)
  })

  it('with attesterDids, drops acks that carry no author at all', () => {
    const anon = (stage: string) =>
      ({ ...ack(stage, 'passed'), actor: undefined }) as unknown as PipelineAckRecord
    const r = auditPipelineAcks(baseRelease(), [anon('build'), anon('test')], {
      attesterDids: ['did:plc:ci'],
    })
    expect(r.ok).toBe(false)
  })
})

describe('isReleaseInstallable', () => {
  it('requires status ready', () => {
    const r = isReleaseInstallable(
      baseRelease({ status: 'awaiting-pipeline' }),
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
