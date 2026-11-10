import assert from 'node:assert/strict'
import { test } from 'node:test'

import { heard, holdLeft, isVoiced, SPEAKING_HOLD_MS, SPEAKING_SAMPLE_MS, type LastVoiced } from './speaking.ts'

const VOICE = 0.3
const SILENCE = 0.01

/** tone is an analyser frame whose root-mean-square amplitude is rms. */
const tone = (rms: number): Float32Array => Float32Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? rms : -rms))

/** ring is the ring's state at each sample of a probe fed frames of these RMS levels. */
const ring = (frames: readonly number[]): boolean[] => {
  let lastVoiced: LastVoiced = null
  return frames.map((rms, i) => {
    const now = i * SPEAKING_SAMPLE_MS
    lastVoiced = heard(lastVoiced, isVoiced(tone(rms)), now)
    return holdLeft(lastVoiced, now) > 0
  })
}

const quiet = (samples: number): number[] => Array<number>(samples).fill(SILENCE)

test('a frame is voiced by its loudness, whichever way the wave swings', () => {
  assert.equal(isVoiced(tone(VOICE)), true)
  assert.equal(isVoiced(tone(SILENCE)), false)
  assert.equal(isVoiced(new Float32Array(1024)), false)
  assert.equal(isVoiced(Float32Array.from({ length: 1024 }, (_, i) => VOICE * Math.sin(i / 8))), true)
})

test('the ring stays off until a voice is heard, then turns on at once', () => {
  assert.deepEqual(ring([SILENCE, SILENCE, VOICE]), [false, false, true])
})

test('a short pause between words keeps the ring on', () => {
  const pause = quiet(2)
  assert.ok(pause.length * SPEAKING_SAMPLE_MS < SPEAKING_HOLD_MS)
  assert.ok(ring([VOICE, VOICE, ...pause, VOICE, VOICE]).every(Boolean))
})

test('a pause longer than the hold turns the ring off', () => {
  const shown = ring([VOICE, VOICE, ...quiet(8)])
  const lastOn = shown.lastIndexOf(true)
  assert.ok(lastOn < shown.length - 1, 'the ring never turned off')
  assert.ok((lastOn - 1) * SPEAKING_SAMPLE_MS < SPEAKING_HOLD_MS)
  assert.ok(shown.slice(lastOn + 1).every((on) => !on))
})

test('a single click does not latch the ring', () => {
  const shown = ring([VOICE, ...quiet(12)])
  const onFor = shown.lastIndexOf(true) * SPEAKING_SAMPLE_MS
  assert.ok(onFor < SPEAKING_HOLD_MS, `the ring stayed on for ${onFor} ms after one click`)
  assert.ok(shown.slice(4).every((on) => !on))
})

test('a translated voice is held by the same rule after it stops playing', () => {
  const started = 120
  const stopped = 1337
  let lastVoiced = heard(null, true, started)
  lastVoiced = heard(lastVoiced, true, stopped)

  assert.ok(holdLeft(lastVoiced, stopped + SPEAKING_HOLD_MS / 2) > 0, 'the ring dropped mid-pause')
  assert.equal(holdLeft(lastVoiced, stopped + SPEAKING_HOLD_MS), 0)
  assert.equal(holdLeft(heard(lastVoiced, false, stopped + 200), stopped + SPEAKING_HOLD_MS), 0)
})

test('the ring is off before anything has been heard', () => {
  assert.equal(holdLeft(heard(null, false, 5000), 5000), 0)
})
