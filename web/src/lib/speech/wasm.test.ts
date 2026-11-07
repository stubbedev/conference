import assert from 'node:assert/strict'
import { test } from 'node:test'

import { wasmThreads } from './wasm.ts'

test('a page that is not cross-origin isolated runs one thread', () => {
  assert.equal(wasmThreads(false, 16, 'model'), 1)
})

test('each of the four speech workers gets a quarter of the cores, at most four, so video keeps its share', () => {
  assert.equal(wasmThreads(true, 1, 'model'), 1)
  assert.equal(wasmThreads(true, 8, 'model'), 2)
  assert.equal(wasmThreads(true, 12, 'model'), 3)
  assert.equal(wasmThreads(true, 32, 'model'), 4)
})

test('voice detection, a tiny model run every few milliseconds, keeps to one thread', () => {
  assert.equal(wasmThreads(true, 32, 'detector'), 1)
})
