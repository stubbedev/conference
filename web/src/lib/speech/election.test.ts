import assert from 'node:assert/strict'
import { test } from 'node:test'

import { translatorFor } from './election.ts'

test('every member of a language agrees on one translator: the lowest id that can translate', () => {
  const room = [
    { id: 'm3', lang: 'de', translates: true },
    { id: 'm1', lang: 'de', translates: false },
    { id: 'm2', lang: 'de', translates: true },
    { id: 'm0', lang: 'en', translates: true },
  ]
  assert.equal(translatorFor('de', room), 'm2')
  assert.equal(translatorFor('de', [...room].reverse()), 'm2')
  assert.equal(translatorFor('en', room), 'm0')
})

test('a language nobody can translate into has no translator', () => {
  assert.equal(translatorFor('da', [{ id: 'm1', lang: 'da', translates: false }]), null)
  assert.equal(translatorFor('da', []), null)
})
