// The speech service's WebSocket protocol as a browser speaks it (see
// internal/speech/wire): binary frames are a 2-byte big-endian header
// length, a JSON header and PCM16 little-endian mono samples; text
// frames are JSON messages. What arrives is parsed here, every field
// checked, or refused with the reason.

import type { Refused } from '../sealed.ts'
import { isLabel, noLabel, parseCaption, type CaptionLine, type VoiceChoice } from './types.ts'

const HEADER_BYTES = 2
const SAMPLE_BYTES = Int16Array.BYTES_PER_ELEMENT

/** Heads a frame of this member's microphone audio. */
export interface AudioHeader {
  speaker: string
  lang: string
  voice: VoiceChoice
}

export function packAudio(header: AudioHeader, pcm: ArrayBuffer): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const frame = new Uint8Array(HEADER_BYTES + json.length + pcm.byteLength)
  new DataView(frame.buffer).setUint16(0, json.length)
  frame.set(json, HEADER_BYTES)
  frame.set(new Uint8Array(pcm), HEADER_BYTES + json.length)
  return frame.buffer
}

/** A sentence of this member's speech, spoken in another language. */
export interface Voice {
  lang: string
  rate: number
  pcm: Float32Array
}

function parseJSON(text: string): { value: unknown } | Refused {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return { refused: 'it is not JSON' }
  }
}

/** parseVoice reads a binary frame of translated voice. */
export function parseVoice(frame: ArrayBuffer): Voice | Refused {
  if (frame.byteLength < HEADER_BYTES) return { refused: 'it is shorter than its header length' }

  const samplesAt = HEADER_BYTES + new DataView(frame).getUint16(0)
  if (samplesAt > frame.byteLength) return { refused: 'its header runs past the frame' }
  if ((frame.byteLength - samplesAt) % SAMPLE_BYTES !== 0) return { refused: 'its audio ends in half a sample' }

  const header = parseJSON(new TextDecoder().decode(new Uint8Array(frame, HEADER_BYTES, samplesAt - HEADER_BYTES)))
  if ('refused' in header) return { refused: 'its header is not JSON' }
  if (typeof header.value !== 'object' || header.value === null) return { refused: 'its header is not an object' }

  const { lang, rate } = header.value as Record<string, unknown>
  if (!isLabel(lang)) return noLabel('lang')
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return { refused: 'its rate is not a positive number' }

  const samples = new Int16Array(frame.slice(samplesAt))
  const pcm = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) pcm[i] = samples[i] / 0x8000
  return { lang, rate, pcm }
}

/** What the speech service says in text. */
export type SpeechMessage =
  | { type: 'ready' }
  | { type: 'caption'; caption: CaptionLine }
  | { type: 'translation-failed' }

/**
 * parseSpeechMessage reads a text frame of the speech service that
 * transcribes speaker. A caption is checked like one another member
 * sends: the service captions the member it was opened for, and nobody
 * else.
 */
export function parseSpeechMessage(data: string, speaker: string): SpeechMessage | Refused {
  const parsed = parseJSON(data)
  if ('refused' in parsed) return parsed
  if (typeof parsed.value !== 'object' || parsed.value === null) return { refused: 'it is not an object' }

  const fields = parsed.value as Record<string, unknown>
  switch (fields.type) {
    case 'ready':
      return { type: 'ready' }
    case 'caption': {
      const caption = parseCaption(fields, speaker)
      return 'refused' in caption ? caption : { type: 'caption', caption }
    }
    case 'notice':
      if (fields.code !== 'translation-failed') return { refused: 'it is a notice with a code this build does not know' }
      return { type: 'translation-failed' }
    default:
      return { refused: 'it is of a type this build does not know' }
  }
}
