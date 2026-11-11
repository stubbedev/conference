import assert from 'node:assert/strict'
import { test } from 'node:test'

import { backoffDelay, withBackoff, type Backoff } from './backoff.ts'

const POLICY: Backoff = { attempts: 4, firstDelayMs: 100, maxDelayMs: 250 }

class Blip extends Error {}

function failing(failures: readonly Error[]): { attempt: () => Promise<string>; calls: () => number } {
  let calls = 0
  return {
    attempt: async () => {
      const failure = failures[calls]
      calls += 1
      if (failure) throw failure
      return 'answered'
    },
    calls: () => calls,
  }
}

function recorder(): { wait: (ms: number) => Promise<void>; waited: number[] } {
  const waited: number[] = []
  return {
    wait: async (ms) => {
      waited.push(ms)
    },
    waited,
  }
}

test('the delay doubles from the first one, stays under its cap and ends after the last attempt', () => {
  assert.deepEqual(
    Array.from({ length: POLICY.attempts }, (_, i) => backoffDelay(POLICY, i + 1)),
    [100, 200, 250, null],
  )
})

test('there is no delay before anything has failed', () => {
  assert.equal(backoffDelay(POLICY, 0), null)
})

test('a failure that may pass is retried after the delay until the attempt answers', async () => {
  const { attempt, calls } = failing([new Blip('gone'), new Blip('gone')])
  const { wait, waited } = recorder()
  assert.equal(await withBackoff(attempt, POLICY, (err) => err instanceof Blip, wait), 'answered')
  assert.equal(calls(), 3)
  assert.deepEqual(waited, [100, 200])
})

test('a failure that cannot pass is not retried', async () => {
  const refused = new Error('no such room')
  const { attempt, calls } = failing([refused])
  const { wait, waited } = recorder()
  await assert.rejects(
    withBackoff(attempt, POLICY, (err) => err instanceof Blip, wait),
    (err) => err === refused,
  )
  assert.equal(calls(), 1)
  assert.deepEqual(waited, [])
})

test('after the last attempt the last failure is what comes back', async () => {
  const last = new Blip('still gone')
  const { attempt, calls } = failing([new Blip('gone'), new Blip('gone'), new Blip('gone'), last])
  const { wait, waited } = recorder()
  await assert.rejects(
    withBackoff(attempt, POLICY, (err) => err instanceof Blip, wait),
    (err) => err === last,
  )
  assert.equal(calls(), POLICY.attempts)
  assert.deepEqual(waited, [100, 200, 250])
})
