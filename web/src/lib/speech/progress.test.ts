import assert from 'node:assert/strict'
import { test } from 'node:test'

import { overall, Progress } from './progress.ts'

const MB = 1e6

test('nothing loading shows nothing', () => {
  assert.equal(new Progress().snapshot(), null)
})

test('the total is the announced size, so files a worker starts later do not move it', () => {
  const progress = new Progress()
  progress.begin('transcription')
  progress.expect('transcription', 'whisper', 800 * MB)

  progress.file('transcription', 'whisper/encoder.onnx', 100 * MB, 300 * MB)
  const early = overall(progress.snapshot() ?? [])
  progress.file('transcription', 'whisper/decoder.onnx', 0, 500 * MB)
  progress.file('transcription', 'whisper/tokenizer.json', 0, 2 * MB)
  const later = overall(progress.snapshot() ?? [])

  assert.deepEqual(early, { loaded: 100 * MB, total: 800 * MB })
  assert.deepEqual(later, { loaded: 100 * MB, total: 800 * MB })
})

test('two models of one part add up, so a second one loading does not fill the bar', () => {
  const progress = new Progress()
  progress.expect('translation', 'opus-mt-de-en', 100 * MB)
  progress.file('translation', 'opus-mt-de-en/model.onnx', 100 * MB, 100 * MB)
  progress.expect('translation', 'opus-mt-en-da', 120 * MB)
  progress.file('translation', 'opus-mt-en-da/model.onnx', 20 * MB, 120 * MB)

  assert.deepEqual(overall(progress.snapshot() ?? []), { loaded: 120 * MB, total: 220 * MB })
})

test('a model announced again, as another export, replaces its own size', () => {
  const progress = new Progress()
  progress.begin('translation')
  progress.expect('translation', 'opus-mt-en-de', 300 * MB)
  progress.expect('translation', 'opus-mt-en-de', 100 * MB)

  assert.deepEqual(overall(progress.snapshot() ?? []), { loaded: 0, total: 100 * MB })
})

test('a part loads no more than its total, even when the announced size was short', () => {
  const progress = new Progress()
  progress.begin('voice')
  progress.expect('voice', 'piper/voice', 60 * MB)
  progress.file('voice', 'piper/voice.onnx', 63 * MB, 63 * MB)

  assert.deepEqual(progress.snapshot(), [{ part: 'voice', loaded: 60 * MB, total: 60 * MB, retry: null }])
})

test('a part without an announced size counts what its files report', () => {
  const progress = new Progress()
  progress.begin('runtime')
  progress.file('runtime', '/ort/ort.wasm', 5 * MB, 27 * MB)

  assert.deepEqual(progress.snapshot(), [{ part: 'runtime', loaded: 5 * MB, total: 27 * MB, retry: null }])
})

test('parts are listed in a fixed order, a part that finished shows full while the others still load', () => {
  const progress = new Progress()
  for (const part of ['voice', 'runtime', 'translation'] as const) progress.begin(part)
  progress.expect('translation', 'm2m', 400 * MB)
  progress.expect('voice', 'piper/voice', 60 * MB)
  progress.file('runtime', '/ort/ort.wasm', 27 * MB, 27 * MB)
  progress.end('runtime', true)
  progress.file('voice', 'piper/voice.onnx', 30 * MB, 60 * MB)

  assert.deepEqual(
    progress.snapshot()?.map(({ part, loaded, total }) => [part, loaded, total]),
    [
      ['runtime', 27 * MB, 27 * MB],
      ['translation', 0, 400 * MB],
      ['voice', 30 * MB, 60 * MB],
    ],
  )
})

test('a retry is shown on its part until bytes flow again', () => {
  const progress = new Progress()
  progress.begin('translation')
  progress.file('translation', 'm2m/model.onnx', 10, 100)
  progress.retrying('translation', { attempt: 2, attempts: 5, reason: 'network error' })

  assert.deepEqual(progress.snapshot()?.[0].retry, { attempt: 2, attempts: 5, reason: 'network error' })

  progress.file('translation', 'm2m/model.onnx', 20, 100)
  assert.equal(progress.snapshot()?.[0].retry, null)
})

test('once every load has settled there is nothing left to show', () => {
  const progress = new Progress()
  progress.begin('transcription')
  progress.begin('translation')
  progress.file('translation', 'm2m/model.onnx', 10, 100)
  progress.end('transcription', true)
  assert.notEqual(progress.snapshot(), null)

  progress.end('translation', false)
  assert.equal(progress.snapshot(), null)
})

test('a file that keeps downloading after its load settled still shows until it completes', () => {
  const progress = new Progress()
  progress.file('translation', 'opus/model.onnx', 10, 100)
  assert.notEqual(progress.snapshot(), null)

  progress.file('translation', 'opus/model.onnx', 100, 100)
  assert.equal(progress.snapshot(), null)
})
