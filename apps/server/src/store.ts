import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  generateControlSigningKey,
  type ControlSigningKey,
  type SealedEnvelope,
} from '@open-firmware/iot'
import { randomBytes } from 'node:crypto'

export interface JoinRequest {
  id: string
  product: string
  /** Self-asserted by the device (signed with its key, not otherwise verified). */
  serial: string
  fingerprint: string
  /** Derived by the server from the fingerprint — never taken from the client. */
  mnemonic: string
  ed25519PublicKey: string
  x25519PublicKey: string
  agentVersion: string
  createdAt: string
  /** Server clock when the request arrived; drives expiry. */
  receivedAt?: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  approvedAt?: string
  deniedAt?: string
  enrollmentId?: string
}

export interface Enrollment {
  id: string
  fingerprint: string
  product: string
  serial: string
  ed25519PublicKey: string
  x25519PublicKey: string
  status: 'active' | 'quarantined'
  labels: string[]
  createdAt: string
}

export interface JobRecord {
  id: string
  fingerprint: string
  kind: string
  sealed: SealedEnvelope
  /** Covered by `signature`; devices use it to refuse replays. */
  issuedAt: string
  /** Control-plane Ed25519 signature over the canonical job encoding. */
  signature: string
  status: 'pending' | 'acked_ok' | 'acked_failed' | 'acked_unsupported'
  createdAt: string
  ackedAt?: string
  error?: string
  summary: string
}

export interface StoreData {
  joins: JoinRequest[]
  enrollments: Enrollment[]
  jobs: JobRecord[]
  adminToken: string
  /** Job-signing key. Devices pin the public half; the private half stays here. */
  controlKey: ControlSigningKey
}

export interface FileStoreOptions {
  /**
   * Admin token from the environment. When set it always wins over whatever
   * the store file holds, so rotating the env var rotates the token.
   */
  adminToken?: string
}

export class FileStore {
  private chain: Promise<unknown> = Promise.resolve()
  private ready?: Promise<void>
  private readonly adminTokenOverride: string

  constructor(
    private readonly filePath: string,
    opts: FileStoreOptions = {},
  ) {
    this.adminTokenOverride = opts.adminToken ?? process.env.OFW_ADMIN_TOKEN ?? ''
  }

  /** Create the store, or bring one written by an older version up to date. Runs once. */
  private init(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const data: Partial<StoreData> = existsSync(this.filePath)
        ? (JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoreData>)
        : {}
      await this.save({
        joins: data.joins ?? [],
        enrollments: data.enrollments ?? [],
        jobs: data.jobs ?? [],
        adminToken:
          this.adminTokenOverride || data.adminToken || randomBytes(16).toString('hex'),
        controlKey: data.controlKey ?? generateControlSigningKey(),
      })
    })()
    return this.ready
  }

  async load(): Promise<StoreData> {
    await this.init()
    const data = JSON.parse(await readFile(this.filePath, 'utf8')) as StoreData
    if (this.adminTokenOverride) data.adminToken = this.adminTokenOverride
    return data
  }

  async save(data: StoreData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    // Holds the admin token and the job-signing private key: owner-only.
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.filePath)
  }

  async update(fn: (data: StoreData) => void | Promise<void>): Promise<StoreData> {
    const run = this.chain.then(async () => {
      const data = await this.load()
      await fn(data)
      await this.save(data)
      return data
    })
    this.chain = run.catch(() => undefined)
    return run
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}
