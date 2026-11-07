// What a Piper voice says about itself, read from the JSON beside its
// model and checked before a sentence is handed to a model that would
// otherwise be fed the wrong rate or the wrong speaker. The phonemizer
// answers in JSON lines, one per sentence; reading its ids is here too so
// nothing about a voice's files is parsed in two places.

/** Piper's own defaults, for a voice JSON that leaves them out. */
const NOISE_SCALE = 0.667
const LENGTH_SCALE = 1
const NOISE_WIDTH = 0.8

/** What a Piper voice's JSON says about how to speak with it. */
export interface VoiceConfig {
  /** The espeak-ng voice its phonemes are written in, e.g. da or en-us. */
  espeak: string
  /** The rate of the PCM the model returns. */
  sampleRate: number
  noiseScale: number
  lengthScale: number
  noiseWidth: number
  /** The names of its speakers, empty for a one-speaker voice. */
  speakers: Record<string, number>
}

/** readVoiceConfig checks a voice's JSON and reads the settings out of it. */
export function readVoiceConfig(json: unknown): VoiceConfig {
  const root = record(json, 'voice configuration')
  const espeak = record(root.espeak, 'espeak')
  const audio = record(root.audio, 'audio')
  const inference = root.inference === undefined ? {} : record(root.inference, 'inference')

  return {
    espeak: label(espeak.voice, 'espeak.voice'),
    sampleRate: count(audio.sample_rate, 'audio.sample_rate'),
    noiseScale: ratio(inference.noise_scale, 'inference.noise_scale', NOISE_SCALE),
    lengthScale: ratio(inference.length_scale, 'inference.length_scale', LENGTH_SCALE),
    noiseWidth: ratio(inference.noise_w, 'inference.noise_w', NOISE_WIDTH),
    speakers: speakers(root.speaker_id_map),
  }
}

/**
 * The shape a voice declares for input_lengths. Piper's own exports take
 * one length, [1]; a model exported with a list of them takes one per
 * phoneme id, which is what a dynamic or matching dimension means.
 */
export function lengthsDims(declared: readonly number[] | undefined, length: number): number[] {
  if (declared?.length === 1 && declared[0] === 1) return [1]
  return [length]
}

/** The id of the speaker to speak with, or null when the voice has one speaker. */
export function speakerId(speakers: Record<string, number>, voice: string): number | null {
  const names = Object.keys(speakers)
  if (names.length === 0) return null

  const id = speakers[voice]
  if (id === undefined) throw new Error(`this voice has no ${voice} speaker, only ${names.join(', ')}`)
  return id
}

/** The phoneme ids in the JSON lines the phonemizer printed. */
export function phonemeIds(lines: readonly string[]): number[] {
  const ids: number[] = []
  for (const line of lines) {
    const parsed = json(line)
    const list = parsed?.phoneme_ids
    if (!Array.isArray(list)) continue
    for (const id of list) if (typeof id === 'number') ids.push(id)
  }
  return ids
}

function json(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) return null

  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`the voice has no ${what}`)
  return value as Record<string, unknown>
}

function label(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`the voice has no ${what}`)
  return value
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`the voice has no sensible ${what}`)
  }
  return Math.round(value)
}

function ratio(value: unknown, what: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`the voice's ${what} is not a number`)
  return value
}

function speakers(value: unknown): Record<string, number> {
  if (value === undefined || value === null) return {}

  const listed = record(value, 'speaker_id_map')
  const ids: Record<string, number> = {}
  for (const [name, id] of Object.entries(listed)) {
    if (typeof id === 'number' && Number.isInteger(id)) ids[name] = id
  }
  return ids
}
