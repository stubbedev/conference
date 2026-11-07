export interface GridLayout {
  columns: number
  rows: number
  width: number
  height: number
}

export const LANDSCAPE_TILE = 16 / 9
export const PORTRAIT_TILE = 3 / 4
const MIN_TILE_WIDTH = 120

export function tileRatio(width: number, height: number): number {
  return height > width ? PORTRAIT_TILE : LANDSCAPE_TILE
}

export function bestGrid(count: number, width: number, height: number, ratio: number, gap: number): GridLayout {
  if (count <= 0 || width <= 0 || height <= 0) return { columns: 1, rows: 0, width: 0, height: 0 }

  let best: GridLayout = { columns: 1, rows: count, width: 0, height: 0 }
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns)
    const fitWidth = (width - gap * (columns - 1)) / columns
    const fitHeight = (height - gap * (rows - 1)) / rows
    const tileWidth = Math.floor(Math.min(fitWidth, fitHeight * ratio))
    if (tileWidth > best.width) best = { columns, rows, width: tileWidth, height: Math.floor(tileWidth / ratio) }
  }

  if (best.width >= MIN_TILE_WIDTH) return best
  const columns = Math.max(1, Math.floor((width + gap) / (MIN_TILE_WIDTH + gap)))
  const tileWidth = Math.floor((width - gap * (columns - 1)) / columns)
  return { columns, rows: Math.ceil(count / columns), width: tileWidth, height: Math.floor(tileWidth / ratio) }
}
