import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Unreachable } from './api.ts'
import { roomFailure } from './room-failure.ts'

test('a request that got no answer is a failure that trying again can fix', () => {
  assert.deepEqual(roomFailure(new Unreachable('/api/rooms/abc', new TypeError('Failed to fetch'))), {
    kind: 'unreachable',
    message: 'Could not reach the server for /api/rooms/abc: Failed to fetch',
  })
})

test('a refusal by the server or any other failure is not', () => {
  assert.deepEqual(roomFailure(new Error('No such room.')), { kind: 'failed', message: 'No such room.' })
  assert.deepEqual(roomFailure('gone'), { kind: 'failed', message: 'gone' })
})
