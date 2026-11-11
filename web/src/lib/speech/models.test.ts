import assert from 'node:assert/strict'
import { test } from 'node:test'

import { asrExport, asrRungs, bytesFor, exportKey, hostedIn, loadsUpFront, mtRoute, renderPrompt, sharedRun, type AsrChoice, type Export, type MtChoice, type SharedRun, type SpeechModels } from './models.ts'

const models: SpeechModels = {
  base: '/speech/',
  asr: {
    model: 'onnx-community/whisper-large-v3-turbo',
    dtype: 'q4f16',
    languages: { da: 'owner/danish' },
    fallback: { model: 'onnx-community/whisper-base', dtype: 'q4', languages: { en: 'onnx-community/moonshine-base-ONNX' } },
  },
  mt: { kind: 'llm', model: 'onnx-community/Qwen3-1.7B-ONNX', dtype: 'q4f16', pairs: { 'en-de': { model: 'Xenova/opus-mt-en-de', dtype: 'q4f16' } } },
  voices: { en: 'en_US-joe-medium' },
  sizes: {
    'onnx-community/whisper-large-v3-turbo:q4f16': 500,
    'owner/danish:q4f16': 400,
    'onnx-community/Qwen3-1.7B-ONNX:q4f16': 1400,
    'piper/en_US-joe-medium': 60,
  },
  prompt: {
    task: 'You translate spoken {source} into natural spoken {target}.',
    address: { de: ' Always "Sie".' },
    glossary: ' Use these term translations: Kontainer = Kontainer.',
    earlier: ' Earlier sentences, for context only: ',
    sentences: 2,
  },
}

test('a language loads its own model where it has one, at either tier', () => {
  assert.deepEqual(asrExport(models.asr, 'primary', 'da'), { model: 'owner/danish', dtype: 'q4f16' })
  assert.deepEqual(asrExport(models.asr, 'primary', 'de'), { model: 'onnx-community/whisper-large-v3-turbo', dtype: 'q4f16' })
  assert.deepEqual(asrExport(models.asr, 'fallback', 'en'), { model: 'onnx-community/moonshine-base-ONNX', dtype: 'q4' })
  assert.deepEqual(asrExport(models.asr, 'fallback', 'de'), { model: 'onnx-community/whisper-base', dtype: 'q4' })
  assert.equal(asrExport({ model: 'a/b', dtype: 'q4' }, 'fallback', 'de'), null)
})

const opus = (pair: string): Export => ({ model: `Xenova/opus-mt-${pair}`, dtype: 'q4' })
const pairs = Object.fromEntries(['en-de', 'de-en', 'en-da', 'da-en', 'da-de', 'fr-de'].map((pair) => [pair, opus(pair)]))
const SHARED_RUNS: readonly SharedRun[] = ['seq2seq', 'generative', 'untried', 'none']

const gemma: MtChoice = { kind: 'translator', model: 'google/translategemma', dtype: 'q4', fallback: { model: 'Xenova/m2m100_418M', dtype: 'q4' }, pairs }
const gemmaSizes = { 'google/translategemma:q4': 1, 'Xenova/m2m100_418M:q4': 1, 'Xenova/m2m100_418M:q8': 1 }
const GPU = { gpu: true, halves: false }
const CPU = { gpu: false, halves: false }

test('a translator only the GPU runs leaves m2m100 to run on a browser without one, decided without loading either', () => {
  assert.equal(sharedRun(gemma, CPU, gemmaSizes, null), 'seq2seq')
  assert.equal(sharedRun({ ...gemma, fallback: undefined }, CPU, gemmaSizes, null), 'none')
})

test('a translator a GPU may run is untried until it has loaded or fallen back', () => {
  assert.equal(sharedRun(gemma, GPU, gemmaSizes, null), 'untried')
  assert.equal(sharedRun(gemma, GPU, gemmaSizes, 'translator'), 'generative')
  assert.equal(sharedRun(gemma, GPU, gemmaSizes, 'seq2seq'), 'seq2seq')
})

test('an encoder-decoder shared model is what runs, and a language model that loaded is generative', () => {
  assert.equal(sharedRun({ ...gemma, kind: 'seq2seq', model: 'Xenova/m2m100_418M' }, GPU, gemmaSizes, null), 'seq2seq')
  assert.equal(sharedRun({ ...gemma, kind: 'llm' }, GPU, gemmaSizes, 'llm'), 'generative')
})

test('a pair with a model of its own translates with it, looked up source first, whatever the shared model', () => {
  for (const shared of SHARED_RUNS) {
    assert.deepEqual(mtRoute(pairs, shared, 'en', 'de'), { kind: 'pair', pair: opus('en-de') })
    assert.deepEqual(mtRoute(pairs, shared, 'da', 'de'), { kind: 'pair', pair: opus('da-de') })
  }
})

test('instead of m2m100, a pair without a model of its own goes through English when both legs have one', () => {
  assert.deepEqual(mtRoute(pairs, 'seq2seq', 'de', 'da'), { kind: 'pivot', via: 'en', into: opus('de-en'), out: opus('en-da') })
  assert.deepEqual(mtRoute(pairs, 'none', 'de', 'da'), { kind: 'pivot', via: 'en', into: opus('de-en'), out: opus('en-da') })
})

test('the default translator manifest goes through English on a browser without a GPU', () => {
  assert.equal(mtRoute(gemma.pairs ?? {}, sharedRun(gemma, CPU, gemmaSizes, null), 'de', 'da').kind, 'pivot')
})

test('a translator or language model that runs translates a pair without a model of its own itself', () => {
  assert.deepEqual(mtRoute(pairs, 'generative', 'de', 'da'), { kind: 'shared' })
  assert.deepEqual(mtRoute(gemma.pairs ?? {}, sharedRun(gemma, GPU, gemmaSizes, 'translator'), 'de', 'da'), { kind: 'shared' })
  assert.deepEqual(mtRoute(pairs, sharedRun({ ...gemma, kind: 'llm' }, GPU, gemmaSizes, 'llm'), 'de', 'da'), { kind: 'shared' })
})

test('a shared model not yet tried is settled before a pair that could go through English is routed', () => {
  assert.deepEqual(mtRoute(pairs, 'untried', 'de', 'da'), { kind: 'settle-shared' })
})

test('a pair with a leg missing is left to the shared model, which need not be settled for it', () => {
  for (const shared of SHARED_RUNS) {
    assert.deepEqual(mtRoute(pairs, shared, 'fr', 'da'), { kind: 'shared' })
    assert.deepEqual(mtRoute(pairs, shared, 'de', 'fr'), { kind: 'shared' })
    assert.deepEqual(mtRoute({}, shared, 'de', 'da'), { kind: 'shared' })
  }
})

test('English itself has no route through English', () => {
  assert.deepEqual(mtRoute(pairs, 'seq2seq', 'en', 'fr'), { kind: 'shared' })
  assert.deepEqual(mtRoute(pairs, 'seq2seq', 'fr', 'en'), { kind: 'shared' })
})

test('what a member downloads is their transcription model, the translation model and their voice', () => {
  assert.equal(bytesFor(models, 'en'), 500 + 1400 + 60)
  assert.equal(bytesFor(models, 'da'), 400 + 1400)
})

test('an encoder-decoder model with pairs is not part of what a member downloads up front', () => {
  const paired = { ...models, mt: { kind: 'seq2seq' as const, model: 'Xenova/m2m100_418M', dtype: 'q4f16', pairs: { 'en-de': { model: 'Xenova/opus-mt-en-de', dtype: 'q4f16' } } } }
  assert.equal(loadsUpFront(paired.mt), false)
  assert.equal(bytesFor(paired, 'en'), 500 + 60)
})

test('a shared model with no pairs, and a language model, load up front', () => {
  assert.equal(loadsUpFront({ kind: 'seq2seq', model: 'a/b', dtype: 'q4' }), true)
  assert.equal(loadsUpFront({ kind: 'llm', model: 'a/b', dtype: 'q4', pairs: { 'en-de': { model: 'c/d', dtype: 'q4' } } }), true)
})

test('what is hosted comes from the sizes the server reports', () => {
  const hosted = hostedIn({ 'a/b:q4': 1 }, 'a/b')
  assert.equal(hosted('q4'), true)
  assert.equal(hosted('fp32'), false)
})

const ladderChoice: AsrChoice = { model: 'big/whisper', dtype: 'q4f16', fallback: { model: 'small/whisper', dtype: 'q4' } }
const ladderSizes = { 'big/whisper:q4f16': 1, 'big/whisper:q4': 1, 'small/whisper:q4': 1, 'small/whisper:q8': 1 }

test('transcription stays on the GPU through both models before the CPU', () => {
  const rungs = asrRungs(ladderChoice, 'de', { gpu: true, halves: false }, ladderSizes, 'primary')
  assert.deepEqual(
    rungs.map((rung) => `${rung.device} ${rung.model} ${rung.dtype} ${rung.tier}`),
    ['webgpu big/whisper q4 primary', 'webgpu small/whisper q4 fallback', 'wasm small/whisper q8 fallback'],
  )
})

test('stepping down to the smaller model leaves the larger one behind', () => {
  const rungs = asrRungs(ladderChoice, 'de', { gpu: true, halves: true }, ladderSizes, 'fallback')
  assert.deepEqual([...new Set(rungs.map((rung) => rung.model))], ['small/whisper'])
})

test('without a smaller model the CPU runs the larger one', () => {
  const rungs = asrRungs({ model: 'big/whisper', dtype: 'q4' }, 'de', { gpu: false, halves: false }, { 'big/whisper:q4': 1, 'big/whisper:q8': 1 }, 'primary')
  assert.deepEqual(rungs, [{ device: 'wasm', dtype: 'q8', model: 'big/whisper', tier: 'primary' }])
})

test('the prompt is put together exactly as the server puts it together', () => {
  const en = { code: 'en', name: 'English' }
  const de = { code: 'de', name: 'German' }
  const prompt = models.prompt
  assert.ok(prompt)
  assert.equal(
    renderPrompt(prompt, en, de, ['one.', 'two.', 'three.']),
    'You translate spoken English into natural spoken German. Always "Sie". Use these term translations: Kontainer = Kontainer.' +
      ' Earlier sentences, for context only: two. three.',
  )
  assert.equal(renderPrompt(prompt, de, en, []), 'You translate spoken German into natural spoken English. Use these term translations: Kontainer = Kontainer.')
})

test('an export is named by its model and dtype, as the server names it in sizes', () => {
  assert.equal(exportKey({ model: 'Xenova/m2m100_418M', dtype: 'q8' }), 'Xenova/m2m100_418M:q8')
})
