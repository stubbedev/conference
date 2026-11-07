import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dtypeFor, fallbackToWasm, message, needsHalves, withoutHalves } from './runtime.ts'

test('WebAssembly loads the 8-bit export', () => {
  assert.equal(dtypeFor('wasm', 'q4f16'), 'q8')
  assert.equal(dtypeFor('wasm', 'q8'), 'q8')
})

test('a GPU loads the export the server chose', () => {
  assert.equal(dtypeFor('webgpu', 'q4f16'), 'q4f16')
})

test('a device that cannot run the export is a fallback', () => {
  assert.equal(fallbackToWasm(new Error('Unsupported device: webgpu')), true)
  assert.equal(fallbackToWasm(new Error('model does not support fp16')), true)
})

test('any other failure is not a fallback', () => {
  assert.equal(fallbackToWasm(new Error('no such file: encoder_model_q8.onnx')), false)
  assert.equal(fallbackToWasm('out of memory'), false)
})

test('a failure reads as its message', () => {
  assert.equal(message(new Error('bad model')), 'bad model')
  assert.equal(message('bad model'), 'bad model')
})

test('a GPU without 16-bit floats loads the same export without them', () => {
  assert.equal(withoutHalves('q4f16'), 'q4')
  assert.equal(withoutHalves('fp16'), 'fp32')
  assert.equal(withoutHalves('q4'), 'q4')
})

test('only an export with 16-bit floats needs a GPU that has them', () => {
  assert.equal(needsHalves('q4f16'), true)
  assert.equal(needsHalves('fp16'), true)
  assert.equal(needsHalves('q4'), false)
  assert.equal(needsHalves('q8'), false)
})
