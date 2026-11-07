import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toFloat32, withContext } from './pcm.ts'

test('full scale is one and its negative end is minus one', () => {
  assert.deepEqual(Array.from(toFloat32(Int16Array.from([0x7fff, -0x8000]))), [32767 / 32768, -1])
})

test('silence is silent, and the length is kept', () => {
  const audio = toFloat32(new Int16Array(4))
  assert.equal(audio.length, 4)
  assert.deepEqual(Array.from(audio), [0, 0, 0, 0])
})

test('every sample is scaled the same way', () => {
  const audio = toFloat32(Int16Array.from([16384, -16384, 8192]))
  assert.deepEqual(Array.from(audio), [0.5, -0.5, 0.25])
})

// A voice detection model reads a frame together with the tail of the one
// before it, and without that tail speech scores as noise.
test('a frame is preceded by the context it is read in', () => {
  const input = withContext(Float32Array.from([1, 2]), Float32Array.from([3, 4, 5]))
  assert.deepEqual(Array.from(input), [1, 2, 3, 4, 5])
})

test('a model that asks for no context gets the frame alone', () => {
  const input = withContext(new Float32Array(0), Float32Array.from([3, 4]))
  assert.deepEqual(Array.from(input), [3, 4])
})
