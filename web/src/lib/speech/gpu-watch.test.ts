import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GpuWatch } from './gpu-watch.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function watch(stallMs: number): { gpu: GpuWatch; stalls: () => number } {
  let stalls = 0
  const gpu = new GpuWatch(stallMs, () => {
    stalls += 1
  })
  return { gpu, stalls: () => stalls }
}

test('an attempt that goes quiet past the limit is a stall, once', async () => {
  const { gpu, stalls } = watch(5)
  gpu.started()
  await wait(30)
  assert.equal(stalls(), 1)
})

test('activity keeps an attempt alive past the limit', async () => {
  const { gpu, stalls } = watch(30)
  gpu.started()
  for (let step = 0; step < 4; step++) {
    await wait(15)
    gpu.active()
  }
  assert.equal(stalls(), 0)
  gpu.settled()
})

test('an attempt that settled cannot stall', async () => {
  const { gpu, stalls } = watch(5)
  gpu.started()
  gpu.settled()
  await wait(20)
  assert.equal(stalls(), 0)
})

test('activity with no attempt running starts nothing', async () => {
  const { gpu, stalls } = watch(5)
  gpu.active()
  await wait(20)
  assert.equal(stalls(), 0)
})
