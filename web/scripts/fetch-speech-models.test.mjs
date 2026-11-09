import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseArgs, planPairs } from './fetch-speech-models.mjs'

function hub(models) {
  const asked = []
  const lookup = async (model) => {
    asked.push(model)
    return models[model] ?? null
  }

  return { asked, lookup }
}

const exported = (base) => ({ cardData: { base_model: base, library_name: 'transformers.js' } })

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

test('a pair takes the first owner with an export and the license of its base model', async () => {
  const { lookup } = hub({
    'Xenova/opus-mt-en-de': exported('Helsinki-NLP/opus-mt-en-de'),
    'Helsinki-NLP/opus-mt-en-de': { cardData: { license: 'cc-by-4.0' } },
    'onnx-community/opus-mt-de-en': { cardData: { license: 'apache-2.0' } },
  })

  const { found, skipped } = await planPairs(['en', 'de'], lookup)

  assert.deepEqual(found, [
    { pair: 'en-de', model: 'Xenova/opus-mt-en-de', license: 'cc-by-4.0', card: 'Helsinki-NLP/opus-mt-en-de' },
    { pair: 'de-en', model: 'onnx-community/opus-mt-de-en', license: 'apache-2.0', card: 'onnx-community/opus-mt-de-en' },
  ])
  assert.deepEqual(skipped, [])
})

test('a pair without an export is skipped by name, in a stable order', async () => {
  const { asked, lookup } = hub({
    'Xenova/opus-mt-de-da': exported('Helsinki-NLP/opus-mt-de-da'),
    'Helsinki-NLP/opus-mt-de-da': { cardData: { license: 'apache-2.0' } },
  })

  const { found, skipped } = await planPairs(['de', 'da'], lookup)

  assert.deepEqual(found.map((entry) => entry.pair), ['de-da'])
  assert.deepEqual(skipped, [{ pair: 'da-de', reason: 'none of Xenova/opus-mt-da-de, onnx-community/opus-mt-da-de is on the hub' }])
  assert.deepEqual(asked, ['Xenova/opus-mt-de-da', 'Helsinki-NLP/opus-mt-de-da', 'Xenova/opus-mt-da-de', 'onnx-community/opus-mt-da-de'])
})

test('a pair whose license is missing or unexpected fails the run', async () => {
  await assert.rejects(
    planPairs(['en', 'de'], hub({ 'Xenova/opus-mt-en-de': { cardData: {} } }).lookup),
    /Xenova\/opus-mt-en-de names no license on its model card and no base model/,
  )
  await assert.rejects(
    planPairs(['en', 'de'], hub({ 'Xenova/opus-mt-en-de': exported('Helsinki-NLP/opus-mt-en-de') }).lookup),
    /names Helsinki-NLP\/opus-mt-en-de as its base model, which the hub does not have/,
  )
  await assert.rejects(
    planPairs(['en', 'de'], hub({ 'Xenova/opus-mt-en-de': { cardData: { license: 'cc-by-nc-4.0' } } }).lookup),
    /names the license "cc-by-nc-4.0", not cc-by-4.0 or apache-2.0/,
  )
  await assert.rejects(
    planPairs(
      ['en', 'de'],
      hub({ 'Xenova/opus-mt-en-de': exported('Helsinki-NLP/opus-mt-en-de'), 'Helsinki-NLP/opus-mt-en-de': { cardData: {} } }).lookup,
    ),
    /Helsinki-NLP\/opus-mt-en-de, the model card of Xenova\/opus-mt-en-de, names the license null/,
  )
})
