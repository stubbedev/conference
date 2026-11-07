import assert from 'node:assert/strict'
import { test } from 'node:test'

import { invented } from './invented.ts'

test('what Whisper invents for noise is dropped, whatever its case and punctuation', async () => {
  for (const text of [
    'Thank you for watching!',
    ' you',
    'Untertitel der Amara.org-Community',
    'Undertekster af Nicolai Winther',
    'Napisy stworzone przez społeczność Amara.org',
    'Legendas pela comunidade Amara.org',
    'Untertitelung des ZDF, 2020',
    'Спасибо за просмотр!',
    'Sous-titres réalisés para la communauté d’Amara.org',
    '[Musik]',
    '(applause)',
    '♪ ♪',
    '...',
  ]) {
    assert.equal(await invented(text), true, text)
  }
})

test("a phrase repeated over and over is dropped, as Whisper's compression ratio rule does", async () => {
  assert.equal(await invented('I think so. '.repeat(20)), true)
})

test('real speech is kept, including what an invented line starts with', async () => {
  for (const text of [
    'Thank you.',
    'Thank you for watching the demo yesterday, it helped.',
    'Good morning, everyone. Shall we start with the budget for next year?',
    'Ja.',
    'The company community will subscribe to www dot example dot com.',
  ]) {
    assert.equal(await invented(text), false, text)
  }
})
