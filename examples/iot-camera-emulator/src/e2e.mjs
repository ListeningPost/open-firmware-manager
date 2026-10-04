#!/usr/bin/env node
/**
 * Synthetic camera e2e:
 * 1. init camera + factory identity
 * 2. join → admin approve (control-plane signing key pinned at the factory)
 * 3. sealed + signed password set; forged and replayed jobs refused
 * 4. firmware.offer handed to the app's verified-update hook
 * 5. factory reset → same fingerprint → re-join
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initFactoryProfile,
  factoryReset,
  IotDeviceAgent,
  publicIdentity,
  sealForDevice,
} from '@open-firmware/iot'
import { OpenFirmwareUtility } from '@open-firmware/utility'
import { chunkBytes } from '@open-firmware/core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitHealth(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* retry */
    }
    await sleep(250)
  }
  throw new Error(`timeout waiting for ${url}`)
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ofw-ctrl-'))
  const camRoot = await mkdtemp(path.join(tmpdir(), 'ofw-cam-'))
  const store = path.join(dataDir, 'store.json')
  const adminToken = 'test-admin-token-e2e'

  const server = spawn(
    process.execPath,
    [path.join(repoRoot, 'apps/server/dist/index.js')],
    {
      env: {
        ...process.env,
        PORT: '8799',
        DATA_FILE: store,
        OFW_ADMIN_TOKEN: adminToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let serverLog = ''
  server.stdout.on('data', (d) => {
    serverLog += d.toString()
  })
  server.stderr.on('data', (d) => {
    serverLog += d.toString()
  })

  try {
    await waitHealth('http://127.0.0.1:8799/healthz')
    console.log('✓ control plane up')

    const util = new OpenFirmwareUtility({
      controlUrl: 'http://127.0.0.1:8799',
      adminToken,
    })

    // Factory step: pin the control plane's job-signing key into the device.
    const meta = await util.getMeta()
    if (!meta.controlPublicKey) throw new Error('control plane published no signing key')
    if (JSON.stringify(meta).includes(adminToken)) {
      throw new Error('/v1/meta leaked the admin token')
    }
    console.log('✓ control signing key', meta.controlPublicKey.slice(0, 12) + '…')

    const profile = await initFactoryProfile(camRoot, {
      product: 'camera-x1',
      serial: 'EMU-E2E-1',
      controlEndpoint: 'http://127.0.0.1:8799',
      factorySecret: 'e2e-secret',
      controlPublicKey: meta.controlPublicKey,
    })
    const id = publicIdentity(profile)
    console.log('✓ factory identity', id.mnemonic, id.fingerprint.slice(0, 12))

    const agent = new IotDeviceAgent(camRoot)
    const { joinId } = await agent.requestJoin()
    console.log('✓ join request', joinId)

    const pending = await util.listPendingJoins()
    const seenJoin = pending.joins.find((j) => j.id === joinId)
    if (!seenJoin) throw new Error('join not visible to admin')
    if (seenJoin.mnemonic !== id.mnemonic) {
      throw new Error('admin mnemonic does not match the device sticker')
    }
    console.log('✓ admin sees pending join')

    await util.approveJoin(joinId)
    console.log('✓ admin approved')

    await agent.refreshEnrollment()
    const st = await agent.state()
    if (!st.enrolled) throw new Error('device not enrolled after approve')
    console.log('✓ device enrolled')

    // Password job
    const fp = profile.fingerprint
    await util.setPassword(fp, 'rotated-password-99')
    const applied = await agent.pullAndApplyJobs()
    if (!applied.length) throw new Error('password job not applied')
    const st2 = await agent.state()
    if (st2.password !== 'rotated-password-99' || !st2.passwordRotated) {
      throw new Error('password not updated')
    }
    console.log('✓ sealed + signed password job applied')

    // Anyone can seal to the device's public key; only the control plane can sign.
    const forged = {
      id: 'job_forged',
      kind: 'credential.set',
      issuedAt: new Date().toISOString(),
      sealed: sealForDevice(
        profile.keys.x25519PublicKey,
        JSON.stringify({ kind: 'credential.set', password: 'attacker' }),
      ),
    }
    const mitmFetch = async (input, init) => {
      if (String(input).includes('/v1/devices/me/jobs')) {
        return new Response(JSON.stringify({ jobs: [forged] }), { status: 200 })
      }
      return fetch(input, init)
    }
    const [forgedResult] = await new IotDeviceAgent(camRoot, mitmFetch).pullJobs()
    if (!forgedResult?.rejected) throw new Error('forged unsigned job was not rejected')
    if ((await agent.state()).password !== 'rotated-password-99') {
      throw new Error('forged job changed the password')
    }
    console.log('✓ forged (unsigned) job rejected')

    // firmware.offer: a pointer the application must fetch + verify itself.
    const offer = {
      version: '3.1.0',
      releaseUri: 'at://did:plc:test/app.openfirmware.firmware.release/x',
      cid: 'bafy',
      imageSha256: 'ab'.repeat(32),
    }
    const offerJob = await util.offerFirmware(fp, offer)
    const [noHandler] = await agent.pullJobs()
    if (noHandler?.id !== offerJob.id || noHandler.status !== 'unsupported') {
      throw new Error('firmware.offer without a handler must be reported unsupported')
    }
    console.log('✓ firmware.offer without handler → unsupported (not ok)')

    const offers = []
    const updatingAgent = new IotDeviceAgent(camRoot, fetch, {
      onFirmwareOffer: async (o) => {
        offers.push(o)
      },
    })
    const offerJob2 = await util.offerFirmware(fp, offer)
    const appliedOffers = await updatingAgent.pullAndApplyJobs()
    if (appliedOffers[0] !== offerJob2.id || offers[0]?.releaseUri !== offer.releaseUri) {
      throw new Error('firmware.offer was not delivered to the handler')
    }
    const jobs = await util.listJobs()
    const statusOf = (jid) => jobs.jobs.find((j) => j.id === jid)?.status
    if (statusOf(offerJob.id) !== 'acked_unsupported' || statusOf(offerJob2.id) !== 'acked_ok') {
      throw new Error('control plane did not record the firmware.offer outcomes')
    }
    console.log('✓ firmware.offer delivered to application handler')

    // Unsigned firmware.apply is rejected by the control plane
    let rejected = false
    try {
      await fetch('http://127.0.0.1:8799/v1/jobs', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fingerprint: fp,
          kind: 'firmware.apply',
          payload: { firmwareBase64: 'YQ==', version: '9.9.9' },
        }),
      }).then(async (r) => {
        if (r.status === 400) rejected = true
      })
    } catch {
      /* ignore */
    }
    if (!rejected) throw new Error('unsigned firmware.apply was not rejected')
    console.log('✓ unsigned firmware.apply rejected')

    const fwBytes = Buffer.from('SYNTHETIC_CAMERA_FW_v3.1.0_PAYLOAD')
    const planned = chunkBytes(new Uint8Array(fwBytes), { chunkSize: 64 })
    await agent.applyFirmwareBytes(fwBytes, '3.1.0')
    const st3 = await agent.state()
    if (st3.firmwareVersion !== '3.1.0') throw new Error('firmware version not set')
    if (st3.appliedFirmwareSha256 !== planned.imageSha256) {
      throw new Error('firmware hash mismatch')
    }
    console.log('✓ local verified apply helper', st3.firmwareVersion)

    // Factory reset
    const { profile: p2, state: s2 } = await factoryReset(camRoot)
    if (p2.fingerprint !== profile.fingerprint) throw new Error('fingerprint changed')
    if (s2.password !== profile.defaultPassword) throw new Error('default password not restored')
    if (s2.enrolled) throw new Error('still enrolled after reset')
    if (s2.firmwareVersion !== '0.0.0') throw new Error('firmware not wiped')
    console.log('✓ factory reset deterministic')

    // Re-join
    const agent2 = new IotDeviceAgent(camRoot)
    const { joinId: join2 } = await agent2.requestJoin()
    const pending2 = await util.listPendingJoins()
    if (!pending2.joins.some((j) => j.fingerprint === profile.fingerprint)) {
      throw new Error('re-join not pending')
    }
    await util.approveJoin(join2)
    await agent2.refreshEnrollment()
    if (!(await agent2.state()).enrolled) throw new Error('re-enroll failed')
    console.log('✓ re-join after factory reset')

    console.log('\nALL SYNTHETIC CAMERA E2E CHECKS PASSED')
  } finally {
    server.kill('SIGTERM')
    await rm(dataDir, { recursive: true, force: true })
    await rm(camRoot, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('E2E FAILED', e)
  process.exit(1)
})
