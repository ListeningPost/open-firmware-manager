import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { SealedEnvelope } from '@open-firmware/iot'
import { randomBytes } from 'node:crypto'

export interface JoinRequest {
  id: string
  product: string
  serial: string
  fingerprint: string
  mnemonic: string
  ed25519PublicKey: string
  x25519PublicKey: string
  agentVersion: string
  createdAt: string
  status: 'pending' | 'approved' | 'denied'
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
  status: 'pending' | 'acked_ok' | 'acked_failed'
  createdAt: string
  ackedAt?: string
  error?: string
  /** Redacted summary only — never store plaintext secrets */
  summary: string
}

export interface StoreData {
  joins: JoinRequest[]
  enrollments: Enrollment[]
  jobs: JobRecord[]
  adminToken: string
}

export class FileStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoreData> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    if (!existsSync(this.filePath)) {
      const data: StoreData = {
        joins: [],
        enrollments: [],
        jobs: [],
        adminToken: process.env.OFW_ADMIN_TOKEN || randomBytes(16).toString('hex'),
      }
      await this.save(data)
      return data
    }
    return JSON.parse(await readFile(this.filePath, 'utf8')) as StoreData
  }

  async save(data: StoreData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(data, null, 2))
  }

  async update(fn: (data: StoreData) => void | Promise<void>): Promise<StoreData> {
    const data = await this.load()
    await fn(data)
    await this.save(data)
    return data
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}
