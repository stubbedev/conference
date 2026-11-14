import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LAYER_RIDS as CAMERA, SCREEN_LAYER_RIDS as SCREEN } from './encodings.ts'
import { countsSince, lowerLayer, newQualityState, nextQuality, preferredLayer } from './quality.ts'

const clean = { droppedFrames: 0, decodedFrames: 60, lostPackets: 0, receivedPackets: 400 }
const stalled = { droppedFrames: 10, decodedFrames: 50, lostPackets: 0, receivedPackets: 400 }
const lossy = { droppedFrames: 0, decodedFrames: 60, lostPackets: 40, receivedPackets: 400 }

test('a viewer asks for the layer its layout wants', () => {
  assert.equal(preferredLayer('h', newQualityState().ceiling), 'h')
  assert.equal(preferredLayer('m', newQualityState().ceiling), 'm')
})

test('dropped frames lower the ceiling at once', () => {
  const state = nextQuality(newQualityState(), 'h', stalled, CAMERA)
  assert.equal(state.ceiling, 'm')
})

test('lost packets lower it too', () => {
  assert.equal(nextQuality(newQualityState(), 'h', lossy, CAMERA).ceiling, 'm')
})

test('trouble never lifts the ceiling above the layout', () => {
  const state = nextQuality(newQualityState(), 'l', stalled, CAMERA)
  assert.equal(state.ceiling, 'l')
})

test('a clean stream earns its layer back after a run of samples', () => {
  let state = newQualityState()
  state = nextQuality(state, 'h', stalled, CAMERA)
  state = nextQuality(state, 'h', stalled, CAMERA)

  assert.equal(state.ceiling, 'l')

  state = nextQuality(state, 'h', clean, CAMERA)
  state = nextQuality(state, 'h', clean, CAMERA)
  assert.equal(state.ceiling, 'l', 'the ceiling rose before the samples were clean')

  state = nextQuality(state, 'h', clean, CAMERA)
  assert.equal(state.ceiling, 'm')

  state = nextQuality(state, 'h', clean, CAMERA)
  state = nextQuality(state, 'h', clean, CAMERA)
  state = nextQuality(state, 'h', clean, CAMERA)
  assert.equal(state.ceiling, 'h')
})

test('a shared screen steps straight between its two encodings', () => {
  let state = nextQuality(newQualityState(), 'h', stalled, SCREEN)
  assert.equal(state.ceiling, 'l')

  state = nextQuality(state, 'h', stalled, SCREEN)
  assert.equal(state.ceiling, 'l')

  for (let i = 0; i < 2; i += 1) state = nextQuality(state, 'h', clean, SCREEN)
  assert.equal(state.ceiling, 'l', 'the ceiling rose before the samples were clean')

  state = nextQuality(state, 'h', clean, SCREEN)
  assert.equal(state.ceiling, 'h')
})

test('recovery stops at what the layout can use', () => {
  let state = nextQuality(nextQuality(newQualityState(), 'h', stalled, CAMERA), 'h', stalled, CAMERA)
  assert.equal(state.ceiling, 'l')
  for (let i = 0; i < 12; i += 1) state = nextQuality(state, 'm', clean, CAMERA)
  assert.equal(state.ceiling, 'm')
})

test('a tile that shrinks and grows again gets its layer back at once', () => {
  let state = newQualityState()
  for (let i = 0; i < 6; i += 1) state = nextQuality(state, 'l', clean, CAMERA)
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

test('a layer the link loses again right after it came back waits twice as long next time, and a held layer forgives it', () => {
  let state = nextQuality(newQualityState(), 'h', lossy, CAMERA)
  const samplesToClimb = () => {
    let samples = 0
    while (state.ceiling !== 'h') {
      state = nextQuality(state, 'h', clean, CAMERA)
      samples += 1
    }
    return samples
  }

  const first = samplesToClimb()
  state = nextQuality(state, 'h', lossy, CAMERA)
  const second = samplesToClimb()
  state = nextQuality(state, 'h', lossy, CAMERA)
  const third = samplesToClimb()
  assert.deepEqual([first, second, third], [3, 6, 12])

  for (let i = 0; i < 30; i += 1) state = nextQuality(state, 'h', clean, CAMERA)
  state = nextQuality(state, 'h', lossy, CAMERA)
  assert.equal(samplesToClimb(), 3)
})

test('a share whose scroll bursts drop a few frames on a clean link climbs back at the same pace every time', () => {
  const fluidBurst = { droppedFrames: 6, decodedFrames: 45, lostPackets: 0, receivedPackets: 900 }
  const trickle = { droppedFrames: 0, decodedFrames: 2, lostPackets: 0, receivedPackets: 40 }
  const cycle = ['burst', 'still', 'still'] as const
  let state = newQualityState()
  const stays: number[] = []
  let slow = 0
  for (let sample = 0; sample < 60; sample += 1) {
    const scrolling = cycle[sample % cycle.length] === 'burst'
    state = nextQuality(state, 'h', scrolling && state.ceiling === 'h' ? fluidBurst : trickle, SCREEN)
    if (state.ceiling === 'l') {
      slow += 1
    } else if (slow > 0) {
      stays.push(slow)
      slow = 0
    }
  }
  assert.ok(stays.length >= 5, `the share stepped down ${stays.length} times`)
  assert.ok(
    stays.every((stay) => stay === 3),
    `samples on the slow encoding per step down: ${stays.join(' ')}`,
  )
})

test('a busy share losing a fraction of a percent of its packets is not in trouble', () => {
  const share = { droppedFrames: 0, decodedFrames: 120, lostPackets: 20, receivedPackets: 2400 }
  assert.equal(nextQuality(newQualityState(), 'h', share, CAMERA).ceiling, 'h')
})

test('a 60 fps stream dropping a few frames is not in trouble', () => {
  const share = { droppedFrames: 3, decodedFrames: 117, lostPackets: 0, receivedPackets: 2400 }
  assert.equal(nextQuality(newQualityState(), 'h', share, CAMERA).ceiling, 'h')
})

test('a large share of a tiny sample is not trouble either', () => {
  const quiet = { droppedFrames: 2, decodedFrames: 2, lostPackets: 10, receivedPackets: 10 }
  assert.equal(nextQuality(newQualityState(), 'h', quiet, CAMERA).ceiling, 'h')
})

test('a busy share losing a real share of its packets is in trouble', () => {
  const share = { droppedFrames: 0, decodedFrames: 120, lostPackets: 300, receivedPackets: 2400 }
  assert.equal(nextQuality(newQualityState(), 'h', share, CAMERA).ceiling, 'm')
})

test('a sample is the difference between two readings, never negative', () => {
  const before = { droppedFrames: 5, decodedFrames: 100, lostPackets: 7, receivedPackets: 900 }
  const after = { droppedFrames: 6, decodedFrames: 160, lostPackets: 3, receivedPackets: 1300 }
  assert.deepEqual(countsSince(before, after), { droppedFrames: 1, decodedFrames: 60, lostPackets: 0, receivedPackets: 400 })
})
