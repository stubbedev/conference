import type { CSSProperties } from 'react'

import { PinTarget, SelfView } from '@/components/PhoneStage'
import { VideoTile } from '@/components/VideoTile'
import type { ShownCaption } from '@/hooks/live-translation'
import { CONTROLS_HEIGHT, STAGE_TOP, TILE_GAP, type StageLayout } from '@/hooks/stage-layout'
import type { MemberInfo } from '@/lib/sfu'
import { heardThrough, LOCAL_CAMERA_KEY, LOCAL_SOURCE, tileLabel, type Tile, type Translations } from '@/lib/tiles'
import { SCREEN_KIND } from '@/lib/track-kind'

interface StageProps {
  layout: StageLayout
  selfMember: MemberInfo
  members: readonly MemberInfo[]
  selfId: string
  displayName: string
  captions: Record<string, ShownCaption>
  translations: Translations<MediaStream>
  speaker: string
  volume: number
  controlsOver: boolean
}

type TileView = 'grid' | 'pinned' | 'thumb' | 'bleed' | 'self'

const PHONE_INSET = 12
const PHONE_THUMB = { width: 112, height: 63 }
const SELF_VIEW = { width: 96, height: 128 }

export function Stage({
  layout,
  selfMember,
  members,
  selfId,
  displayName,
  captions,
  translations,
  speaker,
  volume,
  controlsOver,
}: StageProps) {
  const { phone, allTiles, pinnedKey, mainKey, mainTile, stripTiles, togglePin, stageRef, grid } = layout
  const pinnable = allTiles.length > 1
  const label = (tile: Tile) => tileLabel(tile, displayName, members)

  const renderTile = (tile: Tile, view: TileView, pinButton: boolean, bleedCovered = 0) => {
    const isLocal = tile.sourceId === LOCAL_SOURCE
    const isScreen = tile.kind === SCREEN_KIND
    const member = isLocal ? selfMember : members.find((m) => m.id === tile.sourceId)
    const playsAudio = !isLocal && !isScreen
    const speakerId = isLocal ? selfId : tile.sourceId
    const caption = isScreen ? undefined : captions[speakerId]
    const translator = caption?.translatedBy
    const heard = heardThrough(tile, translations)
    return (
      <VideoTile
        key={tile.key}
        tileKey={tile.key}
        stream={tile.stream}
        heard={heard.stream}
        name={label(tile)}
        muted={isLocal}
        mirrored={isLocal && !isScreen}
        micOff={!isScreen ? !(member?.mic ?? true) : false}
        camOff={!isScreen ? !(member?.cam ?? true) : false}
        sharing={isScreen}
        sinkId={playsAudio ? speaker : undefined}
        volume={playsAudio ? (heard.through === 'own' ? volume : 0) : undefined}
        caption={caption?.text}
        captionBy={translator ? (members.find((m) => m.id === translator)?.name ?? 'another member') : undefined}
        pinned={pinnedKey === tile.key}
        onTogglePin={pinButton ? togglePin : undefined}
        compact={view === 'thumb' || view === 'self'}
        fill={view === 'grid' || view === 'bleed' || view === 'self'}
        bleed={view === 'bleed' ? { covered: bleedCovered } : undefined}
      />
    )
  }

  const pinTarget = (tile: Tile, view: TileView, className: string, style?: CSSProperties) => (
    <PinTarget
      key={tile.key}
      label={`${pinnedKey === tile.key ? 'Unpin' : 'Pin'} ${label(tile)}`}
      onPin={() => togglePin(tile.key)}
      className={className}
      style={style}
    >
      {renderTile(tile, view, false)}
    </PinTarget>
  )

  if (mainTile && phone) {
    const selfTile = stripTiles.find((tile) => tile.key === LOCAL_CAMERA_KEY) ?? null
    const others = stripTiles.filter((tile) => tile !== selfTile)
    const bottom = controlsOver ? CONTROLS_HEIGHT : PHONE_INSET
    const stripTop = bottom + (others.length > 0 ? PHONE_THUMB.height + PHONE_INSET : 0)
    return (
      <main className="relative overflow-hidden bg-black" data-stage="focus">
        <div className="absolute inset-0" data-stage="main">
          {renderTile(mainTile, 'bleed', pinnedKey === mainKey, stripTop)}
        </div>
        {others.length > 0 && (
          <div
            className="no-scrollbar absolute inset-x-0 z-10 flex gap-2 overflow-x-auto"
            style={{ bottom, paddingInline: PHONE_INSET }}
            data-stage="strip"
          >
            {others.map((tile) => pinTarget(tile, 'thumb', 'shrink-0 first:ml-auto last:mr-auto', PHONE_THUMB))}
          </div>
        )}
        {selfTile && (
          <SelfView
            label={`${label(selfTile)}: drag to move, tap to pin`}
            inset={{
              top: STAGE_TOP,
              bottom: stripTop,
              side: PHONE_INSET,
            }}
            size={SELF_VIEW}
            onTap={() => togglePin(selfTile.key)}
          >
            {renderTile(selfTile, 'self', false)}
          </SelfView>
        )}
      </main>
    )
  }

  if (mainTile) {
    return (
      <main className="flex flex-col gap-2 px-2 pb-2" style={{ paddingTop: STAGE_TOP }}>
        <div className="min-h-0 flex-1">{renderTile(mainTile, 'pinned', pinnable)}</div>
        {stripTiles.length > 0 && (
          <div className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto">
            {stripTiles.map((tile) => (
              <div key={tile.key} className="aspect-video w-40 shrink-0 first:ml-auto last:mr-auto sm:w-52">
                {renderTile(tile, 'thumb', pinnable)}
              </div>
            ))}
          </div>
        )}
      </main>
    )
  }

  return (
    <main ref={stageRef} className="overflow-y-auto px-2 pb-2" style={{ paddingTop: STAGE_TOP }}>
      <div className="flex min-h-full flex-wrap content-center justify-center" style={{ gap: TILE_GAP }}>
        {allTiles.map((tile) => {
          const size = { width: grid.width, height: grid.height }
          if (phone && pinnable) return pinTarget(tile, 'grid', 'shrink-0', size)
          return (
            <div key={tile.key} className="shrink-0" style={size}>
              {renderTile(tile, 'grid', pinnable)}
            </div>
          )
        })}
      </div>
    </main>
  )
}
