#!/usr/bin/env node
// A share that is started is sent and played, every time it is started:
// a presenter starts and stops a share over and over, and every start
// must put packets on the wire and decoded frames in the viewer's tile
// within a few seconds. Chrome presents to Firefox, then Firefox to
// Chrome.
//
// The start that used to fail did so once in a few dozen on a busy
// machine, which no test can wait for. Its cause can be had every time
// instead. Chrome hands a transformer its frames in a task of its own
// after the rtctransform event, through a weak reference, so a garbage
// collection in the E2EE worker between the two leaves a transform that
// never sees a frame unless the worker holds on to the transformer. The
// Chrome of each pair is therefore run with a collection forced at exactly
// that point for every transform it attaches: its senders when it
// presents, its receivers when it watches. Firefox offers no way to
// collect a page's worker from outside, so its starts are taken as they
// come.
//
// Every stopped share leaves a media section in the viewer's connection,
// which the next one must reuse: the test also fails when the viewer's
// description keeps growing.
//
//   node web/e2e/share-start.mjs [--server path/to/binary] [--chrome binary] [--firefox binary] [--skip-firefox] [--rounds N] [--load N]
//
// Firefox is required unless --skip-firefox says to pair two Chromes.
// --load N keeps N busy loops running for the whole test, to look for a
// start that fails for another reason on a starved machine; the forced
// collection needs no load, and CI runs without.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { consoleOf, createRoom, evalJs, findChrome, findFirefox, joinRoom, launchChrome, launchFirefox, stopProcess, waitFor } from './browser.mjs'
import { buildServer, parseArgs, serverEnv, startServer } from './server.mjs'
import { clickButtonByTitle, fakeDisplay, remoteScreen, SHARE_WIDTH, shareReceiveCounters, shareSendCounters, shareState } from './share.mjs'

const args = parseArgs(process.argv.slice(2))
const rounds = Number(args.rounds ?? 8)
const load = Number(args.load ?? 0)
const chromeBinary = args.chrome ?? process.env.CHROME ?? findChrome()
const skipFirefox = args['skip-firefox'] === true
const firefoxBinary = skipFirefox ? null : (args.firefox ?? process.env.FIREFOX ?? findFirefox())

// How long a start may take to send its first packet and to be decoded
// by the viewer. A start takes a second or two on a busy machine; one
// that failed never sent at all.
const START_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 15_000

// How long the page is kept busy after it creates a transform: long
// enough for the worker to have run the rtctransform event and the
// collection after it before the page can hand the transformer its frames.
const HOLD_PAGE_MS = 100

// A share restarted before the viewer's answer to its removal has reached
// the server cannot take the section the old one left and gets one more;
// a description that grows by more than that is not reusing them.
const SPARE_SECTIONS = 1

// Runs in Chrome before the app: the E2EE worker collects garbage after
// every rtctransform event, and the page stays busy after creating a
// transform until the worker has. Needs --js-flags=--expose-gc.
const collectAfterTransformEvent = `
(() => {
  const OrigWorker = window.Worker
  window.Worker = function (url, options) {
    if (!String(url).includes('e2ee.worker')) return new OrigWorker(url, options)
    const source = 'import ' + JSON.stringify(String(url)) + '; self.addEventListener("rtctransform", () => setTimeout(() => { gc(); gc() }, 0))'
    return new OrigWorker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), options)
  }
  window.Worker.prototype = OrigWorker.prototype
  const OrigTransform = window.RTCRtpScriptTransform
  window.RTCRtpScriptTransform = function (...a) {
    const transform = new OrigTransform(...a)
    const until = performance.now() + ${HOLD_PAGE_MS}
    while (performance.now() < until) {}
    return transform
  }
  window.RTCRtpScriptTransform.prototype = OrigTransform.prototype
  window.__collects = true
})()
`

const launchers = {
  chrome: async (idx, dir) => {
    const browser = await launchChrome(chromeBinary, idx, dir, ['--js-flags=--expose-gc'])
    await browser.addInitScript(collectAfterTransformEvent)
    return browser
  },
  firefox: (idx, dir) => launchFirefox(firefoxBinary, idx, dir),
}

// The media sections of the connection the viewer watches the presenter on.
const downstreamSections = `
Math.max(0, ...window.__pcs
  .filter((pc) => pc.signalingState !== 'closed' && pc.getReceivers().length > 0 && pc.getSenders().every((sender) => !sender.track))
  .map((pc) => (pc.remoteDescription?.sdp.match(/^m=/gm) ?? []).length))
`

const sentBytes = (counters) => Object.values(counters?.layers ?? {}).reduce((sum, layer) => sum + layer.bytes, 0)

async function startAndStop(label, round, presenter, viewer) {
  const started = Date.now()
  if (!(await clickButtonByTitle(presenter, 'Share your screen'))) return `${label}, start ${round}: no "Share your screen" button`

  const sending = await waitFor(presenter, shareSendCounters, (counters) => sentBytes(counters) > 0, START_TIMEOUT_MS)
  if (!sending.ok) {
    return `${label}, start ${round}: the share sent nothing within ${START_TIMEOUT_MS} ms: ${JSON.stringify(await evalJs(presenter, shareState))}`
  }

  // Decoded frames, not painted ones: a headless Firefox counts none of
  // what its video elements show.
  const playing = await waitFor(viewer, shareReceiveCounters, (received) => received?.width === SHARE_WIDTH && received.decoded > 0, START_TIMEOUT_MS)
  if (!playing.ok) {
    return `${label}, start ${round}: the viewer decoded nothing of the share within ${START_TIMEOUT_MS} ms (${JSON.stringify(playing.value)}); the presenter: ${JSON.stringify(await evalJs(presenter, shareState))}`
  }

  const took = Date.now() - started
  if (!(await clickButtonByTitle(presenter, 'Stop sharing'))) return `${label}, start ${round}: no "Stop sharing" button`

  const gone = await waitFor(viewer, remoteScreen, (screen) => screen === null, STOP_TIMEOUT_MS)
  if (!gone.ok) return `${label}, start ${round}: the share stayed on the viewer's screen after it stopped`

  console.log(`  ${label}, start ${round}: sent and decoded after ${took} ms`)
  return null
}

async function pair(label, presenterKind, viewerKind, base, dir, firstIdx) {
  const presenter = await launchers[presenterKind](firstIdx, dir)
  const procs = [presenter.proc]
  try {
    const viewer = await launchers[viewerKind](firstIdx + 1, dir)
    procs.push(viewer.proc)

    const room = await createRoom(base, `share-start-${label}`)
    await joinRoom(presenter, room.url)
    await joinRoom(viewer, room.url)
    await evalJs(presenter, fakeDisplay)
    const lines = presenterKind === 'chrome' ? await consoleOf(presenter) : []
    console.log(`${label}: ${presenter.browser} presenting to ${viewer.browser}`)

    for (const [role, kind, browser] of [['presenter', presenterKind, presenter], ['viewer', viewerKind, viewer]]) {
      if (kind === 'chrome' && (await evalJs(browser, 'window.__collects')) !== true) return [`${label}: the ${role}'s worker is not collecting after its transform events`]
    }

    let afterFirst = 0
    for (let round = 1; round <= rounds; round++) {
      const failure = await startAndStop(label, round, presenter, viewer)
      if (failure) return [`${failure}; presenter's console: ${lines.join(' | ') || 'nothing'}`]
      if (round === 1) afterFirst = await evalJs(viewer, downstreamSections)
    }

    const afterLast = await evalJs(viewer, downstreamSections)
    console.log(`  ${label}: the viewer's connection has ${afterLast} media sections after ${rounds} shares, ${afterFirst} after the first`)
    if (afterLast > afterFirst + SPARE_SECTIONS) {
      return [`${label}: the viewer's connection grew from ${afterFirst} media sections after the first share to ${afterLast} after ${rounds}: stopped shares leave sections that are not reused`]
    }
    return []
  } finally {
    await Promise.all(procs.map((proc) => stopProcess(proc, 'SIGKILL')))
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'conference-share-start-'))
  const procs = []
  const loops = []
  const failures = []
  try {
    const bin = args.server ? resolve(args.server) : buildServer(dir, { race: true })
    const server = await startServer(bin, serverEnv(dir))
    procs.push(server.proc)
    const { base } = server

    for (let i = 0; i < load; i++) loops.push(spawn('sh', ['-c', 'while :; do :; done'], { stdio: 'ignore' }))
    if (load > 0) console.log(`share start: ${load} busy loops running`)

    const pairs = firefoxBinary
      ? [['chrome to firefox', 'chrome', 'firefox'], ['firefox to chrome', 'firefox', 'chrome']]
      : [['chrome to chrome', 'chrome', 'chrome']]
    if (!firefoxBinary) console.log('share start: --skip-firefox given, pairing two Chromes')

    for (const [index, [label, presenterKind, viewerKind]] of pairs.entries()) {
      failures.push(...(await pair(label, presenterKind, viewerKind, base, dir, index * 2)))
    }

    if (server.proc.exitCode !== null) failures.push(`the server exited with code ${server.proc.exitCode}`)
    if (failures.length) {
      console.error('\nSHARE START FAILED')
      for (const f of failures) console.error('  - ' + f)
      console.error('\nserver log tail:\n' + server.log().split('\n').slice(-20).join('\n'))
      process.exitCode = 1
    } else {
      console.log(`\nSHARE START OK: ${rounds} shares in a row were sent and decoded from each presenter, and reused the sections they left`)
    }
  } finally {
    for (const loop of loops) loop.kill('SIGKILL')
    await Promise.all(procs.map((p) => stopProcess(p, 'SIGKILL')))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
