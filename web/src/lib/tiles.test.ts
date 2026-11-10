import assert from 'node:assert/strict'
import { test } from 'node:test'

import { heardThrough, layoutLayer, withoutVoice, withVoice, type Speaker, type Tile, type Translations } from './tiles.ts'
import { CAMERA_KIND, SCREEN_KIND } from './track-kind.ts'

const screen: Pick<Tile, 'key' | 'kind'> = { key: 'bob:screen', kind: SCREEN_KIND }
const camera: Pick<Tile, 'key' | 'kind'> = { key: 'bob:cam', kind: CAMERA_KIND }

test('a pinned share gets its fluid layer while the cameras under it get thumbnails', () => {
  assert.equal(layoutLayer(screen, screen.key, 4), 'h')
  assert.equal(layoutLayer(camera, screen.key, 4), 'l')
})

test('a share in the strip under a pinned camera gets its slow layer', () => {
  assert.equal(layoutLayer(screen, camera.key, 4), 'l')
  assert.equal(layoutLayer(camera, camera.key, 4), 'h')
})

test('a share in the grid stays fluid however many tiles share the stage', () => {
  for (const count of [2, 5, 12]) assert.equal(layoutLayer(screen, null, count), 'h')
})

test('a camera in the grid is sized by how many tiles share the stage', () => {
  assert.deepEqual(
    [2, 5, 12].map((count) => layoutLayer(camera, null, count)),
    ['h', 'm', 'l'],
  )
})

const OWN = 'own voice'
const TRANSLATION = 'translated voice'
const bobCamera = { sourceId: 'bob', kind: CAMERA_KIND, stream: OWN } as const
const bobScreen = { sourceId: 'bob', kind: SCREEN_KIND, stream: OWN } as const
const HEARD_OWN = { through: 'own', stream: OWN }
const HEARD_TRANSLATED = { through: 'translation', stream: TRANSLATION }

/** Bob as he announces himself while the speech service voices his German in English. */
const voicedBob: Speaker = { lang: 'de', captions: true, voices: ['en'] }

/** Bob as he announces himself while his own browser captions his German. */
const captionedBob: Speaker = { lang: 'de', captions: true, voices: [] }

const announcing = (bob: Speaker): ReadonlyMap<string, Speaker> => new Map([['bob', bob]])

/** What an English listener gets while Bob speaks German and his English voice arrives from the room. */
const translations: Translations<string> = {
  on: true,
  lang: 'en',
  voice: true,
  announced: announcing(voicedBob),
  published: { bob: { en: TRANSLATION } },
  local: {},
}

/** The same listener while the browsers run the engines, and this one made Bob a voice. */
const madeHere: Translations<string> = { ...translations, announced: announcing(captionedBob), published: {}, local: { bob: TRANSLATION } }

test('a translated voice replaces the own voice of a member who speaks another language', () => {
  assert.deepEqual(heardThrough(bobCamera, translations), HEARD_TRANSLATED)
})

test('a member is heard through their own voice while live translation is off', () => {
  assert.deepEqual(heardThrough(bobCamera, { ...translations, on: false }), HEARD_OWN)
})

test('a listener who turned translated voices off hears everyone’s own voice', () => {
  assert.deepEqual(heardThrough(bobCamera, { ...translations, voice: false }), HEARD_OWN)
  assert.deepEqual(heardThrough(bobCamera, { ...madeHere, voice: false }), HEARD_OWN)
})

test('a member who speaks the listener’s language, or none known yet, keeps their own voice', () => {
  assert.deepEqual(heardThrough(bobCamera, { ...translations, announced: announcing({ ...voicedBob, lang: 'en' }) }), HEARD_OWN)
  assert.deepEqual(heardThrough(bobCamera, { ...translations, announced: new Map() }), HEARD_OWN)
  assert.deepEqual(heardThrough(bobCamera, { ...madeHere, announced: new Map() }), HEARD_OWN)
})

test('a member keeps their own voice until a translated one arrives in the listener’s language', () => {
  assert.deepEqual(heardThrough(bobCamera, { ...translations, published: {} }), HEARD_OWN)
  assert.deepEqual(heardThrough(bobCamera, { ...translations, published: { bob: { fr: TRANSLATION } } }), HEARD_OWN)
})

test('a voice that still arrives but its speaker no longer announces gives way to the speaker’s own', () => {
  const silent = announcing({ ...voicedBob, voices: [] })
  assert.deepEqual(heardThrough(bobCamera, { ...translations, announced: silent }), HEARD_OWN, 'the translator fell silent and kept its track')

  const elsewhere = announcing({ ...voicedBob, voices: ['fr'] })
  assert.deepEqual(heardThrough(bobCamera, { ...translations, announced: elsewhere }), HEARD_OWN, 'the last sentence has a voice in French only')

  assert.deepEqual(heardThrough(bobCamera, { ...translations, announced: announcing(voicedBob) }), HEARD_TRANSLATED, 'the next sentence has a voice again')
})

test('a share keeps its own sound while its member is translated', () => {
  assert.deepEqual(heardThrough(bobScreen, translations), HEARD_OWN)
})

test('a member’s translated voice in one language takes the place of the one it had and of no other', () => {
  const voices = withVoice(withVoice({ bob: { fr: 'French' } }, 'bob', 'en', 'first'), 'bob', 'en', 'second')
  assert.deepEqual(voices, { bob: { fr: 'French', en: 'second' } })
})

test('a voice the listener’s own engines make is heard in the listener’s language, whichever that is by now', () => {
  for (const lang of ['en', 'fr']) assert.deepEqual(heardThrough(bobCamera, { ...madeHere, lang }), HEARD_TRANSLATED)
})

test('a voice made here gives way to the own voice of a speaker who is no longer captioned', () => {
  const uncaptioned = announcing({ ...captionedBob, captions: false })
  assert.deepEqual(heardThrough(bobCamera, { ...madeHere, announced: uncaptioned }), HEARD_OWN)
  assert.deepEqual(heardThrough(bobCamera, madeHere), HEARD_TRANSLATED, 'and takes over again once captions are back')
})

test('a member whose sentence these engines could not voice is heard through their own voice', () => {
  assert.deepEqual(heardThrough(bobCamera, { ...madeHere, local: {} }), HEARD_OWN)
})

test('voices made here and voices from the room each serve their own member', () => {
  const both: Translations<string> = {
    ...translations,
    announced: new Map([
      ['alice', voicedBob],
      ['bob', captionedBob],
    ]),
    published: { alice: { en: 'published' } },
    local: { bob: TRANSLATION },
  }
  assert.deepEqual(heardThrough({ ...bobCamera, sourceId: 'alice' }, both), { through: 'translation', stream: 'published' })
  assert.deepEqual(heardThrough(bobCamera, both), HEARD_TRANSLATED)
})

test('a member whose translated voice is gone is heard through their own voice again', () => {
  const translated = { ...translations, published: withVoice({}, 'bob', 'en', TRANSLATION) }
  assert.deepEqual(heardThrough(bobCamera, translated), HEARD_TRANSLATED)

  const stopped = { ...translated, published: withoutVoice(translated.published, 'bob', 'en', TRANSLATION) }
  assert.deepEqual(stopped.published, {})
  assert.deepEqual(heardThrough(bobCamera, stopped), HEARD_OWN)
})

test('a voice that is gone takes nothing else along', () => {
  const voices = { alice: { en: 'Alice in English' }, bob: { en: TRANSLATION, fr: 'Bob in French' } }
  assert.deepEqual(withoutVoice(voices, 'bob', 'en', TRANSLATION), { alice: { en: 'Alice in English' }, bob: { fr: 'Bob in French' } })
})

test('a voice published anew stays when the one before it is seen to leave only afterwards', () => {
  const restarted = withVoice(withVoice({}, 'bob', 'en', TRANSLATION), 'bob', 'en', 'the new voice')
  assert.equal(withoutVoice(restarted, 'bob', 'en', TRANSLATION), restarted)
  assert.equal(withoutVoice(restarted, 'carol', 'en', TRANSLATION), restarted)
})
