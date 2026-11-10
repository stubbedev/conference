import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseArgs, planPairs, retryAfterSeconds } from './fetch-speech-models.mjs'

test('pair languages are their own list beside every language', () => {
  const options = parseArgs(['/srv/models', '--languages=all', '--pair-languages=en, de,da,en', '--pair-dtype=q4'])

  assert.deepEqual(options.languages, ['all'])
  assert.deepEqual(options.pairs, { languages: ['en', 'de', 'da'], dtype: 'q4' })
})

test('pairs cover every language by default', () => {
  assert.deepEqual(parseArgs(['/srv/models', '--languages=en,de']).pairs, { languages: ['en', 'de'], dtype: 'q4f16' })
  assert.deepEqual(parseArgs(['/srv/models', '--languages=all']).pairs, { languages: ['all'], dtype: 'q4f16' })
})

test('one language has no pairs, and none turns them off', () => {
  assert.equal(parseArgs(['/srv/models', '--languages=en']).pairs, null)
  assert.equal(parseArgs(['/srv/models', '--languages=en,de', '--pair-languages=none']).pairs, null)
})

test('the old pairs flag and an empty pair list are refused', () => {
  assert.throws(() => parseArgs(['/srv/models', '--pairs']), /pairs is not an option/)
  assert.throws(() => parseArgs(['/srv/models', '--pair-languages=,']), /--pair-languages names no language/)
})

test('Portuguese into English uses the Romance model when it has no pair of its own', () => {
  const hosted = new Set(['Xenova/opus-mt-ROMANCE-en'])

  const { found } = planPairs(['pt', 'en'], hosted)

  assert.deepEqual(found, [{ pair: 'pt-en', model: 'Xenova/opus-mt-ROMANCE-en' }])
})

test('a pair of its own wins over the Romance model', () => {
  const hosted = new Set(['Xenova/opus-mt-pt-en', 'Xenova/opus-mt-ROMANCE-en'])

  const { found } = planPairs(['pt', 'en'], hosted)

  assert.deepEqual(found, [{ pair: 'pt-en', model: 'Xenova/opus-mt-pt-en' }])
})

test('the Romance model only translates into English', () => {
  const hosted = new Set(['Xenova/opus-mt-ROMANCE-en'])

  const { found } = planPairs(['pt', 'de'], hosted)

  assert.deepEqual(found, [])
})

test('a pair takes the first owner with an export', () => {
  const hosted = new Set(['Xenova/opus-mt-en-de', 'onnx-community/opus-mt-de-en'])

  const { found, skipped } = planPairs(['en', 'de'], hosted)

  assert.deepEqual(found, [
    { pair: 'en-de', model: 'Xenova/opus-mt-en-de' },
    { pair: 'de-en', model: 'onnx-community/opus-mt-de-en' },
  ])
  assert.deepEqual(skipped, [])
})

test('a pair without an export is skipped by name, in a stable order', () => {
  const hosted = new Set(['Xenova/opus-mt-de-da'])

  const { found, skipped } = planPairs(['de', 'da'], hosted)

  assert.deepEqual(found.map((entry) => entry.pair), ['de-da'])
  assert.deepEqual(skipped, [{ pair: 'da-de', reason: 'none of Xenova/opus-mt-da-de, onnx-community/opus-mt-da-de is on the hub' }])
})

test('a rate-limited hub call waits as long as the hub asks, within bounds', () => {
  assert.equal(retryAfterSeconds('155'), 155)
  assert.equal(retryAfterSeconds('86400'), 330)
  assert.equal(retryAfterSeconds(null), 60)
  assert.equal(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT'), 60)
})
