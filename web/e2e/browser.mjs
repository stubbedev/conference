// Browser harness shared by the smoke test and the production monitor:
// headless Chromes with fake devices driven over the DevTools protocol,
// a page hook that records peer connections and E2EE stats, and the
// assertions that a call really carries media.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolvePort(port))
    })
  })
}

export function findChrome() {
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    if (spawnSync('sh', ['-c', `command -v ${name}`]).status === 0) return name
  }
  throw new Error('no Chrome binary found; pass --chrome or set CHROME')
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
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
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

export async function launchChrome(chrome, idx, dir, extraArgs = []) {
  const port = await freePort()
  const profile = mkdtempSync(join(dir, `chrome-${idx}-`))
  const proc = spawn(
    chrome,
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
export const hook = (relayTransport) => `
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
          urls: s.urls.filter((u) => relayTransport === 'tls' ? u.startsWith('turns:') : u.startsWith('turn:') && u.endsWith('?transport=' + relayTransport)),
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

export const probe = `
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

export async function joinRoom(browser, url, relayTransport = null) {
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

export async function evalJs(browser, expression) {
  const r = await browser.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    browser.sessionId,
  )
  return r.result.value
}

export async function callJs(browser, fn, ...args) {
  const global = await browser.cdp.send('Runtime.evaluate', { expression: 'globalThis' }, browser.sessionId)
  const r = await browser.cdp.send(
    'Runtime.callFunctionOn',
    {
      functionDeclaration: fn.toString(),
      objectId: global.result.objectId,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    },
    browser.sessionId,
  )
  await browser.cdp.send('Runtime.releaseObject', { objectId: global.result.objectId }, browser.sessionId)
  if (r.exceptionDetails) throw new Error(`${fn.name} threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}

export async function waitFor(browser, expression, predicate, timeoutMs) {
  let value
  for (let t = 0; t < timeoutMs; t += 250) {
    value = await evalJs(browser, expression)
    if (predicate(value)) return { ok: true, value }
    await sleep(250)
  }
  return { ok: false, value }
}

export async function sample(browser) {
  const r = await browser.cdp.send(
    'Runtime.evaluate',
    { expression: probe, awaitPromise: true, returnByValue: true },
    browser.sessionId,
  )
  return JSON.parse(r.result.value)
}

export function check(failures, label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`)
}

export async function createRoom(base, name, apiKey = '') {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ name, password: '', maxMembers: 4 }),
  })
  if (!res.ok) throw new Error(`create room on ${base}: HTTP ${res.status} ${await res.text()}`)
  const room = await res.json()
  return {
    slug: room.slug,
    url: `${base}/r/${room.slug}#k=${room.roomKey}`,
    privUrl: `${base}${room.privPath}#k=${room.roomKey}`,
  }
}

export function stopProcess(proc, signal) {
  return new Promise((done) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return done()
    proc.once('exit', done)
    proc.kill(signal)
  })
}

export async function checkCall(failures, browsers, labels, { seconds, wantPaths = [] }) {
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
