import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isSpeaking, nextLevel } from './speaking.ts'

const rise = (frames: number): number => {
  let level = 0
  for (let i = 0; i < frames; i += 1) level = nextLevel(level, 0.5)
  return level
}

const fall = (level: number, frames: number): number => {
  for (let i = 0; i < frames; i += 1) level = nextLevel(level, 0)
  return level
}

test('a loud frame is heard as speaking within a sample or two', () => {
  assert.equal(isSpeaking(rise(1)), true)
})

test('quiet frames bring the level back down', () => {
  assert.equal(isSpeaking(fall(rise(3), 6)), false)
})

test('the level never leaves 0..1', () => {
  let level = 0
  for (let i = 0; i < 50; i += 1) level = nextLevel(level, 1)
  assert.ok(level <= 1, `level ${level} above 1`)
  assert.ok(fall(level, 50) >= 0)
})

test('a voice that keeps talking stays speaking between syllables', () => {
  let level = rise(2)
  for (let i = 0; i < 4; i += 1) {
    level = nextLevel(level, 0)
    level = nextLevel(level, 0.4)
  }
  assert.equal(isSpeaking(level), true)
})

test('the level falls away so the ring does not stick', () => {
  assert.ok(fall(rise(3), 1) < rise(3), 'the level did not fall after a quiet frame')
})
