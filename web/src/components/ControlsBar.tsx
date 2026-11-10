import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Circle,
  Contrast,
  Languages,
  Maximize2,
  MessageSquare,
  Minimize2,
  MonitorUp,
  MonitorX,
  MoreVertical,
  PhoneOff,
  Users,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DeviceToggle } from '@/components/DeviceToggle'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Hint } from '@/components/Hint'
import { MeetingClock } from '@/components/MeetingClock'
import { blurToggleLabel } from '@/hooks/media'
import { cn } from '@/lib/utils'

interface ControlsBarProps {
  roomName: string
  mic: boolean
  cam: boolean
  micAvailable: boolean
  camAvailable: boolean
  sharing: boolean
  blur: boolean
  canBlur?: boolean
  blurUnavailable?: string
  onBlur?: () => void
  peopleCount: number
  peopleOpen: boolean
  onTogglePeople: () => void
  chatOpen: boolean
  unread: number
  fullscreen: boolean
  canShare?: boolean
  canRecord?: boolean
  recording?: boolean
  canTranslate?: boolean
  translating?: boolean
  onTranslate?: () => void
  onMic: () => void
  onCam: () => void
  onShare: () => void
  onRecord?: () => void
  onLeave: () => void
  onToggleChat: () => void
  onToggleFullscreen: () => void
  children?: ReactNode
}

const AUTO_HIDE_MS = 3000
const ROUND = 'size-11 rounded-full [&_svg:not([class*="size-"])]:size-5'
const SIDE = 'size-10 rounded-full [&_svg:not([class*="size-"])]:size-5'

export const ControlsBar = memo(function ControlsBar({
  roomName,
  mic,
  cam,
  micAvailable,
  camAvailable,
  sharing,
  blur = false,
  canBlur = false,
  blurUnavailable,
  onBlur,
  peopleCount,
  peopleOpen,
  onTogglePeople,
  chatOpen,
  unread,
  fullscreen,
  canShare = true,
  canRecord = false,
  recording = false,
  canTranslate = false,
  translating = false,
  onTranslate,
  onMic,
  onCam,
  onShare,
  onRecord,
  onLeave,
  onToggleChat,
  onToggleFullscreen,
  children,
}: ControlsBarProps) {
  const translateLabel = translating ? 'Stop live translation' : 'Start live translation'
  const shareLabel = sharing ? 'Stop sharing' : 'Share your screen'
  const recordLabel = recording ? 'Stop recording' : 'Record the call'
  const blurLabel = blurToggleLabel(blur)
  const chatName = chatOpen ? 'Close chat' : 'Open chat'
  const [revealed, setRevealed] = useState(true)
  const visible = !fullscreen || revealed
  const hideTimer = useRef<number | undefined>(undefined)

  const armHide = useCallback(() => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setRevealed(false), AUTO_HIDE_MS)
  }, [])

  const show = useCallback(() => {
    setRevealed(true)
    armHide()
  }, [armHide])

  useEffect(() => {
    if (!fullscreen) return
    armHide()
    window.addEventListener('pointermove', show)
    return () => {
      window.clearTimeout(hideTimer.current)
      window.removeEventListener('pointermove', show)
      setRevealed(true)
    }
  }, [fullscreen, armHide, show])

  return (
    <footer
      onPointerEnter={() => window.clearTimeout(hideTimer.current)}
      onPointerLeave={fullscreen ? show : undefined}
      className={cn(
        'grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 py-3 sm:px-5',
        fullscreen &&
          cn(
            'fixed inset-x-0 bottom-0 z-50 bg-gradient-to-t from-black/60 to-transparent transition-all duration-200',
            visible ? 'opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
          ),
      )}
    >
      <div className="flex min-w-0 items-center gap-3 text-sm">
        <span className="hidden shrink-0 tabular-nums sm:inline">
          <MeetingClock />
        </span>
        <span className="hidden h-4 w-px shrink-0 bg-border sm:inline" />
        <span className="hidden min-w-0 truncate font-medium md:inline">{roomName}</span>
        {canRecord && onRecord && (
          <Hint label={recordLabel}>
            <Button
              variant={recording ? 'destructive' : 'ghost'}
              className={cn(
                'h-9 shrink-0 rounded-full px-3 pointer-coarse:h-11',
                recording ? 'gap-1.5 text-xs font-semibold' : 'gap-2',
              )}
              onClick={onRecord}
            >
              {recording ? (
                <>
                  <span className="size-2 animate-pulse rounded-full bg-white" />
                  REC
                </>
              ) : (
                <>
                  <Circle className="fill-destructive text-destructive" />
                  <span className="hidden lg:inline">Record</span>
                </>
              )}
            </Button>
          </Hint>
        )}
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <DeviceToggle kind="mic" on={mic} available={micAvailable} onToggle={onMic} withShortcut className={ROUND} />
        <DeviceToggle kind="cam" on={cam} available={camAvailable} onToggle={onCam} withShortcut className={ROUND} />
        {canShare && (
          <Hint label={shareLabel}>
            <Button
              variant={sharing ? 'default' : 'secondary'}
              size="icon"
              className={cn(ROUND, 'hidden sm:inline-flex')}
              onClick={onShare}
            >
              {sharing ? <MonitorX /> : <MonitorUp />}
            </Button>
          </Hint>
        )}
        {canTranslate && onTranslate && (
          <Hint label={translateLabel}>
            <Button
              variant={translating ? 'default' : 'secondary'}
              size="icon"
              className={ROUND}
              onClick={onTranslate}
              aria-pressed={translating}
            >
              <Languages />
            </Button>
          </Hint>
        )}
        <DropdownMenu>
          <Hint label="More options">
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" className={ROUND}>
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent side="top" align="center">
            {canShare && (
              <DropdownMenuItem className="sm:hidden" onSelect={onShare} aria-label={shareLabel}>
                {sharing ? <MonitorX /> : <MonitorUp />}
                {shareLabel}
              </DropdownMenuItem>
            )}
            {canBlur && onBlur && (
              <DropdownMenuItem
                onSelect={onBlur}
                disabled={!cam || Boolean(blurUnavailable)}
                aria-label={blurLabel}
              >
                <Contrast />
                {blurUnavailable || blurLabel}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onToggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
              {fullscreen ? <Minimize2 /> : <Maximize2 />}
              {fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="sm:hidden" />
            <DropdownMenuItem className="sm:hidden" onSelect={onTogglePeople} aria-label="People">
              <Users />
              People ({peopleCount})
            </DropdownMenuItem>
            <DropdownMenuItem className="sm:hidden" onSelect={onToggleChat} aria-label={chatName}>
              <MessageSquare />
              Chat{unread > 0 ? ` (${unread > 9 ? '9+' : unread} new)` : ''}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Hint label="Leave call" name="Leave">
          <Button variant="destructive" className="h-11 w-16 rounded-full [&_svg]:size-5" onClick={onLeave}>
            <PhoneOff />
          </Button>
        </Hint>
      </div>

      <div className="flex items-center justify-end gap-1">
        <span className="hidden sm:contents">{children}</span>
        <Hint label={peopleOpen ? 'Hide people' : 'Show everyone'} name="Participants">
          <Button
            variant={peopleOpen ? 'secondary' : 'ghost'}
            size="icon"
            className={cn(SIDE, 'relative hidden sm:inline-flex')}
            onClick={onTogglePeople}
            aria-pressed={peopleOpen}
          >
            <Users />
            <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-muted px-1 text-[10px] font-semibold leading-4 text-foreground">
              {peopleCount}
            </span>
          </Button>
        </Hint>
        <Hint label={chatOpen ? 'Close chat (C)' : 'Chat with everyone (C)'} name={chatName}>
          <Button
            variant={chatOpen ? 'secondary' : 'ghost'}
            size="icon"
            className={cn(SIDE, 'relative hidden sm:inline-flex')}
            onClick={onToggleChat}
          >
            <MessageSquare />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </Button>
        </Hint>
      </div>
    </footer>
  )
})
