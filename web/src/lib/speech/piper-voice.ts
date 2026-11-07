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
  phonemeIds: Record<string, number[]>
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
    phonemeIds: phonemeIdMap(root.phoneme_id_map),
  }
}

export type VoiceInput =
  | { name: string; type: 'int64'; data: BigInt64Array; dims: number[] }
  | { name: string; type: 'float32'; data: Float32Array; dims: number[] }

export function voiceInputs(ids: readonly number[], config: VoiceConfig, speaker: number | null): VoiceInput[] {
  const inputs: VoiceInput[] = [
    { name: 'input', type: 'int64', data: BigInt64Array.from(ids, (id) => BigInt(id)), dims: [1, ids.length] },
    { name: 'input_lengths', type: 'int64', data: BigInt64Array.of(BigInt(ids.length)), dims: [1] },
    {
      name: 'scales',
      type: 'float32',
      data: Float32Array.of(config.noiseScale, config.lengthScale, config.noiseWidth),
      dims: [3],
    },
  ]
  if (speaker !== null) inputs.push({ name: 'sid', type: 'int64', data: BigInt64Array.of(BigInt(speaker)), dims: [1] })
  return inputs
}

export function speakerId(speakers: Record<string, number>, voice: string): number | null {
  const ids = Object.values(speakers)
  if (ids.length === 0) return null
  return speakers[voice] ?? Math.min(...ids)
}

const BOS = '^'
const EOS = '$'
const PAD = '_'

export function phonemes(lines: readonly string[]): string[][] {
  const sentences: string[][] = []
  for (const line of lines) {
    const list = json(line)?.phonemes
    if (!Array.isArray(list)) continue
    sentences.push(list.filter((phoneme): phoneme is string => typeof phoneme === 'string'))
  }
  return sentences
}

export function phonemeIds(sentences: readonly (readonly string[])[], map: Readonly<Record<string, number[]>>): number[] {
  const pad = map[PAD] ?? []
  const ids: number[] = []
  for (const sentence of sentences) {
    const known = sentence.flatMap((phoneme) => map[phoneme] ?? [])
    if (known.length === 0) continue

    ids.push(...(map[BOS] ?? []), ...pad)
    for (const phoneme of sentence) {
      const mapped = map[phoneme]
      if (mapped) ids.push(...mapped, ...pad)
    }
    ids.push(...(map[EOS] ?? []))
  }
  return ids
}

function json(line: string): Record<string, unknown> | null {
  const start = line.indexOf('{')
  if (start < 0) return null

  try {
    const parsed: unknown = JSON.parse(line.slice(start))
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

function phonemeIdMap(value: unknown): Record<string, number[]> {
  const listed = record(value, 'phoneme_id_map')
  const map: Record<string, number[]> = {}
  for (const [phoneme, ids] of Object.entries(listed)) {
    if (Array.isArray(ids) && ids.length > 0 && ids.every((id) => Number.isInteger(id))) map[phoneme] = ids as number[]
  }
  for (const marker of [BOS, EOS, PAD]) {
    if (!map[marker]) throw new Error(`the voice's phoneme_id_map has no ${marker}`)
  }
  return map
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
