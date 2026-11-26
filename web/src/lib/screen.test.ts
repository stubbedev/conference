import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SCREEN_SHARE_FPS } from './encodings.ts'
import { SCREEN_CAPTURE } from './screen.ts'

test('a screen is captured at the frame rate it is encoded at', () => {
  assert.deepEqual(SCREEN_CAPTURE.frameRate, { ideal: SCREEN_SHARE_FPS })
})
