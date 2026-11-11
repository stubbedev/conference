import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CHAT_TEXT_MAX, parseChatText, Refusals } from './sealed.ts'

test('a chat message is read as it was written, up to the limit', () => {
  for (const text of ['hi', ' two\nlines ', 'x'.repeat(CHAT_TEXT_MAX)]) assert.deepEqual(parseChatText(text), { text })
})

test('an empty chat message and one over the limit are refused', () => {
  assert.deepEqual(parseChatText(''), { refused: 'it is empty' })
  assert.deepEqual(parseChatText('x'.repeat(CHAT_TEXT_MAX + 1)), { refused: `it is longer than ${CHAT_TEXT_MAX} characters` })
})

test('the longest chat message fits what the server relays, whatever it is written in', () => {
  const relayedCiphertextChars = 16 << 10
  const gcmTagBytes = 16
  const sealedBytes = new TextEncoder().encode('€'.repeat(CHAT_TEXT_MAX)).length + gcmTagBytes
  assert.ok(Math.ceil((sealedBytes * 4) / 3) <= relayedCiphertextChars)
})

test('a refusal is logged once per reason and kind, with the first sender', () => {
  const lines: unknown[][] = []
  const refusals = new Refusals((...line) => lines.push(line))
  const cause = new Error('bad tag')

  refusals.report('a caption', 'anna', 'its text is not a string')
  refusals.report('a caption', 'bob', 'its text is not a string')
  refusals.report('a chat message', 'bob', 'it is empty')
  refusals.report('a caption', 'bob', 'it cannot be opened', cause)

  assert.deepEqual(lines, [
    ['dropping a caption from anna, and every later one like it: its text is not a string'],
    ['dropping a chat message from bob, and every later one like it: it is empty'],
    ['dropping a caption from bob, and every later one like it: it cannot be opened', cause],
  ])
})
