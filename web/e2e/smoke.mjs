#!/usr/bin/env node
// End-to-end smoke test: two real Chromes with fake cameras join one
// room through a freshly started server and must actually exchange
// media. It fails the build when anything in the pipeline silently
// breaks — an encoded-transform API that does not exist in the
// browser, an SFU that forwards packets the receiver drops, a tile
// rendered twice — none of which unit tests or type checks can see.
//
//   node web/e2e/smoke.mjs [--server path/to/binary] [--chrome binary] [--seconds N]
//
// Without --server the binary is built with `go build`. Chrome needs
// no network access; the server listens on 127.0.0.1 with ephemeral
// ICE ports. Exit code 0 means every assertion held on both browsers.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const args = parseArgs(process.argv.slice(2))
const seconds = Number(args.seconds ?? 8)
const chromeBinary = args.chrome ?? process.env.CHROME ?? findChrome()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    out[key.slice(2)] = argv[i + 1]
    i++
  }
  return out
}

function findChrome() {
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    if (spawnSync('sh', ['-c', `command -v ${name}`]).status === 0) return name
  }
  throw new Error('no Chrome binary found; pass --chrome or set CHROME')
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolvePort(port))
    })
  })
}

function buildServer(dir) {
  const bin = join(dir, 'server')
  const res = spawnSync('go', ['build', '-o', bin, './cmd/server'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0' },
  })
  if (res.status !== 0) throw new Error('go build failed')
  return bin
}

async function startServer(bin, dir, port) {
  const proc = spawn(bin, [], {
    env: { ...process.env, PORT: String(port), ICE_UDP_PORT: '0', DB_PATH: join(dir, 'smoke.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', (d) => (log += d))
  proc.stderr.on('data', (d) => (log += d))
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`)
      if (res.ok) return { proc, log: () => log }
    } catch {
      // not up yet
    }
    await sleep(200)
  }
  proc.kill('SIGKILL')
  throw new Error(`server did not start:\n${log}`)
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const waiter = msg.id && this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result)
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
}

async function launchChrome(idx, dir) {
  const port = await freePort()
  const profile = mkdtempSync(join(dir, `chrome-${idx}-`))
  const proc = spawn(
    chromeBinary,
    [
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--disable-gpu',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--window-size=1200,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let stderr = ''
  proc.stderr.on('data', (d) => (stderr += d))
  let version
  for (let i = 0; i < 100 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    } catch {
      await sleep(200)
    }
  }
  if (!version) {
    proc.kill('SIGKILL')
    throw new Error(`chrome ${idx} did not start: ${stderr}`)
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((r, reject) => {
    ws.onopen = r
    ws.onerror = reject
  })
  const cdp = new CDP(ws)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  return { proc, cdp, sessionId, browser: version.Browser }
}

// Injected before the app loads: records peer connections and the
// E2EE worker's stats so the probe can read them from page context.
const hook = `
(() => {
  window.__pcs = [];
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) { const pc = new OrigPC(...a); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
  const OrigWorker = window.Worker;
  window.Worker = function (...a) {
    const w = new OrigWorker(...a);
    w.addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'e2ee-stats') window.__e2ee = ev.data; });
    return w;
  };
  window.Worker.prototype = OrigWorker.prototype;
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
})();
`

const probe = `
(async () => {
  const out = { videos: [], audioPackets: 0, videoDecoded: 0, e2ee: window.__e2ee || null, errors: window.__errors };
  for (const v of document.querySelectorAll('video')) {
    out.videos.push({ frames: v.getVideoPlaybackQuality().totalVideoFrames, w: v.videoWidth, h: v.videoHeight, paused: v.paused });
  }
  for (const pc of window.__pcs) {
    for (const r of (await pc.getStats()).values()) {
      if (r.type !== 'inbound-rtp') continue;
      if (r.kind === 'audio') out.audioPackets += r.packetsReceived || 0;
      if (r.kind === 'video') out.videoDecoded += r.framesDecoded || 0;
    }
  }
  return JSON.stringify(out);
})()
`

async function joinRoom(browser, url) {
  const s = browser.sessionId
  await browser.cdp.send('Page.enable', {}, s)
  await browser.cdp.send('Runtime.enable', {}, s)
  await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: hook }, s)
  await browser.cdp.send('Page.navigate', { url }, s)
  for (let t = 0; t < 80; t++) {
    const r = await browser.cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Join call'); if (b && !b.disabled) { b.click(); return true; } return false; })()`,
        returnByValue: true,
      },
      s,
    )
    if (r.result.value === true) return
    await sleep(250)
  }
  throw new Error('Join call button never became clickable')
}

async function sample(browser) {
  const r = await browser.cdp.send(
    'Runtime.evaluate',
    { expression: probe, awaitPromise: true, returnByValue: true },
    browser.sessionId,
  )
  return JSON.parse(r.result.value)
}

function check(failures, label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`)
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'conference-smoke-'))
  const procs = []
  const failures = []
  try {
    const bin = args.server ? resolve(args.server) : buildServer(dir)
    const port = await freePort()
    const server = await startServer(bin, dir, port)
    procs.push(server.proc)

    const room = await (
      await fetch(`http://127.0.0.1:${port}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'smoke', password: '', maxMembers: 4 }),
      })
    ).json()
    const url = `http://127.0.0.1:${port}/r/${room.slug}#k=${room.roomKey}`

    const browsers = [await launchChrome(0, dir), await launchChrome(1, dir)]
    for (const b of browsers) procs.push(b.proc)
    console.log(`smoke: ${browsers[0].browser}, room ${room.slug}`)

    for (const b of browsers) {
      await joinRoom(b, url)
      await sleep(500)
    }

    await sleep(seconds * 1000)
    const first = await Promise.all(browsers.map(sample))
    await sleep(2000)
    const second = await Promise.all(browsers.map(sample))

    for (const [i, a] of first.entries()) {
      const b = second[i]
      const label = `browser ${i}`
      console.log(
        `${label}: videos=${a.videos.length} frames=[${a.videos.map((v) => v.frames).join(',')}]→[${b.videos.map((v) => v.frames).join(',')}] ` +
          `audioPkts=${a.audioPackets}→${b.audioPackets} videoDecoded=${a.videoDecoded}→${b.videoDecoded} ` +
          `e2ee=${JSON.stringify(a.e2ee)}`,
      )
      check(failures, label, a.videos.length === 2, `expected 2 video elements (self + one remote), found ${a.videos.length}`)
      check(failures, label, a.e2ee !== null, 'no E2EE worker stats received')
      if (a.e2ee) {
        check(failures, label, a.e2ee.dropSend === 0, `E2EE dropped ${a.e2ee.dropSend} outgoing frames: ${a.e2ee.lastError}`)
        check(failures, label, a.e2ee.dropRecv === 0, `E2EE dropped ${a.e2ee.dropRecv} incoming frames: ${a.e2ee.lastError}`)
        check(failures, label, a.e2ee.send > 0, 'E2EE encrypted no outgoing frames')
        check(failures, label, a.e2ee.recv > 0, 'E2EE decrypted no incoming frames')
      }
      check(failures, label, a.audioPackets > 0, 'no remote audio packets received')
      check(failures, label, b.videoDecoded > a.videoDecoded && a.videoDecoded > 0, `remote video not decoding (${a.videoDecoded}→${b.videoDecoded})`)
      for (const [j, v] of a.videos.entries()) {
        check(failures, label, b.videos[j] && b.videos[j].frames > v.frames, `video element ${j} stopped rendering (${v.frames}→${b.videos[j]?.frames})`)
        check(failures, label, !v.paused, `video element ${j} is paused`)
      }
      check(failures, label, a.errors.length === 0, `page errors: ${a.errors.join(' | ')}`)
    }

    if (failures.length) {
      console.error('\nSMOKE FAILED')
      for (const f of failures) console.error('  - ' + f)
      console.error('\nserver log tail:\n' + server.log().split('\n').slice(-20).join('\n'))
      process.exitCode = 1
    } else {
      console.log('\nSMOKE OK: media flows both ways through the SFU with E2EE')
    }
  } finally {
    for (const p of procs) p.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
