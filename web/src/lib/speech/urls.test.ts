import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelURL } from './urls.ts'

test('a file is joined under the base path', () => {
  assert.equal(modelURL('/speech/', 'silero_vad.onnx'), '/speech/silero_vad.onnx')
})

test('a base without a trailing slash still joins with one slash', () => {
  assert.equal(modelURL('/speech', 'piper', 'da_DK-talesyntese-medium.onnx'), '/speech/piper/da_DK-talesyntese-medium.onnx')
})

test('the base path is kept as it is written', () => {
  assert.equal(modelURL('https://models.example/speech/', 'onnx/encoder_model_q8.onnx'), 'https://models.example/speech/onnx/encoder_model_q8.onnx')
})

test('slashes in the parts do not double up', () => {
  assert.equal(modelURL('/speech', '/piper/', '/voice.onnx.json'), '/speech/piper/voice.onnx.json')
})
