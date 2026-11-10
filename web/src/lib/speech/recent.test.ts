import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Recent } from './recent.ts'

test('a result asked for again is answered from memory', () => {
  const recent = new Recent<string>(2)
  recent.set('a', 'A')
  assert.equal(recent.get('a'), 'A')
  assert.equal(recent.get('b'), undefined)
})

test('the least recently used result makes room for a new one', () => {
  const recent = new Recent<string>(2)
  recent.set('a', 'A')
  recent.set('b', 'B')
  recent.get('a')
  recent.set('c', 'C')
  assert.equal(recent.get('b'), undefined)
  assert.equal(recent.get('a'), 'A')
  assert.equal(recent.get('c'), 'C')
})

test('a cache without room is refused', () => {
  assert.throws(() => new Recent<string>(0), RangeError)
})
