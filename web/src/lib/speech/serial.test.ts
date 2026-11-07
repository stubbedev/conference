import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Serial } from './serial.ts'

function later(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('tasks finish in the order they were queued', async () => {
  const serial = new Serial()
  const done: number[] = []
  const tasks = [30, 10, 20].map((ms, i) => serial.run(async () => {
    await later(ms)
    done.push(i)
  }))

  await Promise.all(tasks)
  assert.deepEqual(done, [0, 1, 2])
})

test('a task that throws does not block the ones after it', async () => {
  const serial = new Serial()
  const failed = serial.run(() => {
    throw new Error('no')
  })
  const next = serial.run(() => 'answered')

  await assert.rejects(failed, /no/)
  assert.equal(await next, 'answered')
})

test('a task is not started while another is running', async () => {
  const serial = new Serial()
  let running = 0
  let most = 0
  await Promise.all([0, 1, 2, 3].map(() => serial.run(async () => {
    running += 1
    most = Math.max(most, running)
    await later(1)
    running -= 1
  })))

  assert.equal(most, 1)
})
