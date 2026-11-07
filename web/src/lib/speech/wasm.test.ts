import assert from 'node:assert/strict'
import { test } from 'node:test'

import { wasmThreads } from './wasm.ts'

test('a page that is not cross-origin isolated runs one thread', () => {
  assert.equal(wasmThreads(false, 16), 1)
})

test('each of the four speech workers gets a quarter of the cores, at most four, so video keeps its share', () => {
  assert.equal(wasmThreads(true, 1), 1)
  assert.equal(wasmThreads(true, 8), 2)
  assert.equal(wasmThreads(true, 12), 3)
  assert.equal(wasmThreads(true, 32), 4)
})
