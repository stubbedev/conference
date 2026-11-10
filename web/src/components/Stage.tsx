import { VideoTile } from '@/components/VideoTile'
import type { ShownCaption } from '@/hooks/live-translation'
import { STAGE_TOP, TILE_GAP, type StageLayout } from '@/hooks/stage-layout'
import type { MemberInfo } from '@/lib/sfu'
import { heardThrough, LOCAL_SOURCE, tileLabel, type Tile, type Translations } from '@/lib/tiles'
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
}

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
}: StageProps) {
  const { allTiles, pinnedKey, pinnedTile, stripTiles, togglePin, stageRef, grid } = layout

  const renderTile = (tile: Tile, compact = false) => {
    const isLocal = tile.sourceId === LOCAL_SOURCE
    const isScreen = tile.kind === SCREEN_KIND
    const member = isLocal ? selfMember : members.find((m) => m.id === tile.sourceId)
    const playsAudio = !isLocal && !isScreen
    const speakerId = isLocal ? selfId : tile.sourceId
    const caption = isScreen ? undefined : captions[speakerId]?.text
    const heard = heardThrough(tile, translations)
    return (
      <VideoTile
        key={tile.key}
        tileKey={tile.key}
        stream={tile.stream}
        heard={heard.stream}
        name={tileLabel(tile, displayName, members)}
        muted={isLocal}
        mirrored={isLocal && !isScreen}
        micOff={!isScreen ? !(member?.mic ?? true) : false}
        camOff={!isScreen ? !(member?.cam ?? true) : false}
        sharing={isScreen}
        sinkId={playsAudio ? speaker : undefined}
        volume={playsAudio ? (heard.through === 'own' ? volume : 0) : undefined}
        caption={caption}
        pinned={pinnedKey === tile.key}
        onTogglePin={allTiles.length > 1 ? togglePin : undefined}
        compact={compact}
        fill={!compact && !pinnedKey}
      />
    )
  }

  if (pinnedTile) {
    return (
      <main className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2" style={{ paddingTop: STAGE_TOP }}>
        <div className="min-h-0 flex-1">{renderTile(pinnedTile)}</div>
        {stripTiles.length > 0 && (
          <div className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto">
            {stripTiles.map((tile) => (
              <div key={tile.key} className="aspect-video w-40 shrink-0 first:ml-auto last:mr-auto sm:w-52">
                {renderTile(tile, true)}
              </div>
            ))}
          </div>
        )}
      </main>
    )
  }

  return (
    <main ref={stageRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" style={{ paddingTop: STAGE_TOP }}>
      <div className="flex min-h-full flex-wrap content-center justify-center" style={{ gap: TILE_GAP }}>
        {allTiles.map((tile) => (
          <div key={tile.key} className="shrink-0" style={{ width: grid.width, height: grid.height }}>
            {renderTile(tile, false)}
          </div>
        ))}
      </div>
    </main>
  )
}
