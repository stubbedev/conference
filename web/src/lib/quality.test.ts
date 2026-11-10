import assert from 'node:assert/strict'
import { test } from 'node:test'

import { countsSince, lowerLayer, newQualityState, nextQuality, preferredLayer } from './quality.ts'

const clean = { droppedFrames: 0, decodedFrames: 60, lostPackets: 0, receivedPackets: 400 }
const stalled = { droppedFrames: 10, decodedFrames: 50, lostPackets: 0, receivedPackets: 400 }
const lossy = { droppedFrames: 0, decodedFrames: 60, lostPackets: 40, receivedPackets: 400 }

test('a viewer asks for the layer its layout wants', () => {
  assert.equal(preferredLayer('h', newQualityState().ceiling), 'h')
  assert.equal(preferredLayer('m', newQualityState().ceiling), 'm')
})

test('dropped frames lower the ceiling at once', () => {
  const state = nextQuality(newQualityState(), 'h', stalled)
  assert.equal(state.ceiling, 'm')
})

test('lost packets lower it too', () => {
  assert.equal(nextQuality(newQualityState(), 'h', lossy).ceiling, 'm')
})

test('trouble never lifts the ceiling above the layout', () => {
  const state = nextQuality(newQualityState(), 'l', stalled)
  assert.equal(state.ceiling, 'l')
})

test('a clean stream earns its layer back after a run of samples', () => {
  let state = newQualityState()
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
  let state = nextQuality(nextQuality(newQualityState(), 'h', stalled), 'h', stalled)
  assert.equal(state.ceiling, 'l')
  for (let i = 0; i < 12; i += 1) state = nextQuality(state, 'm', clean)
  assert.equal(state.ceiling, 'm')
})

test('a tile that shrinks and grows again gets its layer back at once', () => {
  let state = newQualityState()
  for (let i = 0; i < 6; i += 1) state = nextQuality(state, 'l', clean)
  assert.equal(preferredLayer('l', state.ceiling), 'l')
  assert.equal(preferredLayer('h', state.ceiling), 'h')
})

test('a stream first seen as a thumbnail can be enlarged at once', () => {
  assert.equal(preferredLayer('h', newQualityState().ceiling), 'h')
})

test('the lower of two layers wins', () => {
  assert.equal(lowerLayer('h', 'm'), 'm')
  assert.equal(lowerLayer('l', 'h'), 'l')
})

test('a layer lost again right after it came back waits twice as long next time, and a held layer forgives it', () => {
  let state = nextQuality(newQualityState(), 'h', stalled)
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

test('a busy share losing a fraction of a percent of its packets is not in trouble', () => {
  const share = { droppedFrames: 0, decodedFrames: 120, lostPackets: 20, receivedPackets: 2400 }
  assert.equal(nextQuality(newQualityState(), 'h', share).ceiling, 'h')
})

test('a 60 fps stream dropping a few frames is not in trouble', () => {
  const share = { droppedFrames: 3, decodedFrames: 117, lostPackets: 0, receivedPackets: 2400 }
  assert.equal(nextQuality(newQualityState(), 'h', share).ceiling, 'h')
})

test('a large share of a tiny sample is not trouble either', () => {
  const quiet = { droppedFrames: 2, decodedFrames: 2, lostPackets: 10, receivedPackets: 10 }
  assert.equal(nextQuality(newQualityState(), 'h', quiet).ceiling, 'h')
})

test('a busy share losing a real share of its packets is in trouble', () => {
  const share = { droppedFrames: 0, decodedFrames: 120, lostPackets: 300, receivedPackets: 2400 }
  assert.equal(nextQuality(newQualityState(), 'h', share).ceiling, 'm')
})

test('a sample is the difference between two readings, never negative', () => {
  const before = { droppedFrames: 5, decodedFrames: 100, lostPackets: 7, receivedPackets: 900 }
  const after = { droppedFrames: 6, decodedFrames: 160, lostPackets: 3, receivedPackets: 1300 }
  assert.deepEqual(countsSince(before, after), { droppedFrames: 1, decodedFrames: 60, lostPackets: 0, receivedPackets: 400 })
})
