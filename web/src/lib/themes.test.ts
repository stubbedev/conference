import assert from 'node:assert/strict'
import { test } from 'node:test'

import { THEME_LABELS, THEMES, TOGGLE_THEMES } from './themes.ts'

test('the toggle covers dark and light', () => {
  assert.deepEqual([...TOGGLE_THEMES], ['dark', 'light'])
})

test('a theme the toggle cycles is one the settings can pick too', () => {
  for (const theme of TOGGLE_THEMES) assert.ok(THEMES.includes(theme), `${theme} is not a theme`)
})

test('cyberchat is picked in the settings, not cycled past', () => {
  assert.ok(THEMES.includes('hud'))
  assert.ok(!TOGGLE_THEMES.includes('hud' as (typeof TOGGLE_THEMES)[number]))
})

test('every theme has a label and every label names a theme', () => {
  assert.deepEqual(Object.keys(THEME_LABELS).sort(), [...THEMES].sort())
})

test('a click from a theme off the toggle lands on the first one', () => {
  const next = TOGGLE_THEMES[(TOGGLE_THEMES.indexOf('hud' as (typeof TOGGLE_THEMES)[number]) + 1) % TOGGLE_THEMES.length]
  assert.equal(next, 'dark')
})
