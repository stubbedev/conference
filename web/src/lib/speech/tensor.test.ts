import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixed, known, size } from './tensor.ts'

test('a shape holds as many values as its dimensions multiply to', () => {
  assert.equal(size([1, 12]), 12)
  assert.equal(size([2, 1, 128]), 256)
  assert.equal(size([]), 1)
  assert.equal(size(undefined), 1)
})

test('a dimension the model left open still counts as one', () => {
  assert.equal(size([1, 0]), 1)
  assert.equal(size([1, -1]), 1)
  assert.equal(size([2, -1, 128]), 256)
})

// ONNX Runtime Web reports an open dimension as the unsigned -1, which
// multiplied into a shape asks for a tensor of four billion values.
test('a dimension read as unsigned -1 counts as one', () => {
  assert.equal(known(4294967295), false)
  assert.equal(size([2, 4294967295, 128]), 256)
})

test('a real dimension is known, and a string is not', () => {
  assert.equal(known(128), true)
  assert.equal(known(0), false)
  assert.equal(known(''), false)
})

test('a value is repeated as many times as it is asked for', () => {
  assert.deepEqual(Array.from(fixed(3, 16000)), [16000n, 16000n, 16000n])
  assert.equal(fixed(1, 0).length, 1)
})
