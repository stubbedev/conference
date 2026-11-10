import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeTrackOpenError } from './media-errors.ts'

test('a denied permission names the blocked device and how to allow it', () => {
  const message = describeTrackOpenError('microphone', new DOMException('Permission denied', 'NotAllowedError'))
  assert.match(message, /blocking the microphone/)
  assert.match(message, /site settings/)
})

test('a missing device, a busy device and an unavailable choice each say so', () => {
  assert.match(describeTrackOpenError('microphone', new DOMException('', 'NotFoundError')), /No microphone was found/)
  assert.match(describeTrackOpenError('camera', new DOMException('', 'NotReadableError')), /camera could not be started/)
  assert.match(describeTrackOpenError('microphone', new DOMException('', 'OverconstrainedError')), /selected microphone is not available/)
})

test('an unrecognised failure keeps its own name and message', () => {
  assert.equal(
    describeTrackOpenError('microphone', new TypeError('mediaDevices is undefined')),
    'The microphone could not be opened (TypeError: mediaDevices is undefined).',
  )
  assert.equal(describeTrackOpenError('camera', 'gone'), 'The camera could not be opened (gone).')
})
