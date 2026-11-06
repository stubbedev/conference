import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CAMERA_LAYERS,
  CAMERA_SHARING_LAYERS,
  PUBLISH_CEILING_BPS,
  relayerParameters,
  SCREEN_SHARE_FPS,
  SCREEN_SHARE_MAX_BITRATE,
  screenSenderParameters,
} from './encodings.ts'

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
  assert.equal(SCREEN_SHARE_MAX_BITRATE, PUBLISH_CEILING_BPS)
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

test('the camera layers stay under the publish ceiling', () => {
  const total = CAMERA_LAYERS.reduce((sum, layer) => sum + (layer.maxBitrate ?? 0), 0)
  assert.ok(total <= PUBLISH_CEILING_BPS, `the camera layers ask for ${total} bps, more than one participant may send`)
  assert.ok((CAMERA_LAYERS.at(-1)?.maxBitrate ?? 0) >= 1_500_000, 'the high layer is starved')
})

test('relayering caps the camera while a screen is shared', () => {
  const shared = relayerParameters(parameters(CAMERA_LAYERS.map((layer) => ({ ...layer }))), CAMERA_SHARING_LAYERS)
  assert.deepEqual(
    shared.encodings.map((encoding) => encoding.maxBitrate),
    [150_000, 300_000, 300_000],
  )
})

test('relayering gives the camera its layers back afterwards', () => {
  const restored = relayerParameters(parameters(CAMERA_SHARING_LAYERS.map((layer) => ({ ...layer }))), CAMERA_LAYERS)
  assert.deepEqual(
    restored.encodings.map((encoding) => encoding.maxBitrate),
    CAMERA_LAYERS.map((layer) => layer.maxBitrate),
  )
})

test('relayering matches layers by rid, not by order', () => {
  const reversed = relayerParameters(
    parameters([{ rid: 'h', maxBitrate: 1 }, { rid: 'l', maxBitrate: 1 }]),
    CAMERA_SHARING_LAYERS,
  )
  assert.deepEqual(
    reversed.encodings.map((encoding) => encoding.maxBitrate),
    [300_000, 150_000],
  )
})

test('relayering leaves what the layers do not describe alone', () => {
  const sent = relayerParameters(parameters([{ maxFramerate: 10 }]), CAMERA_LAYERS)
  assert.equal(sent.encodings[0]?.maxFramerate, 10)
  assert.equal(sent.encodings[0]?.maxBitrate, 150_000)
  assert.equal(sent.transactionId, 'tx')
})
