/** Artifact kinds carried by the distribution center. */
export type ArtifactKind =
  | 'firmware'
  | 'package'
  | 'container'
  | 'deployment'
  | 'bundle'

export type ApplyRuntime = 'iot' | 'sidekar' | 'edge' | 'any'

export type ReleaseChannel = 'stable' | 'beta' | 'dev'

/** Gate sidecar state (kebab-case, matches lexicon). */
export type GateState = 'awaiting-pipeline' | 'ready' | 'failed'

export type PipelinePolicy = 'strict' | 'optional' | 'skipped'

export type PipelineStage =
  | 'build'
  | 'test'
  | 'lint'
  | 'security-scan'
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
  | 'pending-window'
  | 'quarantined'

export type OfferPriority = 'optional' | 'recommended' | 'required'

export interface StrongRef {
  uri: string
  cid: string
}

export interface BlobRef {
  $type?: string
  ref: { $link: string } | string
  mimeType: string
  size: number
}

export interface OemSignature {
  alg: 'ed25519'
  publicKey: string
  sig: string
  keyId?: string
}

export interface ReleasePart {
  seq: number
  blob: BlobRef
  sha256: string
  byteOffset: number
  byteLength: number
}

export interface ReleaseRecord {
  $type?: string
  version: string
  product: string
  kind: ArtifactKind
  createdAt: string
  imageSha256: string
  imageSize: number
  chunkSize?: number
  mimeType?: string
  channel: ReleaseChannel
  parts: ReleasePart[]
  requirePipelineAcks?: boolean
  requiredPipelineStages?: string[]
  pipelinePolicy?: PipelinePolicy
  changelog?: string
  minClientVersion?: string
  platform?: string
  ociDigest?: string
  runtime?: ApplyRuntime
  oemSignature?: OemSignature
}

export interface ChannelRecord {
  $type?: string
  product: string
  channel: ReleaseChannel
  release: StrongRef
  version: string
  updatedAt: string
  maxAgeSec?: number
}

export interface GateRecord {
  $type?: string
  release: StrongRef
  state: GateState
  updatedAt: string
  reason?: string
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
  actor: string
  uri?: string
  cid?: string
  authorDid?: string
}

export interface ReleaseSealRecord {
  $type?: string
  release: StrongRef
  partCount: number
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
  type: 'all' | 'product' | 'label' | 'did' | 'role' | 'fingerprint'
  product?: string
  label?: string
  did?: string
  fingerprint?: string
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

/** In-memory part used for audit/assemble (network-agnostic). */
export interface ChunkMeta {
  seq: number
  sha256: string
  byteOffset: number
  byteLength: number
  blobCid?: string
  blobSize?: number
  authorDid?: string
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
  /** Resolved from the gate sidecar (or 'ready' when following a channel pointer). */
  status: GateState
  authorDid: string
  uri?: string
  cid?: string
  runtime?: ApplyRuntime
  maxImageBytes?: number
  requirePipelineAcks?: boolean
  requiredPipelineStages?: string[]
  pipelinePolicy?: PipelinePolicy
  oemSignature?: OemSignature
  createdAt?: string
}

export type AuditErrorCode =
  | 'AUTHOR_MISMATCH'
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
  | 'BLOB_CID_MISMATCH'
  | 'EMPTY_CHAIN'
  | 'PIPELINE_REQUIRED'
  | 'PIPELINE_FAILED'
  | 'PIPELINE_INCOMPLETE'
  | 'OEM_SIG_MISSING'
  | 'OEM_SIG_INVALID'
  | 'TYPE_MISMATCH'
  | 'STALE_CHANNEL'

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
  channel: 'app.openfirmware.firmware.channel',
  gate: 'app.openfirmware.firmware.gate',
  releaseSeal: 'app.openfirmware.firmware.releaseSeal',
  pipelineAck: 'app.openfirmware.firmware.pipelineAck',
  declaration: 'app.openfirmware.actor.declaration',
  deviceIdentity: 'app.openfirmware.device.identity',
  deviceStatus: 'app.openfirmware.device.status',
  deviceCapabilities: 'app.openfirmware.device.capabilities',
  fleetEnrollment: 'app.openfirmware.fleet.enrollment',
  fleetUpdateOffer: 'app.openfirmware.fleet.updateOffer',
  fleetAdminGrant: 'app.openfirmware.fleet.adminGrant',
  fleetPolicy: 'app.openfirmware.fleet.policy',
} as const

export const DEFAULT_PIPELINE_STAGES = ['build', 'test'] as const

/** Default part size: 4 MiB. Under every current PDS blob cap. */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024

/** Official Bluesky PDS blob upload limit. */
export const MAX_BLOB_BYTES = 50 * 1024 * 1024

export const IOT_DEFAULT_KINDS: ArtifactKind[] = ['firmware', 'package']

export const SIDEKAR_DEFAULT_KINDS: ArtifactKind[] = [
  'container',
  'deployment',
  'bundle',
  'package',
]

export function channelRkey(product: string, channel: string): string {
  return releaseRkey(product, '', channel).replace(/--+/g, '-')
}

export function releaseRkey(
  product: string,
  version: string,
  channel: string,
): string {
  const raw = version ? `${product}-${version}-${channel}` : `${product}-${channel}`
  return raw.replace(/[^A-Za-z0-9._~-]+/g, '-')
}
