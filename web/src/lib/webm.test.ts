import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withDuration } from './webm.ts'

const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3]
const SEGMENT = [0x18, 0x53, 0x80, 0x67]
const INFO = [0x15, 0x49, 0xa9, 0x66]
const TIMECODE_SCALE = [0x2a, 0xd7, 0xb1]
const MUXING_APP = [0x4d, 0x80]
const DURATION = [0x44, 0x89]
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75]
const UNKNOWN_SIZE = [0xff]

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const element = (id: number[], payload: Uint8Array): Uint8Array => {
  const size = payload.length
  assert.ok(size < 0x7f, 'the fixtures stay inside a one byte size')
  return concat(Uint8Array.from(id), Uint8Array.from([0x80 | size]), payload)
}

const text = (value: string): Uint8Array => Uint8Array.from(value, (c) => c.charCodeAt(0))

const timecodeScale = (value: number): Uint8Array => {
  const payload = new Uint8Array(3)
  payload[0] = (value >> 16) & 0xff
  payload[1] = (value >> 8) & 0xff
  payload[2] = value & 0xff
  return element(TIMECODE_SCALE, payload)
}

const float32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setFloat32(0, value)
  return out
}

const float64 = (value: number): Uint8Array => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setFloat64(0, value)
  return out
}

const cluster = (payload: string): Uint8Array => element(CLUSTER, text(payload))

const webm = (infoChildren: Uint8Array[], afterInfo: Uint8Array[] = [cluster('frames')]): Uint8Array =>
  concat(
    element(EBML_HEADER, concat(element([0x42, 0x86], text('webm')), element([0x42, 0x87], text('1')))),
    concat(Uint8Array.from(SEGMENT), Uint8Array.from(UNKNOWN_SIZE), element(INFO, concat(...infoChildren)), ...afterInfo),
  )

const indexOf = (bytes: Uint8Array, needle: number[]): number => {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer
    return i
  }
  throw new Error('the fixture is missing an element')
}

const sizeLength = (first: number): number => {
  for (let length = 1; length <= 8; length++) if ((first & (0x80 >> (length - 1))) !== 0) return length
  throw new Error('not a size')
}

const readSize = (bytes: Uint8Array, offset: number): number => {
  const length = sizeLength(bytes[offset])
  let value = bytes[offset] & (0xff >> length)
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]
  return value
}

interface Child {
  id: number
  data: Uint8Array
}

const infoChildren = (bytes: Uint8Array): Child[] => {
  const start = indexOf(bytes, INFO)
  const cursor = start + INFO.length + sizeLength(bytes[start + INFO.length])
  const end = cursor + readSize(bytes, start + INFO.length)
  const children: Child[] = []
  let at = cursor
  while (at < end) {
    const idLength = sizeLength(bytes[at])
    const id = bytes.subarray(at, at + idLength).reduce((acc, byte) => acc * 256 + byte, 0)
    const sizeAt = at + idLength
    const size = readSize(bytes, sizeAt)
    const dataAt = sizeAt + sizeLength(bytes[sizeAt])
    children.push({ id, data: bytes.subarray(dataAt, dataAt + size) })
    at = dataAt + size
  }
  return children
}

const child = (bytes: Uint8Array, id: number[]): Child | undefined => {
  const wanted = id.reduce((acc, byte) => acc * 256 + byte, 0)
  return infoChildren(bytes).find((entry) => entry.id === wanted)
}

const durationTicks = (bytes: Uint8Array): number => {
  const data = child(bytes, DURATION)?.data
  assert.ok(data, 'the file carries no Duration')
  const view = Buffer.from(data)
  return data.length === 4 ? view.readFloatBE(0) : view.readDoubleBE(0)
}

const durationSeconds = (bytes: Uint8Array, scaleNs = 1_000_000): number => (durationTicks(bytes) * scaleNs) / 1e9

test('a recording without a duration gets its real length', () => {
  const original = webm([timecodeScale(1_000_000), element(MUXING_APP, text('Chrome'))])
  assert.equal(child(original, DURATION), undefined)

  const patched = withDuration(original, 95_500)

  assert.ok(Math.abs(durationSeconds(patched) - 95.5) < 1e-9)
  assert.deepEqual(child(patched, TIMECODE_SCALE)?.data, Uint8Array.from([0x0f, 0x42, 0x40]))
  assert.equal(Buffer.from(child(patched, MUXING_APP)?.data ?? []).toString(), 'Chrome')
})

test('the inserted duration comes right after the timecode scale', () => {
  const original = webm([timecodeScale(1_000_000), element(MUXING_APP, text('Chrome'))])
  const patched = withDuration(original, 1_000)
  const ids = infoChildren(patched).map((entry) => entry.id)

  assert.deepEqual(ids, [0x2ad7b1, 0x4489, 0x4d80])
})

test('a duration-less Info with nothing before it still gets one', () => {
  const patched = withDuration(webm([element(MUXING_APP, text('Chrome'))]), 4_000)
  const ids = infoChildren(patched).map((entry) => entry.id)

  assert.deepEqual(ids, [0x4489, 0x4d80])
  assert.ok(Math.abs(durationSeconds(patched) - 4) < 1e-9)
})

test('a float32 duration already in the file is corrected in place', () => {
  const original = webm([timecodeScale(1_000_000), element(DURATION, float32(1.5))])
  const patched = withDuration(original, 62_250)

  assert.equal(patched.length, original.length)
  assert.ok(Math.abs(durationSeconds(patched) - 62.25) < 1e-3)
})

test('a float64 duration already in the file is corrected in place', () => {
  const original = webm([timecodeScale(1_000_000), element(DURATION, float64(1.5))])
  const patched = withDuration(original, 3_723_456)

  assert.equal(patched.length, original.length)
  assert.ok(Math.abs(durationSeconds(patched) - 3723.456) < 1e-9)
})

test('a patched Duration keeps the 64 bit value of a long meeting exact', () => {
  const patched = withDuration(webm([timecodeScale(1_000_000)]), 3_600_000)

  assert.equal(durationSeconds(patched), 3600)
  assert.equal(child(patched, DURATION)?.data.length, 8)
})

test('the bytes after the patched Info are left alone', () => {
  const original = webm([timecodeScale(1_000_000)], [cluster('first'), cluster('second')])
  const infoAt = indexOf(original, INFO)
  const infoSizeAt = infoAt + INFO.length
  const infoEnd = infoSizeAt + sizeLength(original[infoSizeAt]) + readSize(original, infoSizeAt)

  const patched = withDuration(original, 12_000)

  assert.deepEqual(patched.subarray(0, infoAt), original.subarray(0, infoAt))
  assert.deepEqual(patched.subarray(patched.length - (original.length - infoEnd)), original.subarray(infoEnd))
})

test('the Segment keeps its unknown size', () => {
  const original = webm([timecodeScale(1_000_000)])
  const patched = withDuration(original, 5_000)
  const segmentAt = indexOf(original, SEGMENT)

  assert.deepEqual(patched.subarray(segmentAt, segmentAt + SEGMENT.length + 1), original.subarray(segmentAt, segmentAt + SEGMENT.length + 1))
})

test('a truncated file is refused and the caller keeps its bytes', () => {
  const original = webm([timecodeScale(1_000_000)])
  const truncated = original.subarray(0, indexOf(original, INFO) + 2)
  const before = truncated.slice()

  assert.throws(() => withDuration(truncated, 5_000), /cannot write a duration into this WebM file/)
  assert.deepEqual(truncated, before)
})

test('an Info that claims more bytes than the file holds is refused', () => {
  const original = webm([timecodeScale(1_000_000)])
  const infoAt = indexOf(original, INFO)
  const broken = original.slice()
  broken[infoAt + INFO.length] = 0x80 | 0x7e

  assert.throws(() => withDuration(broken, 5_000), /cannot write a duration into this WebM file/)
})

test('a file that is not WebM is refused', () => {
  const notWebm = text('\u0000\u0000\u0000\u0018ftypmp42')

  assert.throws(() => withDuration(notWebm, 5_000), /WebM/)
})

test('a Segment without an Info element is refused', () => {
  const noInfo = concat(
    element(EBML_HEADER, element([0x42, 0x86], text('webm'))),
    concat(Uint8Array.from(SEGMENT), Uint8Array.from(UNKNOWN_SIZE), cluster('frames')),
  )

  assert.throws(() => withDuration(noInfo, 5_000), /Info/)
})

test('a duration that cannot be a real length is refused', () => {
  const original = webm([timecodeScale(1_000_000)])

  assert.throws(() => withDuration(original, 0), /not a usable duration/)
  assert.throws(() => withDuration(original, Number.NaN), /not a usable duration/)
})

test('a Segment with a fixed size is refused rather than left wrong', () => {
  const fixed = concat(
    element(EBML_HEADER, element([0x42, 0x86], text('webm'))),
    element(SEGMENT, concat(element(INFO, timecodeScale(1_000_000)), cluster('frames'))),
  )

  assert.throws(() => withDuration(fixed, 5_000), /fixed size/)
})

test('a fixed-size Segment still gets a duration it already has corrected', () => {
  const fixed = concat(
    element(EBML_HEADER, element([0x42, 0x86], text('webm'))),
    element(SEGMENT, concat(element(INFO, concat(timecodeScale(1_000_000), element(DURATION, float32(1)))), cluster('frames'))),
  )

  const patched = withDuration(fixed, 8_000)

  assert.equal(patched.length, fixed.length)
  assert.ok(Math.abs(durationSeconds(patched) - 8) < 1e-3)
})

test('a file with its own timecode scale gets ticks in that scale', () => {
  const original = webm([timecodeScale(10_000_000)])

  const patched = withDuration(original, 5_000)

  assert.equal(durationTicks(patched), 500)
  assert.ok(Math.abs(durationSeconds(patched, 10_000_000) - 5) < 1e-9)
})

test('a file without a timecode scale counts one millisecond ticks', () => {
  const patched = withDuration(webm([element(MUXING_APP, text('Chrome'))]), 2_500)

  assert.equal(durationTicks(patched), 2_500)
})
