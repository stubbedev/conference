import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SCREEN_AUDIO_KIND, SCREEN_SHARE_FPS, SCREEN_SHARE_MAX_BITRATE, screenSenderParameters, screenTracks } from './screen.ts'

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

const track = (id: string, kind: 'audio' | 'video', readyState: MediaStreamTrackState = 'live') =>
  ({ id, kind, readyState }) as MediaStreamTrack

test('a share gets its sound merged into its picture', () => {
  const merged = screenTracks([track('v', 'video')], [track('a', 'audio')])
  assert.deepEqual(
    merged.map((t) => t.id),
    ['v', 'a'],
  )
})

test('the same track arriving twice is not played twice', () => {
  const merged = screenTracks([track('v', 'video')], [track('v', 'video')])
  assert.equal(merged.length, 1)
})

test('a track that already ended is dropped', () => {
  const merged = screenTracks([track('old', 'audio', 'ended')], [track('v', 'video')])
  assert.deepEqual(
    merged.map((t) => t.id),
    ['v'],
  )
})

test('the announced kind for a share is audio to the server', () => {
  assert.equal(SCREEN_AUDIO_KIND, 'screen-audio')
})
