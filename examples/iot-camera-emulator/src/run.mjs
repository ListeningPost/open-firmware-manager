#!/usr/bin/env node
/**
 * Synthetic IoT camera emulator.
 *
 *   node src/run.mjs init
 *   node src/run.mjs run
 *   node src/run.mjs factory-reset
 *   node src/run.mjs status
 */
import {
  initFactoryProfile,
  factoryReset,
  IotDeviceAgent,
  loadFactoryProfile,
  loadUserState,
  publicIdentity,
} from '@open-firmware/iot'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.CAMERA_ROOT || path.join(__dirname, '..', 'data', 'camera-1')
const CONTROL = process.env.OFW_CONTROL_URL || 'http://127.0.0.1:8787'
const PRODUCT = process.env.PRODUCT || 'camera-x1'
const SERIAL = process.env.SERIAL || 'EMU-001'

const [cmd] = process.argv.slice(2)

async function main() {
  if (cmd === 'init') {
    const profile = await initFactoryProfile(ROOT, {
      product: PRODUCT,
      serial: SERIAL,
      controlEndpoint: CONTROL,
    })
    console.log('Factory profile created:')
    console.log(JSON.stringify(publicIdentity(profile), null, 2))
    console.log('defaultPassword:', profile.defaultPassword)
    console.log('root:', ROOT)
    return
  }

  if (cmd === 'factory-reset') {
    const { profile, state } = await factoryReset(ROOT)
    console.log('Factory reset complete')
    console.log('fingerprint (unchanged):', profile.fingerprint)
    console.log('mnemonic:', profile.mnemonic)
    console.log('password restored:', state.password)
    console.log('status:', state.status)
    return
  }

  if (cmd === 'status') {
    const profile = await loadFactoryProfile(ROOT)
    const state = await loadUserState(ROOT)
    console.log(JSON.stringify({ identity: publicIdentity(profile), state }, null, 2))
    return
  }

  if (cmd === 'run' || !cmd) {
    const agent = new IotDeviceAgent(ROOT)
    const id = await agent.identity()
    console.log('Camera emulator online')
    console.log('  product:', id.product)
    console.log('  serial:', id.serial)
    console.log('  fingerprint:', id.fingerprint)
    console.log('  mnemonic:', id.mnemonic)
    console.log('  control:', (await agent.profile()).controlEndpoint)

    console.log('Requesting join…')
    const { joinId } = await agent.requestJoin()
    console.log('  joinRequest:', joinId)

    const pollMs = Number(process.env.POLL_MS || 3000)
    for (;;) {
      try {
        const st = await agent.refreshEnrollment()
        if (st.enrolled) {
          console.log('Enrolled — pulling jobs…')
          const applied = await agent.pullAndApplyJobs()
          if (applied.length) console.log('  applied jobs:', applied.join(', '))
          const state = await agent.state()
          console.log(
            `  passwordRotated=${state.passwordRotated} firmware=${state.firmwareVersion}`,
          )
        } else {
          console.log('Waiting for admin approve…')
        }
      } catch (e) {
        console.error('loop error', e.message || e)
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  console.log('usage: init | run | factory-reset | status')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
