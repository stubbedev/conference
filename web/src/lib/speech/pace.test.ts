import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Pace } from './pace.ts'

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
