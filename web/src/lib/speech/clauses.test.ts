import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clauses } from './clauses.ts'

test('a long sentence is spoken a clause at a time', () => {
  assert.deepEqual(clauses('Good morning everyone and welcome, today we look at the budget for next year; then we vote.'), [
    'Good morning everyone and welcome,',
    'today we look at the budget for next year; then we vote.',
  ])
})

test('short pieces stay with their neighbours, so a voice never says one word on its own', () => {
  assert.deepEqual(clauses('Yes, well, I think so.'), ['Yes, well, I think so.'])
  assert.deepEqual(clauses('So, as I was saying about the plan, yes.'), ['So, as I was saying about the plan, yes.'])
})

test('a sentence without a break is one clause, and nothing is no clause', () => {
  assert.deepEqual(clauses('Hello there'), ['Hello there'])
  assert.deepEqual(clauses('   '), [])
})
