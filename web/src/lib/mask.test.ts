import assert from 'node:assert/strict'
import { test } from 'node:test'

import { maskAlpha, MASK_HIGH, MASK_LOW, segmentEvery, writeMaskAlpha } from './mask.ts'

test('a certain background pixel is transparent', () => {
  const bytes = maskAlpha([0, 0.1])
  assert.equal(bytes[3], 0)
  assert.equal(bytes[7], 0)
})

test('a certain person pixel is opaque white', () => {
  const bytes = maskAlpha([1])
  assert.deepEqual([...bytes], [255, 255, 255, 255])
})

test('the edge ramps between background and person', () => {
  const middle = (MASK_LOW + MASK_HIGH) / 2
  const bytes = maskAlpha([MASK_LOW, middle, MASK_HIGH])

  assert.equal(bytes[3], 0)
  assert.equal(bytes[7], 128)
  assert.equal(bytes[11], 255)
})

test('the ramp never goes backwards', () => {
  const bytes = maskAlpha([0, 0.2, 0.4, 0.6, 0.8, 1])
  const alphas = [3, 7, 11, 15, 19, 23].map((at) => bytes[at])

  for (let index = 1; index < alphas.length; index += 1) {
    assert.ok(alphas[index] >= alphas[index - 1], `alpha fell from ${alphas[index - 1]} to ${alphas[index]}`)
  }
})

test('every pixel gets four bytes', () => {
  assert.equal(maskAlpha(new Float32Array(256 * 144)).length, 256 * 144 * 4)
})

test('the model is asked less often than frames are drawn', () => {
  assert.equal(segmentEvery(30, 15), 2)
  assert.equal(segmentEvery(30, 30), 1)
  assert.equal(segmentEvery(30, 60), 1)
  assert.equal(segmentEvery(30, 0), Number.MAX_SAFE_INTEGER)
})

test('the mask can be written into a buffer that is used again', () => {
  const out = new Uint8ClampedArray(2 * 4).fill(7)
  writeMaskAlpha([1, 0], out)

  assert.deepEqual([...out], [255, 255, 255, 255, 255, 255, 255, 0])
})
