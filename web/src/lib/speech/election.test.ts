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

const anna: Candidate = { id: 'anna', lang: 'de', translates: 'none' }
const bob: Candidate = { id: 'bob', lang: 'en', translates: 'plain' }
const cleo: Candidate = { id: 'cleo', lang: 'en', translates: 'prompted' }
const idle = (member: Candidate): Candidate => ({ ...member, translates: 'none' })

test('the translator into a language may translate any sentence, and nobody else may', () => {
  const election = new Election()
  election.hold([anna, bob, idle(cleo)])

  assert.ok(election.translated('bob', 'en', 'anna', 'anna-1'))
  assert.ok(!election.translated('cleo', 'en', 'anna', 'anna-1'))
  assert.ok(!election.translated('bob', 'fr', 'anna', 'anna-1'))
})

test('a translator replaced while a sentence was being translated may still deliver it', () => {
  const election = new Election()
  election.hold([anna, bob, idle(cleo)])
  election.hear('anna', 'anna-1')
  election.hold([anna, bob, cleo])

  assert.equal(election.translatorFor('en'), 'cleo')
  assert.ok(election.translated('bob', 'en', 'anna', 'anna-1'), 'the line was on its way when the room changed its translator')
  assert.ok(election.translated('cleo', 'en', 'anna', 'anna-1'))
})

test('a translator replaced before a sentence was heard may not translate it', () => {
  const election = new Election()
  election.hold([anna, bob, idle(cleo)])
  election.hold([anna, bob, cleo])
  election.hear('anna', 'anna-2')

  assert.ok(!election.translated('bob', 'en', 'anna', 'anna-2'))
  assert.ok(!election.translated('bob', 'en', 'anna', 'anna-never-heard'))
})

test('a sentence is first heard once: a later interim does not shorten who may translate it', () => {
  const election = new Election()
  election.hold([anna, bob, idle(cleo)])
  election.hear('anna', 'anna-1')
  election.hold([anna, bob, cleo])
  election.hear('anna', 'anna-1')

  assert.ok(election.translated('bob', 'en', 'anna', 'anna-1'))
})

test('a sentence is told apart by its speaker, so nobody can stand in for another member’s sentence', () => {
  const election = new Election()
  election.hold([anna, bob, idle(cleo)])
  election.hear('bob', 'anna-1')
  election.hold([anna, bob, cleo])

  assert.ok(!election.translated('bob', 'en', 'anna', 'anna-1'))
})

test('a translator who stopped translating altogether may still deliver the sentence it was on', () => {
  const election = new Election()
  election.hold([anna, bob])
  election.hear('anna', 'anna-1')
  election.hold([anna, idle(bob)])

  assert.equal(election.translatorFor('en'), null)
  assert.ok(election.translated('bob', 'en', 'anna', 'anna-1'))
})

test('a member who left, or a language nobody speaks any more, leaves no past translator behind', () => {
  const election = new Election()
  election.hold([anna, bob, idle(cleo)])
  election.hear('anna', 'anna-1')
  election.hold([anna, cleo])
  assert.ok(!election.translated('bob', 'en', 'anna', 'anna-1'), 'bob left the call')

  election.hold([anna, bob, idle(cleo)])
  election.hear('anna', 'anna-2')
  election.hold([anna, { ...bob, lang: 'de' }, { ...cleo, lang: 'de' }])
  assert.ok(!election.translated('bob', 'en', 'anna', 'anna-2'), 'nobody speaks English any more')
})

test('a translator elected again is the translator, whatever happened in between', () => {
  const election = new Election()
  election.hold([anna, bob, idle(cleo)])
  election.hold([anna, bob, cleo])
  election.hold([anna, bob, idle(cleo)])
  election.hear('anna', 'anna-3')

  assert.ok(election.translated('bob', 'en', 'anna', 'anna-3'))
  assert.ok(!election.translated('cleo', 'en', 'anna', 'anna-3'))
})
