import type { Layer } from './quality.ts'

export const SCREEN_KIND = 'screen'
export const CAMERA_KIND = 'camera'
export const LOCAL_SOURCE = 'local'

export type TileKind = typeof SCREEN_KIND | typeof CAMERA_KIND

export interface Tile {
  key: string
  sourceId: string
  kind: TileKind
  stream: MediaStream | null
}

export function tileLabel(tile: Tile, displayName: string, members: readonly { id: string; name: string }[]): string {
  if (tile.sourceId === LOCAL_SOURCE) {
    return tile.kind === SCREEN_KIND ? 'Your screen' : `${displayName} (you)`
  }
  const name = members.find((member) => member.id === tile.sourceId)?.name ?? 'Guest'
  return tile.kind === SCREEN_KIND ? `${name}'s screen` : name
}

export function layoutLayer(tile: Pick<Tile, 'key' | 'kind'>, pinnedKey: string | null, tileCount: number): Layer {
  if (pinnedKey) return tile.key === pinnedKey ? 'h' : 'l'
  if (tile.kind === SCREEN_KIND) return 'h'
  if (tileCount <= 2) return 'h'
  if (tileCount <= 6) return 'm'
  return 'l'
}
