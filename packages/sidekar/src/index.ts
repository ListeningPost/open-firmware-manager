import {
  OpenFirmwareClient,
  type AppliedRelease,
  type ApplyHandler,
} from '@open-firmware/client'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export interface SidekarConfig {
  pds: string
  authorDid: string
  product: string
  channel?: string
  pollIntervalMs?: number
  statePath?: string
  workDir?: string
  /** Where package-kind payloads are written (e.g. message file for simple apps) */
  packageTargetPath?: string
  /** If set, run `docker load` for container kind */
  dockerLoad?: boolean
  /** Optional compose project directory to `docker compose up -d` after load */
  composeProjectDir?: string
  trustedAuthors?: string[]
  /** Skip CI/pipeline ack enforcement when selecting releases */
  skipPipelineCheck?: boolean
}

export interface SidekarState {
  appliedVersion?: string
  appliedUri?: string
  appliedCid?: string
  appliedAt?: string
  imageSha256?: string
}

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), '-', ...args)
}

async function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))
    })
  })
}

/**
 * Production Sidekar — server host agent.
 * Pulls signed releases from a PDS and applies them. Docker is optional and
 * only used for container/deployment kinds when configured.
 */
export class Sidekar {
  readonly client: OpenFirmwareClient
  readonly config: Required<
    Pick<
      SidekarConfig,
      'product' | 'channel' | 'pollIntervalMs' | 'statePath' | 'workDir'
    >
  > &
    SidekarConfig

  private handlers = new Map<string, ApplyHandler>()
  private running = false

  constructor(config: SidekarConfig) {
    this.config = {
      channel: 'stable',
      pollIntervalMs: 15_000,
      statePath: path.join(config.workDir ?? '/var/lib/sidekar', 'state.json'),
      workDir: '/var/lib/sidekar',
      dockerLoad: true,
      ...config,
    }
    this.client = new OpenFirmwareClient({
      pds: config.pds,
      authorDid: config.authorDid,
      trustedAuthors: config.trustedAuthors ?? [config.authorDid],
      skipPipelineCheck: config.skipPipelineCheck ?? false,
    })

    // Built-in apply handlers
    this.handlers.set('package', async (art) => {
      const target =
        this.config.packageTargetPath ??
        path.join(this.config.workDir, `${art.product}.bin`)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(art.path, target)
      log('package applied →', target)
    })

    this.handlers.set('firmware', async (art) => {
      // IoT-style: write image for external flash tool / hook override
      const target = path.join(this.config.workDir, `${art.product}-firmware.bin`)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(art.path, target)
      log('firmware image staged →', target, '(override apply handler to flash)')
    })

    this.handlers.set('container', async (art) => {
      if (!this.config.dockerLoad) {
        throw new Error('container kind requires dockerLoad=true and docker CLI')
      }
      await run('docker', ['load', '-i', art.path])
      if (this.config.composeProjectDir) {
        await run(
          'docker',
          ['compose', 'up', '-d', '--remove-orphans'],
          this.config.composeProjectDir,
        )
      }
      log('container loaded', art.version)
    })

    this.handlers.set('deployment', async (art) => {
      // Treat as compose/project archive: extract not implemented; load path as file bundle
      if (this.config.composeProjectDir) {
        await copyFile(
          art.path,
          path.join(this.config.composeProjectDir, 'bundle.bin'),
        )
        await run(
          'docker',
          ['compose', 'up', '-d', '--remove-orphans'],
          this.config.composeProjectDir,
        )
      } else {
        await this.handlers.get('package')!(art)
      }
    })
  }

  setApplyHandler(kind: string, handler: ApplyHandler): void {
    this.handlers.set(kind, handler)
  }

  async readState(): Promise<SidekarState> {
    try {
      return JSON.parse(await readFile(this.config.statePath, 'utf8')) as SidekarState
    } catch {
      return {}
    }
  }

  async writeState(state: SidekarState): Promise<void> {
    await mkdir(path.dirname(this.config.statePath), { recursive: true })
    await writeFile(this.config.statePath, JSON.stringify(state, null, 2))
  }

  async tick(): Promise<AppliedRelease | null> {
    const state = await this.readState()
    const art = await this.client.pullIfNewer({
      product: this.config.product,
      channel: this.config.channel,
      currentVersion: state.appliedVersion,
      outDir: path.join(this.config.workDir, 'downloads'),
    })
    if (!art) return null

    log('applying', art.kind, art.version, art.uri)
    const handler = this.handlers.get(art.kind) ?? this.handlers.get('package')
    if (!handler) throw new Error(`no apply handler for kind ${art.kind}`)
    await handler(art)

    await this.writeState({
      appliedVersion: art.version,
      appliedUri: art.uri,
      appliedCid: art.cid,
      appliedAt: new Date().toISOString(),
      imageSha256: art.imageSha256,
    })
    log('applied', art.version)
    return art
  }

  async runLoop(signal?: AbortSignal): Promise<void> {
    if (this.running) return
    this.running = true
    log('Sidekar starting', {
      pds: this.config.pds,
      authorDid: this.config.authorDid,
      product: this.config.product,
      channel: this.config.channel,
    })
    while (this.running && !signal?.aborted) {
      try {
        await this.tick()
      } catch (e) {
        log('tick error', e instanceof Error ? e.message : e)
      }
      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs))
    }
  }

  stop(): void {
    this.running = false
  }
}

export function loadAuthorDidFromFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  try {
    return readFileSync(filePath, 'utf8').trim() || null
  } catch {
    return null
  }
}
