import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  deviceFingerprint,
  factoryDefaultPassword,
  fingerprintMnemonic,
  generateDeviceKeys,
  type DeviceKeyMaterial,
} from './crypto.js'

export interface FactoryProfile {
  product: string
  serial: string
  keys: DeviceKeyMaterial
  fingerprint: string
  mnemonic: string
  /**
   * Derived per-serial default (`KDF(factorySecret, serial)`). The fleet-wide
   * factory secret itself is never written to the device.
   */
  defaultPassword: string
  controlEndpoint: string
  /**
   * Control-plane Ed25519 job-signing key (base64url) pinned at the factory.
   * When absent the agent pins the key it is given at first enrollment.
   */
  controlPublicKey?: string
  agentVersion: string
  createdAt: string
}

export interface UserState {
  enrolled: boolean
  enrollmentId?: string
  password: string
  passwordRotated: boolean
  firmwareVersion: string
  appliedFirmwareSha256?: string
  joinRequestId?: string
  /** Control-plane key pinned at enrollment (only when not factory-pinned). */
  controlPublicKey?: string
  status: 'awaiting_enrollment' | 'enrolled' | 'quarantined'
  updatedAt: string
}

export interface DevicePaths {
  root: string
  factoryDir: string
  userDir: string
  factoryProfile: string
  userState: string
  firmwareImage: string
  /** Replay guard for control-plane jobs; lives in factory/ so it survives reset. */
  jobGuard: string
}

export function devicePaths(root: string): DevicePaths {
  const factoryDir = path.join(root, 'factory')
  const userDir = path.join(root, 'user-data')
  return {
    root,
    factoryDir,
    userDir,
    factoryProfile: path.join(factoryDir, 'profile.json'),
    userState: path.join(userDir, 'state.json'),
    firmwareImage: path.join(userDir, 'firmware.bin'),
    jobGuard: path.join(factoryDir, 'job-guard.json'),
  }
}

export const DEV_FACTORY_SECRET = 'ofw-dev-factory-secret'

/** Device state holds private keys and passwords: owner-only, always. */
export async function writePrivateFile(
  file: string,
  data: string | Uint8Array,
): Promise<void> {
  await writeFile(file, data, { mode: 0o600 })
  // `mode` only applies on create; tighten files written by older versions too.
  await chmod(file, 0o600)
}

async function mkdirPrivate(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
}

export async function initFactoryProfile(
  root: string,
  opts: {
    product: string
    serial: string
    /** Fleet-wide secret; used once to derive the default password, not stored. */
    factorySecret?: string
    controlEndpoint?: string
    /** Control-plane job-signing public key to pin (GET /v1/meta → controlPublicKey). */
    controlPublicKey?: string
  },
): Promise<FactoryProfile> {
  const paths = devicePaths(root)
  await mkdirPrivate(paths.factoryDir)
  await mkdirPrivate(paths.userDir)

  const factorySecret = opts.factorySecret || DEV_FACTORY_SECRET
  if (factorySecret === DEV_FACTORY_SECRET) {
    console.warn(
      '[open-firmware/iot] WARNING: INSECURE DEFAULT FACTORY SECRET IN USE. ' +
        'Default passwords derived from it are computable by anyone who knows the serial. ' +
        'Pass a real `factorySecret` for anything other than local development.',
    )
  }
  const keys = generateDeviceKeys()
  const fingerprint = deviceFingerprint(opts.product, keys.ed25519PublicKey)
  const profile: FactoryProfile = {
    product: opts.product,
    serial: opts.serial,
    keys,
    fingerprint,
    mnemonic: fingerprintMnemonic(fingerprint),
    defaultPassword: factoryDefaultPassword(factorySecret, opts.serial),
    controlEndpoint: opts.controlEndpoint ?? 'http://127.0.0.1:8787',
    ...(opts.controlPublicKey ? { controlPublicKey: opts.controlPublicKey } : {}),
    agentVersion: '0.1.0',
    createdAt: new Date().toISOString(),
  }
  await writePrivateFile(paths.factoryProfile, JSON.stringify(profile, null, 2))
  // New identity: any replay guard left by a previous one is meaningless.
  await rm(paths.jobGuard, { force: true })
  await restoreUserStateFromFactory(paths, profile)
  return profile
}

export async function loadFactoryProfile(root: string): Promise<FactoryProfile> {
  const paths = devicePaths(root)
  const raw = await readFile(paths.factoryProfile, 'utf8')
  return JSON.parse(raw) as FactoryProfile
}

export async function loadUserState(root: string): Promise<UserState> {
  const paths = devicePaths(root)
  const raw = await readFile(paths.userState, 'utf8')
  return JSON.parse(raw) as UserState
}

export async function saveUserState(root: string, state: UserState): Promise<void> {
  const paths = devicePaths(root)
  await mkdirPrivate(paths.userDir)
  state.updatedAt = new Date().toISOString()
  await writePrivateFile(paths.userState, JSON.stringify(state, null, 2))
}

async function restoreUserStateFromFactory(
  paths: DevicePaths,
  profile: FactoryProfile,
): Promise<UserState> {
  const state: UserState = {
    enrolled: false,
    password: profile.defaultPassword,
    passwordRotated: false,
    firmwareVersion: '0.0.0',
    status: 'awaiting_enrollment',
    updatedAt: new Date().toISOString(),
  }
  await mkdirPrivate(paths.userDir)
  await writePrivateFile(paths.userState, JSON.stringify(state, null, 2))
  return state
}

/**
 * Deterministic factory reset: wipe user-data, keep factory profile,
 * restore default password and awaiting_enrollment.
 */
export async function factoryReset(root: string): Promise<{
  profile: FactoryProfile
  state: UserState
}> {
  const paths = devicePaths(root)
  if (!existsSync(paths.factoryProfile)) {
    throw new Error('no factory profile — run init first')
  }
  const profile = await loadFactoryProfile(root)
  await rm(paths.userDir, { recursive: true, force: true })
  const state = await restoreUserStateFromFactory(paths, profile)
  return { profile, state }
}

export function publicIdentity(profile: FactoryProfile) {
  return {
    product: profile.product,
    serial: profile.serial,
    fingerprint: profile.fingerprint,
    mnemonic: profile.mnemonic,
    ed25519PublicKey: profile.keys.ed25519PublicKey,
    x25519PublicKey: profile.keys.x25519PublicKey,
    agentVersion: profile.agentVersion,
  }
}

export type JobStatus = 'ok' | 'failed' | 'unsupported'

export interface SeenJob {
  id: string
  /** Epoch ms of the control plane's `issuedAt` */
  issuedAt: number
  status: JobStatus
}

/**
 * Control-plane jobs this device has already accepted, so a captured job
 * cannot be replayed — including after a factory reset.
 */
export interface JobGuard {
  /** Jobs issued at or before this instant (epoch ms) are refused. */
  floor: number
  seen: SeenJob[]
}

const JOB_GUARD_MAX = 256

export async function loadJobGuard(root: string): Promise<JobGuard> {
  let raw: string
  try {
    raw = await readFile(devicePaths(root).jobGuard, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { floor: 0, seen: [] }
    throw e
  }
  // A corrupt guard throws: refusing jobs is safer than forgetting what was seen.
  const g = JSON.parse(raw) as JobGuard
  return { floor: Number(g.floor) || 0, seen: Array.isArray(g.seen) ? g.seen : [] }
}

export async function recordJobSeen(root: string, job: SeenJob): Promise<void> {
  const guard = await loadJobGuard(root)
  guard.seen.push(job)
  guard.seen.sort((a, b) => a.issuedAt - b.issuedAt)
  while (guard.seen.length > JOB_GUARD_MAX) {
    const dropped = guard.seen.shift()!
    guard.floor = Math.max(guard.floor, dropped.issuedAt)
  }
  await writePrivateFile(devicePaths(root).jobGuard, JSON.stringify(guard, null, 2))
}
