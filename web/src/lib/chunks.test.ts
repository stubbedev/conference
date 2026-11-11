import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ChunkLoadFailed, loadChunk } from './chunks.ts'

test('loaded code comes back as it is', async () => {
  const module = { default: 'Room' }
  assert.equal(await loadChunk('the room page', async () => module), module)
})

test('code that could not be fetched fails saying which and why', async () => {
  const fetchFailed = new TypeError('Failed to fetch dynamically imported module: /assets/Room-abc.js')
  await assert.rejects(
    loadChunk('the room page', () => Promise.reject(fetchFailed)),
    (err: Error) => {
      assert.ok(err instanceof ChunkLoadFailed)
      assert.equal(err.message, 'Could not load the room page: Failed to fetch dynamically imported module: /assets/Room-abc.js')
      assert.equal(err.cause, fetchFailed)
      return true
    },
  )
})
