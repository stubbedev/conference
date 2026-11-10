import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bestGrid, LANDSCAPE_TILE, PORTRAIT_TILE, tileRatio } from './layout.ts'

test('four people on a wide screen sit two by two, as large as the stage allows', () => {
  const grid = bestGrid(4, 1424, 780, LANDSCAPE_TILE, 8)
  assert.equal(grid.columns, 2)
  assert.equal(grid.rows, 2)
  assert.ok(grid.height * 2 + 8 <= 780 && grid.height * 2 + 8 > 760)
})

test('one person fills the stage, and two sit side by side', () => {
  assert.deepEqual(bestGrid(1, 1424, 780, LANDSCAPE_TILE, 8).columns, 1)
  assert.deepEqual(bestGrid(2, 1424, 780, LANDSCAPE_TILE, 8).columns, 2)
})

test('a phone held upright stacks two and puts four in a square', () => {
  const ratio = tileRatio(374, 680)
  assert.equal(ratio, PORTRAIT_TILE)
  assert.equal(bestGrid(2, 374, 680, ratio, 8).columns, 1)
  assert.equal(bestGrid(4, 374, 680, ratio, 8).columns, 2)
})

test('the tiles always fit inside the stage', () => {
  for (const [count, width, height] of [
    [3, 1424, 780],
    [7, 1424, 780],
    [16, 1424, 780],
    [9, 768, 960],
  ]) {
    const grid = bestGrid(count, width, height, tileRatio(width, height), 8)
    assert.ok(grid.columns * grid.width + (grid.columns - 1) * 8 <= width, `${count} wide`)
    assert.ok(grid.rows * grid.height + (grid.rows - 1) * 8 <= height, `${count} high`)
  }
})

test('too many people to fit keep a usable size and scroll instead of shrinking to nothing', () => {
  const grid = bestGrid(60, 374, 680, PORTRAIT_TILE, 8)
  assert.ok(grid.width >= 120)
  assert.ok(grid.rows * grid.height > 680)
})

test('an empty or unmeasured stage lays out nothing', () => {
  assert.equal(bestGrid(0, 1000, 800, LANDSCAPE_TILE, 8).rows, 0)
  assert.equal(bestGrid(4, 0, 0, LANDSCAPE_TILE, 8).width, 0)
})
