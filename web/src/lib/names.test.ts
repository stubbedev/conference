import assert from 'node:assert/strict'
import { test } from 'node:test'

import { avatarColor, initials, storedDisplayName } from './names.ts'

test('initials take the first and last word, or the first two letters of one', () => {
  assert.equal(initials('Hana Sato'), 'HS')
  assert.equal(initials('Ama Kofi Owusu'), 'AO')
  assert.equal(initials('gerd'), 'GE')
  assert.equal(initials('  '), '?')
})

test('a member keeps one avatar colour wherever they appear', () => {
  assert.equal(avatarColor('member-1'), avatarColor('member-1'))
  assert.match(avatarColor('member-2'), /^bg-/)
})

test('a stored name is kept as it is, anything else becomes a random name', () => {
  assert.equal(storedDisplayName('Hana Sato'), 'Hana Sato')
  assert.equal(storedDisplayName(''), '')
  for (const stored of [undefined, null, 7, { name: 'Hana' }]) assert.match(storedDisplayName(stored), /^[A-Z][a-z]+ [A-Z][a-z]+$/)
})
