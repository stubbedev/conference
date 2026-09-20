import { useEffect, useRef } from 'react'
import { MicOff, MonitorUp, Pin, PinOff, VideoOff } from 'lucide-react'

import { useIsSpeaking } from '@/hooks/media'
import { cn } from '@/lib/utils'

interface VideoTileProps {
  stream: MediaStream | null
  name: string
  muted?: boolean
  mirrored?: boolean
  sharing?: boolean
  micOff?: boolean
  camOff?: boolean
  sinkId?: string
  volume?: number
  pinned?: boolean
  onTogglePin?: () => void
  compact?: boolean
}

// The rounded frame is a dedicated div whose only job is clipping:
// overflow-hidden + border-radius is not reliable for composited video
// layers, so the same radius is enforced again with clip-path, which the
// compositor cannot skip. Overlays live outside the clip.
export function VideoTile({
  stream,
  name,
  muted,
  mirrored,
  sharing,
  micOff,
  camOff,
  sinkId,
  volume,
  pinned,
  onTogglePin,
  compact,
}: VideoTileProps) {
  const ref = useRef<HTMLVideoElement>(null)
  const speaking = useIsSpeaking(stream)

  useEffect(() => {
    const video = ref.current
    if (video && video.srcObject !== stream) {
      video.srcObject = stream
      void video.play().catch(() => {})
    }
  }, [stream])

  useEffect(() => {
    const video = ref.current
    if (!video || !sinkId) return
    if ('setSinkId' in video) video.setSinkId(sinkId).catch(() => {})
  }, [sinkId, stream])

  useEffect(() => {
    const video = ref.current
    if (!video || volume === undefined) return
    video.volume = Math.min(1, Math.max(0, volume))
  }, [volume])

  const initials =
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'

  const hideVideo = Boolean(camOff && !sharing)
  const speakingNow = speaking && !micOff && !sharing

  return (
    <div className="group relative isolate h-full w-full">
      {speakingNow && (
        <span className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-emerald-400" />
      )}
      <div className="absolute inset-0 overflow-hidden rounded-xl bg-black [clip-path:inset(0_round_0.75rem)]">
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={muted}
          className={cn(
            'h-full w-full',
            sharing ? 'object-contain' : 'object-cover',
            mirrored && !sharing && '-scale-x-100',
            hideVideo && 'opacity-0',
          )}
        />
        {hideVideo && (
          <div className="absolute inset-0 grid place-items-center bg-gradient-to-b from-muted/40 to-muted">
            <div className={cn('flex flex-col items-center', compact ? 'gap-1' : 'gap-2')}>
              <div
                className={cn(
                  'grid place-items-center rounded-full bg-background/80 font-semibold text-foreground/70',
                  compact ? 'size-8 text-xs' : 'size-16 text-xl',
                )}
              >
                {initials}
              </div>
              {!compact && <span className="text-xs text-muted-foreground">Camera is off</span>}
            </div>
          </div>
        )}
      </div>
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-black/60 py-1 pr-2.5 pl-2 text-xs font-medium text-white backdrop-blur-sm">
        {sharing && <MonitorUp className="size-3.5 shrink-0" />}
        {!sharing && micOff && <MicOff className="size-3.5 shrink-0 text-red-400" />}
        <span className={cn('truncate', compact ? 'max-w-24' : 'max-w-48')}>{name}</span>
        {sharing && <span className="shrink-0 text-white/60">screen</span>}
      </div>
      <div className="absolute top-2 right-2 flex gap-1 text-white">
        {micOff && <MicOff className="size-4" />}
        {camOff && !sharing && <VideoOff className="size-4" />}
      </div>
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          title={pinned ? 'Unpin' : 'Pin to main view'}
          className={cn(
            'absolute top-2 right-2 grid size-7 cursor-pointer place-items-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-opacity hover:bg-black/80',
            pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
      )}
    </div>
  )
}
