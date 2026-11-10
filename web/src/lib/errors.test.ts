import assert from 'node:assert/strict'
import { test } from 'node:test'

import { asError, errorMessage, errorName, errorText } from './errors.ts'

test('an error gives its name, its message and both together', () => {
  const denied = new DOMException('Permission denied', 'NotAllowedError')
  assert.equal(errorName(denied), 'NotAllowedError')
  assert.equal(errorMessage(denied), 'Permission denied')
  assert.equal(errorText(denied), 'NotAllowedError: Permission denied')
})

test('anything else that was thrown has no name and reads as its own text', () => {
  assert.equal(errorName('gone'), '')
  assert.equal(errorMessage('gone'), 'gone')
  assert.equal(errorText('gone'), 'gone')
  assert.equal(errorMessage(undefined), 'undefined')
})

test('an error stays the same error, and anything else becomes one that says what it was', () => {
  const failed = new TypeError('bad model')
  assert.equal(asError(failed), failed)
  const made = asError('bad model')
  assert.ok(made instanceof Error)
  assert.equal(made.message, 'bad model')
})
