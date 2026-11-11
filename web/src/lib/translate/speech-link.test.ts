import assert from 'node:assert/strict'
import { test } from 'node:test'

import { afterEnd, MAX_ATTEMPTS, SETTLED_MS, type Ended } from './speech-link.ts'

const REFUSED: Ended = { how: 'refused' }
const DROPPED_AT_ONCE: Ended = { how: 'dropped', lastedMs: 300 }
const DROPPED_AFTER_AN_HOUR: Ended = { how: 'dropped', lastedMs: 3_600_000 }

/** What the bridge does after each of these ends in a row. */
function after(ends: readonly Ended[]): string[] {
  let failures = 0
  return ends.map((ended) => {
    const verdict = afterEnd(failures, ended)
    failures = verdict.failures
    return verdict.next
  })
}

test('a service that turns every attempt away is given up on after a few', () => {
  assert.deepEqual(after(Array<Ended>(MAX_ATTEMPTS).fill(REFUSED)), ['retry', 'retry', 'give-up'])
  assert.match(afterEnd(MAX_ATTEMPTS - 1, REFUSED).detail, /cannot be reached or refused/)
})

test('a connection that opens and drops at once, every time, is given up on as well', () => {
  assert.deepEqual(after(Array<Ended>(MAX_ATTEMPTS).fill(DROPPED_AT_ONCE)), ['retry', 'retry', 'give-up'])
  assert.match(afterEnd(MAX_ATTEMPTS - 1, DROPPED_AT_ONCE).detail, /keeps dropping/)
})

test('attempts that fail in different ways count together', () => {
  assert.deepEqual(after([DROPPED_AT_ONCE, REFUSED, DROPPED_AT_ONCE]), ['retry', 'retry', 'give-up'])
})

test('a connection that lasted starts the count anew when it drops', () => {
  assert.deepEqual(after([REFUSED, REFUSED, DROPPED_AFTER_AN_HOUR, REFUSED, REFUSED, REFUSED]), ['retry', 'retry', 'retry', 'retry', 'retry', 'give-up'])
  assert.deepEqual(afterEnd(MAX_ATTEMPTS - 1, DROPPED_AFTER_AN_HOUR), { failures: 0, next: 'retry', detail: 'The speech connection dropped; reconnecting.' })
})

test('lasting means staying open for the settling time, no less', () => {
  assert.equal(afterEnd(0, { how: 'dropped', lastedMs: SETTLED_MS - 1 }).failures, 1)
  assert.equal(afterEnd(0, { how: 'dropped', lastedMs: SETTLED_MS }).failures, 0)
})

test('the member is told which try this was', () => {
  assert.equal(afterEnd(0, REFUSED).detail, `The speech service did not answer (try 1 of ${MAX_ATTEMPTS}).`)
  assert.equal(afterEnd(1, DROPPED_AT_ONCE).detail, `The speech connection dropped right after it opened (try 2 of ${MAX_ATTEMPTS}).`)
})
