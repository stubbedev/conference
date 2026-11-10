import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'

import { useElementSize } from '@/hooks/element-size'
import { useLatest } from '@/hooks/latest'
import { bestGrid, tileRatio } from '@/lib/layout'
import type { RoomClient } from '@/lib/sfu'
import { layoutLayer, LOCAL_SOURCE, type Tile } from '@/lib/tiles'
import { CAMERA_KIND, SCREEN_KIND } from '@/lib/track-kind'

export const TILE_GAP = 8
export const STAGE_TOP = 64
const STAGE_PADDING = 8

type UserPin = { kind: 'auto' } | { kind: 'none' } | { kind: 'tile'; key: string }

function pinnedKeyOf(pin: UserPin, tiles: readonly Tile[]): string | null {
  if (pin.kind === 'none') return null
  if (pin.kind === 'tile' && tiles.some((tile) => tile.key === pin.key)) return pin.key
  return tiles.find((tile) => tile.kind === SCREEN_KIND)?.key ?? null
}

export function useStageLayout(
  localStream: MediaStream | null,
  screenStream: MediaStream | null,
  remoteTiles: readonly Tile[],
) {
  const [userPin, setUserPin] = useState<UserPin>({ kind: 'auto' })

  const allTiles = useMemo<Tile[]>(() => {
    const list: Tile[] = []
    if (screenStream) {
      list.push({ key: 'local:screen', sourceId: LOCAL_SOURCE, kind: SCREEN_KIND, stream: screenStream })
    }
    list.push({ key: 'local:cam', sourceId: LOCAL_SOURCE, kind: CAMERA_KIND, stream: localStream })
    for (const tile of remoteTiles) {
      if (tile.kind === SCREEN_KIND) list.push(tile)
    }
    for (const tile of remoteTiles) {
      if (tile.kind !== SCREEN_KIND) list.push(tile)
    }
    return list
  }, [screenStream, localStream, remoteTiles])

  const pinnedKey = pinnedKeyOf(userPin, allTiles)
  const pinnedTile = pinnedKey ? (allTiles.find((tile) => tile.key === pinnedKey) ?? null) : null
  const stripTiles = pinnedTile ? allTiles.filter((tile) => tile.key !== pinnedKey) : []
  const pinnedKeyRef = useLatest(pinnedKey)

  const togglePin = useCallback(
    (key: string) => {
      setUserPin(pinnedKeyRef.current === key ? { kind: 'none' } : { kind: 'tile', key })
    },
    [pinnedKeyRef],
  )

  const [stageRef, stage] = useElementSize<HTMLElement>()
  const grid = bestGrid(
    allTiles.length,
    stage.width - 2 * STAGE_PADDING,
    stage.height - STAGE_PADDING - STAGE_TOP,
    tileRatio(stage.width, stage.height),
    TILE_GAP,
  )

  return { allTiles, pinnedKey, pinnedTile, stripTiles, togglePin, stageRef, grid }
}

export type StageLayout = ReturnType<typeof useStageLayout>

export function usePreferredLayers(
  clientRef: RefObject<RoomClient | null>,
  live: boolean,
  clientGeneration: number,
  allTiles: readonly Tile[],
  pinnedKey: string | null,
) {
  useEffect(() => {
    const client = clientRef.current
    if (!live || !client) return
    for (const tile of allTiles) {
      if (tile.sourceId === LOCAL_SOURCE) continue
      client.preferLayer(tile.sourceId, tile.kind, layoutLayer(tile, pinnedKey, allTiles.length))
    }
  }, [clientRef, live, clientGeneration, allTiles, pinnedKey])
}
