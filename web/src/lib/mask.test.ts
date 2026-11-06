import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BLUR_RADIUS_RATIO,
  blurPlan,
  maskAlpha,
  MASK_HIGH,
  MASK_LOW,
  featherRadius,
  modelFor,
  segmentCadence,
  writeMaskAlpha,
} from './mask.ts'

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

test('the mask can be written into a buffer that is used again', () => {
  const out = new Uint8ClampedArray(2 * 4).fill(7)
  writeMaskAlpha([1, 0], out)

  assert.deepEqual([...out], [255, 255, 255, 255, 255, 255, 255, 0])
})

test('the background is blurred by a radius worth the name', () => {
  const plan = blurPlan(1280, 720)

  assert.ok(plan.radius >= 15, `a radius of ${plan.radius}px is a smudge, not a blurred room`)
  assert.ok(plan.radius <= 40, `a radius of ${plan.radius}px is a flat wall, not a blurred room`)
})

test('the same room looks as out of focus on a small camera as on a large one', () => {
  const small = blurPlan(640, 360)
  const large = blurPlan(1920, 1080)

  assert.ok(Math.abs(large.radius / large.width - small.radius / small.width) < 0.01)
})

test('the blurred picture has room for its own blur on every side', () => {
  const plan = blurPlan(1280, 720)

  assert.ok(plan.pad >= plan.radius * 2, 'the blur would fade to nothing at the edges')
  assert.equal(plan.width, 640)
  assert.equal(plan.height, 360)
})

test('a radius never collapses to nothing', () => {
  assert.equal(blurPlan(16, 9).radius, 1)
})

test('the default blur is a fixed fraction of the frame', () => {
  assert.equal(BLUR_RADIUS_RATIO, 1 / 30)
})

test('a landscape camera gets the landscape model', () => {
  assert.equal(modelFor(1280, 720), 'landscape')
  assert.equal(modelFor(720, 720), 'landscape')
  assert.equal(modelFor(720, 1280), 'square')
})

test('a machine that segments in a few milliseconds asks every frame', () => {
  assert.equal(segmentCadence(3, 1000 / 30), 1)
  assert.equal(segmentCadence(15, 1000 / 30), 1)
})

test('a slow machine thins the masks out, never the frames', () => {
  assert.equal(segmentCadence(20, 1000 / 30), 2)
  assert.equal(segmentCadence(40, 1000 / 30), 3)
})

test('the cadence is never zero frames apart', () => {
  assert.equal(segmentCadence(0, 33), 1)
  assert.equal(segmentCadence(0.001, 33), 1)
})

test('the person meets the room over a fade, not a line', () => {
  assert.ok(featherRadius(1280) >= 5, `a ${featherRadius(1280)}px fade is a hard edge`)
  assert.ok(featherRadius(1280) <= 12, `a ${featherRadius(1280)}px fade eats the shoulders`)
})

test('the fade grows with the frame, and never disappears', () => {
  assert.ok(featherRadius(1920) > featherRadius(640))
  assert.equal(featherRadius(16), 2)
})
