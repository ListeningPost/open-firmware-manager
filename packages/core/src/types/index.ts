/** Artifact kinds carried by the distribution center. */
export type ArtifactKind =
  | 'firmware'
  | 'package'
  | 'container'
  | 'deployment'
  | 'bundle'

/**
 * Apply runtime. IoT never requires Docker.
 * Sidekar is the server-side host agent that may use Docker.
 */
export type ApplyRuntime = 'iot' | 'sidekar' | 'edge' | 'any'

export type ReleaseChannel = 'stable' | 'beta' | 'dev'

export type ReleaseStatus =
  | 'publishing'
  | 'awaiting_pipeline'
  | 'ready'
  | 'failed'

/** How pipeline acknowledgments are enforced for install. */
export type PipelinePolicy = 'strict' | 'optional' | 'skipped'

export type PipelineStage =
  | 'build'
  | 'test'
  | 'lint'
  | 'security_scan'
  | 'sign'
  | 'promote'
  | 'custom'

export type PipelineAckResult = 'passed' | 'failed' | 'skipped'

export type DeviceRole = 'iot' | 'sidekar' | 'edge'

export type NodeStatus =
  | 'ok'
  | 'updating'
  | 'failed'
  | 'pending'
  | 'pending_window'
  | 'quarantined'

export type OfferPriority = 'optional' | 'recommended' | 'required'

/** AT Protocol strong reference (uri + cid). */
export interface StrongRef {
  uri: string
  cid: string
}

export interface ReplyRef {
  root: StrongRef
  parent: StrongRef
}

/** Minimal blob metadata as stored on chunk records. */
export interface BlobRef {
  $type?: string
  ref: { $link: string } | string
  mimeType: string
  size: number
}

export interface ReleaseRecord {
  $type?: string
  version: string
  product: string
  kind: ArtifactKind
  createdAt: string
  imageSha256: string
  imageSize: number
  chunkCount: number
  chunkSize?: number
  mimeType?: string
  channel: ReleaseChannel
  status: ReleaseStatus
  /** When true, installers should verify pipeline acks (unless consumer forces skip). */
  requirePipelineAcks?: boolean
  requiredPipelineStages?: string[]
  pipelinePolicy?: PipelinePolicy
  changelog?: string
  minClientVersion?: string
  platform?: string
  ociDigest?: string
  runtime?: ApplyRuntime
}

export interface PipelineAckRecord {
  $type?: string
  release: StrongRef
  stage: PipelineStage | string
  stageId?: string
  result: PipelineAckResult
  createdAt: string
  runUrl?: string
  commit?: string
  summary?: string
  actor?: string
  uri?: string
  cid?: string
  authorDid?: string
}

export interface ChunkRecord {
  $type?: string
  reply: ReplyRef
  seq: number
  blob: BlobRef
  sha256: string
  byteOffset: number
  byteLength: number
  createdAt: string
}

export interface ReleaseSealRecord {
  $type?: string
  release: StrongRef
  chunkCount: number
  imageSha256: string
  createdAt: string
}

export interface ServiceWindow {
  timezone: string
  allowFrom: string
  allowTo: string
  days?: number[]
  urgentBypass?: boolean
  skewSec?: number
}

export interface OfferTarget {
  type: 'all' | 'product' | 'label' | 'did' | 'role'
  product?: string
  label?: string
  did?: string
  role?: DeviceRole
}

export interface Rollout {
  percent?: number
  salt?: string
}

export interface UpdateOfferRecord {
  $type?: string
  release: StrongRef
  version: string
  product?: string
  priority: OfferPriority
  target: OfferTarget
  rollout?: Rollout
  serviceWindow?: ServiceWindow
  paused?: boolean
  createdAt: string
  expiresAt?: string
}

/** In-memory chunk used for audit/assemble (network-agnostic). */
export interface ChunkMeta {
  seq: number
  sha256: string
  byteOffset: number
  byteLength: number
  /** Blob CID / link string when known. */
  blobCid?: string
  /** Declared blob.size from record, if present. */
  blobSize?: number
  /** Author DID that produced this chunk record. */
  authorDid?: string
  /** Strong refs for chain linkage checks. */
  rootUri?: string
  rootCid?: string
  parentUri?: string
  parentCid?: string
  /** Record URI/CID of this chunk. */
  uri?: string
  cid?: string
}

export interface ReleaseMeta {
  version: string
  product: string
  kind: ArtifactKind
  imageSha256: string
  imageSize: number
  chunkCount: number
  channel: ReleaseChannel
  status: ReleaseStatus
  authorDid: string
  uri?: string
  cid?: string
  runtime?: ApplyRuntime
  maxImageBytes?: number
  requirePipelineAcks?: boolean
  requiredPipelineStages?: string[]
  pipelinePolicy?: PipelinePolicy
}

export type AuditErrorCode =
  | 'AUTHOR_MISMATCH'
  | 'CHAIN_BROKEN'
  | 'COUNT_MISMATCH'
  | 'SEQ_GAP'
  | 'SEQ_DUPLICATE'
  | 'LAYOUT_INVALID'
  | 'SIZE_MISMATCH'
  | 'DIGEST_MISSING'
  | 'DIGEST_INVALID'
  | 'INCOMPLETE_PUBLISH'
  | 'INSUFFICIENT_SPACE'
  | 'IMAGE_TOO_LARGE'
  | 'BLOB_SIZE_MISMATCH'
  | 'BLOB_UNAVAILABLE'
  | 'EMPTY_CHAIN'
  | 'PIPELINE_REQUIRED'
  | 'PIPELINE_FAILED'
  | 'PIPELINE_INCOMPLETE'

export interface AuditIssue {
  code: AuditErrorCode
  message: string
  seq?: number
}

export interface ChainAuditReport {
  ok: boolean
  release: ReleaseMeta
  chunks: ChunkMeta[]
  issues: AuditIssue[]
  requiredBytes: number
  freeSpaceBytes?: number
}

export interface ChunkPlan {
  seq: number
  byteOffset: number
  byteLength: number
  sha256: string
  data: Uint8Array
}

export const COLLECTIONS = {
  release: 'app.openfirmware.firmware.release',
  chunk: 'app.openfirmware.firmware.chunk',
  releaseSeal: 'app.openfirmware.firmware.releaseSeal',
  pipelineAck: 'app.openfirmware.firmware.pipelineAck',
  deviceIdentity: 'app.openfirmware.device.identity',
  deviceStatus: 'app.openfirmware.device.status',
  deviceCapabilities: 'app.openfirmware.device.capabilities',
  fleetEnrollment: 'app.openfirmware.fleet.enrollment',
  fleetUpdateOffer: 'app.openfirmware.fleet.updateOffer',
  fleetAdminGrant: 'app.openfirmware.fleet.adminGrant',
  fleetPolicy: 'app.openfirmware.fleet.policy',
} as const

/** Default stages when requirePipelineAcks is true but requiredPipelineStages is empty. */
export const DEFAULT_PIPELINE_STAGES = ['build', 'test'] as const

/** Kinds typically applied by IoT client (no Docker). */
export const IOT_DEFAULT_KINDS: ArtifactKind[] = ['firmware', 'package']

/** Kinds typically applied by Sidekar (Docker-capable host). */
export const SIDEKAR_DEFAULT_KINDS: ArtifactKind[] = [
  'container',
  'deployment',
  'bundle',
  'package',
]
