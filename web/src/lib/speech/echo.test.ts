import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ECHO_LATENCY_MS, Echoes } from './echo.ts'

const VOICE = { from: 10_000, until: 14_000 }

function played(text: string, span = VOICE): Echoes {
  const echoes = new Echoes()
  echoes.play('anna-1', text, span)
  return echoes
}

test('the microphone hearing a played voice is an echo, whatever the transcription did to case and punctuation', () => {
  const echoes = played('Guten Morgen, sollen wir mit dem Budget anfangen?')
  assert.equal(echoes.echoes('guten morgen sollen wir mit dem budget anfangen', { from: 10_200, until: 14_400 }), true)
})

test('a transcription that misheard a few words of the voice is still an echo', () => {
  const echoes = played('Guten Morgen, sollen wir mit dem Budget anfangen?')
  assert.equal(echoes.echoes('Guten Morgen, wollen wir mit dem Bucket anfangen?', { from: 10_200, until: 14_400 }), true)
})

test('part of a long voice, cut off at a pause, is an echo', () => {
  const echoes = played('Wir haben das Budget geprüft, und die Zahlen für das dritte Quartal sehen besser aus als erwartet.')
  assert.equal(echoes.echoes('Wir haben das Budget geprüft.', { from: 10_100, until: 12_000 }), true)
  assert.equal(echoes.echoes('Die Zahlen für das dritte Quartal sehen besser aus.', { from: 12_300, until: 14_200 }), true)
})

test('a short voice heard back whole is an echo', () => {
  assert.equal(played('Ja.').echoes('Ja', { from: 10_100, until: 10_900 }), true)
})

test('a reply that shares a word or two with the voice is the member speaking', () => {
  const echoes = played('Ja, das stimmt, sehr gut gemacht.')
  assert.equal(echoes.echoes('Ja.', { from: 13_000, until: 14_500 }), false)
  assert.equal(echoes.echoes('Gut, dann machen wir weiter mit dem Plan.', { from: 13_000, until: 15_000 }), false)
})

test('the same words said once the voice has long finished are the member speaking', () => {
  const echoes = played('Sollen wir anfangen?')
  const later = VOICE.until + ECHO_LATENCY_MS + 1
  assert.equal(echoes.echoes('Sollen wir anfangen?', { from: later, until: later + 1_500 }), false)
  assert.equal(echoes.echoes('Sollen wir anfangen?', { from: 6_000, until: 9_999 }), false)
})

test('every clause a voice speaks counts toward when it played', () => {
  const echoes = new Echoes()
  echoes.play('anna-1', 'Guten Morgen, sollen wir anfangen?', { from: 10_000, until: 11_000 })
  echoes.play('anna-1', 'Guten Morgen, sollen wir anfangen?', { from: 11_000, until: 13_000 })
  assert.equal(echoes.echoes('Guten Morgen, sollen wir anfangen?', { from: 10_500, until: 14_000 }), true)
  assert.equal(echoes.echoes('Guten Morgen, sollen wir anfangen?', { from: 7_000, until: 9_500 }), false)
})

test('silence and noise transcribed as nothing are never an echo', () => {
  assert.equal(played('Ja.').echoes(' … ', { from: 10_100, until: 10_900 }), false)
})

test('only the most recent voices are remembered', () => {
  const echoes = new Echoes()
  echoes.play('first', 'Guten Morgen, sollen wir anfangen?', VOICE)
  for (let n = 0; n < 16; n++) echoes.play(`later-${n}`, `Satz Nummer ${n} ist ein anderer.`, VOICE)
  assert.equal(echoes.echoes('Guten Morgen, sollen wir anfangen?', { from: 10_200, until: 14_000 }), false)
  assert.equal(echoes.echoes('Satz Nummer 15 ist ein anderer.', { from: 10_200, until: 14_000 }), true)
})
