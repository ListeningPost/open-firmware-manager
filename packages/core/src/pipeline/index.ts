import type {
  AuditIssue,
  PipelineAckRecord,
  PipelinePolicy,
  ReleaseMeta,
} from '../types/index.js'
import { DEFAULT_PIPELINE_STAGES } from '../types/index.js'

export interface PipelineAuditOptions {
  skipPipelineCheck?: boolean
  consumerDefaultPolicy?: PipelinePolicy
  /** If set, acks whose authorDid is not in this list are ignored (not fatal). */
  attesterDids?: string[]
}

export interface PipelineAuditReport {
  ok: boolean
  policy: PipelinePolicy
  requiredStages: string[]
  acks: PipelineAckRecord[]
  issues: AuditIssue[]
  missingStages: string[]
  failedStages: string[]
}

export function stageKey(ack: PipelineAckRecord): string {
  if (ack.stage === 'custom' && ack.stageId) return `custom:${ack.stageId}`
  return String(ack.stage)
}

export function resolvePipelinePolicy(
  release: Pick<
    ReleaseMeta,
    'requirePipelineAcks' | 'pipelinePolicy' | 'requiredPipelineStages'
  >,
  opts: PipelineAuditOptions = {},
): PipelinePolicy {
  if (opts.skipPipelineCheck) return 'skipped'
  if (release.pipelinePolicy) return release.pipelinePolicy
  if (release.requirePipelineAcks) return 'strict'
  return opts.consumerDefaultPolicy ?? 'skipped'
}

export function resolveRequiredStages(
  release: Pick<
    ReleaseMeta,
    'requirePipelineAcks' | 'pipelinePolicy' | 'requiredPipelineStages'
  >,
  policy: PipelinePolicy,
): string[] {
  if (policy === 'skipped') return []
  if (policy === 'optional') {
    return release.requiredPipelineStages?.length
      ? [...release.requiredPipelineStages]
      : [...DEFAULT_PIPELINE_STAGES]
  }
  if (release.requiredPipelineStages?.length) {
    return [...release.requiredPipelineStages]
  }
  if (release.requirePipelineAcks || policy === 'strict') {
    return [...DEFAULT_PIPELINE_STAGES]
  }
  return []
}

export function latestAcksByStage(
  acks: PipelineAckRecord[],
): Map<string, PipelineAckRecord> {
  const map = new Map<string, PipelineAckRecord>()
  const sorted = [...acks].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  )
  for (const ack of sorted) {
    map.set(stageKey(ack), ack)
  }
  return map
}

export function auditPipelineAcks(
  release: ReleaseMeta,
  acks: PipelineAckRecord[],
  opts: PipelineAuditOptions = {},
): PipelineAuditReport {
  const issues: AuditIssue[] = []
  const policy = resolvePipelinePolicy(release, opts)
  const requiredStages = resolveRequiredStages(release, policy)

  const relevant = acks.filter((ack) => {
    if (release.uri && ack.release?.uri && ack.release.uri !== release.uri) {
      return false
    }
    if (opts.attesterDids?.length) {
      const did = ack.authorDid ?? ack.actor
      if (did && !opts.attesterDids.includes(did)) return false
    }
    return true
  })

  const byStage = latestAcksByStage(relevant)
  const missingStages: string[] = []
  const failedStages: string[] = []

  for (const stage of requiredStages) {
    const ack = byStage.get(stage)
    if (!ack) {
      missingStages.push(stage)
      continue
    }
    if (ack.result === 'failed') {
      failedStages.push(stage)
    } else if (ack.result !== 'passed' && ack.result !== 'skipped') {
      missingStages.push(stage)
    }
  }

  if (policy === 'strict') {
    if (release.status === 'awaiting-pipeline') {
      issues.push({
        code: 'PIPELINE_REQUIRED',
        message: 'release is awaiting-pipeline; not installable yet',
      })
    }
    for (const s of failedStages) {
      issues.push({
        code: 'PIPELINE_FAILED',
        message: `pipeline stage "${s}" failed`,
      })
    }
    for (const s of missingStages) {
      issues.push({
        code: 'PIPELINE_INCOMPLETE',
        message: `missing passed/skipped ack for stage "${s}"`,
      })
    }
  }

  const hardFail =
    policy === 'strict' &&
    (failedStages.length > 0 ||
      missingStages.length > 0 ||
      release.status === 'awaiting-pipeline')

  return {
    ok: !hardFail,
    policy,
    requiredStages,
    acks: relevant,
    issues: policy === 'strict' ? issues : [],
    missingStages,
    failedStages,
  }
}

export function isReleaseInstallable(
  release: ReleaseMeta,
  acks: PipelineAckRecord[],
  opts: PipelineAuditOptions = {},
): { installable: boolean; reason?: string; pipeline: PipelineAuditReport } {
  const pipeline = auditPipelineAcks(release, acks, opts)
  if (release.status !== 'ready') {
    return {
      installable: false,
      reason: `status is "${release.status}", need "ready"`,
      pipeline,
    }
  }
  if (!pipeline.ok) {
    return {
      installable: false,
      reason:
        pipeline.issues.map((i) => i.code).join(', ') || 'pipeline gate failed',
      pipeline,
    }
  }
  return { installable: true, pipeline }
}
