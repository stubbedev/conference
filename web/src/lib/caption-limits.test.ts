import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { encryptChat } from './roomkeys.ts'
import { LABEL_MAX, LINE_TEXT_MAX, parseRoomMessage, type TranslationLine } from './translate/types.ts'

interface CaptionLimits {
  captionTextMax: number
  captionLabelMax: number
  captionCiphertextMax: number
}

const limits = JSON.parse(readFileSync(new URL('../../../fixtures/caption-limits.json', import.meta.url), 'utf8')) as CaptionLimits

const LARGEST_UNIT = '\u0001'

function stringifiedBytes(unit: string): number {
  return new TextEncoder().encode(JSON.stringify(unit)).length - '""'.length
}

test('a caption is bounded by the limits the server derives its cap from', () => {
  assert.equal(LINE_TEXT_MAX, limits.captionTextMax)
  assert.equal(LABEL_MAX, limits.captionLabelMax)
})

test('no UTF-16 unit is stringified into more bytes than a control character', () => {
  const largest = stringifiedBytes(LARGEST_UNIT)
  for (const unit of ['a', '"', '\\', '\n', '\u007f', 'é', '€', ' ', '﻿', '\ud800', '\udfff']) {
    assert.ok(stringifiedBytes(unit) <= largest, `${JSON.stringify(unit)} takes ${stringifiedBytes(unit)} bytes`)
  }
  assert.ok(stringifiedBytes('\u{1f600}') <= 2 * largest)
})

test('the largest caption a member accepts seals to exactly the server cap', async () => {
  const label = LARGEST_UNIT.repeat(LABEL_MAX)
  const largest: TranslationLine = {
    k: 'translation',
    by: label,
    speaker: label,
    segId: label,
    sourceLang: label,
    lang: label,
    text: LARGEST_UNIT.repeat(LINE_TEXT_MAX),
    final: false,
  }
  assert.deepEqual(parseRoomMessage(largest, label, { inCall: () => true, translated: () => true }), largest)

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const { ct } = await encryptChat(key, JSON.stringify(largest))
  assert.equal(ct.length, limits.captionCiphertextMax)
})
