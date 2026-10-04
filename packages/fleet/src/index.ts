import { AtpClient, XRPCError } from '@open-firmware/atproto-lite'
import { COLLECTIONS, type OfferPriority, type ReleaseChannel } from '@open-firmware/core'

export interface FleetWriter {
  client: AtpClient
}

async function upsert(
  client: AtpClient,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
) {
  try {
    const existing = await client.getRecord(client.did, collection, rkey)
    return client.putRecord(collection, rkey, record, { swapRecord: existing.cid })
  } catch (e) {
    if (e instanceof XRPCError && (e.status === 400 || e.status === 404)) {
      return client.createRecord(collection, record, rkey)
    }
    throw e
  }
}

export async function putDeviceIdentity(
  client: AtpClient,
  fingerprint: string,
  record: {
    product: string
    role: 'iot' | 'sidekar' | 'edge'
    ed25519PublicKey?: string
    serialHash?: string
    enrolledWith?: string
    firmwareVersion?: string
  },
) {
  return upsert(client, COLLECTIONS.deviceIdentity, fingerprint, {
    $type: COLLECTIONS.deviceIdentity,
    fingerprint,
    createdAt: new Date().toISOString(),
    ...record,
  })
}

export async function putDeviceStatus(
  client: AtpClient,
  fingerprint: string,
  record: {
    product: string
    status: string
    firmwareVersion?: string
    releaseUri?: string
    lastError?: string
    uptimeSec?: number
    freeStorage?: number
  },
) {
  return upsert(client, COLLECTIONS.deviceStatus, fingerprint, {
    $type: COLLECTIONS.deviceStatus,
    reportedAt: new Date().toISOString(),
    ...record,
  })
}

export async function putEnrollment(
  client: AtpClient,
  fingerprint: string,
  record: {
    product: string
    role?: 'iot' | 'sidekar' | 'edge'
    channel?: ReleaseChannel
    labels?: string[]
    autoUpdate?: boolean
    note?: string
    deviceDid?: string
  },
) {
  return upsert(client, COLLECTIONS.fleetEnrollment, fingerprint, {
    $type: COLLECTIONS.fleetEnrollment,
    fingerprint,
    enrolledAt: new Date().toISOString(),
    ...record,
  })
}

export async function putPolicy(
  client: AtpClient,
  record: {
    autoUpdate?: boolean
    maxImageBytes?: number
    defaultChannel?: ReleaseChannel
    requireOemSignature?: boolean
    trustedOemKeys?: string[]
    maxChannelAgeSec?: number
  },
) {
  return upsert(client, COLLECTIONS.fleetPolicy, 'self', {
    $type: COLLECTIONS.fleetPolicy,
    updatedAt: new Date().toISOString(),
    ...record,
  })
}

export async function createUpdateOffer(
  client: AtpClient,
  record: {
    release: { uri: string; cid: string }
    version: string
    product?: string
    priority: OfferPriority
    target: Record<string, unknown>
    paused?: boolean
  },
) {
  return client.createRecord(COLLECTIONS.fleetUpdateOffer, {
    $type: COLLECTIONS.fleetUpdateOffer,
    createdAt: new Date().toISOString(),
    ...record,
  })
}

export async function grantAdmin(
  client: AtpClient,
  adminDid: string,
  scopes: string[] = ['all'],
) {
  return client.createRecord(COLLECTIONS.fleetAdminGrant, {
    $type: COLLECTIONS.fleetAdminGrant,
    adminDid,
    scopes,
    createdAt: new Date().toISOString(),
  })
}
