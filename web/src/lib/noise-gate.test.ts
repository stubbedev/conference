import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GATE_CLOSE_DBFS, GATE_OPEN_DBFS, NoiseGate } from './noise-gate.ts'

const SAMPLE_RATE = 48_000
const RENDER_QUANTUM = 128

const amplitude = (dbfs: number): number => 10 ** (dbfs / 20)

function noise(dbfs: number, seconds: number, seed = 1): Float32Array {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  const peak = amplitude(dbfs)
  let state = seed
  for (let i = 0; i < samples.length; i++) {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31
    samples[i] = (state / 2 ** 30 - 1) * peak
  }
  return samples
}

function tone(dbfs: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  const peak = amplitude(dbfs)
  for (let i = 0; i < samples.length; i++) samples[i] = peak * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)
  return samples
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function render(input: Float32Array): Float32Array {
  const gate = new NoiseGate(SAMPLE_RATE)
  const output = new Float32Array(input.length)
  for (let start = 0; start < input.length; start += RENDER_QUANTUM) {
    const end = Math.min(start + RENDER_QUANTUM, input.length)
    gate.process([input.subarray(start, end)], [output.subarray(start, end)])
  }
  return output
}

function peakBetween(samples: Float32Array, fromSeconds: number, toSeconds: number): number {
  let peak = 0
  const end = Math.round(toSeconds * SAMPLE_RATE)
  for (let i = Math.round(fromSeconds * SAMPLE_RATE); i < end; i++) peak = Math.max(peak, Math.abs(samples[i]))
  return peak
}

test('silences a steady noise floor below the threshold', () => {
  const output = render(noise(GATE_CLOSE_DBFS - 8, 2))
  assert.equal(peakBetween(output, 0, 2), 0)
})

test('passes speech-level audio after the attack', () => {
  const input = tone(-20, 1)
  const output = render(input)
  assert.ok(Math.abs(peakBetween(output, 0.1, 1) - peakBetween(input, 0.1, 1)) < 1e-3)
})

test('closes again once speech stops and only the noise floor remains', () => {
  const output = render(concat(tone(-20, 0.5), noise(GATE_CLOSE_DBFS - 8, 2)))
  assert.ok(peakBetween(output, 0.5, 0.65) > amplitude(GATE_CLOSE_DBFS - 10))
  assert.ok(peakBetween(output, 2, 2.5) < amplitude(-100))
})

test('stays open for quiet trailing speech between the close and open levels', () => {
  const between = (GATE_OPEN_DBFS + GATE_CLOSE_DBFS) / 2
  const input = concat(tone(-20, 0.5), tone(between, 1))
  const output = render(input)
  assert.ok(Math.abs(peakBetween(output, 1, 1.5) - peakBetween(input, 1, 1.5)) < 1e-4)
})

test('does not open for noise that only starts below the open level', () => {
  const between = (GATE_OPEN_DBFS + GATE_CLOSE_DBFS) / 2
  const output = render(tone(between, 1))
  assert.equal(peakBetween(output, 0, 1), 0)
})

test('rejects a sample rate that cannot drive the timings', () => {
  assert.throws(() => new NoiseGate(0), RangeError)
})
