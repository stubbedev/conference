import assert from 'node:assert/strict'
import { test } from 'node:test'

import { endsSentence, MAX_HELD_CHARS, Sentences } from './sentences.ts'

test('a sentence ends at its full stop, question or exclamation mark, quotes and brackets after it', () => {
  for (const text of ['Yes.', 'Really?', 'Stop!', 'Wait…', 'He said "no."', '(See above.)', '終わり。']) {
    assert.equal(endsSentence(text), true, text)
  }
  for (const text of ['and then', 'the budget,', 'so: ', '']) assert.equal(endsSentence(text), false, text)
})

test('an utterance that ends a sentence is final at once', () => {
  const sentences = new Sentences()
  assert.deepEqual(sentences.utterance(' Good morning. ', 'silence'), { seq: 0, text: 'Good morning.', final: true })
  assert.deepEqual(sentences.utterance('Shall we?', 'silence'), { seq: 1, text: 'Shall we?', final: true })
})

test('a fragment is held and shown until the sentence it starts ends', () => {
  const sentences = new Sentences()
  assert.deepEqual(sentences.utterance('So the budget for', 'silence'), { seq: 0, text: 'So the budget for', final: false })
  assert.equal(sentences.holding, true)
  assert.deepEqual(sentences.partial('next year'), { seq: 0, text: 'So the budget for next year', final: false })
  assert.deepEqual(sentences.utterance('next year is done.', 'silence'), { seq: 0, text: 'So the budget for next year is done.', final: true })
  assert.equal(sentences.holding, false)
  assert.deepEqual(sentences.partial('Next'), { seq: 1, text: 'Next', final: false })
})

test('a fragment nobody finishes is final once it expires', () => {
  const sentences = new Sentences()
  sentences.utterance('and then', 'silence')
  assert.deepEqual(sentences.expire(), { seq: 0, text: 'and then', final: true })
  assert.equal(sentences.expire(), null)
  assert.deepEqual(sentences.utterance('Done.', 'silence'), { seq: 1, text: 'Done.', final: true })
})

test('silence that was transcribed as nothing changes nothing', () => {
  const sentences = new Sentences()
  assert.equal(sentences.utterance('  ', 'silence'), null)
  assert.equal(sentences.partial(''), null)
  sentences.utterance('half', 'silence')
  assert.deepEqual(sentences.utterance('', 'silence'), { seq: 0, text: 'half', final: false })
})

test('a talker who never pauses at a full stop is cut once the held line grows long', () => {
  const sentences = new Sentences()
  const words = 'and then we '
  let line = sentences.utterance(words, 'silence')
  while (line && !line.final) line = sentences.utterance(words, 'silence')
  assert.ok(line && line.final && line.text.length >= MAX_HELD_CHARS)
  assert.ok(line.text.length < MAX_HELD_CHARS + words.length)
  assert.equal(sentences.holding, false)
})

test('a fragment cut at a short pause is held though the transcription closed it with a full stop', () => {
  const sentences = new Sentences()
  assert.deepEqual(sentences.utterance('Wir müssen die Lieferung um zwei Wochen verschieben.', 'pause'), {
    seq: 0,
    text: 'Wir müssen die Lieferung um zwei Wochen verschieben.',
    final: false,
  })
  assert.deepEqual(sentences.utterance('weil der Zulieferer Probleme hat.', 'silence'), {
    seq: 0,
    text: 'Wir müssen die Lieferung um zwei Wochen verschieben weil der Zulieferer Probleme hat.',
    final: true,
  })
})

test('a fragment cut at a pause ends where its speaker stops', () => {
  const sentences = new Sentences()
  sentences.utterance('We can sync the product images every night.', 'pause')
  assert.deepEqual(sentences.expire(), { seq: 0, text: 'We can sync the product images every night.', final: true })
})

test('a new sentence after a pause keeps the full stop before it', () => {
  const sentences = new Sentences()
  sentences.utterance('The picture is too dark.', 'pause')
  assert.deepEqual(sentences.utterance('Please make it brighter.', 'silence'), {
    seq: 0,
    text: 'The picture is too dark. Please make it brighter.',
    final: true,
  })
})

test('a question cut at a pause keeps its question mark when the next part carries on', () => {
  const sentences = new Sentences()
  sentences.utterance('Does that work for you?', 'pause')
  assert.deepEqual(sentences.partial('or should we'), { seq: 0, text: 'Does that work for you? or should we', final: false })
})

test('a talker cut at every pause is still let go once the held line grows long', () => {
  const sentences = new Sentences()
  let line = sentences.utterance('and then we went on.', 'pause')
  while (line && !line.final) line = sentences.utterance('and then we went on.', 'pause')
  assert.ok(line && line.final && line.text.length >= MAX_HELD_CHARS)
})
