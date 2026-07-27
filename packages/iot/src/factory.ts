import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  factorySecret: string
  defaultPassword: string
  controlEndpoint: string
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
  }
}

export async function initFactoryProfile(
  root: string,
  opts: {
    product: string
    serial: string
    factorySecret?: string
    controlEndpoint?: string
  },
): Promise<FactoryProfile> {
  const paths = devicePaths(root)
  await mkdir(paths.factoryDir, { recursive: true })
  await mkdir(paths.userDir, { recursive: true })

  const factorySecret = opts.factorySecret ?? 'ofw-dev-factory-secret'
  const keys = generateDeviceKeys()
  const fingerprint = deviceFingerprint(opts.product, keys.ed25519PublicKey)
  const profile: FactoryProfile = {
    product: opts.product,
    serial: opts.serial,
    keys,
    fingerprint,
    mnemonic: fingerprintMnemonic(fingerprint),
    factorySecret,
    defaultPassword: factoryDefaultPassword(factorySecret, opts.serial),
    controlEndpoint: opts.controlEndpoint ?? 'http://127.0.0.1:8787',
    agentVersion: '0.1.0',
    createdAt: new Date().toISOString(),
  }
  await writeFile(paths.factoryProfile, JSON.stringify(profile, null, 2))
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
  await mkdir(paths.userDir, { recursive: true })
  state.updatedAt = new Date().toISOString()
  await writeFile(paths.userState, JSON.stringify(state, null, 2))
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
  await mkdir(paths.userDir, { recursive: true })
  await writeFile(paths.userState, JSON.stringify(state, null, 2))
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
