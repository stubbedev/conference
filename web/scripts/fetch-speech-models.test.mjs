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

test('no pairs unless pair languages are named', () => {
  assert.equal(parseArgs(['/srv/models', '--languages=en,de']).pairs, null)
})

test('the old pairs flag and an empty pair list are refused', () => {
  assert.throws(() => parseArgs(['/srv/models', '--pairs']), /pairs is not an option/)
  assert.throws(() => parseArgs(['/srv/models', '--pair-languages=,']), /--pair-languages names no language/)
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
