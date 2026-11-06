import assert from 'node:assert/strict'
import { test } from 'node:test'

import { tilesOfMembers } from './reconnect.ts'

const tile = (sourceId: string, kind = 'camera') => ({ key: `${sourceId}:${kind}`, sourceId, kind })

test('a tile whose member is still in the call stays', () => {
  const kept = tilesOfMembers([tile('alice'), tile('bob')], ['alice', 'bob'])
  assert.equal(kept.length, 2)
})

test('a member who left during the reconnect takes their tiles with them', () => {
  const kept = tilesOfMembers([tile('alice'), tile('bob'), tile('bob', 'screen')], ['alice'])
  assert.deepEqual(
    kept.map((t) => t.key),
    ['alice:camera'],
  )
})

test('nothing survives an empty call', () => {
  assert.deepEqual(tilesOfMembers([tile('alice')], []), [])
})
