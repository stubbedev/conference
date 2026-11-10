import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  focusKey,
  gridRects,
  nextSpeakerFocus,
  SPEAKER_HOLD_MS,
  spotlightRects,
  type Rect,
} from './recording-layout.ts'

const FRAME: Rect = { x: 0, y: 0, width: 1280, height: 720 }
const GAP = 8

const tile = (key: string, extra: Partial<{ pinned: boolean; screen: boolean }> = {}) => ({ key, pinned: false, screen: false, ...extra })

const inside = (rect: Rect, area: Rect) =>
  rect.x >= area.x - 0.5 && rect.y >= area.y - 0.5 && rect.x + rect.width <= area.x + area.width + 0.5 && rect.y + rect.height <= area.y + area.height + 0.5

test('every participant gets a tile of the same size inside the frame', () => {
  for (const count of [1, 2, 3, 4, 5, 7, 9, 12]) {
    const rects = gridRects(count, FRAME, GAP)
    assert.equal(rects.length, count)
    for (const rect of rects) {
      assert.ok(inside(rect, FRAME), `${count} people: a tile leaves the frame`)
      assert.equal(rect.width, rects[0]?.width)
      assert.equal(rect.height, rects[0]?.height)
    }
  }
})

test('tiles never overlap and keep an even gap', () => {
  const rects = gridRects(5, FRAME, GAP)
  for (const [i, a] of rects.entries()) {
    for (const b of rects.slice(i + 1)) {
      const apart = a.x + a.width + GAP <= b.x + 0.5 || b.x + b.width + GAP <= a.x + 0.5 || a.y + a.height + GAP <= b.y + 0.5 || b.y + b.height + GAP <= a.y + 0.5
      assert.ok(apart, 'two tiles overlap or touch')
    }
  }
})

test('a short last row is centred under the full ones', () => {
  const rects = gridRects(3, FRAME, GAP)
  const last = rects.at(-1)
  assert.ok(last)
  const firstRowCentre = ((rects[0]?.x ?? 0) + (rects[1]?.x ?? 0) + (rects[1]?.width ?? 0)) / 2
  assert.ok(Math.abs(last.x + last.width / 2 - firstRowCentre) < 1)
})

test('the grid sits in the middle of the frame', () => {
  const rects = gridRects(2, FRAME, GAP)
  const top = Math.min(...rects.map((r) => r.y))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  assert.ok(Math.abs(top - (FRAME.height - bottom)) < 1)
})

test('the spotlight is big and the others sit small and centred below it', () => {
  const { main, strip } = spotlightRects(3, FRAME, GAP)
  assert.equal(strip.length, 3)
  for (const rect of strip) {
    assert.ok(rect.y >= main.y + main.height, 'a small tile overlaps the spotlight')
    assert.ok(rect.height < main.height / 3)
    assert.ok(inside(rect, FRAME))
  }
  const left = strip[0]?.x ?? 0
  const right = (strip.at(-1)?.x ?? 0) + (strip.at(-1)?.width ?? 0)
  assert.ok(Math.abs(left - (FRAME.width - right)) < 1)
})

test('many others shrink to fit the strip instead of being cut off', () => {
  const { strip } = spotlightRects(14, FRAME, GAP)
  assert.equal(strip.length, 14)
  for (const rect of strip) assert.ok(inside(rect, FRAME))
})

test('alone in the spotlight takes the whole frame', () => {
  assert.deepEqual(spotlightRects(0, FRAME, GAP), { main: FRAME, strip: [] })
})

test('the recorder’s pin wins, then a screen share, then the one person speaking', () => {
  assert.equal(focusKey([tile('a'), tile('s', { screen: true }), tile('p', { pinned: true })], 'a'), 'p')
  assert.equal(focusKey([tile('a'), tile('s', { screen: true })], 'a'), 's')
  assert.equal(focusKey([tile('a'), tile('b')], 'b'), 'b')
  assert.equal(focusKey([tile('a'), tile('b')], null), null)
  assert.equal(focusKey([tile('a')], 'gone'), null)
})

test('one person speaking takes the spotlight', () => {
  assert.equal(nextSpeakerFocus(null, ['a'], 1000)?.key, 'a')
})

test('people talking over each other leave the spotlight where it was', () => {
  const focus = nextSpeakerFocus(null, ['a'], 1000)
  assert.equal(nextSpeakerFocus(focus, ['a', 'b'], 1500)?.key, 'a')
  assert.equal(nextSpeakerFocus(null, ['a', 'b'], 1500), null)
})

test('a pause does not drop the speaker at once, but silence does', () => {
  const focus = nextSpeakerFocus(null, ['a'], 1000)
  const pause = nextSpeakerFocus(focus, [], 1000 + SPEAKER_HOLD_MS - 1)
  assert.equal(pause?.key, 'a')
  assert.equal(nextSpeakerFocus(pause, [], 1000 + SPEAKER_HOLD_MS + 1), null)
})

test('someone else speaking alone takes over the spotlight', () => {
  const focus = nextSpeakerFocus(null, ['a'], 1000)
  assert.equal(nextSpeakerFocus(focus, ['b'], 1200)?.key, 'b')
})
