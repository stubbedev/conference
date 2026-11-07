import assert from 'node:assert/strict'
import { test } from 'node:test'

import { membershipChanges } from './announce.ts'

const ada = { id: 'a', name: 'Ada' }
const bo = { id: 'b', name: 'Bo' }
const cy = { id: 'c', name: 'Cy' }

test('someone arriving is announced as joined', () => {
  assert.deepEqual(membershipChanges([ada], [ada, bo]), ['Bo joined'])
})

test('someone leaving is announced as left', () => {
  assert.deepEqual(membershipChanges([ada, bo], [ada]), ['Bo left'])
})

test('arrivals come before departures in one update', () => {
  assert.deepEqual(membershipChanges([ada, bo], [ada, cy]), ['Cy joined', 'Bo left'])
})

test('a member whose state changed is not announced again', () => {
  assert.deepEqual(membershipChanges([ada, bo], [{ ...bo }, { ...ada }]), [])
})
