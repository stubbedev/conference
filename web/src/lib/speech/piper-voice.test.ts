import assert from 'node:assert/strict'
import { test } from 'node:test'
import { phonemeIds, phonemes, readVoiceConfig, speakerId, voiceInputs, type VoiceInput } from './piper-voice.ts'

const voice = {
  audio: { sample_rate: 22050 },
  espeak: { voice: 'da' },
  inference: { noise_scale: 0.5, length_scale: 1.1, noise_w: 0.7 },
  phoneme_id_map: { _: [0], '^': [1], $: [2], h: [20], ə: [59] },
}

test('a voice JSON is read into its settings', () => {
  assert.deepEqual(readVoiceConfig(voice), {
    espeak: 'da',
    sampleRate: 22050,
    noiseScale: 0.5,
    lengthScale: 1.1,
    noiseWidth: 0.7,
    speakers: {},
    phonemeIds: { _: [0], '^': [1], $: [2], h: [20], ə: [59] },
  })
})

test('a voice that leaves the inference settings out gets Piper defaults', () => {
  const config = readVoiceConfig({ ...voice, inference: undefined })
  assert.equal(config.noiseScale, 0.667)
  assert.equal(config.lengthScale, 1)
  assert.equal(config.noiseWidth, 0.8)
})

test('a voice without a sample rate is refused', () => {
  assert.throws(() => readVoiceConfig({ espeak: { voice: 'da' } }), /audio/)
  assert.throws(() => readVoiceConfig({ audio: {}, espeak: { voice: 'da' } }), /audio.sample_rate/)
})

test('a voice without an espeak voice is refused', () => {
  assert.throws(() => readVoiceConfig({ audio: { sample_rate: 22050 } }), /espeak/)
})

test('a speaker map is read, and junk in it is left out', () => {
  const config = readVoiceConfig({ ...voice, speaker_id_map: { male: 1, female: 0, other: 'x' } })
  assert.deepEqual(config.speakers, { male: 1, female: 0 })
})

test('the voice choice picks a speaker, and a voice with one speaker needs none', () => {
  assert.equal(speakerId({}, 'female'), null)
  assert.equal(speakerId({ female: 2, male: 4 }, 'male'), 4)
})

test('a voice whose speakers are not a female and a male one speaks with its first', () => {
  assert.equal(speakerId({ bob: 3, alice: 1, carol: 2 }, 'female'), 1)
  assert.equal(speakerId({ male: 5, neutral: 0 }, 'female'), 0)
})

function values(input: VoiceInput): number[] {
  return input.type === 'int64' ? Array.from(input.data, Number) : Array.from(input.data)
}

test('a sentence is one batch item: its ids, their count, the scales, and the speaker when there is one', () => {
  const config = readVoiceConfig(voice)
  const inputs = voiceInputs([1, 0, 20, 0, 2], config, null)

  assert.deepEqual(
    inputs.map(({ name, dims }) => [name, dims]),
    [
      ['input', [1, 5]],
      ['input_lengths', [1]],
      ['scales', [3]],
    ],
  )
  assert.deepEqual(values(inputs[1]), [5])
  assert.deepEqual(values(inputs[2]).map((value) => Math.round(value * 10) / 10), [0.5, 1.1, 0.7])

  const sid = voiceInputs([1, 2], config, 3).find((input) => input.name === 'sid')
  assert.deepEqual(sid && [values(sid), sid.dims], [[3], [1]])
})

test('the phonemes are read from each line the phonemizer prints, a warning in front of it or not', () => {
  const lines = [
    '{"phoneme_ids":[9],"phonemes":["h","ə"],"text":"Hej"}',
    'starting up',
    'Missing phoneme: \u0361 for: {"phoneme_ids":[9],"phonemes":["t","͡","ʃ"],"text":"tsch"}',
    '{oops',
  ]
  assert.deepEqual(phonemes(lines), [['h', 'ə'], ['t', '͡', 'ʃ']])
})

test('phonemes are mapped with the voice\'s own ids, padded and wrapped per sentence as Piper does', () => {
  const map = readVoiceConfig(voice).phonemeIds
  assert.deepEqual(phonemeIds([['h', 'ə'], ['ə']], map), [1, 0, 20, 0, 59, 0, 2, 1, 0, 59, 0, 2])
})

test('a phoneme the voice does not know is skipped, and a sentence of none is no sentence', () => {
  const map = readVoiceConfig(voice).phonemeIds
  assert.deepEqual(phonemeIds([['h', '͡', 'ə']], map), [1, 0, 20, 0, 59, 0, 2])
  assert.deepEqual(phonemeIds([['͡'], []], map), [])
})

test('a voice without the markers Piper wraps a sentence in is refused', () => {
  assert.throws(() => readVoiceConfig({ ...voice, phoneme_id_map: { h: [20] } }), /phoneme_id_map has no/)
  assert.throws(() => readVoiceConfig({ ...voice, phoneme_id_map: undefined }), /phoneme_id_map/)
})
