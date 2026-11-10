import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DownloadFailed, fallbackToWasm, firstThatRuns, message, needsHalves, rungsFor, type Capabilities, type Rung } from './runtime.ts'

const FULL: Capabilities = { gpu: true, halves: true }
const NO_HALVES: Capabilities = { gpu: true, halves: false }
const NO_GPU: Capabilities = { gpu: false, halves: false }

const hosting = (...dtypes: string[]) => (dtype: string) => dtypes.includes(dtype)
const ALL = hosting('q4f16', 'q4', 'fp16', 'fp32', 'q8')
const onGpu = (dtype: string): Rung => ({ device: 'webgpu', dtype })
const ON_CPU: Rung = { device: 'wasm', dtype: 'q8' }

test('a GPU with 16-bit floats tries every hosted export on the GPU before the CPU', () => {
  assert.deepEqual(rungsFor('q4f16', FULL, ALL, true), [onGpu('q4f16'), onGpu('q4'), onGpu('fp16'), onGpu('fp32'), ON_CPU])
})

test('a GPU without 16-bit floats skips only the exports that need them', () => {
  assert.deepEqual(rungsFor('q4f16', NO_HALVES, ALL, true), [onGpu('q4'), onGpu('fp32'), ON_CPU])
})

test('the export the server chose is tried first', () => {
  assert.deepEqual(rungsFor('fp32', FULL, ALL, true)[0], onGpu('fp32'))
})

test('an export the server does not host is never tried', () => {
  assert.deepEqual(rungsFor('q4f16', NO_HALVES, hosting('q4f16', 'q8'), true), [ON_CPU])
  assert.deepEqual(rungsFor('q4f16', FULL, hosting('q4f16', 'fp32'), true), [onGpu('q4f16'), onGpu('fp32')])
})

test('without a GPU only the CPU remains', () => {
  assert.deepEqual(rungsFor('q4f16', NO_GPU, ALL, true), [ON_CPU])
})

test('a model that cannot run on the CPU has no CPU rung', () => {
  assert.deepEqual(rungsFor('q4f16', NO_HALVES, ALL, false), [onGpu('q4'), onGpu('fp32')])
  assert.deepEqual(rungsFor('q4f16', NO_GPU, ALL, false), [])
})

test('the climb stops at the first rung that runs and names those that did not', async () => {
  const refused: string[] = []
  const result = await firstThatRuns(
    [onGpu('q4f16'), onGpu('q4'), onGpu('fp32')],
    async (rung) => {
      if (rung.dtype === 'q4f16') throw new Error('no such operator')
      return `running ${rung.dtype}`
    },
    (rung) => refused.push(rung.dtype),
  )
  assert.equal(result, 'running q4')
  assert.deepEqual(refused, ['q4f16'])
})

test('when every rung fails the last failure is what comes out', async () => {
  await assert.rejects(
    firstThatRuns(
      [onGpu('a'), onGpu('b')],
      (rung) => Promise.reject(new Error(`${rung.dtype} failed`)),
      () => {},
    ),
    /b failed/,
  )
})

test('no rung at all is a failure that says so', async () => {
  await assert.rejects(
    firstThatRuns(
      [],
      () => Promise.resolve(),
      () => {},
    ),
    /none of the exports/,
  )
})

test('a failed download stops the climb, since another export would fail the same way', async () => {
  const attempted: string[] = []
  await assert.rejects(
    firstThatRuns(
      [onGpu('a'), onGpu('b')],
      (rung) => {
        attempted.push(rung.dtype)
        return Promise.reject(new DownloadFailed(new Error('fetching encoder failed: 503')))
      },
      () => assert.fail('a failed download is not a refused rung'),
    ),
    /503/,
  )
  assert.deepEqual(attempted, ['a'])
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

test('only an export with 16-bit floats needs a GPU that has them', () => {
  assert.equal(needsHalves('q4f16'), true)
  assert.equal(needsHalves('fp16'), true)
  assert.equal(needsHalves('q4'), false)
  assert.equal(needsHalves('q8'), false)
})
