/**
 * Minimal front page that displays a message managed by Sidekar.
 * Reads MESSAGE_FILE on every request so updates appear without restart.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.PORT || 8080)
const MESSAGE_FILE =
  process.env.MESSAGE_FILE || path.join('/data', 'message.txt')
const FALLBACK =
  process.env.DEFAULT_MESSAGE ||
  'Waiting for Sidekar to apply a signed release…'

function readMessage() {
  try {
    const text = fs.readFileSync(MESSAGE_FILE, 'utf8').trim()
    if (text) return text
  } catch {
    // missing file is fine
  }
  return FALLBACK
}

function page(message) {
  const updated = (() => {
    try {
      return fs.statSync(MESSAGE_FILE).mtime.toISOString()
    } catch {
      return 'n/a'
    }
  })()

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="5" />
  <title>Open Firmware · Demo Site</title>
  <style>
    :root { color-scheme: dark light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: radial-gradient(1200px 600px at 20% 0%, #1e3a5f 0%, #0b1220 55%, #070b14 100%);
      color: #e8eef7; }
    main { width: min(40rem, 92vw); padding: 2rem 2.25rem; border-radius: 1rem;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 20px 60px rgba(0,0,0,0.35); backdrop-filter: blur(8px); }
    h1 { margin: 0 0 0.35rem; font-size: 1.15rem; font-weight: 600; letter-spacing: 0.02em;
      color: #9ec1ff; text-transform: uppercase; }
    .msg { margin: 1.25rem 0 1.5rem; font-size: clamp(1.4rem, 3vw, 2rem); line-height: 1.35;
      font-weight: 650; white-space: pre-wrap; word-break: break-word; }
    .meta { font-size: 0.85rem; color: #9aa8bc; display: grid; gap: 0.25rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9d7ea; }
  </style>
</head>
<body>
  <main>
    <h1>Demo front page</h1>
    <p class="msg">${escapeHtml(message)}</p>
    <div class="meta">
      <div>Message file: <code>${escapeHtml(MESSAGE_FILE)}</code></div>
      <div>File mtime: <code>${escapeHtml(updated)}</code></div>
      <div>Auto-refresh every 5s · updated via signed Open Firmware releases + Sidekar</div>
    </div>
  </main>
</body>
</html>`
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  if (req.url === '/api/message') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: readMessage() }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page(readMessage()))
})

server.listen(PORT, () => {
  console.log(`demo-site listening on :${PORT}`)
  console.log(`message file: ${MESSAGE_FILE}`)
})
