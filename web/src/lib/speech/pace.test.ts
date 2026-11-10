import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BACKGROUND_DUTY, nextRunAt, Pace } from './pace.ts'

test('a transcriber is behind once three sentences in a row took longer than they lasted', () => {
  const pace = new Pace()
  pace.record(2, 3)
  pace.record(2, 2.5)
  assert.equal(pace.behind, false)
  pace.record(1, 1.2)
  assert.equal(pace.behind, true)
})

test('one quick sentence among slow ones is not falling behind', () => {
  const pace = new Pace()
  pace.record(2, 3)
  pace.record(2, 0.5)
  pace.record(2, 3)
  assert.equal(pace.behind, false)
  pace.record(2, 3)
  pace.record(2, 3)
  assert.equal(pace.behind, true)
  pace.reset()
  assert.equal(pace.behind, false)
})

test('background work waits at least its minimum gap', () => {
  assert.equal(nextRunAt(1000, 10, 1000), 2000)
})

test('slow background work waits long enough to stay under its share of the device', () => {
  const after = nextRunAt(1000, 600, 1000)
  assert.equal(after, 1000 + (600 * (1 - BACKGROUND_DUTY)) / BACKGROUND_DUTY)
  assert.ok(600 / (600 + (after - 1000)) <= BACKGROUND_DUTY + 1e-9)
})
