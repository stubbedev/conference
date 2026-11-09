import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CAMERA_KIND, layoutLayer, SCREEN_KIND, type Tile } from './tiles.ts'

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
