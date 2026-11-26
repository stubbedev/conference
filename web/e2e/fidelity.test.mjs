import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { chrF, FIXTURES, MAX_WORD_ERROR_RATE, MIN_RECORDING_CHRF, MIN_SENTENCE_CHRF, readOracle, scoreTranslations, wordErrorRate } from './fidelity.mjs'

const oracle = readOracle()

function wavFormat(file) {
  const bytes = readFileSync(join(FIXTURES, file))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4)
    const length = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      return { format: view.getUint16(offset + 8, true), channels: view.getUint16(offset + 10, true), rate: view.getUint32(offset + 12, true), bits: view.getUint16(offset + 22, true) }
    }
    offset += 8 + length + (length % 2)
  }
  throw new Error(`${file} has no fmt chunk`)
}

function variants(reference) {
  return Array.isArray(reference) ? reference : [reference]
}

function asSaid(entry, target) {
  return entry.sentences.map((text, at) => ({ text, translation: variants(entry.translations[target][at])[0] }))
}

test('every recording in the oracle is 16 kHz mono 16-bit PCM, as a microphone is captured', () => {
  for (const { recording } of oracle) assert.deepEqual(wavFormat(recording), { format: 1, channels: 1, rate: 16000, bits: 16 }, recording)
})

test('every reference translation lines up with a sentence of its recording', () => {
  for (const { recording, sentences, translations } of oracle) {
    assert.ok(sentences.length > 0, recording)
    for (const [target, references] of Object.entries(translations)) assert.equal(references.length, sentences.length, `${recording} into ${target}`)
  }
})

test('each language the oracle speaks is also spoken by a recorded human voice, with its source and licence', () => {
  const spoken = new Set(oracle.map(({ lang }) => lang))
  const recorded = oracle.filter(({ speech }) => speech === 'recorded')
  assert.deepEqual(new Set(recorded.map(({ lang }) => lang)), spoken)
  for (const { recording, sentences, source } of recorded) {
    assert.ok(source.url && source.license && source.licenseUrl, recording)
    assert.equal(source.clips.length, sentences.length, recording)
  }
  for (const { speech } of oracle) assert.ok(speech === 'recorded' || speech === 'synthetic')
})

test('a transcript is scored by its word errors against what was said', () => {
  assert.equal(wordErrorRate('Bilden är för mörk.', 'bilden är för mörk'), 0)
  assert.equal(wordErrorRate('the picture is to dark', 'The picture is too dark.'), 0.2)
  assert.ok(wordErrorRate('excel ful senast på feda', 'Excel-fil senast på fredag') > MAX_WORD_ERROR_RATE)
})

test('the reference translations pass the thresholds they are held to', () => {
  for (const entry of oracle) {
    for (const target of Object.keys(entry.translations)) {
      const scored = scoreTranslations(asSaid(entry, target), entry.sentences, entry.translations[target])
      assert.ok(scored.whole >= MIN_RECORDING_CHRF, `${entry.recording} into ${target}`)
      for (const { which, score } of scored.sentences) assert.ok(score >= MIN_SENTENCE_CHRF, `${entry.recording} into ${target}, sentence ${which}`)
    }
  }
})

test('a translation that drifts into nonsense after two sentences fails on the sentences where it does', () => {
  const entry = oracle.find(({ recording }) => recording === 'fleurs-german.wav')
  const said = asSaid(entry, 'en').map((line, at) => (at < 2 ? line : { ...line, translation: 'The the wine of the hours, that was the man in the house of the hours.' }))
  const failing = scoreTranslations(said, entry.sentences, entry.translations.en)
    .sentences.filter(({ score }) => score < MIN_SENTENCE_CHRF)
    .map(({ which }) => which)
  assert.deepEqual(failing, ['3', '4', '5', '6'])
})

test('chrF is 100 for the reference itself and falls with every changed character', () => {
  assert.equal(chrF('The picture is too dark.', 'The picture is too dark.'), 100)
  assert.ok(chrF('The picture is too bright.', 'The picture is too dark.') < 100)
})
