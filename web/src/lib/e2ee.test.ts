import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isE2EEStats, isTransformOptions } from './e2ee.ts'

test('a transform is attached with a purpose and a number', () => {
  assert.equal(isTransformOptions({ purpose: 'send', id: 0 }), true)
  assert.equal(isTransformOptions({ purpose: 'recv', id: 17 }), true)
})

test('options that leave out the purpose or the number are refused, not read as a receiving transform', () => {
  assert.equal(isTransformOptions({ purpose: 'send' }), false)
  assert.equal(isTransformOptions({ id: 3 }), false)
  assert.equal(isTransformOptions({ purpose: 'both', id: 3 }), false)
  assert.equal(isTransformOptions({ purpose: 'recv', id: '3' }), false)
  assert.equal(isTransformOptions(undefined), false)
  assert.equal(isTransformOptions(null), false)
})

test("only the worker's report is taken for one", () => {
  assert.equal(isE2EEStats({ type: 'e2ee-stats', send: 0, recv: 0, dropSend: 0, dropRecv: 0, lastError: '', transforms: [] }), true)
  assert.equal(isE2EEStats({ type: 'loading' }), false)
  assert.equal(isE2EEStats('e2ee-stats'), false)
})
