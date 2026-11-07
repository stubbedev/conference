import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FRAME, Frames, MAX_UTTERANCE_SECONDS, RATE, Segmentation, Utterances } from './vad.ts'

const frame = (value = 0): Int16Array => new Int16Array(FRAME).fill(value)
const silence = 0.1
const speech = 0.9

const frames = (seconds: number): number => Math.floor((seconds * RATE) / FRAME)

function feed(utterances: Utterances, probability: number, count: number): Int16Array[] {
  const done: Int16Array[] = []
  for (let i = 0; i < count; i++) {
    const utterance = utterances.detect(probability, frame(probability > 0.5 ? 1 : 0))
    if (utterance) done.push(utterance)
  }
  return done
}

test('silence alone is no utterance', () => {
  const utterances = new Utterances()
  assert.deepEqual(feed(utterances, silence, 200), [])
  assert.equal(utterances.active, false)
  assert.equal(utterances.flush(), null)
})

test('an utterance ends after 400 ms of silence', () => {
  const utterances = new Utterances()
  feed(utterances, speech, 40)
  assert.equal(utterances.active, true)

  assert.deepEqual(feed(utterances, silence, frames(0.4) - 1), [])
  assert.equal(utterances.active, true)

  const done = feed(utterances, silence, 1)
  assert.equal(done.length, 1)
  assert.equal(utterances.active, false)
  assert.equal(done[0].length, (40 + frames(0.4)) * FRAME)
})

test('a long utterance is cut after 160 ms of silence', () => {
  const utterances = new Utterances()
  feed(utterances, speech, frames(3) + 1)

  assert.deepEqual(feed(utterances, silence, frames(0.16) - 1), [])
  assert.equal(feed(utterances, silence, 1).length, 1)
})

test('an utterance is cut at the longest an utterance runs', () => {
  const utterances = new Utterances()
  const done = feed(utterances, speech, frames(MAX_UTTERANCE_SECONDS) + 10)

  assert.equal(done.length, 1)
  assert.equal(done[0].length, frames(MAX_UTTERANCE_SECONDS) * FRAME)
})

test('the frames before the first speech are kept', () => {
  const utterances = new Utterances()
  feed(utterances, silence, 5)
  feed(utterances, speech, 1)

  const done = utterances.flush()
  assert.equal(done?.length, 6 * FRAME)
})

test('at most 10 of the frames before speech are kept', () => {
  const utterances = new Utterances()
  feed(utterances, silence, 60)
  feed(utterances, speech, 1)

  const done = utterances.flush()
  assert.equal(done?.length, 10 * FRAME)
})

test('frames hold back a partial one until it is whole', () => {
  const framesIn = new Frames()
  assert.deepEqual(framesIn.push(new Int16Array(FRAME - 1)), [])
  assert.deepEqual(framesIn.push(new Int16Array(0)), [])
  assert.equal(framesIn.push(new Int16Array(1)).length, 1)

  const many = framesIn.push(new Int16Array(FRAME * 2 + 7))
  assert.equal(many.length, 2)
  assert.equal(many[0].length, FRAME)
})

test('reset drops the partial frame', () => {
  const framesIn = new Frames()
  framesIn.push(new Int16Array(FRAME - 1))
  framesIn.reset()
  assert.deepEqual(framesIn.push(new Int16Array(1)), [])
})

test('a growing utterance is reported every 600 ms once it is long enough, then ends as one', async () => {
  const segmentation = new Segmentation()
  const seconds = (count: number) => new Int16Array(Math.round(count * RATE))
  const loud = (frame: Int16Array) => (frame[0] === 1 ? 0.9 : 0.1)

  const speaking = seconds(2).fill(1)
  const segments = await segmentation.push(speaking, loud)
  const partials = segments.filter((segment) => segment.kind === 'partial')
  assert.equal(segments.every((segment) => segment.kind === 'partial'), true)
  assert.equal(partials.length, 3)
  assert.ok(partials.every((partial, i) => i === 0 || partial.audio.length > partials[i - 1].audio.length))

  const ended = await segmentation.push(seconds(1), loud)
  const utterances = ended.filter((segment) => segment.kind === 'utterance')
  assert.equal(utterances.length, 1)
  assert.ok(utterances[0].audio.length >= speaking.length)
})

test('a segmentation that is flushed hands back the utterance in progress, and nothing after a reset', async () => {
  const segmentation = new Segmentation()
  await segmentation.push(new Int16Array(RATE).fill(1), () => 0.9)
  assert.equal(segmentation.flush()?.kind, 'utterance')
  assert.equal(segmentation.flush(), null)

  await segmentation.push(new Int16Array(RATE).fill(1), () => 0.9)
  segmentation.reset()
  assert.equal(segmentation.flush(), null)
})
