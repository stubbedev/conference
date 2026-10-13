#!/usr/bin/env node
// End-to-end smoke test: two real Chromes with fake cameras join one
// room through a freshly started server and must actually exchange
// media. It fails the build when anything in the pipeline silently
// breaks — an encoded-transform API that does not exist in the
// browser, an SFU that forwards packets the receiver drops, a tile
// rendered twice — none of which unit tests or type checks can see.
//
//   node web/e2e/smoke.mjs [--server path/to/binary] [--chrome binary] [--seconds N] [--stagger MS]
//
// Without --server the binary is built with `go build`. Chrome needs
// no internet access; the server gets free ICE and TURN ports. A final
// pair of browsers is forced through the embedded TURN relay (one over
// UDP, one over TCP) via the machine's LAN address, since Chrome does
// not relay TURN/UDP to loopback. Exit code 0 means every assertion
// held on every browser.
import { spawn, spawnSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const args = parseArgs(process.argv.slice(2))
const seconds = Number(args.seconds ?? 8)
const stagger = Number(args.stagger ?? 500)
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

function freeUdpPort() {
  return new Promise((resolvePort, reject) => {
    const sock = createSocket('udp4')
    sock.on('error', reject)
    sock.bind(0, () => {
      const { port } = sock.address()
      sock.close(() => resolvePort(port))
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

async function serverEnv(dir, port) {
  return {
    ...process.env,
    PORT: String(port),
    ICE_UDP_PORT: String(await freeUdpPort()),
    TURN_PORT: String(await freePort()),
    DB_PATH: join(dir, 'smoke.db'),
  }
}

async function startServer(bin, env) {
  const port = env.PORT
  const proc = spawn(bin, [], {
    env,
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

function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    const lan = addrs?.find((a) => a.family === 'IPv4' && !a.internal)
    if (lan) return lan.address
  }
  throw new Error('no non-loopback IPv4 address: Chrome only relays TURN/UDP to a routable host')
}

async function launchChrome(idx, dir, extraArgs = []) {
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
      ...extraArgs,
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
const hook = (relayTransport) => `
(() => {
  window.__pcs = [];
  window.__pcStates = [];
  const relayTransport = ${JSON.stringify(relayTransport)};
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (config, ...rest) {
    if (relayTransport) {
      config = {
        ...config,
        iceTransportPolicy: 'relay',
        iceServers: config.iceServers.map((s) => ({
          ...s,
          urls: s.urls.filter((u) => u.startsWith('turn:') && u.endsWith('?transport=' + relayTransport)),
        })),
      };
    }
    const pc = new OrigPC(config, ...rest);
    window.__pcs.push(pc);
    const st = { events: [] };
    const record = (what) => st.events.push(
      Math.round(performance.now()) + ' ' + what +
      ' sig=' + pc.signalingState + ' ice=' + pc.iceConnectionState + ' conn=' + pc.connectionState,
    );
    pc.addEventListener('connectionstatechange', () => record('conn'));
    pc.addEventListener('iceconnectionstatechange', () => record('ice'));
    pc.addEventListener('signalingstatechange', () => record('sig'));
    pc.addEventListener('icecandidateerror', (e) => record('candidate-error ' + e.url + ' ' + e.errorCode + ' ' + e.errorText));
    window.__pcStates.push(st);
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
  const OrigWorker = window.Worker;
  window.Worker = function (...a) {
    const w = new OrigWorker(...a);
    w.addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'e2ee-stats') window.__e2ee = ev.data; });
    return w;
  };
  window.Worker.prototype = OrigWorker.prototype;
  window.__sockets = [];
  const OrigWS = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new OrigWS(...a);
    window.__sockets.push(ws);
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
})();
`

const probe = `
(async () => {
  const out = { videos: [], audioPackets: 0, videoDecoded: 0, e2ee: window.__e2ee || null, errors: window.__errors, pcs: [] };
  for (const v of document.querySelectorAll('video')) {
    out.videos.push({ frames: v.getVideoPlaybackQuality().totalVideoFrames, w: v.videoWidth, h: v.videoHeight, paused: v.paused });
  }
  const live = [...window.__pcs.entries()].filter(([, pc]) => pc.signalingState !== 'closed');
  for (const [i, pc] of live) {
    const s = {
      i,
      sig: pc.signalingState,
      ice: pc.iceConnectionState,
      conn: pc.connectionState,
      senders: pc.getSenders().filter((x) => x.track).length,
      events: (window.__pcStates[i]?.events ?? []).slice(-8),
    };
    for (const r of (await pc.getStats()).values()) {
      if (r.type === 'inbound-rtp') {
        s['in_' + r.kind] = r.packetsReceived || 0
        s['ssrc_' + r.kind] = r.ssrc
        s['bytes_' + r.kind] = r.bytesReceived || 0
      }
      if (r.type === 'outbound-rtp') s['out_' + r.kind] = r.bytesSent || 0
    }
    s.recv_kinds = pc.getReceivers().map((x) => x.track?.kind ?? '?').join(',')
    const stats = await pc.getStats();
    for (const r of stats.values()) {
      if (r.type !== 'transport' || !r.selectedCandidatePairId) continue;
      const local = stats.get(stats.get(r.selectedCandidatePairId)?.localCandidateId);
      s.path = !local ? '?' : local.relayProtocol ? 'relay/' + local.relayProtocol : local.candidateType;
    }
    out.pcs.push(s);
  }
  for (const [, pc] of live) {
    for (const r of (await pc.getStats()).values()) {
      if (r.type !== 'inbound-rtp') continue;
      if (r.kind === 'audio') out.audioPackets += r.packetsReceived || 0;
      if (r.kind === 'video') out.videoDecoded += r.framesDecoded || 0;
    }
  }
  return JSON.stringify(out);
})()
`

async function joinRoom(browser, url, relayTransport = null) {
  const s = browser.sessionId
  await browser.cdp.send('Page.enable', {}, s)
  await browser.cdp.send('Runtime.enable', {}, s)
  await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: hook(relayTransport) }, s)
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

async function evalJs(browser, expression) {
  const r = await browser.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    browser.sessionId,
  )
  return r.result.value
}

async function clickButtonByTitle(browser, label) {
  for (let t = 0; t < 20; t++) {
    const clicked = await evalJs(
      browser,
      `(() => { const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)}); if (b) { b.click(); return true; } return false; })()`,
    )
    if (clicked) return true
    await sleep(250)
  }
  return false
}

const recordingBadgePresent = `(() => { const h = document.querySelector('header'); return Boolean(h && [...h.querySelectorAll('span')].some(s => s.textContent.trim() === 'Recording')); })()`
const recordButtonPresent = `[...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'Record the call')`

// waitForBadge polls until the badge reaches the wanted state, so the
// assertions do not depend on event-arrival timing.
async function waitForBadge(browser, present, timeoutMs = 8000) {
  for (let t = 0; t < timeoutMs; t += 250) {
    const has = await evalJs(browser, present ? recordingBadgePresent : `!(${recordingBadgePresent})`)
    if (has) return true
    await sleep(250)
  }
  return false
}

async function waitForDownload(dir, timeoutMs = 15000) {
  for (let t = 0; t < timeoutMs; t += 500) {
    const files = readdirSync(dir).filter((f) => /\.(webm|mp4)$/.test(f))
    if (files.length > 0 && statSync(join(dir, files[0])).size > 0) {
      return { name: files[0], size: statSync(join(dir, files[0])).size }
    }
    await sleep(500)
  }
  return null
}

const tileMedia = `
(() => {
  const remote = document.querySelector('audio')?.closest('.group');
  const video = remote?.querySelector('video');
  const audio = remote?.querySelector('audio');
  const live = (el) => (el?.srcObject?.getTracks() ?? []).filter((t) => t.readyState === 'live').length;
  return {
    found: Boolean(video && audio),
    unpinButtons: [...document.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Unpin').length,
    videoFrames: video ? video.getVideoPlaybackQuality().totalVideoFrames : 0,
    videoPaused: video ? video.paused : true,
    videoTracks: live(video),
    audioTime: audio ? audio.currentTime : 0,
    audioPaused: audio ? audio.paused : true,
    audioTracks: live(audio),
  };
})()
`

const clickRemotePin = (label) => `
(() => {
  const remote = document.querySelector('audio')?.closest('.group');
  const button = remote && [...remote.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()
`

async function checkRemoteTilePlays(failures, label, browser, phase) {
  const before = await evalJs(browser, tileMedia)
  await sleep(2000)
  const after = await evalJs(browser, tileMedia)
  console.log(`${label} ${phase}: ${JSON.stringify(before)} → frames ${after.videoFrames}, audio t=${after.audioTime.toFixed(2)}`)
  check(failures, label, after.found, `${phase}: remote tile has no video/audio element`)
  if (!after.found) return after
  check(failures, label, after.videoTracks > 0, `${phase}: remote video element has no live track`)
  check(failures, label, after.audioTracks > 0, `${phase}: remote audio element has no live track`)
  check(failures, label, !after.videoPaused, `${phase}: remote video is paused`)
  check(failures, label, !after.audioPaused, `${phase}: remote audio is paused`)
  check(failures, label, after.videoFrames > before.videoFrames, `${phase}: remote video stopped rendering (${before.videoFrames}→${after.videoFrames})`)
  check(failures, label, after.audioTime > before.audioTime, `${phase}: remote audio stopped playing (t=${before.audioTime}→${after.audioTime})`)
  return after
}

async function checkPinRoundTrip(failures, label, browser) {
  check(failures, label, await evalJs(browser, clickRemotePin('Pin to main view')), 'no pin button on the remote tile')
  await sleep(500)
  const pinned = await checkRemoteTilePlays(failures, label, browser, 'pinned')
  check(failures, label, pinned.unpinButtons === 1, `expected the remote tile to be pinned, found ${pinned.unpinButtons} pinned tiles`)

  check(failures, label, await evalJs(browser, clickRemotePin('Unpin')), 'no unpin button on the pinned remote tile')
  await sleep(500)
  const unpinned = await checkRemoteTilePlays(failures, label, browser, 'unpinned')
  check(failures, label, unpinned.unpinButtons === 0, `expected no pinned tile after unpinning, found ${unpinned.unpinButtons}`)
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

async function createRoom(port, name, host = '127.0.0.1') {
  const res = await fetch(`http://${host}:${port}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: '', maxMembers: 4 }),
  })
  const room = await res.json()
  return {
    slug: room.slug,
    url: `http://${host}:${port}/r/${room.slug}#k=${room.roomKey}`,
    privUrl: `http://${host}:${port}${room.privPath}#k=${room.roomKey}`,
  }
}

function stopProcess(proc, signal) {
  return new Promise((done) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return done()
    proc.once('exit', done)
    proc.kill(signal)
  })
}

async function checkStillInRoom(failures, label, browsers) {
  for (const [i, browser] of browsers.entries()) {
    const path = await evalJs(browser, 'location.pathname')
    check(failures, `${label} ${i}`, path.startsWith('/r/'), `left the room for ${path}`)
  }
}

async function checkCall(failures, browsers, labels, wantPaths = []) {
  await sleep(seconds * 1000)
  const first = await Promise.all(browsers.map(sample))
  await sleep(2000)
  const second = await Promise.all(browsers.map(sample))

  for (const [i, a] of first.entries()) {
    const b = second[i]
    const label = labels[i]
    const before = failures.length
    console.log(
      `${label}: videos=${a.videos.length} frames=[${a.videos.map((v) => v.frames).join(',')}]→[${b.videos.map((v) => v.frames).join(',')}] ` +
        `audioPkts=${a.audioPackets}→${b.audioPackets} videoDecoded=${a.videoDecoded}→${b.videoDecoded} ` +
        `paths=${a.pcs.map((pc) => pc.path).join(',')} e2ee=${JSON.stringify(a.e2ee)}`,
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
    if (wantPaths[i]) {
      for (const pc of a.pcs) {
        check(failures, label, pc.path === wantPaths[i], `peer connection ${pc.i} took path ${pc.path}, want ${wantPaths[i]}`)
      }
    }
    if (failures.length > before) {
      console.error(`${label} peer connections: ${JSON.stringify(a.pcs)}`)
    }
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'conference-smoke-'))
  const procs = []
  const failures = []
  try {
    const bin = args.server ? resolve(args.server) : buildServer(dir)
    const port = await freePort()
    const env = await serverEnv(dir, port)
    let server = await startServer(bin, env)
    procs.push(server.proc)

    const room = await createRoom(port, 'smoke')
    const { url, privUrl } = room

    const browsers = [await launchChrome(0, dir), await launchChrome(1, dir)]
    for (const b of browsers) procs.push(b.proc)
    console.log(`smoke: ${browsers[0].browser}, room ${room.slug}`)

    // The first browser joins through the privileged link so it can
    // host the recording phase; the second joins like a normal guest.
    await joinRoom(browsers[0], privUrl)
    await sleep(stagger)
    await joinRoom(browsers[1], url)
    await sleep(stagger)

    await checkCall(failures, browsers, ['browser 0', 'browser 1'])

    for (const [i, browser] of browsers.entries()) {
      await checkPinRoundTrip(failures, `pinning browser ${i}`, browser)
    }

    await evalJs(browsers[1], 'window.__sockets.at(-1).close()')
    await checkCall(failures, browsers, ['dropped signaling 0', 'dropped signaling 1'])
    await checkStillInRoom(failures, 'dropped signaling', browsers)

    await stopProcess(server.proc, 'SIGTERM')
    server = await startServer(bin, env)
    procs.push(server.proc)
    await checkCall(failures, browsers, ['server restart 0', 'server restart 1'])
    await checkStillInRoom(failures, 'server restart', browsers)

    // Recording phase. Round one: the host records, a third browser
    // joins late (the badge must be replayed in its welcome), then the
    // host navigates away (the badge must clear everywhere — recording
    // outlives no one). Round two: the second host re-records, stops,
    // and a file must land on its disk.
    const dlDir = join(dir, 'downloads')
    mkdirSync(dlDir)

    const hostRecordButton = await clickButtonByTitle(browsers[0], 'Record the call')
    check(failures, 'recording', hostRecordButton, 'record button missing on the privileged browser')
    check(failures, 'recording', !(await evalJs(browsers[1], recordButtonPresent)), 'record button visible on the unprivileged browser')

    if (hostRecordButton) {
      check(failures, 'recording', await waitForBadge(browsers[0], true), 'recording badge missing on the recorder page')
      check(failures, 'recording', await waitForBadge(browsers[1], true), 'recording badge missing on the guest page')

      const late = await launchChrome(2, dir)
      procs.push(late.proc)
      await joinRoom(late, privUrl)
      check(failures, 'recording', await waitForBadge(late, true), 'late joiner did not see the recording badge')

      const s = browsers[0].sessionId
      await browsers[0].cdp.send('Page.navigate', { url: 'about:blank' }, s)
      check(failures, 'recording', await waitForBadge(browsers[1], false), 'badge did not clear on the guest after the recorder left')
      check(failures, 'recording', await waitForBadge(late, false), 'badge did not clear on the late joiner after the recorder left')

      // Round two: the late joiner holds a privileged session, so it
      // becomes the recorder and must deliver a file when it stops.
      await late.cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dlDir,
      })
      const reRecord = await clickButtonByTitle(late, 'Record the call')
      check(failures, 'recording', reRecord, 'record button missing on the second host')

      if (reRecord) {
        check(failures, 'recording', await waitForBadge(late, true), 'recording badge missing on the second recorder')
        check(failures, 'recording', await waitForBadge(browsers[1], true), 'recording badge missing on the guest for the second recorder')
        await sleep(3000)

        const stopped = await clickButtonByTitle(late, 'Stop recording')
        check(failures, 'recording', stopped, 'stop button missing while recording')

        const download = await waitForDownload(dlDir)
        check(failures, 'recording', download !== null, 'no recording file was downloaded')

        check(failures, 'recording', await waitForBadge(late, false), 'badge did not clear on the recorder after stop')
        check(failures, 'recording', await waitForBadge(browsers[1], false), 'badge did not clear on the guest after stop')
        const recorderErrors = await evalJs(late, 'window.__errors')
        const guestErrors = await evalJs(browsers[1], 'window.__errors')
        check(failures, 'recording', recorderErrors.length === 0, `recorder page errors: ${recorderErrors.join(' | ')}`)
        check(failures, 'recording', guestErrors.length === 0, `guest page errors: ${guestErrors.join(' | ')}`)

        console.log(`recording: late-joiner replay, recorder-leave clearing, file ${download ? `${download.name} ${download.size} bytes` : 'MISSING'}`)
      }
    }

    const lan = lanAddress()
    const relayRoom = await createRoom(port, 'smoke-relay', lan)
    const secureLan = [`--unsafely-treat-insecure-origin-as-secure=http://${lan}:${port}`]
    const relayed = [await launchChrome(3, dir, secureLan), await launchChrome(4, dir, secureLan)]
    for (const b of relayed) procs.push(b.proc)
    await joinRoom(relayed[0], relayRoom.url, 'udp')
    await sleep(stagger)
    await joinRoom(relayed[1], relayRoom.url, 'tcp')
    await checkCall(failures, relayed, ['relay over udp', 'relay over tcp'], ['relay/udp', 'relay/tcp'])

    if (failures.length) {
      console.error('\nSMOKE FAILED')
      for (const f of failures) console.error('  - ' + f)
      console.error('\nserver log tail:\n' + server.log().split('\n').slice(-20).join('\n'))
      process.exitCode = 1
    } else {
      console.log('\nSMOKE OK: media flows both ways through the SFU with E2EE')
    }
  } finally {
    // Wait for the children to be gone before removing their profiles:
    // Chrome keeps writing to its user-data-dir for a moment after
    // SIGKILL is delivered, and a racing rm fails with ENOTEMPTY.
    await Promise.all(procs.map((p) => stopProcess(p, 'SIGKILL')))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
