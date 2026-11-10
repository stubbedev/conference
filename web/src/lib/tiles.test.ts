import assert from 'node:assert/strict'
import { test } from 'node:test'

import { heardThrough, layoutLayer, type Tile, type Translations } from './tiles.ts'
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

/** What an English listener gets while Bob speaks German and his English voice exists. */
const translations: Translations<string> = {
  on: true,
  lang: 'en',
  voice: true,
  spoken: { bob: 'de' },
  voices: { bob: { en: TRANSLATION } },
}

test('a translated voice replaces the own voice of a member who speaks another language', () => {
  assert.deepEqual(heardThrough(bobCamera, translations), { through: 'translation', stream: TRANSLATION })
})

test('a member is heard through their own voice while live translation is off', () => {
  assert.deepEqual(heardThrough(bobCamera, { ...translations, on: false }), HEARD_OWN)
})

test('a listener who turned translated voices off hears everyone’s own voice', () => {
  assert.deepEqual(heardThrough(bobCamera, { ...translations, voice: false }), HEARD_OWN)
})

test('a member who speaks the listener’s language, or none known yet, keeps their own voice', () => {
  assert.deepEqual(heardThrough(bobCamera, { ...translations, spoken: { bob: 'en' } }), HEARD_OWN)
  assert.deepEqual(heardThrough(bobCamera, { ...translations, spoken: {} }), HEARD_OWN)
})

test('a member keeps their own voice until a translated one exists in the listener’s language', () => {
  assert.deepEqual(heardThrough(bobCamera, { ...translations, voices: {} }), HEARD_OWN)
  assert.deepEqual(heardThrough(bobCamera, { ...translations, voices: { bob: { fr: TRANSLATION } } }), HEARD_OWN)
})

test('a share keeps its own sound while its member is translated', () => {
  assert.deepEqual(heardThrough(bobScreen, translations), HEARD_OWN)
})
