import assert from 'node:assert/strict'
import { test } from 'node:test'

import { refinedAlpha, type EdgeInput, type Rgb } from './edge.ts'

const SIZE = 8
const BRIGHT: Rgb = [0.9, 0.8, 0.7]
const DARK: Rgb = [0.1, 0.15, 0.2]

function scene(personColumns: number, brightColumns: number): EdgeInput {
  const mask = new Float32Array(SIZE * SIZE)
  const guide = new Float32Array(SIZE * SIZE * 3)
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const at = y * SIZE + x
      mask[at] = x < personColumns ? 1 : 0
      guide.set(x < brightColumns ? BRIGHT : DARK, at * 3)
    }
  }
  return { mask, guide, width: SIZE, height: SIZE }
}

test('inside the person and inside the room the answer is certain', () => {
  const input = scene(4, 4)
  assert.equal(refinedAlpha(input, BRIGHT, 1, 4), 1)
  assert.equal(refinedAlpha(input, DARK, 6, 4), 0)
})

test('on the boundary between mask pixels, a pixel that looks like the person stays sharp', () => {
  const input = scene(4, 4)
  assert.ok(refinedAlpha(input, BRIGHT, 3.4, 4) > 0.95)
  assert.ok(refinedAlpha(input, BRIGHT, 3.6, 4) > 0.95)
})

test('on the boundary between mask pixels, a pixel that looks like the room stays blurred', () => {
  const input = scene(4, 4)
  assert.ok(refinedAlpha(input, DARK, 3.4, 4) < 0.05)
  assert.ok(refinedAlpha(input, DARK, 3.6, 4) < 0.05)
})

test('without an edge in the picture the mask is followed smoothly', () => {
  const mask = new Float32Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < 4; x += 1) mask[y * SIZE + x] = 1
  const flat = { mask, guide: new Float32Array(SIZE * SIZE * 3).fill(0.5), width: SIZE, height: SIZE }
  const grey: Rgb = [0.5, 0.5, 0.5]
  const across = [2, 3, 3.5, 4, 5].map((x) => refinedAlpha(flat, grey, x, 4))
  for (let i = 1; i < across.length; i += 1) assert.ok(across[i] <= across[i - 1])
  assert.equal(across[0], 1)
  assert.equal(across.at(-1), 0)
  assert.ok(across[2] > 0 && across[2] < 1)
})

test('the mask border is read as if the picture continued past it', () => {
  const input = scene(SIZE, SIZE)
  assert.equal(refinedAlpha(input, BRIGHT, 0, 0), 1)
  assert.equal(refinedAlpha(input, BRIGHT, SIZE - 1, SIZE - 1), 1)
})
