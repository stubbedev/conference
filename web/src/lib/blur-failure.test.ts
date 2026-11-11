import assert from 'node:assert/strict'
import { test } from 'node:test'

import { blurFailureMessage } from './blur-failure.ts'
import { loadChunk } from './chunks.ts'

test('blur code that could not be fetched asks for a reload', async () => {
  const fetchFailed = new TypeError('Failed to fetch dynamically imported module: /assets/vision-abc.js')
  const err = await loadChunk('the background-blur code', () => Promise.reject(fetchFailed)).catch((caught: unknown) => caught)
  assert.equal(blurFailureMessage(err), 'Could not load background blur, so your camera goes out as it is. Reload the page to try again.')
})

test('a browser that cannot blur is told blur is unavailable', () => {
  const refused = new Error('the background-blur model could not start')
  assert.equal(blurFailureMessage(refused), 'Background blur is unavailable here, so your camera goes out as it is.')
})
