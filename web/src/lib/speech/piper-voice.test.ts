import assert from 'node:assert/strict'
import { test } from 'node:test'
import { phonemeIds, readVoiceConfig, speakerId, voiceInputs, type VoiceInput } from './piper-voice.ts'

const voice = {
  audio: { sample_rate: 22050 },
  espeak: { voice: 'da' },
  inference: { noise_scale: 0.5, length_scale: 1.1, noise_w: 0.7 },
}

test('a voice JSON is read into its settings', () => {
  assert.deepEqual(readVoiceConfig(voice), {
    espeak: 'da',
    sampleRate: 22050,
    noiseScale: 0.5,
    lengthScale: 1.1,
    noiseWidth: 0.7,
    speakers: {},
  })
})

test('a voice that leaves the inference settings out gets Piper defaults', () => {
  const config = readVoiceConfig({ audio: { sample_rate: 16000 }, espeak: { voice: 'en-us' } })
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
  assert.throws(() => speakerId({ alice: 0, bob: 1 }, 'female'), /no female speaker/)
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

test('phoneme ids are read from the lines the phonemizer prints', () => {
  const lines = [
    '{"phoneme_ids":[1,0,20,0,2],"phonemes":["h","ə"],"text":"Hej"}',
    'starting up',
    '{"phoneme_ids":[3,4],"phonemes":["d"],"text":"du"}',
  ]
  assert.deepEqual(phonemeIds(lines), [1, 0, 20, 0, 2, 3, 4])
})

test('a phonemizer that printed nothing has no ids', () => {
  assert.deepEqual(phonemeIds([]), [])
  assert.deepEqual(phonemeIds(['not json', '{"phonemes":[]}']), [])
  assert.deepEqual(phonemeIds(['{oops']), [])
})
