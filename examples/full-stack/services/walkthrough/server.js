/**
 * Guided walkthrough UI — live status + buttons to trigger updates.
 */
import http from 'node:http'
import fs from 'node:fs'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { OpenFirmwareHost } from '@open-firmware/host'
import { verifyOemSignature } from '@open-firmware/core'

const PORT = Number(process.env.PORT || 8099)
const PDS_URL = (process.env.PDS_URL || 'http://pds:2583').replace(/\/$/, '')
const DEMO_URL = (process.env.DEMO_URL || 'http://demo-site:8080').replace(/\/$/, '')
const SIDEKAR_HEALTH = (process.env.SIDEKAR_HEALTH || 'http://sidekar:9090').replace(/\/$/, '')
const RUNNER_HEALTH = (process.env.RUNNER_HEALTH || 'http://pipeline-runner:9091').replace(
  /\/$/,
  '',
)
const CONTROL_URL = (process.env.CONTROL_URL || 'http://control:8787').replace(/\/$/, '')
// The control plane never hands its admin token out; this service is given it.
const ADMIN_TOKEN = process.env.OFW_ADMIN_TOKEN || ''
const AUTHOR_DID_FILE = process.env.AUTHOR_DID_FILE || '/config/author.did'
const ATTESTER_DID_FILE = process.env.ATTESTER_DID_FILE || '/config/attester.did'
const OFW_IDENTIFIER = process.env.OFW_IDENTIFIER || 'publisher.pds.test'
const OFW_PASSWORD = process.env.OFW_PASSWORD || 'publisher-pass-change-me'
const PRODUCT = process.env.PRODUCT || 'demo-site'
const REQUIRED_STAGES = ['build', 'test']
// Same trust anchors Sidekar is configured with, so this page can show the
// verdict Sidekar will reach for every release.
const TRUSTED_OEM_KEYS = (process.env.OFW_TRUSTED_OEM_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean)
// This service plays the publisher's workstation in the browser demo, so it is
// handed the OEM private key (base64 of the PKCS#8 PEM). Demo only.
const OEM_KEY_PEM = process.env.OFW_OEM_KEY_B64
  ? Buffer.from(process.env.OFW_OEM_KEY_B64, 'base64').toString('utf8')
  : ''
const OEM_PUBLIC_KEY = OEM_KEY_PEM ? rawPublicKey(OEM_KEY_PEM) : ''
const COL_RELEASE = 'app.openfirmware.firmware.release'
const COL_ACK = 'app.openfirmware.firmware.pipelineAck'
const COL_GATE = 'app.openfirmware.firmware.gate'
const COL_CHANNEL = 'app.openfirmware.firmware.channel'

/** Raw Ed25519 public key (unpadded base64url) of a PKCS#8 PEM private key. */
function rawPublicKey(pem) {
  const spki = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' })
  return spki.subarray(spki.length - 32).toString('base64url')
}

/** Recent action log for the UI */
const actionLog = []
function pushLog(entry) {
  actionLog.unshift({ at: new Date().toISOString(), ...entry })
  if (actionLog.length > 20) actionLog.length = 20
}

function readDid(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null
  } catch {
    return null
  }
}
const readAuthorDid = () => readDid(AUTHOR_DID_FILE)
const readAttesterDid = () => readDid(ATTESTER_DID_FILE)

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/**
 * The verdict Sidekar reaches for a release, from the same public records and
 * the same trust anchors: pinned OEM key, CI attester acks bound to the
 * release CID, gate ready and still naming this exact record.
 */
function sidekarVerdict(value, cid, gate, attesterAcks) {
  const reasons = []
  const oem = TRUSTED_OEM_KEYS.length
    ? verifyOemSignature(
        {
          product: value.product,
          version: value.version,
          channel: value.channel || 'stable',
          imageSha256: String(value.imageSha256),
          imageSize: Number(value.imageSize),
          oemSignature: value.oemSignature,
        },
        TRUSTED_OEM_KEYS,
      )
    : { ok: false, reason: 'no trusted OEM key configured' }
  const oemState = oem.ok
    ? 'valid'
    : !value.oemSignature
      ? 'missing'
      : oem.reason === 'signature mismatch'
        ? 'invalid'
        : 'untrusted'
  if (!oem.ok) reasons.push(`OEM signature ${oemState}${oem.reason ? ` (${oem.reason})` : ''}`)

  const passed = new Set(
    attesterAcks
      .filter((a) => a.releaseCid === cid && (a.result === 'passed' || a.result === 'skipped'))
      .map((a) => a.stage),
  )
  const missing = REQUIRED_STAGES.filter((st) => !passed.has(st))
  if (missing.length) reasons.push(`no CI attestation for ${missing.join(', ')}`)

  if (!gate) reasons.push('no gate record')
  else if (gate.state !== 'ready') reasons.push(`gate is ${gate.state}`)
  else if (gate.releaseCid !== cid) reasons.push('release record was rewritten after the gate was set')

  return { oem: oemState, attested: missing.length === 0, installable: reasons.length === 0, reasons }
}

async function safeFetch(url, ms = 3000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const res = await fetch(url, { signal: ac.signal })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not json */
    }
    return { ok: res.ok, status: res.status, text, json }
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) }
  } finally {
    clearTimeout(t)
  }
}

function latestAckByStage(acks) {
  const map = new Map()
  const sorted = [...acks].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  )
  for (const a of sorted) map.set(a.stage, a)
  return map
}

function pipelineSummary(release, acksForRelease) {
  const require = Boolean(release.requirePipelineAcks)
  const policy = release.pipelinePolicy || (require ? 'strict' : 'skipped')
  const stages =
    release.requiredPipelineStages?.length > 0
      ? release.requiredPipelineStages
      : require
        ? ['build', 'test']
        : []
  const byStage = latestAckByStage(acksForRelease)
  const stageRows = stages.map((stage) => {
    const ack = byStage.get(stage)
    return {
      stage,
      result: ack?.result || 'missing',
      createdAt: ack?.createdAt || null,
      runUrl: ack?.runUrl || null,
      summary: ack?.summary || null,
    }
  })
  for (const [stage, ack] of byStage) {
    if (!stages.includes(stage)) {
      stageRows.push({
        stage,
        result: ack.result,
        createdAt: ack.createdAt,
        runUrl: ack.runUrl,
        summary: ack.summary,
        extra: true,
      })
    }
  }

  let gate
  if (policy === 'skipped' || !require) gate = 'skipped (no CI required)'
  else if (release.status === 'awaiting-pipeline') gate = 'waiting on CI'
  else if (release.status === 'failed') gate = 'failed'
  else if (release.status === 'ready') {
    const bad = stageRows.some(
      (s) => !s.extra && s.result !== 'passed' && s.result !== 'skipped',
    )
    gate = bad ? 'ready but acks incomplete' : 'passed — installable'
  } else gate = release.status

  return { require, policy, stages, stageRows, gate }
}

async function listAllRecords(repo, collection) {
  const out = []
  let cursor
  const seen = new Set()
  for (let i = 0; i < 50; i++) {
    const u = new URL(`${PDS_URL}/xrpc/com.atproto.repo.listRecords`)
    u.searchParams.set('repo', repo)
    u.searchParams.set('collection', collection)
    u.searchParams.set('limit', '100')
    if (cursor) u.searchParams.set('cursor', cursor)
    const page = await safeFetch(u.toString())
    if (!page.ok || !page.json?.records) break
    out.push(...page.json.records)
    const next = page.json.cursor
    if (!next || next === cursor || seen.has(next)) break
    seen.add(next)
    cursor = next
  }
  return out
}

async function gatherStatus() {
  const authorDid = readAuthorDid()
  const pdsHealth = await safeFetch(`${PDS_URL}/xrpc/_health`)
  const demoHealth = await safeFetch(`${DEMO_URL}/healthz`)
  const demoMsg = await safeFetch(`${DEMO_URL}/api/message`)
  const sidekarHealth = await safeFetch(`${SIDEKAR_HEALTH}/`)
  const runnerHealth = await safeFetch(`${RUNNER_HEALTH}/`)

  let releases = []
  let allAcks = []
  const attesterDid = readAttesterDid()

  if (authorDid && pdsHealth.ok) {
    const listRecords = await listAllRecords(authorDid, COL_RELEASE)
    const gateRecords = await listAllRecords(authorDid, COL_GATE)
    const channelRecords = await listAllRecords(authorDid, COL_CHANNEL)
    const liveUris = new Set(
      channelRecords.map((c) => c.value?.release?.uri).filter(Boolean),
    )
    const gatesByRkey = new Map()
    for (const g of gateRecords) {
      gatesByRkey.set(g.uri?.split('/').pop(), {
        state: g.value?.state,
        releaseCid: g.value?.release?.cid,
      })
    }
    // Only the independent CI account's acks count; the publisher vouching
    // for itself is not attestation.
    const ackRecords = attesterDid ? await listAllRecords(attesterDid, COL_ACK) : []
    allAcks = ackRecords.map((r) => ({
      uri: r.uri,
      releaseUri: r.value?.release?.uri,
      releaseCid: r.value?.release?.cid,
      stage: r.value?.stage,
      result: r.value?.result,
      createdAt: r.value?.createdAt,
      runUrl: r.value?.runUrl,
      summary: r.value?.summary,
      actor: r.value?.actor,
    }))

    releases = listRecords
      .filter((r) => r.value?.product === PRODUCT)
      .map((r) => {
        const value = r.value || {}
        const rkey = r.uri?.split('/').pop()
        const gate = gatesByRkey.get(rkey)
        const status = gate?.state || 'unknown'
        const acksFor = allAcks.filter((a) => a.releaseUri === r.uri && a.releaseCid === r.cid)
        const pipeline = pipelineSummary(
          {
            status,
            requirePipelineAcks: true,
            requiredPipelineStages: REQUIRED_STAGES,
            pipelinePolicy: 'strict',
          },
          acksFor,
        )
        return {
          uri: r.uri,
          cid: r.cid,
          rkey,
          version: value.version,
          product: value.product,
          status,
          channel: value.channel,
          imageSize: value.imageSize,
          createdAt: value.createdAt,
          declaredPolicy: value.pipelinePolicy || (value.requirePipelineAcks ? 'strict' : 'skipped'),
          oemKeyId: value.oemSignature?.keyId || null,
          pipeline,
          acks: acksFor,
          live: liveUris.has(r.uri),
          verdict: sidekarVerdict(value, r.cid, gate, acksFor),
        }
      })
      .sort((x, y) => cmpVersion(y.version, x.version))
  }

  const iot = await gatherIot()

  const awaiting = releases.filter((r) => r.status === 'awaiting-pipeline')

  return {
    at: new Date().toISOString(),
    authorDid,
    attesterDid,
    trustedOemKeys: TRUSTED_OEM_KEYS,
    iot,
    counts: {
      releases: releases.length,
      awaitingPipeline: awaiting.length,
      installable: releases.filter((r) => r.verdict.installable).length,
      refused: releases.filter((r) => r.status === 'ready' && !r.verdict.installable).length,
      pipelineAcks: allAcks.length,
    },
    services: {
      pds: {
        name: 'PDS (distribution center)',
        url: 'http://localhost:2583',
        kind: 'container',
        healthy: pdsHealth.ok,
        detail: pdsHealth.json || pdsHealth.error || pdsHealth.text,
      },
      runner: {
        name: 'CI attester (pipeline-runner container)',
        note: 'Independent account; writes pipeline acks only — cannot promote or install',
        kind: 'container',
        healthy: runnerHealth.ok,
        detail: runnerHealth.json || runnerHealth.error,
      },
      sidekar: {
        name: 'Sidekar (Docker container)',
        note: 'Installer — requires the pinned OEM key and the CI attester, then applies',
        kind: 'container',
        healthy: sidekarHealth.ok,
        detail: sidekarHealth.json || sidekarHealth.error,
      },
      demoSite: {
        name: 'Example workload (demo-site container)',
        url: 'http://localhost:8080',
        kind: 'container',
        healthy: demoHealth.ok,
        message: demoMsg.json?.message || demoMsg.error || null,
      },
      control: {
        name: 'IoT control plane (control container)',
        url: 'http://localhost:8787/v1/meta',
        note: 'Device join approval and signed, sealed jobs',
        kind: 'container',
        healthy: iot.healthy,
      },
      walkthrough: {
        name: 'This walkthrough (Docker container)',
        url: 'http://localhost:8099',
        kind: 'container',
        healthy: true,
      },
    },
    releases,
    awaiting,
    actionLog,
  }
}

async function controlGet(pathname) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 3000)
  try {
    const res = await fetch(`${CONTROL_URL}${pathname}`, {
      signal: ac.signal,
      headers: ADMIN_TOKEN ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {},
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function gatherIot() {
  const meta = await controlGet('/v1/meta')
  if (!meta) return { healthy: false, pending: [], devices: [], jobs: [] }
  const [joins, devices, jobs] = await Promise.all([
    controlGet('/v1/join-requests'),
    controlGet('/v1/devices'),
    controlGet('/v1/jobs'),
  ])
  return {
    healthy: true,
    controlPublicKey: meta.controlPublicKey,
    pending: (joins?.joins || []).map((j) => ({
      id: j.id,
      product: j.product,
      serial: j.serial,
      mnemonic: j.mnemonic,
    })),
    devices: (devices?.devices || []).map((d) => ({
      serial: d.serial,
      product: d.product,
      status: d.status,
      fingerprint: String(d.fingerprint || '').slice(0, 16),
    })),
    jobs: (jobs?.jobs || []).map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      fingerprint: String(j.fingerprint || '').slice(0, 16),
    })),
  }
}

/** One patch above the highest version ever published (releases are immutable). */
async function nextVersion(authorDid) {
  let max = '1.0.0'
  for (const r of await listAllRecords(authorDid, COL_RELEASE)) {
    const v = String(r.value?.version || '')
    if (r.value?.product === PRODUCT && /^\d+\.\d+\.\d+$/.test(v) && cmpVersion(v, max) > 0) {
      max = v
    }
  }
  const [maj, min, patch] = max.split('.').map(Number)
  return `${maj}.${min}.${patch + 1}`
}

/**
 * Publisher step after CI: promote once the attester's acks are in. Only acks
 * from the CI DID are counted. Runs in the background for releases this page
 * published; CLI-published releases are promoted with `ofw pipeline-promote`.
 */
async function promoteWhenAttested(host, rkey, attesterDid) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const ref = await host.tryPromoteRelease(rkey, { attesterDids: [attesterDid] })
      if (ref) {
        pushLog({ action: 'promote', ok: true, message: `${rkey} promoted on CI attester acks` })
        return
      }
    } catch (e) {
      console.log('[walkthrough promote]', e.message || e)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  pushLog({ action: 'promote', ok: false, error: `${rkey}: no CI attestation within 90s` })
}

/**
 * mode 'signed'  — the legitimate publisher: OEM-signed, CI gate required.
 * mode 'attack'  — an attacker with the stolen PDS password: no OEM key,
 *                  CI skipped, pushed straight to the channel.
 */
async function doPublish({ message, mode }) {
  const attack = mode === 'attack'
  const attesterDid = readAttesterDid()
  if (!attack && (!OEM_KEY_PEM || !attesterDid)) {
    throw new Error('walkthrough has no OEM key or attester DID; run ./scripts/demo-setup.sh and restart')
  }
  const host = await OpenFirmwareHost.login({
    pds: PDS_URL,
    identifier: OFW_IDENTIFIER,
    password: OFW_PASSWORD,
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ofw-wt-'))
  const file = path.join(dir, 'payload.txt')
  const text =
    message?.trim() ||
    `Walkthrough update ${new Date().toISOString()}`
  await writeFile(file, text, 'utf8')
  const version = await nextVersion(host.did)
  try {
    const result = await host.publishRelease({
      product: PRODUCT,
      version,
      channel: 'stable',
      kind: 'package',
      file,
      skipPipeline: attack,
      requiredPipelineStages: attack ? [] : REQUIRED_STAGES,
      pipelinePolicy: attack ? 'skipped' : 'strict',
      ...(attack
        ? {}
        : { oemPrivateKeyPem: OEM_KEY_PEM, oemPublicKey: OEM_PUBLIC_KEY, oemKeyId: 'demo-oem-1' }),
      onProgress: (m) => console.log('[walkthrough publish]', m),
    })
    pushLog({
      action: attack ? 'ATTACK: unsigned publish, CI skipped' : 'publish (OEM-signed, CI gate)',
      ok: true,
      message: text,
      version,
      rkey: result.rkey,
      status: result.gateState,
      uri: result.release?.uri,
    })
    if (!attack) void promoteWhenAttested(host, result.rkey, attesterDid)
    return {
      ok: true,
      mode: attack ? 'attack' : 'signed',
      message: text,
      version,
      rkey: result.rkey,
      status: result.gateState,
      uri: result.release.uri,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function resultBadge(result) {
  if (result === 'passed') return '<span class="ok">passed</span>'
  if (result === 'failed') return '<span class="bad">failed</span>'
  if (result === 'skipped') return '<span class="warn">skipped</span>'
  if (result === 'missing') return '<span class="muted">missing</span>'
  return esc(result)
}

function statusBadge(status) {
  if (status === 'ready') return '<span class="ok">ready</span>'
  if (status === 'awaiting-pipeline') return '<span class="warn">awaiting-pipeline</span>'
  if (status === 'failed') return '<span class="bad">failed</span>'
  if (status === 'publishing') return '<span class="muted">publishing</span>'
  return `<span class="muted">${esc(status)}</span>`
}

function page(status) {
  const svc = status.services
  const rows = Object.values(svc)
    .map((s) => {
      const badge =
        s.healthy === true
          ? '<span class="ok">up</span>'
          : s.healthy === false
            ? '<span class="bad">down</span>'
            : '<span class="muted">unknown</span>'
      const kind = s.kind === 'container' ? '<span class="muted">container</span>' : '—'
      return `<tr>
        <td><strong>${esc(s.name)}</strong></td>
        <td>${kind}</td>
        <td>${badge}</td>
        <td>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a><br/>` : ''}${esc(s.note || '—')}</td>
      </tr>`
    })
    .join('')

  const SHOWN = 8
  const releaseCards =
    status.releases.length === 0
      ? '<p class="muted">No releases yet — use a button above, or <code>./scripts/demo-happy-path.sh</code>.</p>'
      : status.releases
          .slice(0, SHOWN)
          .map((r) => {
            const stages = `<table class="tight">
              <thead><tr><th>CI stage</th><th>Attested by CI account</th><th>When</th><th>Note</th></tr></thead>
              <tbody>
              ${r.pipeline.stageRows
                .map(
                  (s) => `<tr>
                  <td><code>${esc(s.stage)}</code></td>
                  <td>${resultBadge(s.result)}</td>
                  <td class="muted">${esc(s.createdAt || '—')}</td>
                  <td class="muted">${esc(s.summary || (s.runUrl ? s.runUrl : '—'))}</td>
                </tr>`,
                )
                .join('')}
              </tbody></table>`
            const v = r.verdict
            const oem =
              v.oem === 'valid'
                ? '<span class="ok">valid — pinned OEM key</span>'
                : v.oem === 'untrusted'
                  ? '<span class="bad">signed by an untrusted key</span>'
                  : v.oem === 'invalid'
                    ? '<span class="bad">invalid — does not match this record</span>'
                    : '<span class="bad">missing</span>'
            const verdict = v.installable
              ? `<span class="ok">${r.live ? 'ACCEPTED — live on the channel' : 'acceptable (superseded)'}</span>`
              : r.status === 'awaiting-pipeline'
                ? '<span class="warn">not offered to devices yet (awaiting CI)</span>'
                : `<span class="bad">REFUSED</span> <span class="muted">${esc(v.reasons.join('; '))}</span>`

            return `<div class="rel${!v.installable && r.status === 'ready' ? ' rel-bad' : ''}">
              <div class="rel-head">
                <div>
                  <strong>${esc(r.product)}</strong>
                  <code>v${esc(r.version)}</code>
                  gate ${statusBadge(r.status)}
                  ${r.live ? '<span class="pill">channel points here</span>' : ''}
                </div>
                <div>Sidekar: ${verdict}</div>
              </div>
              <div class="muted" style="font-size:0.8rem;margin:0.35rem 0">
                OEM signature: ${oem}${r.oemKeyId ? ` <code>${esc(r.oemKeyId)}</code>` : ''}
                · publisher-declared policy=<code>${esc(r.declaredPolicy)}</code>
                · rkey=<code>${esc(r.rkey)}</code>
              </div>
              ${stages}
            </div>`
          })
          .join('') +
        (status.releases.length > SHOWN
          ? `<p class="muted">… and ${status.releases.length - SHOWN} older release(s).</p>`
          : '')

  const iot = status.iot
  const iotCard = !iot.healthy
    ? '<p class="bad">Control plane not reachable.</p>'
    : `<p class="muted" style="margin:0 0 0.5rem">Job-signing key (devices pin this at the factory): <code>${esc(iot.controlPublicKey)}</code></p>
      <table class="tight"><thead><tr><th>Serial</th><th>Product</th><th>State</th><th>Detail</th></tr></thead><tbody>
      ${iot.pending
        .map(
          (j) => `<tr><td><code>${esc(j.serial)}</code></td><td>${esc(j.product)}</td>
          <td><span class="warn">waiting for admin approval</span></td>
          <td class="muted">${esc(j.mnemonic)} · <code>ofw-util approve ${esc(j.id)}</code></td></tr>`,
        )
        .join('')}
      ${iot.devices
        .map(
          (d) => `<tr><td><code>${esc(d.serial)}</code></td><td>${esc(d.product)}</td>
          <td><span class="ok">${esc(d.status)}</span></td>
          <td class="muted">fingerprint ${esc(d.fingerprint)}…</td></tr>`,
        )
        .join('')}
      ${
        iot.pending.length + iot.devices.length === 0
          ? '<tr><td colspan="4" class="muted">No devices yet — run <code>./scripts/iot-demo.sh</code>.</td></tr>'
          : ''
      }
      </tbody></table>
      ${
        iot.jobs.length
          ? `<table class="tight"><thead><tr><th>Signed job</th><th>Kind</th><th>Device</th><th>Status</th></tr></thead><tbody>
        ${iot.jobs
          .slice(0, 6)
          .map(
            (j) => `<tr><td><code>${esc(j.id)}</code></td><td>${esc(j.kind)}</td>
            <td class="muted">${esc(j.fingerprint)}…</td>
            <td>${j.status === 'acked_ok' ? '<span class="ok">applied by device</span>' : `<span class="warn">${esc(j.status)}</span>`}</td></tr>`,
          )
          .join('')}
        </tbody></table>`
          : ''
      }`

  const awaitingNote =
    status.counts.awaitingPipeline > 0
      ? `<p class="warn-box"><strong>${status.counts.awaitingPipeline}</strong> release(s) waiting for the CI attester and the publisher's promotion; no device is offered them yet.</p>`
      : `<p class="muted">No releases currently in <code>awaiting-pipeline</code>.</p>`

  const logRows =
    status.actionLog.length === 0
      ? '<p class="muted">No actions yet from this page.</p>'
      : `<table class="tight"><thead><tr><th>When</th><th>Action</th><th>Result</th></tr></thead><tbody>
      ${status.actionLog
        .map(
          (e) => `<tr>
          <td class="muted">${esc(e.at)}</td>
          <td><code>${esc(e.action)}</code></td>
          <td>${e.ok ? '<span class="ok">ok</span>' : '<span class="bad">fail</span>'}
            ${esc(e.message || '')}
            ${e.version ? ` <code>v${esc(e.version)}</code>` : ''}
            ${e.status ? ` → ${statusBadge(e.status)}` : ''}
            ${e.error ? `<br/><span class="bad">${esc(e.error)}</span>` : ''}
          </td>
        </tr>`,
        )
        .join('')}
      </tbody></table>`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Open Firmware · Guided walkthrough</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070b14; --card: #121a2b; --line: #243247; --text: #e8eef7;
      --muted: #9aa8bc; --ok: #4ade80; --bad: #f87171; --warn: #fbbf24;
      --accent: #60a5fa; --step: #818cf8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: ui-sans-serif, system-ui, sans-serif;
      background:
        radial-gradient(900px 480px at 0% -10%, #1e3a5f 0%, transparent 55%),
        radial-gradient(700px 400px at 100% 0%, #312e81 0%, transparent 45%),
        var(--bg);
      color: var(--text); line-height: 1.5;
    }
    header, main { max-width: 960px; margin: 0 auto; padding: 1.25rem 1.5rem; }
    h1 { font-size: 1.55rem; margin: 0 0 0.4rem; }
    .lead { color: var(--muted); margin: 0 0 1rem; }
    .badge {
      display: inline-block; padding: 0.25rem 0.65rem; border-radius: 999px;
      background: rgba(96,165,250,0.12); color: var(--accent);
      border: 1px solid rgba(96,165,250,0.35); font-size: 0.8rem; font-weight: 600;
    }
    h2 { font-size: 1.1rem; margin: 1.75rem 0 0.6rem; color: #c7d2fe; }
    .card {
      background: var(--card); border: 1px solid var(--line);
      border-radius: 0.85rem; padding: 1rem 1.15rem; margin: 0.75rem 0;
    }
    .flow {
      display: grid; grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr auto 1fr;
      gap: 0.35rem; align-items: stretch; margin: 1rem 0;
    }
    @media (max-width: 900px) { .flow { grid-template-columns: 1fr; } }
    .node {
      background: #0b1220; border: 1px solid var(--line); border-radius: 0.75rem;
      padding: 0.65rem; font-size: 0.85rem;
    }
    .node strong { color: var(--accent); display: block; margin-bottom: 0.2rem; font-size: 0.8rem; }
    .arrow { display: flex; align-items: center; justify-content: center; color: var(--step); font-weight: 700; }
    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; }
    pre {
      background: #0b1220; border: 1px solid var(--line); border-radius: 0.5rem;
      padding: 0.75rem; overflow-x: auto; color: #a5b4fc; margin: 0.5rem 0 0;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    table.tight { font-size: 0.82rem; margin-top: 0.5rem; }
    th, td { text-align: left; padding: 0.4rem 0.45rem; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; }
    .ok { color: var(--ok); font-weight: 700; }
    .bad { color: var(--bad); font-weight: 700; }
    .warn { color: var(--warn); font-weight: 700; }
    .muted { color: var(--muted); }
    .msg { font-size: 1.15rem; font-weight: 650; margin: 0.5rem 0 0; }
    .warn-box {
      background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.35);
      border-radius: 0.5rem; padding: 0.65rem 0.8rem; color: #fde68a;
    }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; }
    @media (max-width: 700px) { .stats { grid-template-columns: 1fr 1fr; } }
    .stat {
      background: #0b1220; border: 1px solid var(--line); border-radius: 0.6rem;
      padding: 0.65rem; text-align: center;
    }
    .stat .n { font-size: 1.4rem; font-weight: 700; color: var(--accent); }
    .stat .l { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; }
    .rel {
      border: 1px solid var(--line); border-radius: 0.65rem; padding: 0.75rem;
      margin: 0.6rem 0; background: #0b1220;
    }
    .rel-bad { border-color: rgba(248,113,113,0.55); background: rgba(248,113,113,0.06); }
    .pill {
      display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px; font-size: 0.72rem;
      border: 1px solid rgba(96,165,250,0.45); color: var(--accent); margin-left: 0.25rem;
    }
    button.danger { background: #7f1d1d; color: #fecaca; border-color: #f87171; }
    .rel-head { display: flex; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; align-items: baseline; }
    a { color: var(--accent); }
    footer { color: var(--muted); font-size: 0.85rem; margin: 2rem 0 1rem; }
    .actions { display: grid; gap: 0.75rem; }
    label { display: grid; gap: 0.3rem; font-size: 0.85rem; color: var(--muted); }
    input[type=text], textarea {
      font: inherit; padding: 0.55rem 0.65rem; border-radius: 0.45rem;
      border: 1px solid var(--line); background: #0b1220; color: var(--text);
    }
    .btn-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
    button {
      font: inherit; font-weight: 600; cursor: pointer; border-radius: 0.5rem;
      border: 1px solid transparent; padding: 0.55rem 0.9rem;
    }
    button.primary { background: #2563eb; color: white; border-color: #2563eb; }
    button.secondary { background: #0b1220; color: var(--text); border-color: var(--line); }
    button:disabled { opacity: 0.5; cursor: wait; }
    #flash {
      display: none; margin: 0.75rem 0; padding: 0.65rem 0.8rem;
      border-radius: 0.5rem; border: 1px solid var(--line); background: #0b1220;
    }
    #flash.show { display: block; }
    #flash.ok { border-color: rgba(74,222,128,0.45); }
    #flash.err { border-color: rgba(248,113,113,0.45); }

    /* —— Progress modal (car track) —— */
    .modal-backdrop {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(4, 8, 18, 0.78); backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      padding: 1rem; opacity: 0; pointer-events: none; transition: opacity 0.28s ease;
    }
    .modal-backdrop.open { opacity: 1; pointer-events: auto; }
    .modal {
      width: min(560px, 100%); background: linear-gradient(165deg, #142033 0%, #0c1220 100%);
      border: 1px solid var(--line); border-radius: 1.1rem; padding: 1.35rem 1.4rem 1.2rem;
      box-shadow: 0 24px 64px rgba(0,0,0,0.55); transform: translateY(12px) scale(0.97);
      transition: transform 0.32s cubic-bezier(.2,.8,.2,1);
    }
    .modal-backdrop.open .modal { transform: none; }
    .modal h3 { margin: 0 0 0.25rem; font-size: 1.15rem; }
    .modal .sub { color: var(--muted); font-size: 0.88rem; margin: 0 0 1rem; }
    .modal-body { display: grid; gap: 1rem; }
    .road-scene {
      position: relative; padding: 0.85rem 0.75rem 1rem;
      background:
        linear-gradient(180deg, rgba(30,41,59,0.5) 0%, rgba(15,23,42,0.9) 100%);
      border: 1px solid var(--line); border-radius: 0.85rem; overflow: hidden;
    }
    .road-labels {
      display: flex; justify-content: space-between; font-size: 0.68rem;
      font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--muted); margin-bottom: 0.35rem; padding: 0 0.15rem;
    }
    .road-labels .finish-label { color: #86efac; }
    .road {
      position: relative; height: 72px; margin: 0.25rem 0 0.5rem;
      border-radius: 0.65rem;
      background:
        repeating-linear-gradient(90deg,
          #1e293b 0 18px, #243247 18px 36px),
        linear-gradient(180deg, #334155, #1e293b);
      border: 2px solid #475569;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04);
    }
    .road::before {
      content: ''; position: absolute; left: 8%; right: 8%; top: 50%;
      height: 3px; margin-top: -1px;
      background: repeating-linear-gradient(90deg,
        #fbbf24 0 14px, transparent 14px 28px);
      opacity: 0.85;
    }
    .mile {
      position: absolute; top: -2px; bottom: -2px; width: 2px;
      background: rgba(148,163,184,0.35); transform: translateX(-50%);
    }
    .mile span {
      position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%);
      font-size: 0.62rem; color: var(--muted); white-space: nowrap; font-weight: 600;
    }
    .mile.hit { background: #4ade80; box-shadow: 0 0 8px rgba(74,222,128,0.5); }
    .mile.hit span { color: #86efac; }
    .mile.current span { color: #fde68a; }
    .car-wrap {
      position: absolute; top: 50%;
      --p: 0; /* 0–1 along the road */
      left: calc(var(--p) * (100% - 48px));
      transform: translateY(-50%);
      transition: left 0.55s cubic-bezier(.22,1,.36,1);
      width: 48px; height: 48px; z-index: 2;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      filter: drop-shadow(0 4px 6px rgba(0,0,0,0.45));
    }
    .car-emoji {
      font-size: 2rem; line-height: 1;
      animation: car-bob 0.45s ease-in-out infinite;
      transition: filter 0.35s ease;
    }
    .car-wrap.loading .car-emoji { animation: car-bob 0.35s ease-in-out infinite, car-wiggle 0.6s ease-in-out infinite; }
    .car-wrap.done .car-emoji {
      animation: none;
      filter: drop-shadow(0 0 10px rgba(74,222,128,0.75));
    }
    .car-wrap.err .car-emoji { animation: none; filter: grayscale(0.2) drop-shadow(0 0 8px rgba(248,113,113,0.6)); }
    .car-badge {
      margin-top: -2px; font-size: 0.55rem; font-weight: 800; letter-spacing: 0.02em;
      text-transform: uppercase; padding: 0.12rem 0.35rem; border-radius: 999px;
      background: #fbbf24; color: #1a1a1a; line-height: 1.1;
      transition: background 0.35s ease, color 0.35s ease, box-shadow 0.35s ease;
    }
    .car-wrap.loading .car-badge {
      background: #fbbf24; color: #1a1a1a;
      animation: badge-pulse 1s ease-in-out infinite;
    }
    .car-wrap.done .car-badge {
      background: #4ade80; color: #052e16;
      box-shadow: 0 0 10px rgba(74,222,128,0.55);
      animation: none;
    }
    .car-wrap.err .car-badge {
      background: #f87171; color: #450a0a; animation: none;
    }
    @keyframes car-bob {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-2px); }
    }
    @keyframes car-wiggle {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      25% { transform: translateY(-2px) rotate(-3deg); }
      75% { transform: translateY(-1px) rotate(3deg); }
    }
    @keyframes badge-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.72; }
    }
    @keyframes face-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.06); }
    }
    .stage-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.45rem; }
    .stage-list li {
      display: grid; grid-template-columns: 28px 1fr; gap: 0.55rem; align-items: start;
      padding: 0.45rem 0.55rem; border-radius: 0.55rem; border: 1px solid transparent;
      background: rgba(11,18,32,0.6);
    }
    .stage-list li.active {
      border-color: rgba(251,191,36,0.4);
      background: rgba(251,191,36,0.08);
    }
    .stage-list li.done {
      border-color: rgba(74,222,128,0.35);
      background: rgba(74,222,128,0.07);
    }
    .stage-list li.skipped {
      border-color: rgba(148,163,184,0.3);
      background: rgba(148,163,184,0.06);
    }
    .stage-list li.failed {
      border-color: rgba(248,113,113,0.4);
      background: rgba(248,113,113,0.08);
    }
    .stage-dot {
      width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center;
      justify-content: center; font-size: 0.72rem; font-weight: 800;
      background: #1e293b; color: var(--muted); border: 2px solid var(--line);
      transition: all 0.35s ease;
    }
    li.active .stage-dot {
      border-color: #fbbf24; color: #fbbf24;
      animation: face-pulse 1.1s ease-in-out infinite;
    }
    li.done .stage-dot {
      background: #166534; border-color: #4ade80; color: #bbf7d0;
      animation: none;
    }
    li.skipped .stage-dot {
      background: #334155; border-color: #94a3b8; color: #cbd5e1;
      animation: none;
    }
    li.failed .stage-dot {
      background: #7f1d1d; border-color: #f87171; color: #fecaca;
      animation: none;
    }
    .stage-meta strong { display: block; font-size: 0.9rem; }
    .stage-meta span { font-size: 0.75rem; color: var(--muted); }
    li.done .stage-meta span { color: #86efac; }
    li.active .stage-meta span { color: #fde68a; }
    .modal-actions { margin-top: 1rem; display: flex; justify-content: flex-end; gap: 0.5rem; }
    .modal-actions button { min-width: 5.5rem; }
  </style>
</head>
<body>
  <header>
    <h1>Guided walkthrough</h1>
    <p class="lead">
      Publish a real release from this page and watch each party check it. The <strong>publisher</strong> signs
      with an OEM key, an <strong>independent CI account</strong> attests build + test, and <strong>Sidekar</strong>
      installs only what passes both checks — then try the attack button.
    </p>
    <span class="badge" id="clock">${esc(status.at)}</span>
  </header>

  <main>
    <h2>Try it — trigger an update</h2>
    <div class="card actions">
      <label>
        Message for the demo front page
        <input type="text" id="msg" maxlength="200"
          value="Hello from walkthrough ${new Date().toISOString().slice(11, 19)}" />
      </label>
      <div class="btn-row">
        <button type="button" class="primary" id="btn-signed" onclick="triggerPublish('signed')">
          Publish signed release (OEM key + CI)
        </button>
        <button type="button" class="danger" id="btn-attack" onclick="triggerPublish('attack')">
          Simulate attack: stolen password, unsigned
        </button>
        <button type="button" class="secondary" id="btn-refresh" onclick="location.reload()">
          Refresh status
        </button>
      </div>
      <p class="muted" style="margin:0.5rem 0 0;font-size:0.85rem">
        <strong>Signed release:</strong> Ed25519 OEM signature, gate <code>awaiting-pipeline</code> until the CI account
        acks build + test, the publisher promotes, Sidekar verifies and installs.<br/>
        <strong>Attack:</strong> someone with the publisher's PDS password pushes an unsigned release straight to the
        channel. The PDS accepts it. Sidekar must not install it.
      </p>
      <div id="flash"></div>
    </div>

    <div class="modal-backdrop" id="growth-modal" aria-hidden="true" role="dialog" aria-labelledby="growth-title">
      <div class="modal">
        <h3 id="growth-title">Update in transit…</h3>
        <p class="sub" id="growth-sub">The car badge says loading, then turns green when each stage finishes.</p>
        <div class="modal-body">
          <div class="road-scene">
            <div class="road-labels">
              <span>Start</span>
              <span class="finish-label">Finish 🏁</span>
            </div>
            <div class="road" id="road">
              <div class="mile" data-mile="0" style="left:0%"><span>start</span></div>
              <div class="mile" data-mile="1" style="left:25%"><span>Publish</span></div>
              <div class="mile" data-mile="2" style="left:50%"><span>CI/CD</span></div>
              <div class="mile" data-mile="3" style="left:75%"><span>Install</span></div>
              <div class="mile" data-mile="4" style="left:100%"><span>Live</span></div>
              <div class="car-wrap loading" id="car-wrap" style="--p: 0">
                <div class="car-emoji" aria-hidden="true">🚗</div>
                <div class="car-badge" id="car-badge">loading</div>
              </div>
            </div>
          </div>
          <ol class="stage-list" id="stage-list"></ol>
        </div>
        <div class="modal-actions">
          <button type="button" class="secondary" id="modal-close" disabled onclick="closeGrowthModal()">Close</button>
        </div>
      </div>
    </div>

    <h2>Roles</h2>
    <div class="card">
      <div class="flow">
        <div class="node"><strong>1. Publisher</strong>OEM-signs, publishes</div>
        <div class="arrow">→</div>
        <div class="node"><strong>2. PDS</strong>immutable release record + blobs</div>
        <div class="arrow">→</div>
        <div class="node"><strong>3. CI account</strong>attests build + test</div>
        <div class="arrow">→</div>
        <div class="node"><strong>4. Sidekar</strong>verifies key, acks, hashes; installs</div>
        <div class="arrow">→</div>
        <div class="node"><strong>5. demo-site</strong>front page</div>
      </div>
    </div>

    <h2>Live counters</h2>
    <div class="stats">
      <div class="stat"><div class="n">${status.counts.releases}</div><div class="l">Releases</div></div>
      <div class="stat"><div class="n">${status.counts.awaitingPipeline}</div><div class="l">Awaiting CI</div></div>
      <div class="stat"><div class="n">${status.counts.installable}</div><div class="l">Passed all checks</div></div>
      <div class="stat"><div class="n" style="color:${status.counts.refused ? 'var(--bad)' : 'var(--accent)'}">${status.counts.refused}</div><div class="l">Refused by Sidekar</div></div>
    </div>
    <div class="card">${awaitingNote}</div>

    <h2>Services (all Docker containers)</h2>
    <div class="card">
      <table>
        <thead><tr><th>Piece</th><th>Type</th><th>Status</th><th>Where / notes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted" style="margin:0.75rem 0 0;font-size:0.85rem">
        Publisher DID: <code>${esc(status.authorDid || 'waiting…')}</code><br/>
        CI attester DID (Sidekar requires its acks): <code>${esc(status.attesterDid || 'waiting…')}</code><br/>
        OEM public key pinned by Sidekar: <code>${esc(status.trustedOemKeys.join(', ') || 'none')}</code>
      </p>
    </div>

    <h2>Front page message</h2>
    <div class="card">
      <p class="msg" id="front-msg">${esc(svc.demoSite.message || '—')}</p>
      <p style="margin:0.75rem 0 0"><a href="http://localhost:8080" target="_blank" rel="noopener">Open app →</a></p>
    </div>

    <h2>Releases — what Sidekar will do with each</h2>
    <div class="card" id="releases">${releaseCards}</div>

    <h2>IoT control plane — devices and signed jobs</h2>
    <div class="card" id="iot">${iotCard}</div>

    <h2>Actions from this page</h2>
    <div class="card">${logRows}</div>

    <footer>
      Auto-refresh every 8s (paused while a publish is running).
      Tear down: <code>docker compose down -v</code>
    </footer>
  </main>
  <script>
    let busy = false
    const STAGES = [
      { id: 'publish', label: 'Publish', detail: 'Sign with the OEM key, post release to the PDS' },
      { id: 'cicd', label: 'CI/CD', detail: 'Independent CI account attests build + test; publisher promotes' },
      { id: 'install', label: 'Install', detail: 'Sidekar verifies OEM key, CI acks, hashes; then applies' },
      { id: 'live', label: 'Live', detail: 'Demo front page shows new message' },
    ]

    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

    function setCar(mode, text, progress) {
      const wrap = document.getElementById('car-wrap')
      const badge = document.getElementById('car-badge')
      wrap.className = 'car-wrap ' + mode
      badge.textContent = text
      if (typeof progress === 'number') {
        wrap.style.setProperty('--p', String(Math.max(0, Math.min(1, progress))))
      }
      // light up milestones the car has passed
      const p = Number(wrap.style.getPropertyValue('--p')) || 0
      document.querySelectorAll('.mile').forEach((el) => {
        const m = Number(el.getAttribute('data-mile')) / 4
        el.classList.toggle('hit', p + 0.001 >= m)
        el.classList.toggle('current', Math.abs(p - m) < 0.12)
      })
    }

    function renderStages(states) {
      const ol = document.getElementById('stage-list')
      ol.innerHTML = STAGES.map((s) => {
        const st = states[s.id] || { status: 'pending', note: 'waiting' }
        const cls = st.status === 'active' ? 'active'
          : st.status === 'done' ? 'done'
          : st.status === 'skipped' ? 'skipped'
          : st.status === 'failed' ? 'failed' : ''
        const icon = st.status === 'done' ? '✓'
          : st.status === 'skipped' ? '–'
          : st.status === 'failed' ? '!'
          : st.status === 'active' ? '…' : '·'
        return '<li class="' + cls + '" data-id="' + s.id + '">' +
          '<div class="stage-dot">' + icon + '</div>' +
          '<div class="stage-meta"><strong>' + s.label + '</strong>' +
          '<span>' + (st.note || s.detail) + '</span></div></li>'
      }).join('')
    }

    function openGrowthModal(mode) {
      const backdrop = document.getElementById('growth-modal')
      document.getElementById('growth-title').textContent = 'Update in transit…'
      document.getElementById('growth-sub').textContent = mode === 'signed'
        ? '🚗 drives Publish → CI/CD → Install → Live. Badge turns green at each checkpoint.'
        : 'An attacker with the stolen publisher password pushes an unsigned release. Watch where it stops.'
      document.getElementById('modal-close').disabled = true
      setCar('loading', 'loading', 0)
      renderStages(Object.fromEntries(STAGES.map((s) => [s.id, { status: 'pending', note: s.detail }])))
      backdrop.classList.add('open')
      backdrop.setAttribute('aria-hidden', 'false')
    }

    function closeGrowthModal() {
      if (busy) return
      const backdrop = document.getElementById('growth-modal')
      backdrop.classList.remove('open')
      backdrop.setAttribute('aria-hidden', 'true')
      location.reload()
    }

    async function pollUntil(fn, { timeoutMs = 90000, intervalMs = 400 } = {}) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const v = await fn()
        if (v) return v
        await sleep(intervalMs)
      }
      throw new Error('Timed out waiting for stage to finish')
    }

    async function fetchStatus() {
      const res = await fetch('/api/status')
      if (!res.ok) throw new Error('status ' + res.status)
      return res.json()
    }

    async function triggerPublish(mode) {
      const attack = mode === 'attack'
      if (busy) return
      busy = true
      const flash = document.getElementById('flash')
      const msg = attack
        ? 'PWNED at ' + new Date().toISOString().slice(11, 19) + ' (unsigned, stolen password)'
        : (document.getElementById('msg').value.trim() ||
          ('Hello from walkthrough ' + new Date().toISOString().slice(11, 19)))
      const btns = [document.getElementById('btn-signed'), document.getElementById('btn-attack')]
      btns.forEach((b) => { b.disabled = true })
      flash.className = 'show'
      flash.textContent = 'Starting the car…'

      const states = Object.fromEntries(
        STAGES.map((s) => [s.id, { status: 'pending', note: s.detail }]),
      )
      const n = STAGES.length
      const mark = (id, status, note) => {
        states[id] = { status, note }
        const doneCount = STAGES.filter((s) => {
          const st = states[s.id].status
          return st === 'done' || st === 'skipped'
        }).length
        const idx = STAGES.findIndex((s) => s.id === id)
        // park car at stage: midway while active, fully at checkpoint when done
        let progress = doneCount / n
        if ((status === 'active' || status === 'failed') && idx >= 0) {
          progress = (idx + 0.45) / n
        } else if ((status === 'done' || status === 'skipped') && idx >= 0) {
          progress = (idx + 1) / n
        }
        renderStages(states)
        if (status === 'active') setCar('loading', 'loading', progress)
        else if (status === 'done') setCar('done', 'ok', progress)
        else if (status === 'skipped') setCar('done', 'skip', progress)
        else if (status === 'failed') setCar('err', 'fail', progress)
      }

      openGrowthModal(mode)

      try {
        // —— Stage 1: Publish ——
        mark('publish', 'active', attack ? 'Attacker posts unsigned release to the PDS…' : 'Signing with the OEM key, posting to the PDS…')
        const res = await fetch('/api/actions/publish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: msg, mode }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || res.statusText)
        mark('publish', 'done', 'v' + (data.version || '') + ' · ' + (data.status || 'ok'))
        await sleep(280)

        // —— Stage 2: CI/CD ——
        if (!attack) {
          mark('cicd', 'active', 'Waiting for the CI account to attest…')
          await pollUntil(async () => {
            const st = await fetchStatus()
            const rel = (st.releases || []).find((r) => r.version === data.version)
            if (!rel) return false
            if (rel.status === 'failed') throw new Error('Pipeline marked release failed')
            if (rel.status === 'ready') {
              mark('cicd', 'done', 'build + test attested by the CI account; publisher promoted')
              return true
            }
            mark('cicd', 'active', 'status=' + rel.status + ' — waiting…')
            return false
          }, { timeoutMs: 120000, intervalMs: 400 })
        } else {
          mark('cicd', 'active', 'Attacker skips CI…')
          await sleep(400)
          mark('cicd', 'skipped', 'bypassed — the PDS accepted it, gate=ready, channel moved')
        }
        await sleep(200)

        if (attack) {
          // Give Sidekar several poll cycles to (wrongly) install it.
          mark('install', 'active', 'Channel points at the attacker release — will Sidekar install it?')
          const t0 = Date.now()
          let verdict = null
          while (Date.now() - t0 < 6000) {
            const st = await fetchStatus()
            if (st.services?.demoSite?.message === msg) {
              throw new Error('FAILED OPEN: the attacker payload is live')
            }
            const rel = (st.releases || []).find((r) => r.version === data.version)
            if (rel) verdict = rel.verdict
            await sleep(500)
          }
          const why = verdict && verdict.reasons.length ? verdict.reasons.join('; ') : 'policy not satisfied'
          mark('install', 'failed', 'Sidekar REFUSED: ' + why)
          states.live = { status: 'skipped', note: 'front page unchanged — attacker payload never ran' }
          renderStages(states)
          setCar('err', 'blocked')
          document.getElementById('growth-title').textContent = 'Blocked — failed closed 🛡'
          document.getElementById('growth-sub').textContent =
            'A stolen password was not enough: no OEM signature, no CI attestation. Publish a signed release to move on.'
          document.getElementById('modal-close').disabled = false
          flash.className = 'show ok'
          flash.innerHTML = '<strong>Attack blocked.</strong> v' + (data.version || '') +
            ' is on the PDS; Sidekar refused it (' + why + ').'
          busy = false
          btns.forEach((b) => { b.disabled = false })
          return
        }

        // —— Stage 3: Install (Sidekar) ——
        mark('install', 'active', 'Sidekar installing ready release…')
        await pollUntil(async () => {
          const st = await fetchStatus()
          const live = st.services?.demoSite?.message
          if (live === msg) {
            mark('install', 'done', 'payload applied')
            return true
          }
          const rel = (st.releases || []).find((r) => r.version === data.version)
          if (rel && rel.status === 'ready') {
            mark('install', 'active', 'release ready — Sidekar polling…')
          }
          return false
        }, { timeoutMs: 90000, intervalMs: 400 })
        await sleep(200)

        // —— Stage 4: Live ——
        mark('live', 'active', 'Confirming front page…')
        await sleep(200)
        const final = await fetchStatus()
        const shown = final.services?.demoSite?.message || ''
        if (shown === msg) {
          mark('live', 'done', '"' + shown + '"')
        } else {
          mark('live', 'done', shown ? '"' + shown + '"' : 'front page updated')
        }
        setCar('done', 'done!', 1)
        document.getElementById('growth-title').textContent = 'Arrived at finish! 🏁'
        document.getElementById('growth-sub').textContent =
          'All stages complete — car badge is green. Open the demo app to see your message.'
        document.getElementById('modal-close').disabled = false
        flash.className = 'show ok'
        flash.innerHTML = '<strong>Done.</strong> v' + (data.version || '') +
          ' · message is live on the demo site.'
        busy = false
        btns.forEach((b) => { b.disabled = false })
      } catch (e) {
        setCar('err', 'fail')
        document.getElementById('growth-title').textContent = 'Breakdown on the road'
        document.getElementById('growth-sub').textContent = e.message || String(e)
        for (const s of STAGES) {
          if (states[s.id].status === 'active') {
            mark(s.id, 'failed', e.message || 'failed')
            break
          }
        }
        document.getElementById('modal-close').disabled = false
        flash.className = 'show err'
        flash.textContent = 'Error: ' + (e.message || e)
        busy = false
        btns.forEach((b) => { b.disabled = false })
      }
    }

    // soft auto-refresh when idle (paused while modal open / publish running)
    setTimeout(() => {
      if (!busy && !document.getElementById('growth-modal').classList.contains('open')) {
        location.reload()
      }
    }, 8000)
  </script>
</body>
</html>`
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  try {
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    if (url.pathname === '/api/status') {
      const status = await gatherStatus()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status, null, 2))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/actions/publish') {
      const raw = await readBody(req)
      const body = raw ? JSON.parse(raw) : {}
      try {
        const result = await doPublish({
          message: typeof body.message === 'string' ? body.message.slice(0, 200) : undefined,
          mode: body.mode === 'attack' ? 'attack' : 'signed',
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (e) {
        pushLog({
          action: 'publish',
          ok: false,
          error: e.message || String(e),
        })
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: e.message || String(e) }))
      }
      return
    }
    const status = await gatherStatus()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(status))
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(e.message || e))
  }
})

server.listen(PORT, () => {
  console.log(`walkthrough listening on :${PORT}`)
  console.log(`publish actions enabled → ${PDS_URL} as ${OFW_IDENTIFIER}`)
  console.log(`OEM key loaded: ${OEM_PUBLIC_KEY || 'NO'}; trusted by Sidekar: ${TRUSTED_OEM_KEYS.join(',') || 'none'}`)
})
