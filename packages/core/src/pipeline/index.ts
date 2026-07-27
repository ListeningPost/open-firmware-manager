/**
 * Pipeline acknowledgment gate for CI/build/test stages between
 * publish (chunks uploaded) and ready (installable).
 */

import type {
  AuditIssue,
  PipelineAckRecord,
  PipelinePolicy,
  ReleaseMeta,
} from '../types/index.js'
import { DEFAULT_PIPELINE_STAGES } from '../types/index.js'

export interface PipelineAuditOptions {
  /**
   * Force-skip pipeline enforcement even if the release asks for it.
   * Use for emergency installs / recovery. Default false.
   */
  skipPipelineCheck?: boolean
  /**
   * Consumer default when release does not set policy.
   * Default: honor release fields (strict if requirePipelineAcks).
   */
  consumerDefaultPolicy?: PipelinePolicy
}

export interface PipelineAuditReport {
  ok: boolean
  policy: PipelinePolicy
  requiredStages: string[]
  acks: PipelineAckRecord[]
  issues: AuditIssue[]
  /** Stages still missing a passed/skipped ack */
  missingStages: string[]
  /** Stages that failed */
  failedStages: string[]
}

function stageKey(ack: PipelineAckRecord): string {
  if (ack.stage === 'custom' && ack.stageId) return `custom:${ack.stageId}`
  return String(ack.stage)
}

/**
 * Resolve effective pipeline policy for a release.
 */
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
  if (policy === 'skipped' || policy === 'optional') {
    // optional: still report missing but do not fail
    if (policy === 'optional') {
      return release.requiredPipelineStages?.length
        ? [...release.requiredPipelineStages]
        : [...DEFAULT_PIPELINE_STAGES]
    }
    return []
  }
  if (release.requiredPipelineStages?.length) {
    return [...release.requiredPipelineStages]
  }
  if (release.requirePipelineAcks || policy === 'strict') {
    return [...DEFAULT_PIPELINE_STAGES]
  }
  return []
}

/**
 * Pick the latest ack per stage (by createdAt string compare).
 */
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

/**
 * Audit pipeline acknowledgments for a release.
 * - strict: all required stages must have latest result passed (or skipped)
 * - optional: never fails install on missing acks (issues still listed as nits via codes)
 * - skipped: no required stages
 */
export function auditPipelineAcks(
  release: ReleaseMeta,
  acks: PipelineAckRecord[],
  opts: PipelineAuditOptions = {},
): PipelineAuditReport {
  const issues: AuditIssue[] = []
  const policy = resolvePipelinePolicy(release, opts)
  const requiredStages = resolveRequiredStages(release, policy)
  const byStage = latestAcksByStage(acks)

  // Author continuity on acks when provided
  for (const ack of acks) {
    if (ack.authorDid && ack.authorDid !== release.authorDid) {
      // CI may use a different DID; allow if result is not used for trust of author
      // For v1 we only warn via issue when strict and stage is required
    }
    if (release.uri && ack.release?.uri && ack.release.uri !== release.uri) {
      issues.push({
        code: 'PIPELINE_INCOMPLETE',
        message: `ack for stage ${stageKey(ack)} points at different release uri`,
      })
    }
  }

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
    if (release.status === 'awaiting_pipeline') {
      issues.push({
        code: 'PIPELINE_REQUIRED',
        message: 'release is awaiting_pipeline; not installable yet',
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
  } else if (policy === 'optional') {
    // Informational only — do not add hard failures
  }

  const hardFail =
    policy === 'strict' &&
    (failedStages.length > 0 ||
      missingStages.length > 0 ||
      release.status === 'awaiting_pipeline' ||
      issues.length > 0)

  return {
    ok: !hardFail,
    policy,
    requiredStages,
    acks,
    issues: policy === 'strict' ? issues : [],
    missingStages,
    failedStages,
  }
}

/**
 * Whether a release is installable given status + pipeline acks.
 */
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
      reason: pipeline.issues.map((i) => i.code).join(', ') || 'pipeline gate failed',
      pipeline,
    }
  }
  return { installable: true, pipeline }
}
