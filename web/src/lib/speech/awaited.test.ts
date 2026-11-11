import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CaptionLine } from '../translate/types.ts'
import { Awaited } from './awaited.ts'

const WAIT_MS = 5000
const EARLIER = ['Guten Morgen.']

const said = (seq: number, final: boolean, speaker = 'anna'): CaptionLine => ({
  k: 'caption',
  speaker,
  segId: `${speaker}-${seq}`,
  sourceLang: 'de',
  lang: 'de',
  text: final ? 'Wie geht es dir?' : 'Wie geht',
  final,
})

const texts = (taken: { caption: CaptionLine }[]): string[] => taken.map(({ caption }) => `${caption.segId} ${caption.final ? 'final' : 'interim'}`)

test('a sentence is waited for from the translator, and no longer than the wait', () => {
  const awaited = new Awaited(WAIT_MS)
  assert.equal(awaited.nextDue, null)

  assert.equal(awaited.heard(said(1, true), EARLIER, 'bob', 1000), 'wait')
  assert.equal(awaited.nextDue, 1000 + WAIT_MS)
  assert.deepEqual(awaited.overdue(1000 + WAIT_MS - 1), [])
  assert.deepEqual(awaited.overdue(1000 + WAIT_MS), [{ caption: said(1, true), earlier: EARLIER }])
  assert.equal(awaited.size, 0, 'a finished sentence the listener took is not kept')
  assert.equal(awaited.nextDue, null)
})

test('a translation that arrives in time settles the sentence', () => {
  const awaited = new Awaited(WAIT_MS)
  awaited.heard(said(1, true), EARLIER, 'bob', 0)
  awaited.translated(said(1, true))

  assert.equal(awaited.size, 0)
  assert.deepEqual(awaited.overdue(WAIT_MS * 2), [])
})

test('nobody waits on a translator that has stopped', () => {
  const awaited = new Awaited(WAIT_MS)
  awaited.heard(said(1, true), EARLIER, 'bob', 0)

  assert.deepEqual(texts(awaited.reassigned(null)), ['anna-1 final'], 'the sentence is the listener’s at once, not after the wait')
  assert.equal(awaited.size, 0)
  assert.equal(awaited.nextDue, null)
})

test('a sentence left to a translator the room has replaced is handed back as well', () => {
  const awaited = new Awaited(WAIT_MS)
  awaited.heard(said(1, true), EARLIER, 'bob', 0)
  awaited.heard(said(1, true, 'dora'), EARLIER, 'bob', 10)

  assert.deepEqual(texts(awaited.reassigned('bob')), [], 'the translator is who it was')
  assert.deepEqual(texts(awaited.reassigned('cleo')), ['anna-1 final', 'dora-1 final'])
})

test('the wait starts with the first state of a sentence and is not put off by its later states', () => {
  const awaited = new Awaited(WAIT_MS)
  awaited.heard(said(1, false), EARLIER, 'bob', 0)
  awaited.heard(said(1, false), EARLIER, 'bob', 2000)
  awaited.heard(said(1, true), EARLIER, 'bob', 4000)

  assert.equal(awaited.nextDue, WAIT_MS)
  assert.deepEqual(texts(awaited.overdue(WAIT_MS)), ['anna-1 final'])
})

test('a sentence the listener took over stays the listener’s until it is finished', () => {
  const awaited = new Awaited(WAIT_MS)
  awaited.heard(said(1, false), EARLIER, 'bob', 0)
  assert.deepEqual(texts(awaited.overdue(WAIT_MS)), ['anna-1 interim'])

  assert.equal(awaited.heard(said(1, false), EARLIER, 'bob', WAIT_MS + 100), 'take', 'no second wait within one sentence')
  assert.equal(awaited.nextDue, null)
  assert.equal(awaited.heard(said(1, true), EARLIER, 'bob', WAIT_MS + 200), 'take')
  assert.equal(awaited.size, 0)

  assert.equal(awaited.heard(said(2, true), EARLIER, 'bob', WAIT_MS + 300), 'wait', 'the next sentence is the translator’s again')
})

test('a translation of an unfinished state ends the wait until the sentence is finished', () => {
  const awaited = new Awaited(WAIT_MS)
  awaited.heard(said(1, false), EARLIER, 'bob', 0)
  awaited.translated(said(1, false))
  assert.equal(awaited.nextDue, null)

  assert.equal(awaited.heard(said(1, false), EARLIER, 'bob', 1000), 'wait')
  assert.equal(awaited.nextDue, null, 'the translator is at work on this sentence')

  awaited.heard(said(1, true), EARLIER, 'bob', 2000)
  assert.equal(awaited.nextDue, 2000 + WAIT_MS, 'the finished sentence is waited for anew')
})

test('once a sentence is finished, only the translation of the finished sentence ends the wait', () => {
  const awaited = new Awaited(WAIT_MS)
  awaited.heard(said(1, false), EARLIER, 'bob', 0)
  awaited.heard(said(1, true), EARLIER, 'bob', 1000)
  awaited.translated(said(1, false))

  assert.equal(awaited.nextDue, WAIT_MS, 'a late translation of an unfinished state leaves the wait running')
  assert.deepEqual(texts(awaited.overdue(WAIT_MS)), ['anna-1 final'])
})

test('an unfinished sentence its speaker has moved on from is not kept', () => {
  const awaited = new Awaited(WAIT_MS)
  awaited.heard(said(1, false), EARLIER, 'bob', 0)
  awaited.overdue(WAIT_MS)
  awaited.heard(said(2, false), EARLIER, 'bob', WAIT_MS + 1000)
  awaited.translated(said(2, false))
  assert.equal(awaited.size, 1, 'the taken sentence 1 went when sentence 2 was heard')

  awaited.heard(said(3, true), EARLIER, 'bob', WAIT_MS + 2000)
  assert.equal(awaited.size, 1, 'and the half-translated sentence 2 when sentence 3 was')
})

test('a finished sentence still waited for outlives the next sentence of its speaker', () => {
  const awaited = new Awaited(WAIT_MS)
  awaited.heard(said(1, true), EARLIER, 'bob', 0)
  awaited.heard(said(2, false), EARLIER, 'bob', 1000)

  assert.deepEqual(texts(awaited.overdue(WAIT_MS)), ['anna-1 final'])
})

test('the sentences of a speaker who is gone are forgotten, and nobody else’s', () => {
  const awaited = new Awaited(WAIT_MS)
  awaited.heard(said(1, true), EARLIER, 'bob', 0)
  awaited.heard(said(1, true, 'dora'), EARLIER, 'bob', 0)
  awaited.forget('anna')

  assert.deepEqual(texts(awaited.overdue(WAIT_MS)), ['dora-1 final'])
})

test('two speakers who number their sentences alike are told apart', () => {
  const awaited = new Awaited(WAIT_MS)
  const dora = { ...said(1, true, 'dora'), segId: 'anna-1' }
  awaited.heard(said(1, true), EARLIER, 'bob', 0)
  awaited.heard(dora, EARLIER, 'bob', 0)
  awaited.translated(dora)

  assert.deepEqual(texts(awaited.overdue(WAIT_MS)), ['anna-1 final'])
})
