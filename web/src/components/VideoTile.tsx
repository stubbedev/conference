import { useEffect, useRef } from 'react'
import { MicOff, MonitorUp, VideoOff } from 'lucide-react'

import { cn } from '@/lib/utils'

interface VideoTileProps {
  stream: MediaStream | null
  name: string
  muted?: boolean
  mirrored?: boolean
  sharing?: boolean
  micOff?: boolean
  camOff?: boolean
}

export function VideoTile({
  stream,
  name,
  muted,
  mirrored,
  sharing,
  micOff,
  camOff,
}: VideoTileProps) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = ref.current
    if (video && video.srcObject !== stream) {
      video.srcObject = stream
      void video.play().catch(() => {})
    }
  }, [stream])

  const initials =
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'

  const hideVideo = Boolean(camOff && !sharing)

  return (
    <div className="group relative overflow-hidden rounded-xl bg-black">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className={cn('h-full w-full object-cover', mirrored && !sharing && '-scale-x-100', hideVideo && 'opacity-0')}
      />
      {hideVideo && (
        <div className="absolute inset-0 grid place-items-center text-3xl font-semibold text-muted-foreground">
          {initials}
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/60 px-2 py-0.5 text-xs text-white">
        {sharing && <MonitorUp className="size-3" />}
        <span>{name}</span>
      </div>
      <div className="absolute top-2 right-2 flex gap-1 text-white">
        {micOff && <MicOff className="size-4" />}
        {camOff && !sharing && <VideoOff className="size-4" />}
      </div>
    </div>
  )
}
