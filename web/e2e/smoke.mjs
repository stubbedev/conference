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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  check,
  checkCall,
  createRoom,
  evalJs,
  findChrome,
  freePort,
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

const clickLocalPin = (label) => `
(() => {
  const local = [...document.querySelectorAll('.group')].find((g) => g.querySelector('video') && !g.querySelector('audio'));
  const button = local && [...local.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()
`

async function checkSimulcast(failures, publisher, viewer) {
  const sent = await waitFor(publisher, sentLayers, (layers) => ['l', 'm', 'h'].every((rid) => layers[rid]?.bytes > 0), 20000)
  console.log(`simulcast sent: ${JSON.stringify(sent.value)}`)
  check(failures, 'simulcast', sent.ok, `publisher is not sending all three layers: ${JSON.stringify(sent.value)}`)

  const steps = [
    { name: 'grid of two', action: null, want: (w) => w >= 1280 },
    { name: 'filmstrip', action: 'Pin to main view', want: (w) => w > 0 && w <= 320 },
    { name: 'grid again', action: 'Unpin', want: (w) => w >= 1280 },
  ]
  for (const step of steps) {
    if (step.action) {
      check(failures, 'simulcast', await evalJs(viewer, clickLocalPin(step.action)), `no "${step.action}" button on the viewer's own tile`)
    }
    const got = await waitFor(viewer, remoteVideoWidth, step.want, 20000)
    console.log(`simulcast ${step.name}: remote video ${got.value}px wide`)
    check(failures, 'simulcast', got.ok, `${step.name}: remote video ${got.value}px wide, wrong layer`)
  }
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

async function checkStillInRoom(failures, label, browsers) {
  for (const [i, browser] of browsers.entries()) {
    const path = await evalJs(browser, 'location.pathname')
    check(failures, `${label} ${i}`, path.startsWith('/r/'), `left the room for ${path}`)
  }
}

const ownName = `(() => {
  const local = [...document.querySelectorAll('.group')].find((g) => g.querySelector('video') && !g.querySelector('audio'));
  return local?.innerText.match(/^(.*) \\(you\\)$/m)?.[1] ?? '';
})()`

const tileTexts = `[...document.querySelectorAll('.group')].filter((g) => g.querySelector('video')).map((g) => g.innerText.replace(/\\s+/g, ' ').trim())`

// A member whose media never reaches the SFU (its peer connections get
// no ICE candidates at all) must still appear in the grid of everyone
// else, marked as connecting, instead of only in the people count.
async function checkStalledJoiner(failures, host, stalled, url) {
  await joinRoom(host, url)
  await sleep(stagger)
  await joinRoom(stalled, url, 'none')
  const name = await waitFor(stalled, ownName, (n) => n !== '', 10000)
  check(failures, 'stalled joiner', name.ok, 'the stalled browser never rendered its own tile')
  if (!name.ok) return
  const seen = await waitFor(
    host,
    tileTexts,
    (texts) => texts.some((t) => t.includes(name.value) && t.includes('Connecting')),
    10000,
  )
  console.log(`stalled joiner: host tiles ${JSON.stringify(seen.value)}`)
  check(failures, 'stalled joiner', seen.ok, `no connecting tile for ${name.value} in the host grid: ${JSON.stringify(seen.value)}`)
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
      await checkPinRoundTrip(failures, `pinning browser ${i}`, browser)
    }

    await checkSimulcast(failures, browsers[0], browsers[1])

    await evalJs(browsers[1], 'window.__sockets.at(-1).close()')
    await checkCall(failures, browsers, ['dropped signaling 0', 'dropped signaling 1'], { seconds })
    await checkStillInRoom(failures, 'dropped signaling', browsers)

    await stopProcess(server.proc, 'SIGTERM')
    server = await startServer(bin, env)
    procs.push(server.proc)
    await checkCall(failures, browsers, ['server restart 0', 'server restart 1'], { seconds })
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

      const late = await launch(2, dir)
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

    const stalledRoom = await createRoom(`http://127.0.0.1:${port}`, 'smoke-stalled')
    const stalledPair = [await launch(5, dir), await launch(6, dir)]
    for (const b of stalledPair) procs.push(b.proc)
    await checkStalledJoiner(failures, stalledPair[0], stalledPair[1], stalledRoom.url)

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
