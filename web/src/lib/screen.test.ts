import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SCREEN_AUDIO_KIND, screenTracks } from './screen.ts'

const track = (id: string, kind: 'audio' | 'video', readyState: MediaStreamTrackState = 'live') =>
  ({ id, kind, readyState }) as MediaStreamTrack

test('a share gets its sound merged into its picture', () => {
  const merged = screenTracks([track('v', 'video')], [track('a', 'audio')])
  assert.deepEqual(
    merged.map((t) => t.id),
    ['v', 'a'],
  )
})

test('the same track arriving twice is not played twice', () => {
  const merged = screenTracks([track('v', 'video')], [track('v', 'video')])
  assert.equal(merged.length, 1)
})

test('a track that already ended is dropped', () => {
  const merged = screenTracks([track('old', 'audio', 'ended')], [track('v', 'video')])
  assert.deepEqual(
    merged.map((t) => t.id),
    ['v'],
  )
})

test('the announced kind for a share is audio to the server', () => {
  assert.equal(SCREEN_AUDIO_KIND, 'screen-audio')
})
