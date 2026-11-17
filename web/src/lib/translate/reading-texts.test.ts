import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { READING_LANGUAGES, readingText } from './reading-texts.ts'

const shipped = JSON.parse(
  readFileSync(new URL('../../../../internal/speech/service/languages.json', import.meta.url), 'utf8'),
) as { code: string }[]

test('every language the speech service ships has a text to read', () => {
  const missing = shipped.map((lang) => lang.code).filter((code) => !READING_LANGUAGES.includes(code))
  assert.deepEqual(missing, [])
})

test('every text is a question-bearing paragraph of about 15 seconds', () => {
  for (const code of READING_LANGUAGES) {
    const { text, read } = readingText(code)
    const words = text.split(/\s+/).length
    assert.equal(read, true, code)
    assert.ok(words >= 25 && words <= 45, `${code}: ${words} words`)
    assert.match(text, /[?;？]/, `${code} has no question`)
  }
})

test('a language without a text gets a prompt to talk freely', () => {
  assert.equal(readingText('xx').read, false)
})
