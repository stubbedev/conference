import assert from 'node:assert/strict'
import { test } from 'node:test'

import { lowerLayer, newQualityState, nextQuality, preferredLayer } from './quality.ts'

const clean = { droppedFrames: 0, lostPackets: 0 }
const stalled = { droppedFrames: 3, lostPackets: 0 }
const lossy = { droppedFrames: 0, lostPackets: 25 }

test('a viewer asks for the layer its layout wants', () => {
  assert.equal(preferredLayer('h', newQualityState('h').ceiling), 'h')
  assert.equal(preferredLayer('m', newQualityState('m').ceiling), 'm')
})

test('dropped frames lower the ceiling at once', () => {
  const state = nextQuality(newQualityState('h'), 'h', stalled)
  assert.equal(state.ceiling, 'm')
})

test('lost packets lower it too', () => {
  assert.equal(nextQuality(newQualityState('h'), 'h', lossy).ceiling, 'm')
})

test('trouble never lifts the ceiling above the layout', () => {
  const state = nextQuality(newQualityState('l'), 'l', stalled)
  assert.equal(state.ceiling, 'l')
})

test('a clean stream earns its layer back after a run of samples', () => {
  let state = newQualityState('h')
  state = nextQuality(state, 'h', stalled)
  state = nextQuality(state, 'h', stalled)

  assert.equal(state.ceiling, 'l')

  state = nextQuality(state, 'h', clean)
  state = nextQuality(state, 'h', clean)
  assert.equal(state.ceiling, 'l', 'the ceiling rose before the samples were clean')

  state = nextQuality(state, 'h', clean)
  assert.equal(state.ceiling, 'm')

  state = nextQuality(state, 'h', clean)
  state = nextQuality(state, 'h', clean)
  state = nextQuality(state, 'h', clean)
  assert.equal(state.ceiling, 'h')
})

test('recovery stops at what the layout can use', () => {
  let state = newQualityState('l')
  for (let i = 0; i < 12; i += 1) state = nextQuality(state, 'm', clean)
  assert.equal(state.ceiling, 'm')
})

test('a smaller layout pulls the ceiling down with it', () => {
  const state = nextQuality(newQualityState('h'), 'l', clean)
  assert.equal(state.ceiling, 'l')
  assert.equal(preferredLayer('l', state.ceiling), 'l')
})

test('the lower of two layers wins', () => {
  assert.equal(lowerLayer('h', 'm'), 'm')
  assert.equal(lowerLayer('l', 'h'), 'l')
})

test('a layer lost again right after it came back waits twice as long next time, and a held layer forgives it', () => {
  let state = nextQuality(newQualityState('h'), 'h', stalled)
  const samplesToClimb = () => {
    let samples = 0
    while (state.ceiling !== 'h') {
      state = nextQuality(state, 'h', clean)
      samples += 1
    }
    return samples
  }

  const first = samplesToClimb()
  state = nextQuality(state, 'h', stalled)
  const second = samplesToClimb()
  state = nextQuality(state, 'h', stalled)
  const third = samplesToClimb()
  assert.deepEqual([first, second, third], [3, 6, 12])

  for (let i = 0; i < 30; i += 1) state = nextQuality(state, 'h', clean)
  state = nextQuality(state, 'h', stalled)
  assert.equal(samplesToClimb(), 3)
})
