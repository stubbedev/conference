#!/usr/bin/env node
// A shared screen that is scrolled in bursts: three seconds of fast
// scrolling, three seconds of nothing changing, over and over, presented
// once from Chrome and once from Firefox to a Chrome viewer. A still
// screen sends almost nothing, so a connection whose bandwidth estimate
// follows what it sends meets the next scroll with an encoder held to a
// trickle: the viewer sees a few frames a second and freezes. This test
// prints the share second by second and fails when a scrolling burst does
// not play fluidly.
//
//   node web/e2e/share-burst.mjs [--server path/to/binary] [--chrome binary] [--firefox binary] [--skip-firefox] [--cycles N]
//
// Firefox is required: without one the test fails, unless --skip-firefox
// says to measure Chrome alone. The server is built without the race
// detector, which would slow forwarding down and skew the rates measured.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createRoom, evalJs, findChrome, findFirefox, freePort, joinRoom, launchChrome, launchFirefox, sleep, stopProcess, waitFor } from './browser.mjs'
import { buildServer, parseArgs, serverEnv, startServer } from './server.mjs'
import { clickButtonByTitle, fakeDisplay, remoteScreen, SHARE_WIDTH, shareMode, shareReceiveCounters, shareSendCounters } from './share.mjs'

const args = parseArgs(process.argv.slice(2))
const cycles = Number(args.cycles ?? 5)
const chromeBinary = args.chrome ?? process.env.CHROME ?? findChrome()
const skipFirefox = args['skip-firefox'] === true
const firefoxBinary = skipFirefox ? null : (args.firefox ?? process.env.FIREFOX ?? findFirefox())

const PHASE_SECONDS = 3
const WARMUP_SECONDS = 5

// A scrolling burst is fluid when the viewer decodes at least this many
// frames a second across it, and does not freeze once it has started.
const BURST_MIN_FPS = 15
const MAX_FROZEN_MS = 500

const phaseAt = (second) => (Math.floor(second / PHASE_SECONDS) % 2 === 0 ? 'scrolling' : 'still')

const burstOf = (second) => Math.floor(second / (PHASE_SECONDS * 2))

// The first second of a burst ends the still screen's pause, which the
// viewer counts as a freeze; it is not one the burst caused.
const burstStarted = (second) => phaseAt(second) === 'scrolling' && second % (PHASE_SECONDS * 2) !== 0

const mbps = (bits) => (bits / 1e6).toFixed(1)

// One second of the share at both ends, from two readings of the counters.
function secondOf(second, before, after, estimate) {
  const h = after.send?.layers.h ?? {}
  const ph = before.send?.layers.h ?? {}
  return {
    second,
    phase: phaseAt(second),
    viewerFps: after.recv.decoded - before.recv.decoded,
    freezes: after.recv.freezes - before.recv.freezes,
    frozenMs: after.recv.frozenMs - before.recv.frozenMs,
    keyframes: after.recv.keyframes - before.recv.keyframes,
    lost: after.recv.lost - before.recv.lost,
    width: after.recv.width,
    encodedFps: (h.encoded ?? 0) - (ph.encoded ?? 0),
    sentBps: ((h.bytes ?? 0) - (ph.bytes ?? 0)) * 8,
    targetBps: h.target ?? 0,
    limit: h.limit ?? '-',
    estimateBps: estimate,
  }
}

async function counters(presenter, viewer) {
  const [recv, send] = await Promise.all([evalJs(viewer, shareReceiveCounters), evalJs(presenter, shareSendCounters)])
  return { recv, send }
}

async function timeline(presenter, viewer, seconds) {
  const out = []
  await evalJs(presenter, shareMode(phaseAt(0)))
  let before = await counters(presenter, viewer)
  for (let second = 0; second < seconds; second++) {
    const phase = phaseAt(second)
    await sleep(1000)
    if (phaseAt(second + 1) !== phase) await evalJs(presenter, shareMode(phaseAt(second + 1)))
    const after = await counters(presenter, viewer)
    if (!after.recv) throw new Error(`the viewer lost the share at t=${second}s`)
    const ssrc = after.send?.layers.h?.ssrc
    const row = secondOf(second, before, after, ssrc === undefined ? null : await presenter.outgoingEstimate(ssrc))
    console.log(
      `  t=${String(second).padStart(2)}s ${phase.padEnd(9)} viewer ${String(row.viewerFps).padStart(2)} fps, +${row.freezes} freeze (${row.frozenMs} ms), +${row.keyframes} key, +${row.lost} lost, ${row.width}px` +
        ` | presenter h ${String(row.encodedFps).padStart(2)} fps, ${mbps(row.sentBps)} Mbps (target ${mbps(row.targetBps)}), ${row.limit}` +
        ` | estimate ${row.estimateBps === null ? 'unknown' : `${mbps(row.estimateBps)} Mbps`}`,
    )
    out.push(row)
    before = after
  }
  return out
}

const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0)

function summarize(rows) {
  const scrolling = rows.filter((row) => row.phase === 'scrolling')
  const still = rows.filter((row) => row.phase === 'still')
  const bursts = Map.groupBy(scrolling, (row) => burstOf(row.second))
  const estimates = (of) => of.map((row) => row.estimateBps).filter((bps) => bps !== null)
  const inBursts = rows.filter((row) => burstStarted(row.second))
  return {
    burstFps: [...bursts.values()].map((burst) => mean(burst.map((row) => row.viewerFps))),
    scrollEncodedFps: mean(scrolling.map((row) => row.encodedFps)),
    scrollMbps: mean(scrolling.map((row) => row.sentBps)) / 1e6,
    stillMbps: mean(still.map((row) => row.sentBps)) / 1e6,
    scrollEstimates: estimates(scrolling),
    stillEstimates: estimates(still),
    burstFreezes: inBursts.reduce((sum, row) => sum + row.freezes, 0),
    burstFrozenMs: Math.max(0, ...inBursts.map((row) => row.frozenMs)),
  }
}

const estimateMbps = (bps) => (bps.length ? (mean(bps) / 1e6).toFixed(1) : 'unknown')
const minEstimateMbps = (bps) => (bps.length ? (Math.min(...bps) / 1e6).toFixed(1) : 'unknown')

async function present(label, presenter, viewer, base) {
  const room = await createRoom(base, `burst-${label}`)
  await joinRoom(presenter, room.url)
  await joinRoom(viewer, room.url)
  await evalJs(presenter, fakeDisplay)
  if (!(await clickButtonByTitle(presenter, 'Share your screen'))) throw new Error(`${label}: no "Share your screen" button`)
  const shown = await waitFor(viewer, remoteScreen, (v) => v?.width === SHARE_WIDTH, 30000)
  if (!shown.ok) throw new Error(`${label}: the share never reached the viewer at ${SHARE_WIDTH}px (${JSON.stringify(shown.value)})`)
  await sleep(WARMUP_SECONDS * 1000)
  console.log(`${label} (${presenter.browser}) presenting to ${viewer.browser}:`)
  return summarize(await timeline(presenter, viewer, cycles * PHASE_SECONDS * 2))
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'conference-share-burst-'))
  const procs = []
  const failures = []
  try {
    const bin = args.server ? resolve(args.server) : buildServer(dir, { race: false })
    const port = await freePort()
    const server = await startServer(bin, await serverEnv(dir, port))
    procs.push(server.proc)
    const base = `http://127.0.0.1:${port}`

    const presenters = [['chrome', (idx) => launchChrome(chromeBinary, idx, dir)]]
    if (firefoxBinary) presenters.push(['firefox', (idx) => launchFirefox(firefoxBinary, idx, dir)])
    else console.log('share burst: --skip-firefox given, measuring the Chrome presenter alone')

    const results = {}
    for (const [index, [label, launch]] of presenters.entries()) {
      const presenter = await launch(index * 2)
      const viewer = await launchChrome(chromeBinary, index * 2 + 1, dir)
      procs.push(presenter.proc, viewer.proc)
      try {
        results[label] = await present(label, presenter, viewer, base)
      } finally {
        await Promise.all([stopProcess(presenter.proc, 'SIGKILL'), stopProcess(viewer.proc, 'SIGKILL')])
      }
    }

    console.log('\nshare burst summary:')
    console.table(
      Object.fromEntries(
        Object.entries(results).map(([label, s]) => [
          label,
          {
            'viewer fps per burst': s.burstFps.map((fps) => fps.toFixed(0)).join(' '),
            'encoded fps scrolling': s.scrollEncodedFps.toFixed(1),
            'Mbps scrolling': s.scrollMbps.toFixed(2),
            'Mbps still': s.stillMbps.toFixed(2),
            'estimate scrolling': estimateMbps(s.scrollEstimates),
            'estimate still (min)': minEstimateMbps(s.stillEstimates),
            'freezes in bursts': s.burstFreezes,
            'longest ms': s.burstFrozenMs,
          },
        ]),
      ),
    )
    for (const [label, s] of Object.entries(results)) {
      const worst = Math.min(...s.burstFps)
      if (worst < BURST_MIN_FPS) failures.push(`${label}: a scrolling burst played at ${worst.toFixed(1)} fps, want at least ${BURST_MIN_FPS}`)
      if (s.burstFrozenMs > MAX_FROZEN_MS) failures.push(`${label}: the share froze for ${s.burstFrozenMs} ms in the middle of a scrolling burst`)
    }
    if (failures.length) {
      console.error('\nSHARE BURST FAILED')
      for (const f of failures) console.error('  - ' + f)
      console.error('\nserver log tail:\n' + server.log().split('\n').slice(-20).join('\n'))
      process.exitCode = 1
    } else {
      console.log('\nSHARE BURST OK: scrolling bursts stay fluid after the screen sat still')
    }
  } finally {
    await Promise.all(procs.map((p) => stopProcess(p, 'SIGKILL')))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
