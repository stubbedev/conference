import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  announcedKinds,
  AUDIO_KIND,
  CAMERA_KIND,
  isAudioKind,
  isTileKind,
  parseTrackKind,
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

test('every kind reads off the wire as itself', () => {
  for (const kind of [...OWN_KINDS, GERMAN_VOICE]) assert.equal(parseTrackKind(kind), kind)
})

test('what the server would refuse in an offer is no kind', () => {
  for (const wire of ['video', 'Camera', 'translation-', 'translation', '', 7, null, undefined]) {
    assert.equal(parseTrackKind(wire), null, `${String(wire)} was read as a kind`)
  }
})

test('a translated voice cannot be published without a language', () => {
  assert.throws(() => translationKind(''), /language/)
})

test('a microphone, a share’s sound and a translated voice are sounds, a camera and a screen are not', () => {
  assert.deepEqual([...OWN_KINDS, GERMAN_VOICE].filter(isAudioKind), [AUDIO_KIND, SCREEN_AUDIO_KIND, GERMAN_VOICE])
})

test('an offer’s track list is read into the kind of each section', () => {
  const { kinds, refused } = announcedKinds([
    { mid: '0', kind: 'audio' },
    { mid: '1', kind: 'camera' },
    { mid: '2', kind: 'translation-de' },
  ])
  assert.deepEqual([...kinds], [['0', AUDIO_KIND], ['1', CAMERA_KIND], ['2', GERMAN_VOICE]])
  assert.deepEqual(refused, [])
})

test('a section announced with a kind this client does not know is refused, and the rest are kept', () => {
  const unknown = { mid: '1', kind: 'hologram' }
  const { kinds, refused } = announcedKinds([{ mid: '0', kind: 'audio' }, unknown])
  assert.deepEqual([...kinds], [['0', AUDIO_KIND]])
  assert.deepEqual(refused, [unknown])
})

test('an offer that announces no tracks has no kinds', () => {
  assert.deepEqual(announcedKinds([]), { kinds: new Map(), refused: [] })
})
