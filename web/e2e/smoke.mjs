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
// Without --server the binary is built with the race detector, which
// stops the server at the first data race the calls provoke. Chrome needs
// no internet access; the server gets free ICE and TURN ports. A final
// pair of browsers is forced through the embedded TURN relay (one over
// UDP, one over TCP) via the machine's LAN address, since Chrome does
// not relay TURN/UDP to loopback. Exit code 0 means every assertion
// held on every browser.
import { spawn, spawnSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  callJs,
  check,
  checkCall,
  consoleOf,
  clickJoin,
  createRoom,
  evalJs,
  findChrome,
  freePort,
  hook,
  joinRoom,
  launchChrome,
  sleep,
  stopProcess,
  waitFor,
} from './browser.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const args = parseArgs(process.argv.slice(2))
const seconds = Number(args.seconds ?? 8)
const stagger = Number(args.stagger ?? 500)
const chromeBinary = args.chrome ?? process.env.CHROME ?? findChrome()
const launch = (idx, dir, extraArgs) => launchChrome(chromeBinary, idx, dir, extraArgs)

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
  const res = spawnSync('go', ['build', '-race', '-o', bin, './cmd/server'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '1' },
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
    SPEECH_ENGINES: 'real',
    TRANSLATE_MODEL: '',
    GORACE: 'halt_on_error=1',
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

function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    const lan = addrs?.find((a) => a.family === 'IPv4' && !a.internal)
    if (lan) return lan.address
  }
  throw new Error('no non-loopback IPv4 address: Chrome only relays TURN/UDP to a routable host')
}

// A control is a button on the bar or an item in its "More options"
// menu, which Radix opens on pointerdown rather than click.
function clickButtonByLabel(label) {
  const find = () => [...document.querySelectorAll('button, [role="menuitem"]')].find((b) => b.getAttribute('aria-label') === label)
  let control = find()
  if (!control) {
    const more = document.querySelector('button[aria-label="More options"]')
    if (!more || more.getAttribute('aria-expanded') === 'true') return false
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    control = find()
  }
  if (!control) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }
  control.click()
  return true
}

async function controlPresent(label) {
  const find = () => [...document.querySelectorAll('button, [role="menuitem"]')].some((b) => b.getAttribute('aria-label') === label)
  if (find()) return true
  const more = document.querySelector('button[aria-label="More options"]')
  if (!more) return false
  more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  for (let i = 0; i < 20 && !find(); i++) await new Promise((resolve) => setTimeout(resolve, 50))
  const present = find()
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return present
}

async function clickButtonByTitle(browser, label) {
  for (let t = 0; t < 20; t++) {
    const clicked = await callJs(browser, clickButtonByLabel, label)
    if (clicked) return true
    await sleep(250)
  }
  return false
}

// Chrome's fake microphone beeps at about -10 dB; silence is below -60.
const REMOTE_VOICE_MIN_DB = -40

// The loudest moment of a recording's audio, in dB (needs ffmpeg).
function maxVolume(file) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  if (res.error) throw new Error('ffmpeg is needed to check the recording: install it or put it on PATH')
  const match = /max_volume: (-?[\d.]+) dB/.exec(res.stderr)
  return match ? Number(match[1]) : null
}

// The video frames of a recording whose timestamps fall in [from, to) seconds (needs ffprobe).
function framesBetween(file, from, to) {
  const res = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  if (res.error) throw new Error('ffprobe is needed to check the recording: install ffmpeg or put it on PATH')
  return res.stdout.split('\n').map(Number).filter((t) => Number.isFinite(t) && t >= from && t < to).length
}

// A hidden tab: another tab in front of it, which is what throttles a page's
// timers and stops its animation frames.
async function hideTab(browser) {
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' })
  await browser.cdp.send('Target.activateTarget', { targetId })
  return async () => {
    await browser.cdp.send('Target.closeTarget', { targetId })
  }
}

const RECORDING_VISIBLE_S = 5
const RECORDING_HIDDEN_S = 8
const HIDDEN_RECORDING_MIN_FPS = 10

const recordingBadgePresent = `(() => { const h = document.querySelector('header'); return Boolean(h && [...h.querySelectorAll('span')].some(s => s.textContent.trim() === 'Recording')); })()`

// A camera whose pixels change at random from frame to frame: what a test
// needs to see a blur at all, since a picture of a flat wall looks the
// same blurred or sharp. Written here rather than shot with ffmpeg so the
// check depends on nothing but node.
function writeNoiseVideo(file, { width = 320, height = 240, frames = 30, rate = 30 } = {}) {
  const frame = Buffer.alloc(width * height + 2 * ((width / 2) * (height / 2)), 128)
  const parts = [Buffer.from(`YUV4MPEG2 W${width} H${height} F${rate}:1 Ip A1:1 C420jpeg\n`)]

  for (let index = 0; index < frames; index++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        frame[y * width + x] = (x * 71 + y * 113 + index * 37 + ((x * y) % 251)) & 0xff
      }
    }
    parts.push(Buffer.from('FRAME\n'), frame)
  }

  writeFileSync(file, Buffer.concat(parts))
}

const previewSharpness = `(() => {
  const video = document.querySelector('video')
  if (!video || !video.videoWidth) return -1
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 240
  const ctx = canvas.getContext('2d')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let energy = 0
  for (let y = 1; y < canvas.height; y++) {
    for (let x = 1; x < canvas.width; x++) {
      const at = (y * canvas.width + x) * 4
      energy += Math.abs(data[at] - data[at - 4]) + Math.abs(data[at] - data[at - canvas.width * 4])
    }
  }
  return energy / (canvas.width * canvas.height)
})()`

const previewCameraLabel = `(() => {
  const video = document.querySelector('video')
  const track = video && video.srcObject && video.srcObject.getVideoTracks()[0]
  return track ? track.label : ''
})()`

// Starting a meeting from the home page goes straight to the join screen as
// its host, and once in, offers a joining link that carries the room key.
async function checkNewMeeting(failures, dir, base) {
  const browser = await launch(6, dir)
  try {
    const session = browser.sessionId
    await browser.cdp.send('Page.enable', {}, session)
    await browser.cdp.send('Page.navigate', { url: `${base}/` }, session)
    const started = await waitFor(
      browser,
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'New meeting'); if (b && !b.disabled) { b.click(); return true } return false })()`,
      Boolean,
      15000,
    )
    check(failures, 'new meeting', started.ok, 'no New meeting button on the home page')
    const lobby = await waitFor(browser, `location.pathname.startsWith('/r/') && location.search.startsWith('?p=') && location.hash.startsWith('#k=')`, Boolean, 15000)
    check(failures, 'new meeting', lobby.ok, 'New meeting did not open the room as its host')
    const joined = await waitFor(
      browser,
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Join call'); if (b && !b.disabled) { b.click(); return true } return false })()`,
      Boolean,
      20000,
    )
    check(failures, 'new meeting', joined.ok, 'the new meeting could not be joined')
    const card = await waitFor(
      browser,
      `document.querySelector('section[aria-label="Your meeting\\'s ready"]')?.textContent ?? ''`,
      (text) => text.includes('/r/') && text.includes('#k='),
      15000,
    )
    check(failures, 'new meeting', card.ok, `no joining link with the room key after starting a meeting: ${JSON.stringify(card.value)}`)
  } finally {
    await stopProcess(browser.proc)
  }
}

const inboundVideoFrames = `(async () => {
  let frames = 0
  for (const pc of window.__pcs) {
    if (pc.connectionState === 'closed') continue
    for (const r of (await pc.getStats()).values()) if (r.type === 'inbound-rtp' && r.kind === 'video') frames += r.framesDecoded || 0
  }
  return frames
})()`

// Someone whose browser blocks the camera and microphone can still join,
// receives the others, and is published into the call as soon as access
// is granted, without rejoining.
async function checkJoinWithoutMedia(failures, dir, base) {
  const label = 'join without media'
  const room = await createRoom(base, 'no-media')
  const origin = new URL(base).origin
  const blocked = await launchChrome(chromeBinary, 7, dir, [], { fakeUi: false })
  const other = await launch(8, dir)
  try {
    const setMedia = (setting) =>
      Promise.all(
        ['camera', 'microphone'].map((name) =>
          blocked.cdp.send('Browser.setPermission', { permission: { name }, setting, origin }),
        ),
      )
    await setMedia('denied')
    const session = blocked.sessionId
    await blocked.cdp.send('Page.enable', {}, session)
    await blocked.cdp.send('Runtime.enable', {}, session)
    await blocked.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: hook() }, session)
    await blocked.cdp.send('Page.navigate', { url: room.url }, session)
    const joined = await waitFor(blocked, clickJoin('Join without camera and microphone'), Boolean, 20000)
    check(failures, label, joined.ok, 'no way to join with the camera and microphone blocked')
    if (!joined.ok) return

    await joinRoom(other, room.url)
    const allow = await waitFor(blocked, `Boolean(document.querySelector('button[aria-label="Allow camera"]'))`, Boolean, 15000)
    check(failures, label, allow.ok, 'the call does not show that the camera is blocked')
    const seesOther = await waitFor(blocked, inboundVideoFrames, (frames) => frames > 0, 20000)
    check(failures, label, seesOther.ok, 'the member without media does not receive the others')
    const leaked = await evalJs(other, inboundVideoFrames)
    check(failures, label, leaked === 0, `${leaked} video frames arrived from a member whose camera is blocked`)

    await setMedia('granted')
    const published = await waitFor(other, inboundVideoFrames, (frames) => frames > 0, 30000)
    check(failures, label, published.ok, 'granting access mid-call did not publish the camera')
  } finally {
    await stopProcess(blocked.proc)
    await stopProcess(other.proc)
  }
}

const countPreviewFrames = `(() => {
  const track = document.querySelector('video').srcObject.getVideoTracks()[0].clone()
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
  window.__previewFrames = 0
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      value.close()
      window.__previewFrames++
    }
  })()
  return true
})()`

async function previewFps(browser, seconds) {
  const before = await evalJs(browser, 'window.__previewFrames')
  await sleep(seconds * 1000)
  return ((await evalJs(browser, 'window.__previewFrames')) - before) / seconds
}

async function checkBackgroundBlur(failures, dir, base) {
  const camera = join(dir, 'blur-camera.y4m')
  writeNoiseVideo(camera)

  const browser = await launch(5, dir, [`--use-file-for-fake-video-capture=${camera}`])
  try {
    const room = await createRoom(base, 'blur')
    const session = browser.sessionId
    await browser.cdp.send('Page.enable', {}, session)
    await browser.cdp.send('Runtime.enable', {}, session)
    await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: hook() }, session)
    await browser.cdp.send('Page.navigate', { url: room.url }, session)

    const prejoined = await waitFor(browser, previewSharpness, (value) => value > 0, 20000)
    check(failures, 'blur', prejoined.ok, `the prejoin preview never showed a camera (${prejoined.value})`)

    const before = await evalJs(browser, previewSharpness)
    const cameraLabel = await evalJs(browser, previewCameraLabel)
    check(failures, 'blur', await clickButtonByTitle(browser, 'Blur background'), 'no blur button on the prejoin')

    const blurred = await waitFor(browser, previewSharpness, (value) => value > 0 && value < before / 2, 20000)
    console.log(`blur: preview sharpness ${before.toFixed(2)} before, ${blurred.value.toFixed(2)} after`)
    check(failures, 'blur', blurred.ok, `the camera did not blur (sharpness ${blurred.value.toFixed(2)} against ${before.toFixed(2)})`)

    const composited = await evalJs(browser, previewCameraLabel)
    check(failures, 'blur', composited !== cameraLabel, `the preview still carries the raw camera (${composited})`)

    await evalJs(browser, countPreviewFrames)
    const visibleFps = await previewFps(browser, 3)
    const show = await hideTab(browser)
    const hiddenFps = await previewFps(browser, 4)
    await show()
    console.log(`blur: ${visibleFps.toFixed(1)} fps visible, ${hiddenFps.toFixed(1)} fps hidden`)
    check(
      failures,
      'blur',
      hiddenFps >= HIDDEN_RECORDING_MIN_FPS && hiddenFps >= visibleFps / 2,
      `the blurred camera stalls in a hidden tab (${hiddenFps.toFixed(1)} fps hidden against ${visibleFps.toFixed(1)} visible)`,
    )

    const errors = await evalJs(browser, 'window.__errors')
    check(failures, 'blur', errors.length === 0, `blur page errors: ${errors.join(' | ')}`)

    // The choice belongs to the camera preferences, so it has to survive
    // a reload — the same person rejoining the same way they left.
    await browser.cdp.send('Page.reload', {}, session)
    const remembered = await waitFor(
      browser,
      `Boolean(document.querySelector('button[aria-label="Turn off background blur"]'))`,
      Boolean,
      20000,
    )
    check(failures, 'blur', remembered.ok, 'blur did not survive a reload')

    check(failures, 'blur', await clickButtonByTitle(browser, 'Turn off background blur'), 'no blur-off button after the reload')
    const cleared = await waitFor(browser, previewCameraLabel, (label) => label === cameraLabel, 20000)
    check(failures, 'blur', cleared.ok, `turning blur off did not restore the camera (${cleared.value})`)
  } finally {
    await stopProcess(browser.proc)
  }
}

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

function clickRemotePin(label) {
  const remote = document.querySelector('audio')?.closest('.group')
  const button = remote && [...remote.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label)
  if (!button) return false
  button.click()
  return true
}

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

const sentLayers = `
(async () => {
  const layers = {};
  for (const pc of window.__pcs.filter((pc) => pc.signalingState !== 'closed')) {
    for (const r of (await pc.getStats()).values()) {
      if (r.type === 'outbound-rtp' && r.kind === 'video' && r.rid) layers[r.rid] = { bytes: r.bytesSent || 0, width: r.frameWidth || 0 };
    }
  }
  return layers;
})()
`

const remoteVideoWidth = `
(() => {
  const remote = document.querySelector('audio')?.closest('.group');
  return remote?.querySelector('video')?.videoWidth ?? 0;
})()
`

function clickLocalPin(label) {
  const local = [...document.querySelectorAll('.group')].find((g) => g.querySelector('video') && !g.querySelector('audio'))
  const button = local && [...local.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label)
  if (!button) return false
  button.click()
  return true
}

const LAYER_PAUSE_MS = 9000

async function layerGrows(publisher, rid, ms) {
  const before = (await evalJs(publisher, sentLayers))[rid]?.bytes ?? 0
  await sleep(ms)
  return ((await evalJs(publisher, sentLayers))[rid]?.bytes ?? 0) > before
}

// The publisher encodes only the layers some viewer wants (and always the
// lowest): in a grid of two nobody needs the middle one, so it is paused.
async function checkSimulcast(failures, publisher, viewer) {
  const sent = await waitFor(publisher, sentLayers, (layers) => ['l', 'h'].every((rid) => layers[rid]?.bytes > 0), 20000)
  console.log(`simulcast sent: ${JSON.stringify(sent.value)}`)
  check(failures, 'simulcast', sent.ok, `publisher is not sending the lowest and the wanted layer: ${JSON.stringify(sent.value)}`)
  await sleep(LAYER_PAUSE_MS)
  check(failures, 'simulcast', !(await layerGrows(publisher, 'm', 3000)), 'the middle layer is still encoded although nobody in a grid of two wants it')

  // Sizes are compared with each other, not with pixels: which resolution
  // the capture and the encoder settle on is the browser's business, that
  // a filmstrip tile gets a fraction of a pinned one is this app's.
  const full = await waitFor(viewer, remoteVideoWidth, (width) => width >= 640, 20000)
  console.log(`simulcast grid of two: remote video ${full.value}px wide`)
  check(failures, 'simulcast', full.ok, `grid of two: remote video ${full.value}px wide, want the largest layer`)

  check(failures, 'simulcast', await callJs(viewer, clickLocalPin, 'Pin to main view'), 'no "Pin to main view" button on the viewer\'s own tile')

  const filmstrip = await waitFor(viewer, remoteVideoWidth, (width) => width > 0 && width * 2 <= full.value, 20000)
  console.log(`simulcast filmstrip: remote video ${filmstrip.value}px wide against ${full.value}px`)
  check(failures, 'simulcast', filmstrip.ok, `filmstrip: remote video ${filmstrip.value}px wide, not a layer below ${full.value}px`)
  await sleep(LAYER_PAUSE_MS)
  check(failures, 'simulcast', !(await layerGrows(publisher, 'h', 3000)), 'the top layer is still encoded although the only viewer shows a thumbnail')

  check(failures, 'simulcast', await callJs(viewer, clickLocalPin, 'Unpin'), 'no "Unpin" button on the viewer\'s own tile')

  // What is being checked is that the layer climbs back up, so the bar is
  // relative to the filmstrip: a capture that settles on a different size
  // mid-call (a busy machine will do that) must not read as a failure.
  const back = await waitFor(viewer, remoteVideoWidth, (width) => width >= filmstrip.value * 2, 20000)
  console.log(`simulcast grid again: remote video ${back.value}px wide against ${filmstrip.value}px in the filmstrip`)
  check(failures, 'simulcast', back.ok, `grid again: remote video ${back.value}px wide, not a layer above ${filmstrip.value}px`)
}

const SHARE_WIDTH = 1600
const SHARE_HEIGHT = 900

// Headless Chrome has no screen to pick, so the share is a canvas of
// changing text handed out where getDisplayMedia would hand out a screen;
// everything after the picker is the call's own path.
const fakeDisplay = `(() => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = ${SHARE_WIDTH}
    canvas.height = ${SHARE_HEIGHT}
    const ctx = canvas.getContext('2d')
    let frame = 0
    const draw = () => {
      if (window.__shareStill) return
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#000'
      ctx.font = '14px monospace'
      for (let line = 0; line < 60; line++) ctx.fillText('line ' + line + ' frame ' + frame + ' the quick brown fox jumps over the lazy dog', 10, 14 * (line + 1))
      frame++
    }
    draw()
    setInterval(draw, 16)
    return canvas.captureStream(60)
  }
  return true
})()`

const screenSent = `
(async () => {
  const pc = window.__pcs.find((pc) => pc.signalingState !== 'closed' && pc.getTransceivers().some((t) => t.sender.track?.contentHint === 'detail'))
  if (!pc) return null
  const mid = pc.getTransceivers().find((t) => t.sender.track?.contentHint === 'detail').mid
  const layers = {}
  let available = 0
  const stats = await pc.getStats()
  for (const r of stats.values()) {
    if (r.type === 'outbound-rtp' && r.mid === mid && r.rid) layers[r.rid] = { bytes: r.bytesSent || 0, frames: r.framesEncoded || 0, width: r.frameWidth || 0, fps: r.framesPerSecond || 0, target: r.targetBitrate || 0, limit: r.qualityLimitationReason, codec: stats.get(r.codecId)?.mimeType ?? '' }
    if (r.type === 'candidate-pair' && r.nominated && r.availableOutgoingBitrate) available = r.availableOutgoingBitrate
  }
  return { layers, available, twcc: /transport-cc/.test(pc.remoteDescription?.sdp ?? '') }
})()
`

function tileByLabel(suffix) {
  return [...document.querySelectorAll('.group')].find((g) => g.querySelector('.hud-label')?.textContent.trim().endsWith(suffix))
}

const remoteScreen = `
(() => {
  const tile = (${tileByLabel.toString()})('screen')
  const video = tile?.querySelector('video')
  return video ? { width: video.videoWidth, frames: video.getVideoPlaybackQuality().totalVideoFrames } : null
})()
`

function clickTilePin(suffix, label) {
  const tile = [...document.querySelectorAll('.group')].find((g) => g.querySelector('.hud-label')?.textContent.trim().endsWith(suffix))
  const button = tile && [...tile.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label)
  if (!button) return false
  button.click()
  return true
}

const SHARE_FPS_WINDOW_MS = 3000

async function remoteScreenFps(viewer) {
  const before = await evalJs(viewer, remoteScreen)
  await sleep(SHARE_FPS_WINDOW_MS)
  const after = await evalJs(viewer, remoteScreen)
  if (!before || !after) return { width: 0, fps: 0 }
  return { width: after.width, fps: ((after.frames - before.frames) * 1000) / SHARE_FPS_WINDOW_MS }
}

const SHARE_SETTLE_MS = 20000

const shareReceiveCounters = `
(async () => {
  const tile = (${tileByLabel.toString()})('screen')
  const trackId = tile?.querySelector('video')?.srcObject?.getVideoTracks()[0]?.id
  for (const pc of window.__pcs.filter((pc) => pc.signalingState !== 'closed')) {
    for (const r of (await pc.getStats()).values()) {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && r.trackIdentifier === trackId) {
        return { decoded: r.framesDecoded || 0, keyframes: r.keyFramesDecoded || 0, freezes: r.freezeCount || 0, frozenMs: Math.round((r.totalFreezesDuration || 0) * 1000), plis: r.pliCount || 0, lost: r.packetsLost || 0, nacks: r.nackCount || 0, width: r.frameWidth || 0 }
      }
    }
  }
  return null
})()
`

const shareSendCounters = `
(async () => {
  const pc = window.__pcs.find((pc) => pc.signalingState !== 'closed' && pc.getTransceivers().some((t) => t.sender.track?.contentHint === 'detail'))
  if (!pc) return null
  const mid = pc.getTransceivers().find((t) => t.sender.track?.contentHint === 'detail').mid
  const layers = {}
  for (const r of (await pc.getStats()).values()) {
    if (r.type === 'outbound-rtp' && r.mid === mid && r.rid) layers[r.rid] = { encoded: r.framesEncoded || 0, keyframes: r.keyFramesEncoded || 0, plis: r.pliCount || 0, firs: r.firCount || 0, limit: r.qualityLimitationReason, bytes: r.bytesSent || 0 }
  }
  return layers
})()
`

const TIMELINE_SECONDS = 20

async function shareTimeline(publisher, viewer) {
  const samples = []
  let previous = null
  for (let second = 0; second <= TIMELINE_SECONDS; second++) {
    const [recv, send] = await Promise.all([evalJs(viewer, shareReceiveCounters), evalJs(publisher, shareSendCounters)])
    const sample = { recv, send }
    if (previous?.recv && recv) {
      const h = send?.h ?? {}
      const ph = previous.send?.h ?? {}
      const l = send?.l ?? {}
      const pl = previous.send?.l ?? {}
      console.log(
        `  t=${second}s viewer: ${recv.decoded - previous.recv.decoded} fps, +${recv.keyframes - previous.recv.keyframes} key, +${recv.freezes - previous.recv.freezes} freeze (${recv.frozenMs - previous.recv.frozenMs} ms), +${recv.plis - previous.recv.plis} pli, +${recv.lost - previous.recv.lost} lost, ${recv.width}px` +
          ` | presenter h: ${(h.encoded ?? 0) - (ph.encoded ?? 0)} fps, +${(h.keyframes ?? 0) - (ph.keyframes ?? 0)} key, +${(h.plis ?? 0) - (ph.plis ?? 0)} pli, ${(((h.bytes ?? 0) - (ph.bytes ?? 0)) * 8 / 1e6).toFixed(1)} Mbps, ${h.limit}` +
          ` l: +${(l.keyframes ?? 0) - (pl.keyframes ?? 0)} key, +${(l.plis ?? 0) - (pl.plis ?? 0)} pli`,
      )
    }
    samples.push(sample)
    previous = sample
    await sleep(1000)
  }
  return samples
}

const screenReceived = `
(async () => {
  const tile = (${tileByLabel.toString()})('screen')
  const trackId = tile?.querySelector('video')?.srcObject?.getVideoTracks()[0]?.id
  for (const pc of window.__pcs.filter((pc) => pc.signalingState !== 'closed')) {
    for (const r of (await pc.getStats()).values()) {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && r.trackIdentifier === trackId) {
        return { fps: r.framesPerSecond || 0, lost: r.packetsLost || 0, plis: r.pliCount || 0, freezes: r.freezeCount || 0, dropped: r.framesDropped || 0, keyframes: r.keyFramesDecoded || 0 }
      }
    }
  }
  return null
})()
`

async function settledScreenFps(viewer, publisher, settled) {
  const deadline = Date.now() + SHARE_SETTLE_MS
  for (;;) {
    const measured = await remoteScreenFps(viewer)
    const sent = await evalJs(publisher, screenSent)
    const encoded = Object.entries(sent?.layers ?? {}).map(([rid, layer]) => `${rid} ${layer.fps} fps (${layer.limit})`)
    const received = await evalJs(viewer, screenReceived)
    console.log(`  share ${measured.width}px at ${measured.fps.toFixed(1)} fps, received ${JSON.stringify(received)}; publisher encodes ${encoded.join(', ')} with ${sent?.available ?? 0} bps available`)
    if (settled(measured) || Date.now() > deadline) return measured
  }
}

const FLUID_SHARE_MIN_FPS = 15

const STILL_SETTLE_MS = 4000
const STILL_WINDOW_MS = 10_000
const STILL_MAX_KEYFRAMES = 1
const STILL_MAX_FREEZES = 1
const SLOW_SHARE_MAX_FPS = 10

// A share goes out as a fluid and a slow encoding, both at full size: a
// pinned share plays the fluid one, a share shrunk into the strip under a
// pinned camera gets the slow one, and the camera thumbnails the viewer
// asks for do not drag the share's layer down with them.
async function checkScreenShare(failures, publisher, viewer) {
  const publisherConsole = await consoleOf(publisher)
  await evalJs(publisher, fakeDisplay)
  check(failures, 'screen share', await clickButtonByTitle(publisher, 'Share your screen'), 'no "Share your screen" button')

  const sent = await waitFor(publisher, screenSent, (s) => s && ['l', 'h'].every((rid) => s.layers[rid]?.frames > 0), 20000)
  console.log(`screen share sent: ${JSON.stringify(sent.value)}`)
  check(failures, 'screen share', sent.ok, `the share is not sent as a slow and a fluid encoding: ${JSON.stringify(sent.value)}; console: ${publisherConsole.join(' | ')}`)
  check(failures, 'screen share', sent.value?.twcc === true, 'the server did not negotiate transport-wide congestion control on the upload')
  for (const rid of ['l', 'h']) {
    const width = sent.value?.layers[rid]?.width
    check(failures, 'screen share', width === SHARE_WIDTH, `the ${rid} encoding of the share is ${width}px wide, not the full ${SHARE_WIDTH}px`)
  }

  const pinned = await waitFor(viewer, remoteScreen, (v) => v?.width === SHARE_WIDTH, 20000)
  check(failures, 'screen share', pinned.ok, `the pinned share arrives ${pinned.value?.width}px wide, not ${SHARE_WIDTH}px`)
  console.log('screen share timeline while pinned:')
  await shareTimeline(publisher, viewer)
  const fluid = await remoteScreenFps(viewer)
  console.log(`screen share pinned: ${fluid.width}px at ${fluid.fps.toFixed(1)} fps`)
  check(failures, 'screen share', fluid.fps >= FLUID_SHARE_MIN_FPS, `the pinned share plays at ${fluid.fps.toFixed(1)} fps, not the fluid encoding`)

  check(failures, 'screen share', await callJs(viewer, clickTilePin, '(you)', 'Pin to main view'), 'no "Pin to main view" button on the viewer\'s own tile')
  const slow = await settledScreenFps(viewer, publisher, (measured) => measured.fps > 0 && measured.fps <= SLOW_SHARE_MAX_FPS)
  console.log(`screen share in the strip: ${slow.width}px at ${slow.fps.toFixed(1)} fps`)
  check(failures, 'screen share', slow.width === SHARE_WIDTH, `the share in the strip arrives ${slow.width}px wide, not at full size`)
  check(failures, 'screen share', slow.fps > 0 && slow.fps <= SLOW_SHARE_MAX_FPS, `the share in the strip plays at ${slow.fps.toFixed(1)} fps, not the slow encoding`)

  check(failures, 'screen share', await callJs(viewer, clickTilePin, '(you)', 'Unpin'), 'no "Unpin" button on the viewer\'s own tile')
  check(failures, 'screen share', await callJs(viewer, clickTilePin, 'screen', 'Pin to main view'), 'no "Pin to main view" button on the share')
  const back = await settledScreenFps(viewer, publisher, (measured) => measured.fps >= FLUID_SHARE_MIN_FPS)
  console.log(`screen share pinned again: ${back.width}px at ${back.fps.toFixed(1)} fps`)
  check(failures, 'screen share', back.fps >= FLUID_SHARE_MIN_FPS, `the share pinned again plays at ${back.fps.toFixed(1)} fps, not the fluid encoding`)

  await evalJs(publisher, 'window.__shareStill = true')
  await sleep(STILL_SETTLE_MS)
  const stillFrom = await evalJs(viewer, shareReceiveCounters)
  await sleep(STILL_WINDOW_MS)
  const stillTo = await evalJs(viewer, shareReceiveCounters)
  const stillKeyframes = (stillTo?.keyframes ?? 0) - (stillFrom?.keyframes ?? 0)
  const stillFreezes = (stillTo?.freezes ?? 0) - (stillFrom?.freezes ?? 0)
  console.log(`screen share held still for ${STILL_WINDOW_MS / 1000} s: +${stillKeyframes} keyframes, +${stillFreezes} freezes`)
  check(failures, 'screen share', stillKeyframes <= STILL_MAX_KEYFRAMES, `a still share brought ${stillKeyframes} keyframes in ${STILL_WINDOW_MS / 1000} s: its viewers are switching layers`)
  check(failures, 'screen share', stillFreezes <= STILL_MAX_FREEZES, `a still share froze ${stillFreezes} times in ${STILL_WINDOW_MS / 1000} s`)

  check(failures, 'screen share', await clickButtonByTitle(publisher, 'Stop sharing'), 'no "Stop sharing" button')
  const gone = await waitFor(viewer, remoteScreen, (v) => v === null, 20000)
  check(failures, 'screen share', gone.ok, 'the share tile stayed after the share stopped')
}

async function checkPinRoundTrip(failures, label, browser) {
  check(failures, label, await callJs(browser, clickRemotePin, 'Pin to main view'), 'no pin button on the remote tile')
  await sleep(500)
  const pinned = await checkRemoteTilePlays(failures, label, browser, 'pinned')
  check(failures, label, pinned.unpinButtons === 1, `expected the remote tile to be pinned, found ${pinned.unpinButtons} pinned tiles`)

  check(failures, label, await callJs(browser, clickRemotePin, 'Unpin'), 'no unpin button on the pinned remote tile')
  await sleep(500)
  const unpinned = await checkRemoteTilePlays(failures, label, browser, 'unpinned')
  check(failures, label, unpinned.unpinButtons === 0, `expected no pinned tile after unpinning, found ${unpinned.unpinButtons}`)
}

async function checkStillInRoom(failures, label, browsers) {
  for (const [i, browser] of browsers.entries()) {
    const path = await evalJs(browser, 'location.pathname')
    check(failures, `${label} ${i}`, path.startsWith('/r/'), `left the room for ${path}`)
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

    const room = await createRoom(`http://127.0.0.1:${port}`, 'smoke')
    const { url, privUrl } = room

    const browsers = [await launch(0, dir), await launch(1, dir)]
    for (const b of browsers) procs.push(b.proc)
    console.log(`smoke: ${browsers[0].browser}, room ${room.slug}`)

    // The first browser joins through the privileged link so it can
    // host the recording phase; the second joins like a normal guest.
    await joinRoom(browsers[0], privUrl)
    await sleep(stagger)
    await joinRoom(browsers[1], url)
    await sleep(stagger)

    await checkCall(failures, browsers, ['browser 0', 'browser 1'], { seconds })
    for (const [i, browser] of browsers.entries()) {
      const worklets = await evalJs(browser, 'window.__worklets')
      check(failures, `browser ${i}`, worklets.includes('noise-gate'), `microphone is not routed through the noise gate (worklets: ${worklets.join(', ') || 'none'})`)
    }

    for (const [i, browser] of browsers.entries()) {
      await checkPinRoundTrip(failures, `pinning browser ${i}`, browser)
    }

    await checkSimulcast(failures, browsers[0], browsers[1])
    await checkScreenShare(failures, browsers[0], browsers[1])

    await checkNewMeeting(failures, dir, `http://127.0.0.1:${port}`)
    await checkBackgroundBlur(failures, dir, `http://127.0.0.1:${port}`)
    await checkJoinWithoutMedia(failures, dir, `http://127.0.0.1:${port}`)

    await evalJs(browsers[1], 'window.__sockets.at(-1).close()')
    await checkCall(failures, browsers, ['dropped signaling 0', 'dropped signaling 1'], { seconds })
    await checkStillInRoom(failures, 'dropped signaling', browsers)

    await stopProcess(server.proc, 'SIGTERM')
    server = await startServer(bin, env)
    procs.push(server.proc)
    await checkCall(failures, browsers, ['server restart 0', 'server restart 1'], { seconds })
    await checkStillInRoom(failures, 'server restart', browsers)

    // No speech engines are configured for this server, so live
    // translation is not offered at all: nobody sees a button to press
    // and no setting that names the variables the operator has to set.
    const translationSurfaced = `(() => {
      const header = document.querySelector('header')
      const text = header ? header.innerText : ''
      return {
        button: Boolean(document.querySelector('[aria-label="Start live translation"]')),
        settings: text.includes('Live translation'),
        variables: /[A-Z]+_MODEL/.test(document.body.innerText),
      }
    })()`
    for (const [index, label] of [
      [0, 'host'],
      [1, 'member'],
    ]) {
      const shown = await evalJs(browsers[index], translationSurfaced)
      check(failures, 'translation', !shown.button, `translate button offered on the ${label} browser with no engines configured`)
      check(failures, 'translation', !shown.settings, `translation settings offered on the ${label} browser`)
      check(failures, 'translation', !shown.variables, `server settings leaked to the ${label} browser`)
    }

    // Recording phase. Round one: the host records, a third browser
    // joins late (the badge must be replayed in its welcome), then the
    // host navigates away (the badge must clear everywhere — recording
    // outlives no one). Round two: the second host re-records, stops,
    // and a file must land on its disk.
    const dlDir = join(dir, 'downloads')
    mkdirSync(dlDir)

    const hostRecordButton = await clickButtonByTitle(browsers[0], 'Record the call')
    check(failures, 'recording', hostRecordButton, 'record button missing on the privileged browser')
    check(failures, 'recording', await callJs(browsers[1], controlPresent, 'Record the call'), 'record button missing on the unprivileged browser')

    if (hostRecordButton) {
      check(failures, 'recording', await waitForBadge(browsers[0], true), 'recording badge missing on the recorder page')
      check(failures, 'recording', await waitForBadge(browsers[1], true), 'recording badge missing on the guest page')

      const late = await launch(2, dir)
      procs.push(late.proc)
      await joinRoom(late, privUrl)
      check(failures, 'recording', await waitForBadge(late, true), 'late joiner did not see the recording badge')

      const s = browsers[0].sessionId
      await browsers[0].cdp.send('Page.navigate', { url: 'about:blank' }, s)
      check(failures, 'recording', await waitForBadge(browsers[1], false), 'badge did not clear on the guest after the recorder left')
      check(failures, 'recording', await waitForBadge(late, false), 'badge did not clear on the late joiner after the recorder left')

      // Round two: the late joiner becomes the recorder and must deliver
      // a file when it stops.
      await late.cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dlDir,
      })
      // The recorder's own microphone goes silent, so any sound in the file
      // is the guest's voice arriving through the call.
      check(failures, 'recording', await clickButtonByTitle(late, 'Mute microphone'), 'mute button missing on the second host')
      const reRecord = await clickButtonByTitle(late, 'Record the call')
      check(failures, 'recording', reRecord, 'record button missing on the second host')

      if (reRecord) {
        check(failures, 'recording', await waitForBadge(late, true), 'recording badge missing on the second recorder')
        check(failures, 'recording', await waitForBadge(browsers[1], true), 'recording badge missing on the guest for the second recorder')
        await sleep(RECORDING_VISIBLE_S * 1000)
        const hiddenState = await evalJs(late, 'document.visibilityState')
        const show = await hideTab(late)
        const hidden = await evalJs(late, 'document.visibilityState')
        await sleep(RECORDING_HIDDEN_S * 1000)
        await show()
        await sleep(2000)
        check(failures, 'recording', hiddenState === 'visible' && hidden === 'hidden', `the recorder's tab did not go from visible to hidden (${hiddenState} → ${hidden})`)

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

        const loudest = download ? maxVolume(join(dlDir, download.name)) : null
        check(failures, 'recording', loudest !== null && loudest > REMOTE_VOICE_MIN_DB, `the guest's voice is not in the recording (loudest ${loudest} dB)`)

        const hiddenFrom = RECORDING_VISIBLE_S + 1
        const hiddenTo = RECORDING_VISIBLE_S + RECORDING_HIDDEN_S - 1
        const hiddenFps = download ? framesBetween(join(dlDir, download.name), hiddenFrom, hiddenTo) / (hiddenTo - hiddenFrom) : 0
        const visibleFps = download ? framesBetween(join(dlDir, download.name), 1, RECORDING_VISIBLE_S) / (RECORDING_VISIBLE_S - 1) : 0
        check(
          failures,
          'recording',
          hiddenFps >= HIDDEN_RECORDING_MIN_FPS && hiddenFps >= visibleFps / 2,
          `the recording's picture slowed to ${hiddenFps.toFixed(1)} fps while its tab was hidden, from ${visibleFps.toFixed(1)} fps`,
        )

        console.log(`recording: late-joiner replay, recorder-leave clearing, ${visibleFps.toFixed(1)} fps visible and ${hiddenFps.toFixed(1)} fps hidden, file ${download ? `${download.name} ${download.size} bytes, loudest ${loudest} dB` : 'MISSING'}`)

        // Round three: a recording the browser ends on its own (the
        // encoder failed, the way a long recording can die) must still
        // hand over the file and clear the badge everywhere instead of
        // silently recording nothing.
        for (const name of readdirSync(dlDir)) rmSync(join(dlDir, name))

        const again = await clickButtonByTitle(late, 'Record the call')
        check(failures, 'recording', again, 'record button missing for the interrupted round')

        if (again) {
          check(failures, 'recording', await waitForBadge(late, true), 'recording badge missing before the interruption')
          await sleep(5000)

          const failed = await evalJs(
            late,
            `(() => {
              const recorder = window.__mediaRecorders.at(-1)
              if (!recorder) return false
              const event = Object.assign(new Event('error'), { error: new DOMException('encoder failure', 'EncodingError') })
              recorder.dispatchEvent(event)
              return true
            })()`,
          )
          check(failures, 'recording', failed, 'the recording has no MediaRecorder to interrupt')

          const partial = await waitForDownload(dlDir)
          check(failures, 'recording', partial !== null, 'a recording the browser ended was not saved')
          check(failures, 'recording', await waitForBadge(late, false), 'badge stayed up on the recorder after its recording ended')
          check(failures, 'recording', await waitForBadge(browsers[1], false), "badge stayed up on the guest after the recorder's recording ended")
          console.log(`recording: interrupted by the browser, file ${partial ? `${partial.name} ${partial.size} bytes` : 'MISSING'}`)
        }
      }
    }

    const lan = lanAddress()
    const relayRoom = await createRoom(`http://${lan}:${port}`, 'smoke-relay')
    const secureLan = [`--unsafely-treat-insecure-origin-as-secure=http://${lan}:${port}`]
    const relayed = [await launch(3, dir, secureLan), await launch(4, dir, secureLan)]
    for (const b of relayed) procs.push(b.proc)
    await joinRoom(relayed[0], relayRoom.url, 'udp')
    await sleep(stagger)
    await joinRoom(relayed[1], relayRoom.url, 'tcp')
    await checkCall(failures, relayed, ['relay over udp', 'relay over tcp'], { seconds, wantPaths: ['relay/udp', 'relay/tcp'] })

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
