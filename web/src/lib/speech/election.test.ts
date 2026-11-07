import assert from 'node:assert/strict'
import { test } from 'node:test'

import { translatorFor, type Candidate } from './election.ts'

test('the member who translates best translates, whatever language they speak', () => {
  const room: Candidate[] = [
    { id: 'm1', lang: 'de', translates: 'plain' },
    { id: 'm2', lang: 'en', translates: 'prompted' },
    { id: 'm3', lang: 'de', translates: 'none' },
  ]
  assert.equal(translatorFor('de', room), 'm2')
  assert.equal(translatorFor('da', room), 'm2')
})

test('among equals, a speaker of the language goes first, then the lowest id, in any order', () => {
  const room: Candidate[] = [
    { id: 'm3', lang: 'de', translates: 'plain' },
    { id: 'm0', lang: 'en', translates: 'plain' },
    { id: 'm2', lang: 'de', translates: 'plain' },
  ]
  assert.equal(translatorFor('de', room), 'm2')
  assert.equal(translatorFor('de', [...room].reverse()), 'm2')
  assert.equal(translatorFor('en', room), 'm0')
  assert.equal(translatorFor('da', room), 'm0')
})

test('a room where nobody can translate has no translator', () => {
  assert.equal(translatorFor('da', [{ id: 'm1', lang: 'da', translates: 'none' }]), null)
  assert.equal(translatorFor('da', []), null)
})
