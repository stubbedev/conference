import assert from 'node:assert/strict'
import { test } from 'node:test'

import { answerBudget, garbled } from './garbled.ts'

const BUDGET = answerBudget('Hello.')

test('the budget for an answer grows with what it translates, from a floor', () => {
  assert.equal(answerBudget('Hello.'), 24)
  assert.equal(answerBudget('Hi'), 16)
  assert.equal(answerBudget('Good morning, shall we start?'), 116)
})

test('an answer with nothing to read is empty', () => {
  for (const answer of ['', '   ', ',.,', '...', ',,,,,,,,,,,,,,,,']) assert.equal(garbled(answer, 3, BUDGET), 'empty', JSON.stringify(answer))
})

test('an answer that used up its budget ran into the token limit', () => {
  assert.equal(garbled('Ich nicht sicher und so weiter und so fort', BUDGET, BUDGET), 'token-limit')
  assert.equal(garbled('Hallo', BUDGET + 1, BUDGET), 'token-limit')
})

test('a model that loops on a word, a phrase or a punctuation mark repeats itself', () => {
  for (const answer of [
    'Ich Ich Ich Ich Ich Ich Ich Ich',
    'Wenn wir wir wir wir wir',
    'Maria Maria Maria Maria Maria Maria.,....',
    'Do??????????????????????',
    'Ich nicht sicher........................',
    'I think so. I think so. I think so.',
  ]) {
    assert.equal(garbled(answer, 10, BUDGET), 'repetition', answer)
  }
})

test('real translations pass, however short', () => {
  for (const answer of [
    'Hallo.',
    'Hallo!',
    'Hej.',
    'Ja.',
    'Ja, ja, ja.',
    'Guten Morgen, sollen wir mit dem Haushalt beginnen?',
    'Ehrlich gesagt, bin ich nicht sicher, dass das realistisch ist, wenn man bedenkt, wie viele Menschen im Urlaub sind.',
    'Vi brugte omkring 40.000 euro mere end planlagt på markedsføring i sidste kvartal.',
    'We paid 1000000 euros... in total.',
    'Er sagte: „Nein, nein“ – und ging.',
  ]) {
    assert.equal(garbled(answer, 8, BUDGET), null, answer)
  }
})
