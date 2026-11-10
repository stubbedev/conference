// A streamed WebM has no Duration in its Info element: MediaRecorder
// never learns the length of a recording that is still running, so it
// writes the header with the field missing. Players then show the file
// with no length and cannot seek. This module patches the header after
// the fact, touching nothing but the Info element.

import { errorMessage } from './errors.ts'

const EBML_HEADER = 0x1a45dfa3
const SEGMENT = 0x18538067
const INFO = 0x1549a966
const TIMECODE_SCALE = 0x2ad7b1
const DURATION = 0x4489

const DEFAULT_TIMECODE_SCALE_NS = 1_000_000
const NANOS_PER_MS = 1_000_000

interface Element {
  id: number
  size: number | null
  start: number
  dataStart: number
  idLength: number
  sizeLength: number
}

function vintLength(first: number): number {
  for (let length = 1; length <= 8; length++) {
    if ((first & (0x80 >> (length - 1))) !== 0) return length
  }
  return 0
}

function readId(bytes: Uint8Array, offset: number): { value: number; length: number } {
  const first = bytes[offset]
  const length = vintLength(first)
  if (length === 0 || length > 4) throw new Error(`byte ${offset} does not start a WebM element id`)
  if (offset + length > bytes.length) throw new Error(`the element id at byte ${offset} runs past the end of the file`)
  let value = 0
  for (let i = 0; i < length; i++) value = value * 256 + bytes[offset + i]
  return { value, length }
}

function readSize(bytes: Uint8Array, offset: number): { value: number | null; length: number } {
  const first = bytes[offset]
  if (first === undefined) throw new Error(`the file ends at byte ${offset} where an element size should start`)
  const length = vintLength(first)
  if (length === 0) throw new Error(`byte ${offset} does not start a WebM element size`)
  if (offset + length > bytes.length) throw new Error(`the element size at byte ${offset} runs past the end of the file`)
  let value = first & (0xff >> length)
  let unknown = value === (0xff >> length)
  for (let i = 1; i < length; i++) {
    const byte = bytes[offset + i]
    value = value * 256 + byte
    if (byte !== 0xff) unknown = false
  }
  return { value: unknown ? null : value, length }
}

function readElement(bytes: Uint8Array, offset: number): Element {
  if (offset >= bytes.length) throw new Error(`the file ends at byte ${offset} where an element should start`)
  const id = readId(bytes, offset)
  const size = readSize(bytes, offset + id.length)
  return {
    id: id.value,
    size: size.value,
    start: offset,
    dataStart: offset + id.length + size.length,
    idLength: id.length,
    sizeLength: size.length,
  }
}

function elementEnd(element: Element, limit: number): number {
  if (element.size === null) throw new Error(`the element at byte ${element.start} has no size, so the file cannot be walked`)
  if (element.dataStart + element.size > limit) {
    throw new Error(`the element at byte ${element.start} claims ${element.size} bytes, more than the file holds`)
  }
  return element.dataStart + element.size
}

function findChild(bytes: Uint8Array, parent: Element, wanted: number, label: string, limit: number): Element {
  let cursor = parent.dataStart
  while (cursor < limit) {
    const child = readElement(bytes, cursor)
    if (child.id === wanted) return child
    cursor = elementEnd(child, limit)
  }
  throw new Error(`the element at byte ${parent.start} has no ${label} element`)
}

function encodeSize(size: number, minLength: number): Uint8Array {
  let length = 1
  while (length < 8 && size >= 2 ** (7 * length) - 1) length++
  if (length < minLength) length = minLength
  if (size >= 2 ** (7 * length) - 1) throw new Error(`the size ${size} is too large for a WebM element size`)
  const out = new Uint8Array(length)
  let rest = size
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256
    rest = Math.floor(rest / 256)
  }
  out[0] |= 0x80 >> (length - 1)
  return out
}

function durationElement(seconds: number): Uint8Array {
  const out = new Uint8Array(11)
  out[0] = 0x44
  out[1] = 0x89
  out[2] = 0x88
  new DataView(out.buffer).setFloat64(3, seconds)
  return out
}

function insertDuration(bytes: Uint8Array, info: Element, infoEnd: number, seconds: number): Uint8Array<ArrayBuffer> {
  let afterTimecodeScale = info.dataStart
  let cursor = info.dataStart
  while (cursor < infoEnd) {
    const child = readElement(bytes, cursor)
    cursor = elementEnd(child, infoEnd)
    if (child.id === TIMECODE_SCALE) {
      afterTimecodeScale = cursor
      break
    }
  }

  const added = durationElement(seconds)
  const payloadLength = infoEnd - info.dataStart + added.length
  const size = encodeSize(payloadLength, info.sizeLength)
  const out = new Uint8Array(info.start + info.idLength + size.length + payloadLength + (bytes.length - infoEnd))

  let at = 0
  out.set(bytes.subarray(0, info.start), at)
  at += info.start
  out.set(bytes.subarray(info.start, info.start + info.idLength), at)
  at += info.idLength
  out.set(size, at)
  at += size.length
  out.set(bytes.subarray(info.dataStart, afterTimecodeScale), at)
  at += afterTimecodeScale - info.dataStart
  out.set(added, at)
  at += added.length
  out.set(bytes.subarray(afterTimecodeScale, infoEnd), at)
  at += infoEnd - afterTimecodeScale
  out.set(bytes.subarray(infoEnd), at)
  return out
}

function overwriteDuration(bytes: Uint8Array, duration: Element, ticks: number): Uint8Array<ArrayBuffer> {
  if (duration.size !== 4 && duration.size !== 8) {
    throw new Error(`the Duration element holds ${duration.size} bytes, which is neither a 32 nor a 64 bit float`)
  }
  const out = bytes.slice()
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  if (duration.size === 4) view.setFloat32(duration.dataStart, ticks)
  else view.setFloat64(duration.dataStart, ticks)
  return out
}

/** A WebM unsigned integer: big endian, any width from one to eight bytes. */
function readUint(bytes: Uint8Array, element: Element): number {
  if (element.size === null || element.size > 8) throw new Error('the element is not an unsigned integer')

  let value = 0
  for (let i = 0; i < element.size; i++) value = value * 256 + bytes[element.dataStart + i]

  return value
}

// timecodeScaleNs is the length of one Duration tick. A file that leaves
// it out uses the one millisecond the format defaults to.
function timecodeScaleNs(bytes: Uint8Array, info: Element, infoEnd: number): number {
  let cursor = info.dataStart

  while (cursor < infoEnd) {
    const child = readElement(bytes, cursor)
    if (child.id === TIMECODE_SCALE) return readUint(bytes, child)

    cursor = elementEnd(child, infoEnd)
  }

  return DEFAULT_TIMECODE_SCALE_NS
}

function rewrite(bytes: Uint8Array, durationMs: number): Uint8Array<ArrayBuffer> {
  const header = readElement(bytes, 0)
  if (header.id !== EBML_HEADER) throw new Error('the file does not start with an EBML header')
  const segment = readElement(bytes, elementEnd(header, bytes.length))
  if (segment.id !== SEGMENT) throw new Error('the EBML header is not followed by a Segment')

  const info = findChild(bytes, segment, INFO, 'Info', bytes.length)
  const infoEnd = elementEnd(info, bytes.length)
  const ticks = (durationMs * NANOS_PER_MS) / timecodeScaleNs(bytes, info, infoEnd)

  if (!Number.isFinite(ticks) || ticks <= 0) throw new Error(`the recording lasted ${durationMs}ms, which is no ticks at all`)

  let cursor = info.dataStart
  while (cursor < infoEnd) {
    const child = readElement(bytes, cursor)
    if (child.id === DURATION) return overwriteDuration(bytes, child, ticks)
    cursor = elementEnd(child, infoEnd)
  }

  // Growing Info shifts everything after it, which a Segment with a known
  // size would then have wrong. MediaRecorder only ever writes the unknown
  // size, so refusing here keeps a hand-built file intact.
  if (segment.size !== null) {
    throw new Error('the Segment has a fixed size, so its Info element cannot grow')
  }

  return insertDuration(bytes, info, infoEnd, ticks)
}

/**
 * Returns the same WebM bytes with the Segment's Info element carrying
 * `durationMs` as its Duration, which is what lets a player seek.
 */
export function withDuration(bytes: Uint8Array, durationMs: number): Uint8Array<ArrayBuffer> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`the recording lasted ${durationMs}ms, which is not a usable duration`)
  }
  try {
    return rewrite(bytes, durationMs)
  } catch (err) {
    throw new Error(`cannot write a duration into this WebM file: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}
