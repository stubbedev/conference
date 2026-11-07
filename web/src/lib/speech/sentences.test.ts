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
  assert.deepEqual(sentences.utterance(' Good morning. '), { seq: 0, text: 'Good morning.', final: true })
  assert.deepEqual(sentences.utterance('Shall we?'), { seq: 1, text: 'Shall we?', final: true })
})

test('a fragment is held and shown until the sentence it starts ends', () => {
  const sentences = new Sentences()
  assert.deepEqual(sentences.utterance('So the budget for'), { seq: 0, text: 'So the budget for', final: false })
  assert.equal(sentences.holding, true)
  assert.deepEqual(sentences.partial('next year'), { seq: 0, text: 'So the budget for next year', final: false })
  assert.deepEqual(sentences.utterance('next year is done.'), { seq: 0, text: 'So the budget for next year is done.', final: true })
  assert.equal(sentences.holding, false)
  assert.deepEqual(sentences.partial('Next'), { seq: 1, text: 'Next', final: false })
})

test('a fragment nobody finishes is final once it expires', () => {
  const sentences = new Sentences()
  sentences.utterance('and then')
  assert.deepEqual(sentences.expire(), { seq: 0, text: 'and then', final: true })
  assert.equal(sentences.expire(), null)
  assert.deepEqual(sentences.utterance('Done.'), { seq: 1, text: 'Done.', final: true })
})

test('silence that was transcribed as nothing changes nothing', () => {
  const sentences = new Sentences()
  assert.equal(sentences.utterance('  '), null)
  assert.equal(sentences.partial(''), null)
  sentences.utterance('half')
  assert.deepEqual(sentences.utterance(''), { seq: 0, text: 'half', final: false })
})

test('a talker who never pauses at a full stop is cut once the held line grows long', () => {
  const sentences = new Sentences()
  const words = 'and then we '
  let line = sentences.utterance(words)
  while (line && !line.final) line = sentences.utterance(words)
  assert.ok(line && line.final && line.text.length >= MAX_HELD_CHARS)
  assert.ok(line.text.length < MAX_HELD_CHARS + words.length)
  assert.equal(sentences.holding, false)
})
