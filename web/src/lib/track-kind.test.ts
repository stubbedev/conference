import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AUDIO_KIND,
  CAMERA_KIND,
  isTileKind,
  SCREEN_AUDIO_KIND,
  SCREEN_KIND,
  tileOf,
  translationKind,
  translationLang,
  type TrackKind,
} from './track-kind.ts'

const GERMAN_VOICE = translationKind('de')
const OWN_KINDS: readonly TrackKind[] = [AUDIO_KIND, CAMERA_KIND, SCREEN_KIND, SCREEN_AUDIO_KIND]

test('the kinds are spelled as the server spells them', () => {
  assert.deepEqual([...OWN_KINDS, GERMAN_VOICE], ['audio', 'camera', 'screen', 'screen-audio', 'translation-de'])
})

test('a translated voice names its language, and no other kind names one', () => {
  assert.equal(translationLang(GERMAN_VOICE), 'de')
  for (const kind of OWN_KINDS) assert.equal(translationLang(kind), null)
})

test('only the pictures are tiles a viewer picks a layer of', () => {
  assert.deepEqual([...OWN_KINDS, GERMAN_VOICE, undefined].filter(isTileKind), [CAMERA_KIND, SCREEN_KIND])
})

test('a microphone is heard in its camera’s tile and a share’s sound in the share’s', () => {
  assert.deepEqual(OWN_KINDS.map(tileOf), [CAMERA_KIND, CAMERA_KIND, SCREEN_KIND, SCREEN_KIND])
})

test('a translated voice has no tile of its own', () => {
  assert.equal(tileOf(GERMAN_VOICE), null)
})
