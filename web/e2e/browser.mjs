// Browser harness shared by the smoke test and the production monitor:
// headless Chromes with fake devices driven over the DevTools protocol,
// headless Firefoxes driven over WebDriver BiDi behind the same calls, a
// page hook that records peer connections and E2EE stats, and the
// assertions that a call really carries media.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

// A control's accessible name, as far as this app's markup goes: what
// aria-labelledby points at, else its aria-label, else its content, which
// is its text and the labels of what is inside it, without the parts
// hidden from assistive technology.
export function accessibleName(control) {
  const text = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.data
    if (node.nodeType !== Node.ELEMENT_NODE || node.getAttribute('aria-hidden') === 'true') return ''
    return node.getAttribute('aria-label') ?? node.getAttribute('alt') ?? [...node.childNodes].map(text).join('')
  }
  const tidy = (name) => name.replace(/\s+/g, ' ').trim()
  const labelledBy = control.getAttribute('aria-labelledby')
  if (labelledBy) return tidy(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '))
  return tidy(text(control))
}

// A function called in the page travels as its source, so nothing of
// this module is in its scope except what is declared beside it here.
const inPage = (fn) => `(...args) => { ${accessibleName}; return (${fn})(...args) }`

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method) for (const listener of this.listeners.get(msg.method) ?? []) listener(msg.params)
      const waiter = msg.id && this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
    }
  }
  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener])
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
}

const CHROME_START_TIMEOUT_MS = 90_000

function devToolsEndpoint(proc, idx) {
  return new Promise((resolveEndpoint, reject) => {
    let stderr = ''
    const settle = () => {
      clearTimeout(timer)
      proc.off('error', onError)
      proc.off('exit', onExit)
      proc.stderr.off('data', onData)
      proc.stderr.resume()
    }
    const fail = (reason) => {
      settle()
      proc.kill('SIGKILL')
      reject(new Error(`chrome ${idx} did not start: ${reason}\n${stderr}`))
    }
    const onError = (err) => fail(err.message)
    const onExit = (code, signal) => fail(`exited with ${signal ?? `code ${code}`}`)
    const onData = (chunk) => {
      stderr += chunk
      const match = /^DevTools listening on (ws:\/\/\S+)$/m.exec(stderr)
      if (!match) return
      settle()
      resolveEndpoint(match[1])
    }
    const timer = setTimeout(() => fail(`no DevTools endpoint within ${CHROME_START_TIMEOUT_MS} ms`), CHROME_START_TIMEOUT_MS)
    proc.on('error', onError)
    proc.on('exit', onExit)
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', onData)
  })
}

export async function launchChrome(chrome, idx, dir, extraArgs = [], { headless = true, fakeDevices = true, fakeUi = true, gpu = false } = {}) {
  const profile = mkdtempSync(join(dir, `chrome-${idx}-`))
  const proc = spawn(
    chrome,
    [
      // Test browsers stay silent: their fake mics would beep through the speakers.
      ...(headless ? ['--headless=new', '--mute-audio'] : []),
      '--no-sandbox',
      '--no-first-run',
      ...(gpu ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan'] : ['--disable-gpu']),
      ...(fakeDevices ? ['--use-fake-device-for-media-stream'] : []),
      ...(fakeUi ? ['--use-fake-ui-for-media-stream'] : []),
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-size=1200,900',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const ws = new WebSocket(await devToolsEndpoint(proc, idx))
  await new Promise((r, reject) => {
    ws.onopen = r
    ws.onerror = reject
  })
  const cdp = new CDP(ws)
  const { product } = await cdp.send('Browser.getVersion')
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  return {
    proc,
    cdp,
    sessionId,
    browser: product,
    async addInitScript(source) {
      await cdp.send('Page.enable', {}, sessionId)
      await cdp.send('Runtime.enable', {}, sessionId)
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId)
    },
    async navigate(url) {
      await cdp.send('Page.enable', {}, sessionId)
      await cdp.send('Page.navigate', { url }, sessionId)
    },
    async evaluate(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
      return r.result.value
    },
    async callFunction(fn, ...args) {
      const global = await cdp.send('Runtime.evaluate', { expression: 'globalThis' }, sessionId)
      const r = await cdp.send(
        'Runtime.callFunctionOn',
        {
          functionDeclaration: inPage(fn),
          objectId: global.result.objectId,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: true,
        },
        sessionId,
      )
      await cdp.send('Runtime.releaseObject', { objectId: global.result.objectId }, sessionId)
      if (r.exceptionDetails) throw new Error(`${fn.name} threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
      return r.result.value
    },
    // The send-side bandwidth estimate of the connection that sends ssrc,
    // in bits per second; null when no connection sends it.
    async outgoingEstimate(ssrc) {
      return this.evaluate(`(async () => {
        for (const pc of window.__pcs.filter((pc) => pc.signalingState !== 'closed')) {
          const stats = [...(await pc.getStats()).values()]
          if (!stats.some((r) => r.type === 'outbound-rtp' && r.ssrc === ${Number(ssrc)})) continue
          return stats.find((r) => r.type === 'candidate-pair' && r.nominated && r.availableOutgoingBitrate)?.availableOutgoingBitrate ?? null
        }
        return null
      })()`)
    },
  }
}

export function findFirefox() {
  for (const name of ['firefox', 'firefox-esr']) {
    if (spawnSync('sh', ['-c', `command -v ${name}`]).status === 0) return name
  }
  throw new Error('no Firefox binary found; pass --firefox or set FIREFOX, or pass --skip-firefox to measure Chrome alone')
}

// WebDriver BiDi, which Firefox speaks natively now that it has dropped
// CDP. Commands and events share one socket; events carry a method and
// no id.
class BiDi {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const waiter = msg.id && this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.type === 'error') waiter.reject(new Error(`${msg.error}: ${msg.message}`))
      else waiter.resolve(msg.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

function bidiEndpoint(proc, idx) {
  return new Promise((resolveEndpoint, reject) => {
    let stderr = ''
    const settle = () => {
      clearTimeout(timer)
      proc.off('error', onError)
      proc.off('exit', onExit)
      proc.stderr.off('data', onData)
      proc.stderr.resume()
    }
    const fail = (reason) => {
      settle()
      proc.kill('SIGKILL')
      reject(new Error(`firefox ${idx} did not start: ${reason}\n${stderr}`))
    }
    const onError = (err) => fail(err.message)
    const onExit = (code, signal) => fail(`exited with ${signal ?? `code ${code}`}`)
    const onData = (chunk) => {
      stderr += chunk
      const match = /^WebDriver BiDi listening on (ws:\/\/\S+)$/m.exec(stderr)
      if (!match) return
      settle()
      resolveEndpoint(`${match[1]}/session`)
    }
    const timer = setTimeout(() => fail(`no WebDriver BiDi endpoint within ${CHROME_START_TIMEOUT_MS} ms`), CHROME_START_TIMEOUT_MS)
    proc.on('error', onError)
    proc.on('exit', onExit)
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', onData)
  })
}

// Fake camera and microphone without a prompt, media that plays without
// a gesture, silent speakers, and ICE over loopback, which Firefox leaves
// out unless told to.
const FIREFOX_PREFS = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
  'media.autoplay.default': 0,
  'media.autoplay.blocking_policy': 0,
  'media.volume_scale': '0.0',
  'media.peerconnection.ice.loopback': true,
  'media.peerconnection.ice.obfuscate_host_addresses': false,
}

function bidiValue(value) {
  if (value === null) return { type: 'null' }
  if (value === undefined) return { type: 'undefined' }
  if (typeof value === 'string' || typeof value === 'boolean') return { type: typeof value, value }
  if (typeof value === 'number') return { type: 'number', value }
  throw new Error(`cannot pass ${typeof value} ${String(value)} to the page over WebDriver BiDi`)
}

// Results cross as JSON text, so a page value arrives as the same plain
// data Chrome's returnByValue gives.
function bidiResult(response, what) {
  if (response.type === 'exception') return { thrown: `${what} threw: ${response.exceptionDetails.text}` }
  const { result } = response
  return { value: result.type === 'string' ? JSON.parse(result.value) : undefined }
}

export async function launchFirefox(firefox, idx, dir, { headless = true } = {}) {
  const profile = mkdtempSync(join(dir, `firefox-${idx}-`))
  writeFileSync(
    join(profile, 'user.js'),
    Object.entries(FIREFOX_PREFS)
      .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
      .join('\n'),
  )
  const proc = spawn(
    firefox,
    [
      ...(headless ? ['--headless'] : []),
      '--no-remote',
      '--profile',
      profile,
      '--remote-debugging-port=0',
      '--remote-allow-system-access',
      '--width=1200',
      '--height=900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } },
  )
  const ws = new WebSocket(await bidiEndpoint(proc, idx))
  await new Promise((r, reject) => {
    ws.onopen = r
    ws.onerror = reject
  })
  const bidi = new BiDi(ws)
  const { capabilities } = await bidi.send('session.new', { capabilities: {} })
  const { contexts } = await bidi.send('browsingContext.getTree', {})
  const target = { context: contexts[0].context }
  const { contexts: windows } = await bidi.send('browsingContext.getTree', { 'moz:scope': 'chrome' })
  const browserWindow = { context: windows[0].context }
  return {
    proc,
    bidi,
    browser: `${capabilities.browserName}/${capabilities.browserVersion}`,
    async addInitScript(source) {
      await bidi.send('script.addPreloadScript', { functionDeclaration: `() => { ${source} }` })
    },
    async navigate(url) {
      await bidi.send('browsingContext.navigate', { context: target.context, url, wait: 'interactive' })
    },
    async evaluate(expression) {
      const response = await bidi.send('script.evaluate', {
        expression: `(async () => JSON.stringify(await (${expression})))()`,
        target,
        awaitPromise: true,
        resultOwnership: 'none',
      })
      return bidiResult(response, 'expression').value
    },
    async callFunction(fn, ...args) {
      const response = await bidi.send('script.callFunction', {
        functionDeclaration: `async (...args) => JSON.stringify(await (${inPage(fn)})(...args))`,
        arguments: args.map(bidiValue),
        target,
        awaitPromise: true,
        resultOwnership: 'none',
      })
      const { thrown, value } = bidiResult(response, fn.name)
      if (thrown) throw new Error(thrown)
      return value
    },
    // Firefox keeps its bandwidth estimate out of getStats; about:webrtc
    // reads it from the browser's own window, which system access opens
    // to the test. Despite its name, sendBandwidthBps counts bytes: an
    // idle connection reads 37500, libwebrtc's 300 kbps starting rate.
    async outgoingEstimate(ssrc) {
      const response = await bidi.send('script.evaluate', {
        expression: `new Promise((done) => WebrtcGlobalInformation.getAllStats((all) => {
          const report = all.reports.find((r) => r.outboundRtpStreamStats.some((s) => s.ssrc === ${Number(ssrc)}))
          const bytes = report?.bandwidthEstimations[0]?.sendBandwidthBps
          done(JSON.stringify(bytes === undefined ? null : bytes * 8))
        }))`,
        target: browserWindow,
        awaitPromise: true,
        resultOwnership: 'none',
      })
      const { thrown, value } = bidiResult(response, 'the bandwidth estimate')
      if (thrown) throw new Error(thrown)
      return value
    },
  }
}

// Injected before the app loads: records peer connections, the E2EE
// worker's stats and the audio worklets built, so the probe can read
// them from page context.
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
  window.__worklets = [];
  const OrigWorkletNode = window.AudioWorkletNode;
  window.AudioWorkletNode = class extends OrigWorkletNode {
    constructor(context, name, options) {
      super(context, name, options);
      window.__worklets.push(name);
    }
  };
  window.__sockets = [];
  window.__welcomes = 0;
  const OrigWS = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new OrigWS(...a);
    window.__sockets.push(ws);
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        if (JSON.parse(ev.data).type === 'welcome') window.__welcomes++;
      } catch {}
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
  // Every MediaRecorder the page builds, so a test can end a recording
  // the way a browser does, without waiting for one to fail.
  window.__mediaRecorders = [];
  const OrigRecorder = window.MediaRecorder;
  window.MediaRecorder = class extends OrigRecorder {
    constructor(...a) {
      super(...a);
      window.__mediaRecorders.push(this);
    }
  };
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

const joinButton = (label) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`

const previewLive = `[...document.querySelectorAll('video')].some((v) => v.srcObject && v.srcObject.getVideoTracks().some((t) => t.readyState === 'live'))`

export const clickJoin = (label) => `(() => { const b = ${joinButton(label)}; if (b) { b.click(); return true } return false })()`

const JOINED_TIMEOUT_MS = 20_000

const joinState = `({ welcomes: window.__welcomes ?? 0, joinScreen: Boolean(${joinButton('Join call')}) })`

async function waitJoined(browser) {
  const joined = await waitFor(browser, joinState, (state) => state.welcomes > 0 && !state.joinScreen, JOINED_TIMEOUT_MS)
  if (joined.ok) return
  const stage = joined.value?.welcomes > 0 ? 'the server welcomed the member but the join screen stayed' : "the server's welcome never arrived"
  throw new Error(`joining did not finish within ${JOINED_TIMEOUT_MS} ms after "Join call" was clicked: ${stage}`)
}

// beforeJoin, if given, runs on the join screen before "Join call" is clicked.
// Joining waits for the camera preview, so the call starts with media, and
// returns once the server has welcomed the member into the call.
export async function joinRoom(browser, url, relayTransport = null, beforeJoin = null) {
  await browser.addInitScript(hook(relayTransport))
  await browser.navigate(url)
  if (beforeJoin) {
    const ready = `Boolean(${joinButton('Join call')}) && ${previewLive}`
    for (let t = 0; t < 80 && !(await evalJs(browser, ready)); t++) await sleep(250)
    await beforeJoin(browser)
  }
  for (let t = 0; t < 80; t++) {
    if ((await evalJs(browser, `${previewLive} && ${clickJoin('Join call')}`)) === true) {
      await waitJoined(browser)
      return
    }
    await sleep(250)
  }
  throw new Error('Join call button never became clickable')
}

// Both browsers answer the same calls (see launchChrome and launchFirefox):
// an expression or a function evaluated in the page, awaited, and its
// result handed back as plain data.
export function evalJs(browser, expression) {
  return browser.evaluate(expression)
}

export function callJs(browser, fn, ...args) {
  return browser.callFunction(fn, ...args)
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
  return JSON.parse(await evalJs(browser, probe))
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

// Collects what a page and its workers warn about, for a failing test to show.
export async function consoleOf(browser) {
  const lines = []
  browser.cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type === 'warning' || type === 'error') lines.push(`${type}: ${args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`)
  })
  await browser.cdp.send('Runtime.enable', {}, browser.sessionId)
  return lines
}
