import { useEffect, useRef, useState } from 'react'
import { MicOff, MonitorUp, Pin, PinOff, VideoOff, VolumeX } from 'lucide-react'

import { useLatest } from '@/hooks/latest'
import {
  aspectRatioChanged,
  playMediaElement,
  resumeAudio,
  useIsSpeaking,
} from '@/hooks/media'
import { cn } from '@/lib/utils'

interface VideoTileProps {
  stream: MediaStream | null
  name: string
  /** Local tile: no audio sink is rendered (video is always element-muted). */
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
  onAspectRatio?: (ratio: number) => void
}

// Streams grow over time (audio can arrive before video) and mobile
// browsers suspend decoding in ways that leave elements paused, so both
// media elements re-check playback when the stream gains tracks or the
// page becomes visible again.
function watchStream(stream: MediaStream | null, start: () => void): () => void {
  stream?.addEventListener('addtrack', start)
  return () => stream?.removeEventListener('addtrack', start)
}

function watchVisibility(element: HTMLMediaElement, start: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible' && element.paused) start()
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => document.removeEventListener('visibilitychange', onVisible)
}

// The rounded frame is a dedicated div whose only job is clipping:
// overflow-hidden + border-radius is not reliable for composited video
// layers, so the same radius is enforced again with clip-path, which the
// compositor cannot skip. Overlays live outside the clip.
//
// Mobile autoplay policy (iOS Safari, Chrome Android) blocks playback of
// any element carrying sound, which shows up as a frozen first frame and
// no audio. The video element therefore never carries sound: it stays
// muted (muted playback is always allowed) and remote audio plays through
// a dedicated <audio> element that retries on the next user gesture if
// the initial play is refused.
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
  onAspectRatio,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const ratioRef = useRef(0)
  const onAspectRatioRef = useLatest(onAspectRatio)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const speaking = useIsSpeaking(stream)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const start = () => {
      video.muted = true
      playMediaElement(video)
    }
    const reportRatio = () => {
      const ratio =
        video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 0
      if (aspectRatioChanged(ratioRef.current, ratio)) {
        ratioRef.current = ratio
        onAspectRatioRef.current?.(ratio)
      }
    }
    const onLoadedMetadata = () => {
      reportRatio()
      if (video.paused) start()
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream
      start()
    }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('resize', reportRatio)
    const disposers = [watchStream(stream, start), watchVisibility(video, start)]

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('resize', reportRatio)
      for (const dispose of disposers) dispose()
    }
  }, [stream, onAspectRatioRef])

  useEffect(() => {
    if (muted) return
    const audio = audioRef.current
    if (!audio) return

    const start = () => playMediaElement(audio, setAudioBlocked)
    if (audio.srcObject !== stream) {
      audio.srcObject = stream
      start()
    }

    const disposers = [watchStream(stream, start), watchVisibility(audio, start)]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [muted, stream])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !sinkId) return
    if ('setSinkId' in audio) audio.setSinkId(sinkId).catch(() => {})
  }, [sinkId, stream])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || volume === undefined) return
    audio.volume = Math.min(1, Math.max(0, volume))
  }, [volume])

  const enableSound = () => {
    resumeAudio()
    const audio = audioRef.current
    if (audio) playMediaElement(audio, setAudioBlocked)
  }

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
          ref={videoRef}
          autoPlay
          playsInline
          muted
          disablePictureInPicture
          disableRemotePlayback
          className={cn(
            'h-full w-full object-contain',
            mirrored && !sharing && '-scale-x-100',
            hideVideo && 'opacity-0',
          )}
        />
        {!muted && <audio ref={audioRef} autoPlay playsInline className="hidden" />}
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
      {!muted && audioBlocked && (
        <button
          type="button"
          onClick={enableSound}
          className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm"
        >
          <VolumeX className="size-3.5 shrink-0" />
          Tap for sound
        </button>
      )}
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
