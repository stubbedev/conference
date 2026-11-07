import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cameraLayers,
  demandParameters,
  PUBLISH_CEILING_BPS,
  relayerParameters,
  SCREEN_SHARE_FPS,
  SCREEN_SHARE_MAX_BITRATE,
  screenSenderParameters,
  sharingLayers,
} from './encodings.ts'

const HD = cameraLayers({ width: 1280, height: 720 })
const FULL_HD = cameraLayers({ width: 1920, height: 1080 })
const bitrates = (layers: RTCRtpEncodingParameters[]) => layers.map((layer) => layer.maxBitrate)
const total = (layers: RTCRtpEncodingParameters[]) => layers.reduce((sum, layer) => sum + (layer.maxBitrate ?? 0), 0)

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

test('the camera layers stay under the publish ceiling at every capture size', () => {
  for (const layers of [HD, FULL_HD, cameraLayers({ width: 3840, height: 2160 })]) {
    assert.ok(total(layers) <= PUBLISH_CEILING_BPS, `the camera layers ask for ${total(layers)} bps, more than one participant may send`)
  }
  assert.ok((HD.at(-1)?.maxBitrate ?? 0) >= 1_500_000, 'the high layer is starved')
})

test('a full HD camera gets a sharper full layer than an HD one', () => {
  assert.deepEqual(bitrates(HD), [150_000, 600_000, 1_750_000])
  assert.deepEqual(bitrates(FULL_HD), [300_000, 1_000_000, 2_500_000])
})

test('a small camera does not reserve bandwidth it cannot fill', () => {
  assert.deepEqual(bitrates(cameraLayers({ width: 640, height: 360 })), [100_000, 150_000, 600_000])
})

test('a camera larger than full HD is budgeted as full HD', () => {
  assert.deepEqual(cameraLayers({ width: 3840, height: 2160 }), FULL_HD)
})

test('a portrait camera is budgeted by its short side', () => {
  assert.deepEqual(cameraLayers({ width: 1080, height: 1920 }), FULL_HD)
})

test('a track that does not report its size is budgeted as HD', () => {
  assert.deepEqual(cameraLayers({}), HD)
})

test('the layers keep their rids and scales', () => {
  assert.deepEqual(
    FULL_HD.map(({ rid, scaleResolutionDownBy }) => [rid, scaleResolutionDownBy]),
    [['l', 4], ['m', 2], ['h', 1]],
  )
})

test('relayering caps the camera while a screen is shared', () => {
  const shared = relayerParameters(parameters(HD), sharingLayers(HD))
  assert.deepEqual(
    shared.encodings.map((encoding) => encoding.maxBitrate),
    [150_000, 300_000, 300_000],
  )
})

test('relayering gives the camera its layers back afterwards', () => {
  const restored = relayerParameters(parameters(sharingLayers(FULL_HD)), FULL_HD)
  assert.deepEqual(restored.encodings.map((encoding) => encoding.maxBitrate), bitrates(FULL_HD))
})

test('relayering matches layers by rid, not by order', () => {
  const reversed = relayerParameters(
    parameters([{ rid: 'h', maxBitrate: 1 }, { rid: 'l', maxBitrate: 1 }]),
    sharingLayers(HD),
  )
  assert.deepEqual(
    reversed.encodings.map((encoding) => encoding.maxBitrate),
    [300_000, 150_000],
  )
})

test('relayering leaves what the layers do not describe alone', () => {
  const sent = relayerParameters(parameters([{ maxFramerate: 10 }]), HD)
  assert.equal(sent.encodings[0]?.maxFramerate, 10)
  assert.equal(sent.encodings[0]?.maxBitrate, 150_000)
  assert.equal(sent.transactionId, 'tx')
})

test('layers nobody watches are paused and the ones someone wants run', () => {
  const sent = demandParameters(parameters(HD.map((layer) => ({ ...layer, active: true }))), [true, false, true])
  assert.deepEqual(
    sent.encodings.map((encoding) => [encoding.rid, encoding.active]),
    [['l', true], ['m', false], ['h', true]],
  )
})

test('layer demand is matched by rid and leaves the bitrate caps alone', () => {
  const sent = demandParameters(parameters([{ rid: 'h', maxBitrate: 1 }, { rid: 'l', maxBitrate: 2 }]), [true, true, false])
  assert.deepEqual(
    sent.encodings.map((encoding) => [encoding.rid, encoding.active, encoding.maxBitrate]),
    [['h', false, 1], ['l', true, 2]],
  )
})

test('an encoding without a layer rid is left as it is', () => {
  const sent = demandParameters(parameters([{ maxBitrate: 5 }]), [false, false, false])
  assert.deepEqual(sent.encodings, [{ maxBitrate: 5 }])
})
