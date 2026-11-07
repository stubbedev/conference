import { bestGrid, LANDSCAPE_TILE } from './layout.ts'

export const SPEAKER_HOLD_MS = 3000
const STRIP_SHARE = 0.2

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutTile {
  key: string
  pinned: boolean
  screen: boolean
}

export interface SpeakerFocus {
  key: string | null
  heardAt: number
}

export const NO_SPEAKER: SpeakerFocus = { key: null, heardAt: 0 }

export function nextSpeakerFocus(focus: SpeakerFocus, speaking: readonly string[], now: number): SpeakerFocus {
  if (speaking.length === 1) return { key: speaking[0] ?? null, heardAt: now }
  if (focus.key !== null && speaking.includes(focus.key)) return { key: focus.key, heardAt: now }
  if (focus.key !== null && now - focus.heardAt < SPEAKER_HOLD_MS) return focus
  return { key: null, heardAt: focus.heardAt }
}

export function focusKey(tiles: readonly LayoutTile[], speaker: string | null): string | null {
  const pinned = tiles.find((tile) => tile.pinned)
  if (pinned) return pinned.key
  const screen = tiles.find((tile) => tile.screen)
  if (screen) return screen.key
  return speaker !== null && tiles.some((tile) => tile.key === speaker) ? speaker : null
}

function centredRow(count: number, tileWidth: number, tileHeight: number, gap: number, area: Rect): Rect[] {
  const rowWidth = count * tileWidth + (count - 1) * gap
  const left = area.x + (area.width - rowWidth) / 2
  const top = area.y + (area.height - tileHeight) / 2
  return Array.from({ length: count }, (_, index) => ({ x: left + index * (tileWidth + gap), y: top, width: tileWidth, height: tileHeight }))
}

export function gridRects(count: number, area: Rect, gap: number): Rect[] {
  if (count <= 0) return []
  const grid = bestGrid(count, area.width, area.height, LANDSCAPE_TILE, gap)
  const blockHeight = grid.rows * grid.height + (grid.rows - 1) * gap
  const top = area.y + (area.height - blockHeight) / 2
  const rects: Rect[] = []
  for (let row = 0; row < grid.rows; row += 1) {
    const inRow = Math.min(grid.columns, count - row * grid.columns)
    const band = { x: area.x, y: top + row * (grid.height + gap), width: area.width, height: grid.height }
    rects.push(...centredRow(inRow, grid.width, grid.height, gap, band))
  }
  return rects
}

export interface Spotlight {
  main: Rect
  strip: Rect[]
}

export function spotlightRects(others: number, area: Rect, gap: number): Spotlight {
  if (others <= 0) return { main: area, strip: [] }
  const stripHeight = Math.round(area.height * STRIP_SHARE)
  const main = { x: area.x, y: area.y, width: area.width, height: area.height - stripHeight - gap }
  const band = { x: area.x, y: area.y + area.height - stripHeight, width: area.width, height: stripHeight }
  const fitted = Math.floor(stripHeight * LANDSCAPE_TILE)
  const shared = Math.floor((area.width - gap * (others - 1)) / others)
  const tileWidth = Math.min(fitted, shared)
  const tileHeight = Math.floor(tileWidth / LANDSCAPE_TILE)
  return { main, strip: centredRow(others, tileWidth, tileHeight, gap, band) }
}
