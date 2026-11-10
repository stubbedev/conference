import assert from 'node:assert/strict'
import { test } from 'node:test'

import { colorScheme, nextToggleTheme, parseThemeChoice, resolveTheme, THEME_LABELS, THEMES, TOGGLE_THEMES } from './themes.ts'

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

test('a click from a theme off the toggle lands on the first one, and the toggle cycles its own', () => {
  assert.equal(nextToggleTheme('hud'), 'dark')
  assert.equal(nextToggleTheme('dark'), 'light')
  assert.equal(nextToggleTheme('light'), 'dark')
})

test('a stored theme is kept, and anything else falls to the default', () => {
  assert.equal(parseThemeChoice('light'), 'light')
  assert.equal(parseThemeChoice('hud'), 'hud')
  assert.equal(parseThemeChoice('system'), 'system')
  assert.equal(parseThemeChoice(null), 'dark')
  assert.equal(parseThemeChoice('sepia'), 'dark')
})

test('the system choice follows the system, and a theme is itself', () => {
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('hud', false), 'hud')
})

test('only the light theme asks the browser for light form controls', () => {
  assert.equal(colorScheme('light'), 'light')
  assert.equal(colorScheme('dark'), 'dark')
  assert.equal(colorScheme('hud'), 'dark')
})
