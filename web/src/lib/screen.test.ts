import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SCREEN_SHARE_FPS, SCREEN_SHARE_MAX_BITRATE, screenSenderParameters } from './screen.ts'

const parameters = (encodings: RTCRtpEncodingParameters[]): RTCRtpSendParameters =>
  ({ transactionId: 'tx', rtcp: { cname: 'abc', reducedSize: false }, encodings }) as RTCRtpSendParameters

test('a screen share keeps its frame rate when the bitrate shrinks', () => {
  const sent = screenSenderParameters(parameters([{}]))
  assert.equal(sent.degradationPreference, 'maintain-framerate')
  assert.equal(sent.encodings[0]?.maxFramerate, SCREEN_SHARE_FPS)
})

test('a screen share gets a bitrate budget for a whole window', () => {
  const sent = screenSenderParameters(parameters([{}]))
  assert.ok(SCREEN_SHARE_MAX_BITRATE >= 2_000_000)
  assert.equal(sent.encodings[0]?.maxBitrate, SCREEN_SHARE_MAX_BITRATE)
})

test('the rest of the sender parameters survive', () => {
  const sent = screenSenderParameters(parameters([{ active: true, maxBitrate: 900_000 }]))
  assert.equal(sent.transactionId, 'tx')
  assert.equal(sent.rtcp.cname, 'abc')
  assert.equal(sent.encodings.length, 1)
  assert.equal(sent.encodings[0]?.active, true)
})

test('the value handed to setParameters is new, not the one read from the sender', () => {
  const read = parameters([{ active: true, maxBitrate: 900_000 }])
  screenSenderParameters(read)
  assert.equal(read.encodings[0]?.maxBitrate, 900_000)
  assert.equal(read.degradationPreference, undefined)
})
