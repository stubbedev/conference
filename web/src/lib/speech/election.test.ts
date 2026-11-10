import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assignTranslators, Election, type Candidate } from './election.ts'

const shuffled = (room: Candidate[]): Candidate[][] => [room, [...room].reverse(), [...room.slice(1), room[0]]]

test('the languages are shared out among the members who translate best', () => {
  const room: Candidate[] = [
    { id: 'm1', lang: 'en', translates: 'prompted' },
    { id: 'm2', lang: 'de', translates: 'prompted' },
    { id: 'm3', lang: 'da', translates: 'none' },
    { id: 'm4', lang: 'fr', translates: 'none' },
  ]
  for (const order of shuffled(room)) {
    const assigned = assignTranslators(order)
    assert.deepEqual(Object.fromEntries([...assigned].sort()), { da: 'm1', de: 'm2', en: 'm1', fr: 'm2' })
  }
})

test('quality goes first: a member with the language model is not passed over for a plain one', () => {
  const room: Candidate[] = [
    { id: 'm1', lang: 'de', translates: 'plain' },
    { id: 'm2', lang: 'en', translates: 'prompted' },
    { id: 'm3', lang: 'da', translates: 'plain' },
  ]
  assert.deepEqual(Object.fromEntries([...assignTranslators(room)].sort()), { da: 'm2', de: 'm2', en: 'm2' })
})

test('with equal load, a speaker of the language translates into it, then the lowest id', () => {
  const room: Candidate[] = [
    { id: 'm3', lang: 'de', translates: 'plain' },
    { id: 'm0', lang: 'en', translates: 'plain' },
  ]
  for (const order of shuffled(room)) {
    assert.deepEqual(Object.fromEntries(assignTranslators(order)), { de: 'm3', en: 'm0' })
  }
})

test('every member computes the same translators from the same room, in any order', () => {
  const room: Candidate[] = ['en', 'de', 'da', 'sv', 'fi', 'nl'].map((lang, i) => ({ id: `m${i}`, lang, translates: i % 2 ? 'plain' : 'prompted' }))
  const expected = JSON.stringify([...assignTranslators(room)].sort())
  for (const order of shuffled(room)) assert.equal(JSON.stringify([...assignTranslators(order)].sort()), expected)
  assert.equal(new Set(assignTranslators(room).values()).size, 3)
})

test('a room where nobody can translate has no translator', () => {
  assert.equal(assignTranslators([{ id: 'm1', lang: 'da', translates: 'none' }]).size, 0)
  assert.equal(assignTranslators([]).size, 0)
})

test('an election is held again whenever the room is announced anew', () => {
  const election = new Election()
  assert.equal(election.translatorFor('de'), null)

  election.hold([
    { id: 'm1', lang: 'de', translates: 'plain' },
    { id: 'm2', lang: 'en', translates: 'none' },
  ])
  assert.deepEqual(Object.fromEntries(election.translators), { de: 'm1', en: 'm1' })

  election.hold([
    { id: 'm1', lang: 'de', translates: 'none' },
    { id: 'm2', lang: 'en', translates: 'none' },
  ])
  assert.equal(election.translatorFor('de'), null)
  assert.equal(election.translators.size, 0)
})
