import assert from 'node:assert/strict'
import { test } from 'node:test'

import { settled } from './settled.ts'

test('a promise has settled when it resolves and when it rejects, and its failure stays with it', async () => {
  const failed = Promise.reject(new Error('no'))
  assert.equal(await settled(Promise.resolve('answered')), undefined)
  assert.equal(await settled(failed), undefined)
  await assert.rejects(failed, /no/)
})
