#!/usr/bin/env node
/**
 * Synthetic camera e2e:
 * 1. init camera + factory identity
 * 2. join → admin approve
 * 3. sealed password set
 * 4. synthetic firmware apply job
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

    const profile = await initFactoryProfile(camRoot, {
      product: 'camera-x1',
      serial: 'EMU-E2E-1',
      controlEndpoint: 'http://127.0.0.1:8799',
      factorySecret: 'e2e-secret',
    })
    const id = publicIdentity(profile)
    console.log('✓ factory identity', id.mnemonic, id.fingerprint.slice(0, 12))

    const agent = new IotDeviceAgent(camRoot)
    const { joinId } = await agent.requestJoin()
    console.log('✓ join request', joinId)

    const util = new OpenFirmwareUtility({
      controlUrl: 'http://127.0.0.1:8799',
      adminToken,
    })
    const pending = await util.listPendingJoins()
    if (!pending.joins.some((j) => j.id === joinId)) {
      throw new Error('join not visible to admin')
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
    console.log('✓ sealed password job applied')

    // Synthetic firmware as sealed job
    const fwBytes = Buffer.from('SYNTHETIC_CAMERA_FW_v3.1.0_PAYLOAD')
    const planned = chunkBytes(new Uint8Array(fwBytes), { chunkSize: 64 })
    await util.pushFirmware(fp, {
      version: '3.1.0',
      firmwareBase64: fwBytes.toString('base64'),
    })
    await agent.pullAndApplyJobs()
    const st3 = await agent.state()
    if (st3.firmwareVersion !== '3.1.0') throw new Error('firmware version not set')
    if (st3.appliedFirmwareSha256 !== planned.imageSha256) {
      throw new Error('firmware hash mismatch')
    }
    const img = await agent.readFirmware()
    if (!img || img.toString() !== fwBytes.toString()) {
      throw new Error('firmware bytes mismatch')
    }
    console.log('✓ synthetic firmware applied', st3.firmwareVersion, st3.appliedFirmwareSha256.slice(0, 12))

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
