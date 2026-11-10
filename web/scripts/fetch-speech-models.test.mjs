import assert from 'node:assert/strict'
import { test } from 'node:test'

import { externalData, manifestOf, parseArgs, planPairs, retryAfterSeconds, treeFiles, voiceFiles } from './fetch-speech-models.mjs'

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

test('an export takes every shard of its external data, in order', () => {
  const tree = new Set(['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data_1', 'onnx/model_q4.onnx_data', 'onnx/model_q4.onnx_data_3', 'onnx/model_q4f16.onnx_data'])

  assert.deepEqual(externalData(tree, 'onnx/model_q4.onnx'), ['onnx/model_q4.onnx_data', 'onnx/model_q4.onnx_data_1'])
  assert.deepEqual(externalData(tree, 'onnx/model_fp16.onnx'), [])
})

test('the translator is TranslateGemma, falling back to m2m100', () => {
  const { mt } = parseArgs(['/srv/models', '--languages=en,de'])

  assert.deepEqual(mt, {
    kind: 'translator',
    model: 'onnx-community/translategemma-text-4b-it-ONNX',
    dtype: 'q4f16',
    fallback: { model: 'Xenova/m2m100_418M', dtype: 'q4f16' },
  })
})

test('an encoder-decoder translator needs no fallback', () => {
  assert.equal(parseArgs(['/srv/models', '--mt-kind=seq2seq']).mt.fallback, null)
})

const REVISION = '0123456789abcdef0123456789abcdef01234567'

test('a model lists its metadata and every export it has, served under its id', () => {
  const listing = [
    { type: 'file', path: 'config.json', size: 2 },
    { type: 'file', path: 'tokenizer.json', size: 30 },
    { type: 'file', path: 'README.md', size: 9 },
    { type: 'directory', path: 'onnx', size: 0 },
    { type: 'file', path: 'onnx/model_q4f16.onnx', size: 400, lfs: { oid: 'ab'.repeat(32), size: 400 } },
    { type: 'file', path: 'onnx/model_q4f16.onnx_data', size: 900, lfs: { oid: 'cd'.repeat(32), size: 900 } },
    { type: 'file', path: 'onnx/model_quantized.onnx', size: 800, lfs: { oid: 'ef'.repeat(32), size: 800 } },
  ]

  const files = treeFiles('owner/model', 'llm', ['q4f16'], REVISION, listing, 'tree')

  assert.deepEqual(files, [
    { path: 'owner/model/config.json', repo: 'owner/model', revision: REVISION, file: 'config.json', size: 2 },
    { path: 'owner/model/tokenizer.json', repo: 'owner/model', revision: REVISION, file: 'tokenizer.json', size: 30 },
    { path: 'owner/model/onnx/model_q4f16.onnx', repo: 'owner/model', revision: REVISION, file: 'onnx/model_q4f16.onnx', size: 400, sha256: 'ab'.repeat(32) },
    { path: 'owner/model/onnx/model_q4f16.onnx_data', repo: 'owner/model', revision: REVISION, file: 'onnx/model_q4f16.onnx_data', size: 900, sha256: 'cd'.repeat(32) },
  ])
})

test('a model without the export asked for is refused by name', () => {
  const listing = [{ type: 'file', path: 'config.json', size: 2 }]

  assert.throws(() => treeFiles('owner/model', 'llm', ['q4'], REVISION, listing, 'tree'), /owner\/model has no onnx\/model_q4\.onnx/)
})

test('a voice is served from piper/ under its own name, with its MD5', () => {
  const voice = {
    key: 'en_US-lessac-medium',
    files: {
      'en/en_US/lessac/medium/en_US-lessac-medium.onnx': { size_bytes: 63, md5_digest: 'aa'.repeat(16) },
      'en/en_US/lessac/medium/en_US-lessac-medium.onnx.json': { size_bytes: 5, md5_digest: 'bb'.repeat(16) },
      'en/en_US/lessac/medium/MODEL_CARD': { size_bytes: 1, md5_digest: 'cc'.repeat(16) },
    },
  }

  assert.deepEqual(voiceFiles(voice).map(({ path, file, size, md5, repo }) => ({ path, file, size, md5, repo })), [
    { path: 'piper/en_US-lessac-medium.onnx', file: 'en/en_US/lessac/medium/en_US-lessac-medium.onnx', size: 63, md5: 'aa'.repeat(16), repo: 'rhasspy/piper-voices' },
    { path: 'piper/en_US-lessac-medium.onnx.json', file: 'en/en_US/lessac/medium/en_US-lessac-medium.onnx.json', size: 5, md5: 'bb'.repeat(16), repo: 'rhasspy/piper-voices' },
  ])
})

test('the manifest lists each file once by the path it is served at, in order', () => {
  const file = (path, size) => ({ path, repo: 'owner/model', revision: REVISION, file: path.slice('owner/model/'.length), size })

  const manifest = manifestOf([file('owner/model/onnx/b.onnx', 2), file('owner/model/config.json', 1), file('owner/model/onnx/b.onnx', 2)])

  assert.deepEqual(Object.keys(manifest), ['owner/model/config.json', 'owner/model/onnx/b.onnx'])
  assert.deepEqual(manifest['owner/model/config.json'], { repo: 'owner/model', revision: REVISION, file: 'config.json', size: 1 })
  assert.throws(() => manifestOf([file('owner/model/config.json', 1), file('owner/model/config.json', 2)]), /listed twice/)
})
