import assert from 'node:assert/strict'
import { test } from 'node:test'

import { wasmThreads } from './wasm.ts'

test('a page that is not cross-origin isolated runs one thread', () => {
  assert.equal(wasmThreads(false, 16), 1)
})

test('an isolated page uses half its cores, at most four', () => {
  assert.equal(wasmThreads(true, 1), 1)
  assert.equal(wasmThreads(true, 6), 3)
  assert.equal(wasmThreads(true, 32), 4)
})
