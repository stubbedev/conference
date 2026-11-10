import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GpuWatch } from './gpu-watch.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function watch(): { gpu: GpuWatch; stalls: () => number } {
  let stalls = 0
  const gpu = new GpuWatch(() => {
    stalls += 1
  })
  return { gpu, stalls: () => stalls }
}

test('an attempt that goes quiet past its budget is a stall, once', async () => {
  const { gpu, stalls } = watch()
  gpu.started(5)
  await wait(30)
  assert.equal(stalls(), 1)
  assert.equal(gpu.settled(), null)
})

test('activity keeps an attempt alive past its budget', async () => {
  const { gpu, stalls } = watch()
  gpu.started(30)
  for (let step = 0; step < 4; step++) {
    await wait(15)
    gpu.active()
  }
  assert.equal(stalls(), 0)
  gpu.stop()
})

test('a settled attempt reports its longest quiet stretch and cannot stall', async () => {
  const { gpu, stalls } = watch()
  gpu.started(200)
  await wait(10)
  gpu.active()
  await wait(40)
  gpu.active()
  await wait(5)
  const quiet = gpu.settled()
  assert.ok(quiet !== null && quiet >= 35 && quiet < 150, `quiet ${quiet}`)
  await wait(250)
  assert.equal(stalls(), 0)
})

test('each attempt measures its own quiet stretches', async () => {
  const { gpu } = watch()
  gpu.started(200)
  await wait(40)
  gpu.settled()
  gpu.started(200)
  await wait(5)
  const quiet = gpu.settled()
  assert.ok(quiet !== null && quiet < 35, `quiet ${quiet}`)
})

test('activity with no attempt running starts nothing', async () => {
  const { gpu, stalls } = watch()
  gpu.active()
  await wait(20)
  assert.equal(stalls(), 0)
  assert.equal(gpu.settled(), null)
})
