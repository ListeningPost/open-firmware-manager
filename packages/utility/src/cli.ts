#!/usr/bin/env node
import { OpenFirmwareUtility } from './index.js'

const [cmd, ...args] = process.argv.slice(2)
const controlUrl = process.env.OFW_CONTROL_URL || 'http://127.0.0.1:8787'
const adminToken = process.env.OFW_ADMIN_TOKEN || ''

if (!adminToken && cmd !== 'help' && cmd) {
  console.error('Set OFW_ADMIN_TOKEN (printed by control plane on start)')
  process.exit(1)
}

const util = new OpenFirmwareUtility({ controlUrl, adminToken })

async function main() {
  switch (cmd) {
    case 'list-pending': {
      const r = await util.listPendingJoins()
      for (const j of r.joins) {
        console.log(
          `${j.id}\t${j.product}\t${j.serial}\t${j.mnemonic}\t${j.fingerprint.slice(0, 16)}…`,
        )
      }
      if (!r.joins.length) console.log('(none)')
      break
    }
    case 'approve': {
      const id = args[0]
      if (!id) throw new Error('usage: ofw-util approve <joinId>')
      const r = await util.approveJoin(id)
      console.log('approved', r.enrollmentId)
      break
    }
    case 'deny': {
      const id = args[0]
      if (!id) throw new Error('usage: ofw-util deny <joinId>')
      await util.denyJoin(id)
      console.log('denied', id)
      break
    }
    case 'list-devices': {
      const r = await util.listDevices()
      for (const d of r.devices) {
        console.log(
          `${d.id}\t${d.product}\t${d.serial}\t${d.status}\t${d.fingerprint.slice(0, 16)}…`,
        )
      }
      if (!r.devices.length) console.log('(none)')
      break
    }
    case 'set-password': {
      const [fp, password] = args
      if (!fp || !password) {
        throw new Error('usage: ofw-util set-password <fingerprint> <password>')
      }
      const r = await util.setPassword(fp, password)
      console.log('job', r.id, r.summary)
      break
    }
    case 'list-jobs': {
      const r = await util.listJobs()
      for (const j of r.jobs) {
        console.log(`${j.id}\t${j.kind}\t${j.status}\t${j.summary}`)
      }
      break
    }
    default:
      console.log(`ofw-util — admin utility for Open Firmware control plane

Usage:
  ofw-util list-pending
  ofw-util approve <joinId>
  ofw-util deny <joinId>
  ofw-util list-devices
  ofw-util set-password <fingerprint> <password>
  ofw-util list-jobs

Env:
  OFW_CONTROL_URL   default http://127.0.0.1:8787
  OFW_ADMIN_TOKEN   required (from control plane logs)
`)
  }
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
