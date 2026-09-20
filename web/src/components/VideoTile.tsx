import { useEffect, useRef, useState } from 'react'
import { MicOff, MonitorUp, Pin, PinOff, VideoOff, VolumeX } from 'lucide-react'

import { useLatest } from '@/hooks/latest'
import {
  aspectRatioChanged,
  playMediaElement,
  resumeAudio,
  useIsSpeaking,
  useSplitStreams,
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

// Debug overlays show per-tile playback diagnostics: rendered and
// dropped frame counters plus element state. When a tile freezes these
// numbers say which side failed — counters still climbing means frames
// decode but the picture stopped compositing; counters frozen means
// frames stopped arriving or decrypting.
//
// Enabled by "debug=1" anywhere in the URL (the room key lives in the
// #fragment, so a trailing ?debug=1 typed after it never reaches
// location.search), or toggled at runtime by tapping the room name
// five times.
let tileDebugOn = typeof location !== 'undefined' && /debug=1/.test(location.href)

export function toggleTileDebug(): void {
  tileDebugOn = !tileDebugOn
  window.dispatchEvent(new CustomEvent('tile-debug'))
}

// Mobile browsers suspend decoding in ways that leave elements paused
// while the tab is hidden, so visibility changes re-check playback.
// Track-list changes never touch a bound element: useSplitStreams hands
// the tile a fresh MediaStream instead, which goes through the element's
// normal load path (Android Chrome renders one frame and stops when a
// track is added to a stream it is already playing).
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
  const [debugStats, setDebugStats] = useState('')
  const [debugOn, setDebugOn] = useState(tileDebugOn)
  const speaking = useIsSpeaking(stream)
  const { video: videoStream, audio: audioStream } = useSplitStreams(stream)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoStream) return

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

    if (video.srcObject !== videoStream) {
      video.srcObject = videoStream
      start()
    }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('resize', reportRatio)
    const unwatch = watchVisibility(video, start)

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('resize', reportRatio)
      unwatch()
      // Release the sink: a detached element still holding a live
      // camera track keeps consuming frames on some mobile browsers.
      video.srcObject = null
    }
  }, [videoStream, onAspectRatioRef])

  useEffect(() => {
    if (muted) return
    const audio = audioRef.current
    if (!audio || !audioStream) return

    const start = () => playMediaElement(audio, setAudioBlocked)
    if (audio.srcObject !== audioStream) {
      audio.srcObject = audioStream
      start()
    }

    const unwatch = watchVisibility(audio, start)
    return () => {
      unwatch()
      audio.srcObject = null
    }
  }, [muted, audioStream])

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

  useEffect(() => {
    const sync = () => setDebugOn(tileDebugOn)
    window.addEventListener('tile-debug', sync)
    return () => window.removeEventListener('tile-debug', sync)
  }, [])

  useEffect(() => {
    if (!debugOn) return
    const video = videoRef.current
    if (!video) return

    const sample = () => {
      const quality = video.getVideoPlaybackQuality()
      setDebugStats(
        `v:${videoStream?.getVideoTracks().length ?? 0} f:${quality.totalVideoFrames} d:${quality.droppedVideoFrames} rs:${video.readyState} t:${video.currentTime.toFixed(1)}`,
      )
    }
    const timer = window.setInterval(sample, 1000)
    return () => window.clearInterval(timer)
  }, [videoStream, debugOn])

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
      {debugOn && debugStats && (
        <span className="absolute right-2 bottom-9 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
          {debugStats}
        </span>
      )}
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
