import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CAMERA_PRIORITY,
  CAMERA_SHARING_PRIORITY,
  cameraLayers,
  cameraSenderParameters,
  DEFAULT_PRIORITY,
  demandParameters,
  fluidShareBitrate,
  relayerParameters,
  SCREEN_CONTENT_HINT,
  SCREEN_SHARE_FPS,
  SCREEN_SHARE_FLUID_MAX_BITRATE,
  SCREEN_SHARE_LOW_MAX_BITRATE,
  SCREEN_SHARE_PRIORITY,
  screenLayers,
  screenSenderParameters,
  sharingLayers,
} from './encodings.ts'

const CEILING = 15_000_000

const HD = cameraLayers({ width: 1280, height: 720 })
const FULL_HD = cameraLayers({ width: 1920, height: 1080 })
const bitrates = (layers: RTCRtpEncodingParameters[]) => layers.map((layer) => layer.maxBitrate)
const total = (layers: RTCRtpEncodingParameters[]) => layers.reduce((sum, layer) => sum + (layer.maxBitrate ?? 0), 0)

const parameters = (encodings: RTCRtpEncodingParameters[]): RTCRtpSendParameters =>
  ({ transactionId: 'tx', rtcp: { cname: 'abc', reducedSize: false }, encodings }) as RTCRtpSendParameters

const senderPriority = (sent: RTCRtpSendParameters) => {
  const first = sent.encodings[0]
  assert.equal(first?.networkPriority, first?.priority)
  return first?.priority
}

test('a screen share keeps its resolution when the bitrate shrinks, so text stays legible', () => {
  assert.equal(screenSenderParameters(parameters(screenLayers(CEILING))).degradationPreference, 'maintain-resolution')
})

test('a screen share is encoded as detailed content, not as motion', () => {
  assert.equal(SCREEN_CONTENT_HINT, 'detail')
})

test('a screen share goes out fluid and slow, both at full resolution', () => {
  const [low, high] = screenLayers(CEILING)
  assert.deepEqual(
    screenLayers(CEILING).map(({ rid, scaleResolutionDownBy }) => [rid, scaleResolutionDownBy]),
    [['l', 1], ['h', 1]],
  )
  assert.equal(high?.maxFramerate, SCREEN_SHARE_FPS)
  assert.ok((low?.maxFramerate ?? Infinity) < SCREEN_SHARE_FPS)
  assert.ok((low?.maxBitrate ?? Infinity) < (high?.maxBitrate ?? 0))
})

test('a share plays at 60 frames a second', () => {
  assert.equal(SCREEN_SHARE_FPS, 60)
})

test('the fluid share takes what the server allows, up to what crisp 60 fps text needs', () => {
  assert.equal(fluidShareBitrate(null), SCREEN_SHARE_FLUID_MAX_BITRATE)
  assert.equal(fluidShareBitrate(20_000_000), SCREEN_SHARE_FLUID_MAX_BITRATE)
  assert.equal(fluidShareBitrate(4_000_000), 4_000_000 - SCREEN_SHARE_LOW_MAX_BITRATE)
  assert.ok(SCREEN_SHARE_FLUID_MAX_BITRATE >= 6_000_000, 'scrolling text at 1440p and 60 fps needs about 6 Mbps')
})

test('both encodings of a share stay within a server ceiling below their budget', () => {
  assert.equal(total(screenLayers(4_000_000)), 4_000_000)
})

test('a server ceiling below the slow encoding still leaves the fluid one at least as much', () => {
  assert.equal(fluidShareBitrate(300_000), SCREEN_SHARE_LOW_MAX_BITRATE)
})

test('a screen share outranks the camera on the uplink, most of all while it is shared', () => {
  const rank: Record<RTCPriorityType, number> = { 'very-low': 0, low: 1, medium: 2, high: 3 }
  assert.deepEqual(senderPriority(screenSenderParameters(parameters(screenLayers(CEILING)))), SCREEN_SHARE_PRIORITY)
  assert.deepEqual(senderPriority(cameraSenderParameters(parameters(HD), HD, false)), CAMERA_PRIORITY)
  assert.deepEqual(senderPriority(cameraSenderParameters(parameters(HD), HD, true)), CAMERA_SHARING_PRIORITY)
  assert.ok(rank[SCREEN_SHARE_PRIORITY] > rank[CAMERA_PRIORITY])
  assert.ok(rank[CAMERA_SHARING_PRIORITY] < rank[CAMERA_PRIORITY])
})

test('only the first encoding of a sender carries its priority, the way browsers accept it', () => {
  for (const sent of [
    screenSenderParameters(parameters(screenLayers(CEILING))),
    cameraSenderParameters(parameters(HD), HD, true),
    cameraSenderParameters(parameters(HD), HD, false),
  ]) {
    for (const encoding of sent.encodings.slice(1)) {
      assert.equal(encoding.priority, DEFAULT_PRIORITY)
      assert.equal(encoding.networkPriority, DEFAULT_PRIORITY)
    }
  }
})

test('the encodings a share is created with carry no priority, which browsers refuse there', () => {
  for (const layer of screenLayers(CEILING)) {
    assert.equal(layer.priority, undefined)
    assert.equal(layer.networkPriority, undefined)
  }
})

test('tuning a share leaves its encodings and the rest of the sender parameters alone', () => {
  const read = parameters(screenLayers(CEILING))
  const sent = screenSenderParameters(read)
  assert.equal(sent.transactionId, 'tx')
  assert.equal(sent.rtcp.cname, 'abc')
  assert.deepEqual(
    sent.encodings.map(({ priority: _priority, networkPriority: _networkPriority, ...rest }) => rest),
    screenLayers(CEILING),
  )
  assert.equal(read.degradationPreference, undefined)
})

test('a share is paused and resumed by layer like a camera', () => {
  const sent = demandParameters(parameters(screenLayers(CEILING)), [true, false, false])
  assert.deepEqual(
    sent.encodings.map((encoding) => [encoding.rid, encoding.active]),
    [['l', true], ['h', false]],
  )
})

test('the camera layers stay under the default publish ceiling at every capture size', () => {
  for (const layers of [HD, FULL_HD, cameraLayers({ width: 3840, height: 2160 })]) {
    assert.ok(total(layers) <= CEILING, `the camera layers ask for ${total(layers)} bps, more than one participant may send`)
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

test('the camera becomes a thumbnail while a screen is shared and gets its layers back afterwards', () => {
  const shared = cameraSenderParameters(parameters(FULL_HD), FULL_HD, true)
  assert.deepEqual(bitrates(shared.encodings), [300_000, 300_000, 300_000])
  const restored = cameraSenderParameters(shared, FULL_HD, false)
  assert.deepEqual(bitrates(restored.encodings), bitrates(FULL_HD))
  assert.equal(senderPriority(restored), CAMERA_PRIORITY)
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
