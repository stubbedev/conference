import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loudness } from './energy.ts'
import { FRAME } from './vad.ts'

const frame = (dbfs: number): Int16Array => {
  const peak = 0x8000 * 10 ** (dbfs / 20)
  const samples = new Int16Array(FRAME)
  for (let i = 0; i < FRAME; i++) samples[i] = Math.round(peak * Math.sin((2 * Math.PI * 440 * i) / FRAME))
  return samples
}

test('a loud frame is speech', () => {
  assert.equal(loudness(frame(-20)), 1)
})

test('a quiet frame is not', () => {
  assert.equal(loudness(frame(-90)), 0)
  assert.equal(loudness(new Int16Array(FRAME)), 0)
})

test('a frame between the gate levels is somewhere in between', () => {
  const probability = loudness(frame(-48))
  assert.ok(probability > 0 && probability < 1, `probability ${probability}`)
})
