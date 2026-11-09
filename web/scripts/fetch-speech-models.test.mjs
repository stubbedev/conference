import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseArgs, planPairs } from './fetch-speech-models.mjs'

function hub(models) {
  const asked = []
  const exists = async (model) => {
    asked.push(model)
    return models.includes(model)
  }

  return { asked, exists }
}

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

test('Portuguese into English uses the Romance model when it has no pair of its own', async () => {
  const { exists } = hub(['Xenova/opus-mt-ROMANCE-en'])

  const { found } = await planPairs(['pt', 'en'], exists)

  assert.deepEqual(found, [{ pair: 'pt-en', model: 'Xenova/opus-mt-ROMANCE-en' }])
})

test('a pair of its own wins over the Romance model', async () => {
  const { exists } = hub(['Xenova/opus-mt-pt-en', 'Xenova/opus-mt-ROMANCE-en'])

  const { found } = await planPairs(['pt', 'en'], exists)

  assert.deepEqual(found, [{ pair: 'pt-en', model: 'Xenova/opus-mt-pt-en' }])
})

test('the Romance model only translates into English', async () => {
  const { exists } = hub(['Xenova/opus-mt-ROMANCE-en'])

  const { found } = await planPairs(['pt', 'de'], exists)

  assert.deepEqual(found, [])
})

test('a pair takes the first owner with an export', async () => {
  const { exists } = hub(['Xenova/opus-mt-en-de', 'onnx-community/opus-mt-de-en'])

  const { found, skipped } = await planPairs(['en', 'de'], exists)

  assert.deepEqual(found, [
    { pair: 'en-de', model: 'Xenova/opus-mt-en-de' },
    { pair: 'de-en', model: 'onnx-community/opus-mt-de-en' },
  ])
  assert.deepEqual(skipped, [])
})

test('a pair without an export is skipped by name, in a stable order', async () => {
  const { asked, exists } = hub(['Xenova/opus-mt-de-da'])

  const { found, skipped } = await planPairs(['de', 'da'], exists)

  assert.deepEqual(found.map((entry) => entry.pair), ['de-da'])
  assert.deepEqual(skipped, [{ pair: 'da-de', reason: 'none of Xenova/opus-mt-da-de, onnx-community/opus-mt-da-de is on the hub' }])
  assert.deepEqual(asked, ['Xenova/opus-mt-de-da', 'Xenova/opus-mt-da-de', 'onnx-community/opus-mt-da-de'])
})
