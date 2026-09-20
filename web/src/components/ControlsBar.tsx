import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  MonitorX,
  PhoneOff,
  Video,
  VideoOff,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

interface ControlsBarProps {
  mic: boolean
  cam: boolean
  sharing: boolean
  chatOpen: boolean
  unread: number
  fullscreen: boolean
  /** getDisplayMedia is missing on iOS Safari and some mobile browsers. */
  canShare?: boolean
  onMic: () => void
  onCam: () => void
  onShare: () => void
  onLeave: () => void
  onToggleChat: () => void
  onToggleFullscreen: () => void
  children?: ReactNode
}

const AUTO_HIDE_MS = 3000

export function ControlsBar({
  mic,
  cam,
  sharing,
  chatOpen,
  unread,
  fullscreen,
  canShare = true,
  onMic,
  onCam,
  onShare,
  onLeave,
  onToggleChat,
  onToggleFullscreen,
  children,
}: ControlsBarProps) {
  const [visible, setVisible] = useState(true)
  const hideTimer = useRef<number | undefined>(undefined)

  const show = useCallback(() => {
    setVisible(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setVisible(false), AUTO_HIDE_MS)
  }, [])

  useEffect(() => {
    if (!fullscreen) {
      window.clearTimeout(hideTimer.current)
      setVisible(true)
      return
    }
    show()
    window.addEventListener('pointermove', show)
    return () => {
      window.clearTimeout(hideTimer.current)
      window.removeEventListener('pointermove', show)
    }
  }, [fullscreen, show])

  return (
    <footer
      onPointerEnter={() => window.clearTimeout(hideTimer.current)}
      onPointerLeave={fullscreen ? show : undefined}
      className={cn(
        'flex items-center justify-center gap-2',
        fullscreen
          ? cn(
              'fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-2xl border bg-background/95 p-2 shadow-lg backdrop-blur transition-all duration-200',
              visible ? 'opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
            )
          : 'border-t px-4 py-3',
      )}
    >
      <Button
        variant={mic ? 'secondary' : 'destructive'}
        size="icon"
        onClick={onMic}
        title={mic ? 'Mute microphone (M)' : 'Unmute microphone (M)'}
      >
        {mic ? <Mic /> : <MicOff />}
      </Button>
      <Button
        variant={cam ? 'secondary' : 'destructive'}
        size="icon"
        onClick={onCam}
        title={cam ? 'Turn camera off (V)' : 'Turn camera on (V)'}
      >
        {cam ? <Video /> : <VideoOff />}
      </Button>
      {canShare && (
        <Button
          variant={sharing ? 'destructive' : 'secondary'}
          size="icon"
          onClick={onShare}
          title={sharing ? 'Stop sharing' : 'Share your screen'}
        >
          {sharing ? <MonitorX /> : <MonitorUp />}
        </Button>
      )}

      <Separator orientation="vertical" className="mx-1 self-center" />

      <Button
        variant={chatOpen ? 'secondary' : 'ghost'}
        size="icon"
        onClick={onToggleChat}
        title={chatOpen ? 'Close chat (C)' : 'Open chat (C)'}
        className="relative"
      >
        <MessageSquare />
        {unread > 0 && (
          <span className="absolute top-0 right-0 grid size-4 -translate-y-1/4 translate-x-1/4 place-items-center rounded-full bg-destructive text-[10px] font-semibold leading-none text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Button>
      {children}
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleFullscreen}
        title={fullscreen ? 'Exit fullscreen (F)' : 'Enter fullscreen (F)'}
      >
        {fullscreen ? <Minimize2 /> : <Maximize2 />}
      </Button>

      <Separator orientation="vertical" className="mx-1 self-center" />

      <Button variant="destructive" size="icon" onClick={onLeave} title="Leave">
        <PhoneOff />
      </Button>
    </footer>
  )
}
