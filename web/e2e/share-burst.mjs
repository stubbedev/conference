#!/usr/bin/env node
// A shared screen that is scrolled in bursts: three seconds of fast
// scrolling, three seconds of nothing changing, over and over, presented
// once from Chrome and once from Firefox to a Chrome viewer. A still
// screen sends almost nothing, so a connection whose bandwidth estimate
// follows what it sends meets the next scroll with an encoder held to a
// trickle: the viewer sees a few frames a second and freezes. This test
// prints the share second by second and fails when a scrolling burst is
// not sent or not delivered fluidly, when it does not play fluidly, when
// the viewer needs a keyframe after every still stretch, or when a share
// started on a still screen does not get a high estimate at once.
//
// What a burst plays at is only asked of a viewer that is watching the
// fluid encoding. A viewer whose decoder drops frames asks the SFU for the
// slow encoding on its own (lib/quality), and a machine too small to
// decode a burst in time does exactly that: what it then plays says
// nothing about the share. The test reads what the viewer asked for, and
// holds a viewer that stepped down to having dropped the frames that
// explain it and to not having lost the packets that would.
//
//   node web/e2e/share-burst.mjs [--server path/to/binary] [--chrome binary] [--firefox binary] [--skip-firefox] [--cycles N]
//
// Firefox is required: without one the test fails, unless --skip-firefox
// says to measure Chrome alone. The server is built without the race
// detector, which would slow forwarding down and skew the rates measured.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createRoom, evalJs, findChrome, findFirefox, joinRoom, launchChrome, launchFirefox, sleep, stopProcess, waitFor } from './browser.mjs'
import { buildServer, parseArgs, serverEnv, startServer } from './server.mjs'
import { SCREEN_LAYER_RIDS, SCREEN_SHARE_FLUID_MAX_BITRATE } from '../src/lib/encodings.ts'
import { DROPPED_FRAMES_LIMIT, LOST_PACKETS_LIMIT } from '../src/lib/quality.ts'
import { clickButtonByTitle, fakeDisplay, remoteScreen, SHARE_WIDTH, shareMode, shareReceiveCounters, shareSendCounters } from './share.mjs'

const args = parseArgs(process.argv.slice(2))
const cycles = Number(args.cycles ?? 5)
const chromeBinary = args.chrome ?? process.env.CHROME ?? findChrome()
const skipFirefox = args['skip-firefox'] === true
const firefoxBinary = skipFirefox ? null : (args.firefox ?? process.env.FIREFOX ?? findFirefox())

const PHASE_SECONDS = 3
const WARMUP_SECONDS = 5

const [, FLUID] = SCREEN_LAYER_RIDS

// The presenter's fastest burst must reach this many frames a second:
// it is the fluid encoding that is sent, not the slow one. How fast each
// burst runs beyond that follows the machine's free CPU from one second
// to the next (40 and 18 frames a second in one run, 14 to 44 between
// runs), so it is not judged: what holds a burst back for our reasons
// shows in the estimate and in the encoder's own account below.
const BURST_MIN_FPS = 15

// What a browser's encoder says when the bandwidth it is given, not the
// CPU, limits what it sends. Chrome says; Firefox does not report it.
const LIMITED_BY_BANDWIDTH = 'bandwidth'

// A viewer watching the fluid encoding plays at least this share of the
// frames a burst was sent with.
const MIN_PLAYED_SHARE = 0.8

const FREEZE_MAX_FRAME_INTERVALS = 30

// The frames of a burst the presenter sent that must reach a viewer
// watching the fluid encoding. The two ends are read a moment apart, so a
// few frames at either edge of a burst are counted at one end only.
const MIN_DELIVERED_SHARE = 0.9

// How long after asking for the fluid encoding a viewer is taken to be
// watching it: the SFU asks the presenter for a keyframe at its next
// one-second tick and switches the viewer when it arrives.
const SWITCH_SETTLE_MS = 2000

// A keyframe is the largest frame; one at the start of every burst would
// arrive exactly when the bitrate is needed most. Loss may cost one.
const MAX_KEYFRAMES = 1

// A share that starts on a still screen must have the estimate a scroll
// needs within libwebrtc's two-second start window, not climb to it at
// 8% a second.
const START_SECONDS = 3
const START_SAMPLE_MS = 250
const START_WINDOW_MS = 2000
const START_MIN_ESTIMATE = SCREEN_SHARE_FLUID_MAX_BITRATE

// The estimate must then stay there through every burst and every still
// stretch: one that sinks while the screen is still is what starves the
// next burst.
const HELD_MIN_ESTIMATE = SCREEN_SHARE_FLUID_MAX_BITRATE

const phaseAt = (second) => (Math.floor(second / PHASE_SECONDS) % 2 === 0 ? 'scrolling' : 'still')

const burstOf = (second) => Math.floor(second / (PHASE_SECONDS * 2))

// The first second of a burst ends the still screen's pause, which the
// viewer counts as a freeze; it is not one the burst caused.
const burstStarted = (second) => phaseAt(second) === 'scrolling' && second % (PHASE_SECONDS * 2) !== 0

const mbps = (bits) => (bits / 1e6).toFixed(1)

// A viewer watches the fluid encoding over a stretch when that is what it
// last asked for, long enough before the stretch for the switch to be over.
function watchesFluid(before, after) {
  const last = after.asks.at(-1)
  return last?.layer === FLUID && last.at <= before.at - SWITCH_SETTLE_MS
}

// One stretch of the share at both ends, from two readings of the
// counters. A stretch is a second by intent only: each end says when it
// was read, and the rates are over the time that really passed there.
function secondOf(second, before, after, estimate) {
  const h = after.send.layers[FLUID] ?? {}
  const ph = before.send.layers[FLUID] ?? {}
  return {
    second,
    phase: phaseAt(second),
    recvSeconds: (after.recv.at - before.recv.at) / 1000,
    sendSeconds: (after.send.at - before.send.at) / 1000,
    fluid: watchesFluid(before.recv, after.recv),
    asked: after.recv.asks.at(-1)?.layer ?? '-',
    received: after.recv.received - before.recv.received,
    decoded: after.recv.decoded - before.recv.decoded,
    dropped: after.recv.dropped - before.recv.dropped,
    freezes: after.recv.freezes - before.recv.freezes,
    frozenMs: after.recv.frozenMs - before.recv.frozenMs,
    keyframes: after.recv.keyframes - before.recv.keyframes,
    viewerPlis: after.recv.plis - before.recv.plis,
    sentKeyframes: (h.keyframes ?? 0) - (ph.keyframes ?? 0),
    presenterPlis: (h.plis ?? 0) - (ph.plis ?? 0) + (h.firs ?? 0) - (ph.firs ?? 0),
    lost: after.recv.lost - before.recv.lost,
    width: after.recv.width,
    encoded: (h.encoded ?? 0) - (ph.encoded ?? 0),
    sentBits: ((h.bytes ?? 0) - (ph.bytes ?? 0)) * 8,
    targetBps: h.target ?? 0,
    limit: h.limit ?? '-',
    estimateBps: estimate,
  }
}

async function counters(presenter, viewer, second) {
  const [recv, send] = await Promise.all([evalJs(viewer, shareReceiveCounters), evalJs(presenter, shareSendCounters)])
  if (!recv) throw new Error(`the viewer lost the share at t=${second}s`)
  if (!send) throw new Error(`the presenter lost the share at t=${second}s`)
  return { recv, send }
}

const perSecond = (count, seconds) => (seconds > 0 ? count / seconds : 0)

async function timeline(presenter, viewer, seconds) {
  const out = []
  await evalJs(presenter, shareMode(phaseAt(0)))
  let before = await counters(presenter, viewer, 0)
  for (let second = 0; second < seconds; second++) {
    const phase = phaseAt(second)
    await sleep(1000)
    if (phaseAt(second + 1) !== phase) await evalJs(presenter, shareMode(phaseAt(second + 1)))
    const after = await counters(presenter, viewer, second)
    const ssrc = after.send.layers[FLUID]?.ssrc
    const row = secondOf(second, before, after, ssrc === undefined ? null : await presenter.outgoingEstimate(ssrc))
    const fps = (count, over) => String(Math.round(perSecond(count, over))).padStart(2)
    console.log(
      `  t=${String(second).padStart(2)}s ${phase.padEnd(9)} viewer asks ${row.asked}, ${fps(row.received, row.recvSeconds)} fps in, ${fps(row.decoded, row.recvSeconds)} decoded, +${row.dropped} dropped, +${row.freezes} freeze (${row.frozenMs} ms), +${row.keyframes} key, +${row.viewerPlis} pli, +${row.lost} lost, ${row.width}px` +
        ` | presenter ${FLUID} ${fps(row.encoded, row.sendSeconds)} fps, +${row.sentKeyframes} key, +${row.presenterPlis} pli, ${mbps(perSecond(row.sentBits, row.sendSeconds))} Mbps (target ${mbps(row.targetBps)}), ${row.limit}` +
        ` | estimate ${row.estimateBps === null ? 'unknown' : `${mbps(row.estimateBps)} Mbps`}`,
    )
    out.push(row)
    before = after
  }
  return { rows: out, end: before.recv }
}

const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0)

const total = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0)

// One scrolling burst at both ends: what the presenter sent of the fluid
// encoding, what of it reached the viewer, what the viewer made of it, and
// whether the viewer was watching that encoding from start to end.
function burstOfRows(rows) {
  const started = rows.filter((row) => burstStarted(row.second))
  const delivered = total(rows, 'encoded') > 0 ? total(rows, 'received') / total(rows, 'encoded') : 0
  const decoded = total(rows, 'decoded')
  return {
    fluid: rows.every((row) => row.fluid),
    sentFps: perSecond(total(rows, 'encoded'), total(rows, 'sendSeconds')),
    decodedFps: perSecond(decoded, total(rows, 'recvSeconds')),
    delivered,
    freezes: total(started, 'freezes'),
    frozenMs: Math.max(0, ...started.map((row) => row.frozenMs)),
    playingFrameMs: decoded > 0 ? (total(rows, 'recvSeconds') * 1000 - total(rows, 'frozenMs')) / decoded : Infinity,
    causes: heldBackBy(rows, delivered),
  }
}

function heldBackBy(rows, delivered) {
  const causes = []
  const lost = total(rows, 'lost')
  const requests = total(rows, 'viewerPlis') + total(rows, 'presenterPlis')
  const estimates = rows.map((row) => row.estimateBps).filter((bps) => bps !== null)
  const limited = rows.filter((row) => row.limit === LIMITED_BY_BANDWIDTH).map((row) => row.second)
  if (lost > 0) causes.push(`${lost} packets lost`)
  if (requests > 0) causes.push(`${requests} keyframe requests`)
  if (estimates.some((bps) => bps < HELD_MIN_ESTIMATE)) causes.push(`the estimate sank to ${mbps(Math.min(...estimates))} Mbps`)
  if (limited.length > 0) causes.push(`the encoder limited by bandwidth at t=${limited.join(', ')}s`)
  if (delivered < MIN_DELIVERED_SHARE) causes.push(`${(delivered * 100).toFixed(0)}% of its frames forwarded`)
  return causes
}

function freezeFailure(burst) {
  if (burst.freezes === 0) return null
  if (burst.causes.length > 0) return `the share froze for ${burst.frozenMs} ms in the middle of a scrolling burst with ${burst.causes.join(', ')}`
  const limitMs = FREEZE_MAX_FRAME_INTERVALS * burst.playingFrameMs
  if (burst.frozenMs <= limitMs) return null
  return `the share froze for ${burst.frozenMs} ms in the middle of a scrolling burst, over ${FREEZE_MAX_FRAME_INTERVALS} times its ${burst.playingFrameMs.toFixed(0)} ms between frames while it played (${limitMs.toFixed(0)} ms)`
}

function summarize({ rows, end }) {
  const scrolling = rows.filter((row) => row.phase === 'scrolling')
  const still = rows.filter((row) => row.phase === 'still')
  const estimates = (of) => of.map((row) => row.estimateBps).filter((bps) => bps !== null)
  const sentMbps = (of) => perSecond(total(of, 'sentBits'), total(of, 'sendSeconds')) / 1e6
  return {
    bursts: [...Map.groupBy(scrolling, (row) => burstOf(row.second)).values()].map(burstOfRows),
    scrollMbps: sentMbps(scrolling),
    stillMbps: sentMbps(still),
    scrollEstimates: estimates(scrolling),
    stillEstimates: estimates(still),
    keyframes: total(rows.filter((row) => row.fluid), 'keyframes'),
    limitedSeconds: rows.filter((row) => row.limit === LIMITED_BY_BANDWIDTH).map((row) => row.second),
    steppedDown: end.asks.some((ask) => ask.layer !== FLUID),
    viewer: end,
  }
}

const estimateMbps = (bps) => (bps.length ? (mean(bps) / 1e6).toFixed(1) : 'unknown')
const minEstimateMbps = (bps) => (bps.length ? (Math.min(...bps) / 1e6).toFixed(1) : 'unknown')

// The share's estimate over its first seconds, sampled from its first
// frame on: a share that starts on a still screen sends a few frames and
// then nothing, and its estimate must still start high rather than climb.
async function startingEstimates(label, presenter) {
  const sending = await waitFor(presenter, shareSendCounters, (v) => (v?.layers[FLUID]?.bytes ?? 0) > 0, 30000)
  if (!sending.ok) throw new Error(`${label}: the share never sent its first frame`)
  const ssrc = sending.value.layers[FLUID].ssrc
  const start = Date.now()
  const samples = []
  while (Date.now() - start < START_SECONDS * 1000) {
    samples.push({ ms: Date.now() - start, bps: await presenter.outgoingEstimate(ssrc) })
    await sleep(START_SAMPLE_MS)
  }
  return samples
}

const startEstimateOf = (samples) => Math.max(0, ...samples.filter((s) => s.ms <= START_WINDOW_MS && s.bps !== null).map((s) => s.bps))

async function present(label, presenter, viewer, base) {
  const room = await createRoom(base, `burst-${label}`)
  await joinRoom(presenter, room.url)
  await joinRoom(viewer, room.url)
  await evalJs(presenter, fakeDisplay)
  await evalJs(presenter, shareMode('still'))
  if (!(await clickButtonByTitle(presenter, 'Share your screen'))) throw new Error(`${label}: no "Share your screen" button`)
  const start = await startingEstimates(label, presenter)
  console.log(`${label} (${presenter.browser}) starting on a still screen, estimate: ${start.map((s) => `${(s.ms / 1000).toFixed(1)}s ${s.bps === null ? 'unknown' : mbps(s.bps)}`).join(', ')} Mbps`)
  const shown = await waitFor(viewer, remoteScreen, (v) => v?.width === SHARE_WIDTH, 30000)
  if (!shown.ok) throw new Error(`${label}: the share never reached the viewer at ${SHARE_WIDTH}px (${JSON.stringify(shown.value)})`)
  await sleep(WARMUP_SECONDS * 1000)
  console.log(`${label} (${presenter.browser}) presenting to ${viewer.browser}:`)
  return { startEstimate: startEstimateOf(start), ...summarize(await timeline(presenter, viewer, cycles * PHASE_SECONDS * 2)) }
}

const fpsList = (bursts, field) => bursts.map((burst) => burst[field].toFixed(0)).join(' ')

function failuresOf(label, s) {
  const failures = []
  const fluid = s.bursts.filter((burst) => burst.fluid)
  const fastestSent = Math.max(...s.bursts.map((burst) => burst.sentFps))
  const held = [...s.scrollEstimates, ...s.stillEstimates]
  if (fastestSent < BURST_MIN_FPS) failures.push(`${label}: the fastest scrolling burst was sent at ${fastestSent.toFixed(1)} fps, want at least ${BURST_MIN_FPS}`)
  if (s.limitedSeconds.length > 0) failures.push(`${label}: the encoder of the fluid encoding was limited by bandwidth at t=${s.limitedSeconds.join(', ')}s`)
  if (held.length === 0) failures.push(`${label}: the share's estimate could not be read while it was presented`)
  else if (Math.min(...held) < HELD_MIN_ESTIMATE) failures.push(`${label}: the share's estimate sank to ${mbps(Math.min(...held))} Mbps while it was presented, want at least ${mbps(HELD_MIN_ESTIMATE)}`)
  if (s.startEstimate < START_MIN_ESTIMATE) failures.push(`${label}: a share started on a still screen estimated ${mbps(s.startEstimate)} Mbps within ${START_WINDOW_MS} ms, want at least ${mbps(START_MIN_ESTIMATE)}`)
  if (s.viewer.asks.length === 0) failures.push(`${label}: the viewer never asked the SFU for a layer of the share`)
  if (s.steppedDown && s.viewer.dropped < DROPPED_FRAMES_LIMIT) failures.push(`${label}: the viewer asked for less than the fluid encoding having dropped ${s.viewer.dropped} frames: its decoder does not explain it`)
  if (s.steppedDown && s.viewer.lost >= LOST_PACKETS_LIMIT) failures.push(`${label}: the viewer asked for less than the fluid encoding having lost ${s.viewer.lost} packets on a network that loses none`)
  if (fluid.length === 0) return failures

  const leastDelivered = Math.min(...fluid.map((burst) => burst.delivered))
  const leastPlayed = Math.min(...fluid.map((burst) => (burst.sentFps > 0 ? burst.decodedFps / burst.sentFps : 0)))
  if (leastDelivered < MIN_DELIVERED_SHARE) failures.push(`${label}: ${(leastDelivered * 100).toFixed(0)}% of the frames sent in a scrolling burst reached a viewer watching the fluid encoding, want at least ${MIN_DELIVERED_SHARE * 100}%`)
  if (leastPlayed < MIN_PLAYED_SHARE) failures.push(`${label}: a viewer watching the fluid encoding played ${(leastPlayed * 100).toFixed(0)}% of the frames a scrolling burst was sent with, want at least ${MIN_PLAYED_SHARE * 100}%`)
  for (const failure of fluid.map(freezeFailure).filter((failure) => failure !== null)) failures.push(`${label}: ${failure}`)
  if (s.keyframes > MAX_KEYFRAMES) failures.push(`${label}: a viewer watching the fluid encoding decoded ${s.keyframes} keyframes over ${cycles} bursts, want at most ${MAX_KEYFRAMES}`)
  return failures
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'conference-share-burst-'))
  const procs = []
  const failures = []
  try {
    const bin = args.server ? resolve(args.server) : buildServer(dir, { race: false })
    const server = await startServer(bin, serverEnv(dir))
    procs.push(server.proc)
    const { base } = server

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
            'estimate at start': mbps(s.startEstimate),
            'sent fps per burst': fpsList(s.bursts, 'sentFps'),
            'viewer fps per burst': fpsList(s.bursts, 'decodedFps'),
            'watched fluid': s.bursts.map((burst) => (burst.fluid ? 'yes' : 'no')).join(' '),
            'Mbps scrolling': s.scrollMbps.toFixed(2),
            'Mbps still': s.stillMbps.toFixed(2),
            'estimate scrolling': estimateMbps(s.scrollEstimates),
            'estimate still (min)': minEstimateMbps(s.stillEstimates),
            'freezes in fluid bursts': s.bursts.filter((burst) => burst.fluid).reduce((sum, burst) => sum + burst.freezes, 0),
            'keyframes while fluid': s.keyframes,
          },
        ]),
      ),
    )
    for (const [label, s] of Object.entries(results)) {
      const fluid = s.bursts.filter((burst) => burst.fluid).length
      if (fluid < s.bursts.length) {
        console.log(
          `${label}: the viewer watched ${fluid} of ${s.bursts.length} bursts on the fluid encoding. It dropped ${s.viewer.dropped} of the ${s.viewer.received} frames it received and lost ${s.viewer.lost} packets, and asked for the slow encoding on its own: what the other bursts played at is not held against the share`,
        )
      }
      failures.push(...failuresOf(label, s))
    }
    if (failures.length) {
      console.error('\nSHARE BURST FAILED')
      for (const f of failures) console.error('  - ' + f)
      console.error('\nserver log tail:\n' + server.log().split('\n').slice(-20).join('\n'))
      process.exitCode = 1
    } else {
      console.log('\nSHARE BURST OK: the share starts with the estimate a scroll needs and keeps it while the screen sits still, its encoder is never limited by bandwidth, and the bursts a viewer watched on the fluid encoding arrived, played without a freeze that anything held back or that stood far beyond their own frame gaps, and needed no keyframe')
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
