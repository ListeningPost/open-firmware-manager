#!/usr/bin/env node
import { Sidekar } from './index.js'
import { readFileSync, existsSync } from 'node:fs'
import http from 'node:http'

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`missing env ${name}`)
  return v
}

function resolveAuthorDid(): string {
  if (process.env.AUTHOR_DID || process.env.OFW_AUTHOR_DID) {
    return (process.env.AUTHOR_DID || process.env.OFW_AUTHOR_DID)!
  }
  const file = process.env.AUTHOR_DID_FILE || '/config/author.did'
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  throw new Error('AUTHOR_DID or AUTHOR_DID_FILE required')
}

const skipPipeline =
  process.env.OFW_SKIP_PIPELINE === '1' ||
  process.env.SKIP_PIPELINE_CHECK === '1'

const sidekar = new Sidekar({
  pds: env('PDS_URL', process.env.OFW_PDS || 'http://127.0.0.1:2583'),
  authorDid: resolveAuthorDid(),
  product: env('PRODUCT', 'demo-site'),
  channel: process.env.CHANNEL || 'stable',
  pollIntervalMs: Number(process.env.POLL_MS || 5000),
  workDir: process.env.WORK_DIR || '/var/lib/sidekar',
  statePath: process.env.STATE_FILE || '/var/lib/sidekar/state.json',
  packageTargetPath: process.env.PACKAGE_TARGET || process.env.MESSAGE_FILE,
  dockerLoad: process.env.DOCKER_LOAD !== '0',
  composeProjectDir: process.env.COMPOSE_PROJECT_DIR,
  skipPipelineCheck: skipPipeline,
})

// Health endpoint so walkthrough / orchestrators can see this container is up
const healthPort = Number(process.env.HEALTH_PORT || 9090)
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        role: 'sidekar',
        product: process.env.PRODUCT || 'demo-site',
        note: 'installer container — not the CI runner',
      }),
    )
  })
  .listen(healthPort, () => {
    console.log(new Date().toISOString(), '-', 'health on :' + healthPort)
  })

const ac = new AbortController()
process.on('SIGTERM', () => {
  sidekar.stop()
  ac.abort()
})
process.on('SIGINT', () => {
  sidekar.stop()
  ac.abort()
})

await sidekar.runLoop(ac.signal)
