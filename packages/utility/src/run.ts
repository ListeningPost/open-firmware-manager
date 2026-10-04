import { OpenFirmwareUtility } from './index.js'

export interface CliIo {
  log: (line: string) => void
  error: (line: string) => void
}

export const USAGE = `ofw-util — admin utility for Open Firmware control plane

Usage:
  ofw-util list-pending
  ofw-util approve <joinId>
  ofw-util deny <joinId>
  ofw-util list-devices
  ofw-util set-password <fingerprint> <password>
  ofw-util list-jobs
  ofw-util control-key

Env:
  OFW_CONTROL_URL   default http://127.0.0.1:8787
  OFW_ADMIN_TOKEN   required (the value the control plane was started with)
`

/**
 * Run one ofw-util command. Returns the process exit code; never exits or
 * reads globals itself so it can be driven from tests.
 */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo = { log: console.log, error: console.error },
  fetchImpl?: typeof fetch,
): Promise<number> {
  const [cmd, ...args] = argv
  const controlUrl = env.OFW_CONTROL_URL || 'http://127.0.0.1:8787'
  const adminToken = env.OFW_ADMIN_TOKEN || ''

  // control-key reads only public metadata, so it needs no token.
  if (!adminToken && cmd && cmd !== 'help' && cmd !== 'control-key') {
    io.error('Set OFW_ADMIN_TOKEN (the value the control plane was started with)')
    return 1
  }

  const util = new OpenFirmwareUtility({ controlUrl, adminToken, fetchImpl })

  try {
    switch (cmd) {
      case 'list-pending': {
        const r = await util.listPendingJoins()
        for (const j of r.joins) {
          io.log(
            `${j.id}\t${j.product}\t${j.serial}\t${j.mnemonic}\t${j.fingerprint.slice(0, 16)}…`,
          )
        }
        if (!r.joins.length) io.log('(none)')
        break
      }
      case 'approve': {
        const id = args[0]
        if (!id) throw new Error('usage: ofw-util approve <joinId>')
        const r = await util.approveJoin(id)
        io.log(`approved ${r.enrollmentId}`)
        break
      }
      case 'deny': {
        const id = args[0]
        if (!id) throw new Error('usage: ofw-util deny <joinId>')
        await util.denyJoin(id)
        io.log(`denied ${id}`)
        break
      }
      case 'list-devices': {
        const r = await util.listDevices()
        for (const d of r.devices) {
          io.log(
            `${d.id}\t${d.product}\t${d.serial}\t${d.status}\t${d.fingerprint.slice(0, 16)}…`,
          )
        }
        if (!r.devices.length) io.log('(none)')
        break
      }
      case 'set-password': {
        const [fp, password] = args
        if (!fp || !password) {
          throw new Error('usage: ofw-util set-password <fingerprint> <password>')
        }
        const r = await util.setPassword(fp, password)
        io.log(`job ${r.id} ${r.summary}`)
        break
      }
      case 'list-jobs': {
        const r = await util.listJobs()
        for (const j of r.jobs) {
          io.log(`${j.id}\t${j.kind}\t${j.status}\t${j.summary}`)
        }
        break
      }
      case 'control-key': {
        const r = await util.getMeta()
        io.log(r.controlPublicKey)
        break
      }
      case undefined:
      case 'help': {
        io.log(USAGE)
        break
      }
      default: {
        io.error(`unknown command: ${cmd}\n`)
        io.error(USAGE)
        return 1
      }
    }
    return 0
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}
