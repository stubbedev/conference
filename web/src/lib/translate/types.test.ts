import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LABEL_MAX,
  LINE_TEXT_MAX,
  parseAnnouncement,
  parseLanguageSet,
  parseRoomMessage,
  PROVIDES_NOTHING,
  sameProvides,
  VOICES_MAX,
  type CaptionLine,
  type LangAnnouncement,
  type Room,
  type TranslationLine,
} from './types.ts'

const CALL = ['anna', 'bob', 'cleo']

/** A call of three where Bob is the translator into English. */
const call: Room = {
  inCall: (member) => CALL.includes(member),
  translated: (member, lang) => member === 'bob' && lang === 'en',
}

const caption: CaptionLine = { k: 'caption', speaker: 'anna', segId: 'anna-3', sourceLang: 'de', lang: 'de', text: 'Guten Morgen.', final: true }
const translation: TranslationLine = { ...caption, k: 'translation', by: 'bob', lang: 'en', text: 'Good morning.' }

/** Why a message from sender is refused; fails when it is read instead. */
function refusal(value: unknown, sender: string): string {
  const parsed = parseRoomMessage(value, sender, call)
  if (!('refused' in parsed)) assert.fail(`read as a room message: ${JSON.stringify(value)}`)
  return parsed.refused
}

test('a caption from its own speaker is read as it was sent', () => {
  assert.deepEqual(parseRoomMessage(caption, 'anna', call), caption)
})

test('a translation by its sender of someone in the call is read as it was sent', () => {
  assert.deepEqual(parseRoomMessage(translation, 'bob', call), translation)
})

test('only the fields of a line are kept', () => {
  assert.deepEqual(parseRoomMessage({ ...caption, by: 'bob', html: '<b>' }, 'anna', call), caption)
})

test('a line may be empty and as long as the limit, and no longer', () => {
  for (const text of ['', 'x'.repeat(LINE_TEXT_MAX)]) assert.deepEqual(parseRoomMessage({ ...caption, text }, 'anna', call), { ...caption, text })
  assert.match(refusal({ ...caption, text: 'x'.repeat(LINE_TEXT_MAX + 1) }, 'anna'), /text is longer/)
})

test('what is no caption and no translation is refused', () => {
  for (const value of [undefined, null, 'caption', 7, []]) assert.match(refusal(value, 'anna'), /not an object|neither a caption/)
  assert.match(refusal({ ...caption, k: 'voice' }, 'anna'), /neither a caption nor a translation/)
  assert.match(refusal({ k: 'caption' }, 'anna'), /speaker/)
})

test('a missing, empty, mistyped or oversized name is refused, field by field', () => {
  for (const field of ['speaker', 'segId', 'sourceLang', 'lang']) {
    for (const value of [undefined, '', 7, 'x'.repeat(LABEL_MAX + 1)]) {
      assert.match(refusal({ ...translation, [field]: value }, 'bob'), new RegExp(`its ${field} is not a name`))
    }
  }
})

test('a text that is no string and a final that is no boolean are refused', () => {
  assert.match(refusal({ ...caption, text: ['Guten Morgen.'] }, 'anna'), /text is not a string/)
  assert.match(refusal({ ...caption, final: 'true' }, 'anna'), /final is not a boolean/)
})

test('nobody captions another member’s speech', () => {
  assert.match(refusal(caption, 'bob'), /captions someone other than its sender/)
})

test('a translation names its sender as the translator', () => {
  assert.match(refusal(translation, 'cleo'), /someone other than its sender as its translator/)
  assert.match(refusal({ ...translation, by: undefined }, 'bob'), /someone other than its sender as its translator/)
})

test('a translation of someone who is not in the call is refused', () => {
  assert.match(refusal({ ...translation, speaker: 'mallory' }, 'bob'), /not in the call/)
})

test('a translation from a member who is not the translator into its language is refused', () => {
  assert.match(refusal({ ...translation, by: 'cleo' }, 'cleo'), /not the translator into its language/)
  assert.match(refusal({ ...translation, lang: 'fr' }, 'bob'), /not the translator into its language/)
})

test('the room is asked about the very sentence a translation names', () => {
  const asked: string[][] = []
  const room: Room = { inCall: () => true, translated: (...line) => asked.push(line) > 0 }

  assert.deepEqual(parseRoomMessage(translation, 'bob', room), translation)
  assert.deepEqual(asked, [['bob', 'en', 'anna', 'anna-3']])
})

test('a speaker may put their own words into another language without being the translator', () => {
  const own = { ...translation, by: 'anna' }
  assert.deepEqual(parseRoomMessage(own, 'anna', { ...call, translated: () => false }), own)
})

const announced: LangAnnouncement = {
  lang: 'de',
  voice: true,
  subtitles: false,
  voiceChoice: 'male',
  captions: true,
  translates: 'plain',
  voices: ['en', 'da'],
  ownVoice: false,
}

/** Why a parser refuses value; fails when it reads it instead. */
function refused(parsed: object): string {
  if (!('refused' in parsed) || typeof parsed.refused !== 'string') assert.fail(`read: ${JSON.stringify(parsed)}`)
  return parsed.refused
}

test('an announcement is read as it was sent, and only its fields are kept', () => {
  assert.deepEqual(parseAnnouncement(announced), announced)
  assert.deepEqual(parseAnnouncement({ ...announced, name: 'Anna', html: '<b>' }), announced)
})

test('an announcement with a missing or mistyped field is refused, never completed', () => {
  for (const value of [undefined, null, 'de', 7]) assert.match(refused(parseAnnouncement(value)), /not an object/)
  for (const lang of [undefined, '', 7, 'x'.repeat(LABEL_MAX + 1)]) assert.match(refused(parseAnnouncement({ ...announced, lang })), /its lang is not a name/)
  for (const field of ['voice', 'subtitles', 'captions']) {
    for (const value of [undefined, 'true', 1]) assert.match(refused(parseAnnouncement({ ...announced, [field]: value })), new RegExp(`its ${field} is not a boolean`))
  }
  for (const voiceChoice of [undefined, 'robot', true]) assert.match(refused(parseAnnouncement({ ...announced, voiceChoice })), /voiceChoice/)
  for (const translates of [undefined, 'perfect', true]) assert.match(refused(parseAnnouncement({ ...announced, translates })), /translates/)
  for (const voices of [undefined, 'en', [7], [''], ['x'.repeat(LABEL_MAX + 1)], Array<string>(VOICES_MAX + 1).fill('en')]) {
    assert.match(refused(parseAnnouncement({ ...announced, voices })), /its voices is not a list/)
  }
})

test('a member who provides nothing announces just that', () => {
  assert.deepEqual(parseAnnouncement({ ...announced, ...PROVIDES_NOTHING }), {
    ...announced,
    captions: false,
    translates: 'none',
    voices: [],
    ownVoice: false,
  })
})

test('a member on a build without own voice announces none', () => {
  const { ownVoice: _none, ...older } = { ...announced, ...PROVIDES_NOTHING }
  assert.deepEqual(parseAnnouncement(older), { ...announced, ...PROVIDES_NOTHING })
  assert.deepEqual(parseAnnouncement({ ...announced, ...PROVIDES_NOTHING, ownVoice: true }), {
    ...announced,
    ...PROVIDES_NOTHING,
    ownVoice: true,
  })
  for (const ownVoice of ['true', 1, null]) {
    assert.match(refused(parseAnnouncement({ ...announced, ...PROVIDES_NOTHING, ownVoice })), /its ownVoice is not a boolean/)
  }
})

test('what a member provides is the same until one of its facts changes', () => {
  const provides = { captions: true, translates: 'plain', voices: ['da', 'en'], ownVoice: false } as const
  assert.ok(sameProvides(provides, { ...provides, voices: ['da', 'en'] }))
  assert.ok(!sameProvides(provides, { ...provides, captions: false }))
  assert.ok(!sameProvides(provides, { ...provides, translates: 'none' }))
  assert.ok(!sameProvides(provides, { ...provides, ownVoice: true }))
  assert.ok(!sameProvides(provides, { ...provides, voices: ['da'] }))
  assert.ok(!sameProvides(provides, { ...provides, voices: ['da', 'fr'] }))
})

test('the language a host sets is a name, and nothing else is kept', () => {
  assert.deepEqual(parseLanguageSet({ lang: 'da', voice: false }), { lang: 'da' })
  for (const value of [undefined, null, 'da']) assert.match(refused(parseLanguageSet(value)), /not an object/)
  for (const lang of [undefined, '', 7, 'x'.repeat(LABEL_MAX + 1)]) assert.match(refused(parseLanguageSet({ lang })), /its lang is not a name/)
})
