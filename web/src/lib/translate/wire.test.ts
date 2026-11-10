import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LABEL_MAX } from './types.ts'
import { packAudio, parseSpeechMessage, parseVoice } from './wire.ts'

const caption = { type: 'caption', speaker: 'anna', segId: 'anna-3', sourceLang: 'de', lang: 'en', text: 'Good morning.', final: true }

/** A frame as the speech service packs one: header length, header, PCM16. */
function frame(header: unknown, samples: number[], trailing = 0): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const bytes = new Uint8Array(2 + json.length + samples.length * 2 + trailing)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, json.length)
  bytes.set(json, 2)
  samples.forEach((sample, i) => view.setInt16(2 + json.length + i * 2, sample, true))
  return bytes.buffer
}

function refused(parsed: object): string {
  if (!('refused' in parsed) || typeof parsed.refused !== 'string') assert.fail(`read: ${JSON.stringify(parsed)}`)
  return parsed.refused
}

test('microphone audio is framed as the speech service unpacks it', () => {
  const pcm = new Int16Array([1, -2, 3])
  const packed = packAudio({ speaker: 'anna', lang: 'de', voice: 'female' }, pcm.buffer)
  const size = new DataView(packed).getUint16(0)

  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(packed, 2, size))), { speaker: 'anna', lang: 'de', voice: 'female' })
  assert.deepEqual([...new Int16Array(packed.slice(2 + size))], [1, -2, 3])
})

test('a frame of translated voice is read into its language, rate and samples', () => {
  const voice = parseVoice(frame({ speaker: 'anna', segId: 'anna-3', lang: 'en', rate: 16000 }, [0x4000, -0x8000]))
  assert.deepEqual(voice, { lang: 'en', rate: 16000, pcm: new Float32Array([0.5, -1]) })
})

test('a voice frame that is cut short or mislabelled is refused, not played', () => {
  assert.match(refused(parseVoice(new ArrayBuffer(1))), /shorter than its header length/)
  assert.match(refused(parseVoice(frame({ lang: 'en', rate: 16000 }, []).slice(0, 10))), /header runs past the frame/)
  assert.match(refused(parseVoice(frame({ lang: 'en', rate: 16000 }, [1], 1))), /half a sample/)
  assert.match(refused(parseVoice(frame('en', [1]))), /header is not an object/)
  for (const lang of [undefined, '', 7, 'x'.repeat(LABEL_MAX + 1)]) assert.match(refused(parseVoice(frame({ lang, rate: 16000 }, [1]))), /its lang is not a name/)
  for (const rate of [undefined, '16000', 0, -1]) assert.match(refused(parseVoice(frame({ lang: 'en', rate }, [1]))), /rate is not a positive number/)

  const notJSON = new Uint8Array([0, 1, 0x7b, 0, 0])
  assert.match(refused(parseVoice(notJSON.buffer)), /header is not JSON/)
})

test('the service’s caption of its own speaker is read like any caption, and only its fields are kept', () => {
  const { type: _type, ...line } = caption
  assert.deepEqual(parseSpeechMessage(JSON.stringify({ ...caption, html: '<b>' }), 'anna'), { type: 'caption', caption: { k: 'caption', ...line } })
})

test('a caption with a field missing is refused, never completed', () => {
  for (const field of ['speaker', 'segId', 'sourceLang', 'lang', 'text', 'final']) {
    assert.match(refused(parseSpeechMessage(JSON.stringify({ ...caption, [field]: undefined }), 'anna')), new RegExp(field))
  }
})

test('the service captions the member it was opened for and nobody else', () => {
  assert.match(refused(parseSpeechMessage(JSON.stringify(caption), 'bob')), /captions someone other than its sender/)
})

test('a failed translation and the service being ready are read, and nothing unknown is', () => {
  assert.deepEqual(parseSpeechMessage('{"type":"ready"}', 'anna'), { type: 'ready' })
  assert.deepEqual(parseSpeechMessage('{"type":"notice","code":"translation-failed"}', 'anna'), { type: 'translation-failed' })
  assert.match(refused(parseSpeechMessage('{"type":"notice","code":"on-fire"}', 'anna')), /code this build does not know/)
  assert.match(refused(parseSpeechMessage('{"type":"voice"}', 'anna')), /type this build does not know/)
  assert.match(refused(parseSpeechMessage('caption', 'anna')), /not JSON/)
  assert.match(refused(parseSpeechMessage('"caption"', 'anna')), /not an object/)
})
