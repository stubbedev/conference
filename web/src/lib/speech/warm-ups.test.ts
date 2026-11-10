import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WarmUps } from './warm-ups.ts'

test('each language other than the target is claimed once, however many members speak it', () => {
  const warmUps = new WarmUps()
  assert.deepEqual(warmUps.claim(['de', 'en', 'de', 'da'], 'en'), [
    { source: 'de', target: 'en' },
    { source: 'da', target: 'en' },
  ])
})

test('a member joining with a language already warmed claims nothing', () => {
  const warmUps = new WarmUps()
  warmUps.claim(['de'], 'en')
  assert.deepEqual(warmUps.claim(['de'], 'en'), [])
})

test('a member joining with a new language claims only that pair', () => {
  const warmUps = new WarmUps()
  warmUps.claim(['de'], 'en')
  assert.deepEqual(warmUps.claim(['de', 'da'], 'en'), [{ source: 'da', target: 'en' }])
})

test('changing the target language claims the pairs into it', () => {
  const warmUps = new WarmUps()
  warmUps.claim(['de', 'da'], 'en')
  assert.deepEqual(warmUps.claim(['de', 'da'], 'da'), [{ source: 'de', target: 'da' }])
})
