import { Mic, MicOff, Video, VideoOff } from 'lucide-react'

import { deviceNoun, type TrackKind } from '@/hooks/media'
import { shortcutKey, type Shortcut } from '@/hooks/shortcuts'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const LABELS: Record<TrackKind, { on: string; off: string; blocked: string; shortcut: Shortcut }> = {
  mic: { on: 'Mute microphone', off: 'Unmute microphone', blocked: 'Allow microphone', shortcut: 'toggleMic' },
  cam: { on: 'Turn camera off', off: 'Turn camera on', blocked: 'Allow camera', shortcut: 'toggleCam' },
}

interface DeviceToggleProps {
  kind: TrackKind
  on: boolean
  available: boolean
  onToggle: () => void
  withShortcut?: boolean
  className: string
}

export function DeviceToggle({ kind, on, available, onToggle, withShortcut = false, className }: DeviceToggleProps) {
  const labels = LABELS[kind]
  const live = available && on
  const label = !available ? labels.blocked : on ? labels.on : labels.off
  const shortcut = withShortcut ? shortcutKey(labels.shortcut) : undefined
  const hint = !available
    ? `Your browser has not allowed the ${deviceNoun(kind)} yet. Click to ask again.`
    : shortcut
      ? `${label} (${shortcut})`
      : label
  const Icon = kind === 'mic' ? (live ? Mic : MicOff) : live ? Video : VideoOff

  return (
    <Hint label={hint} name={label}>
      <Button
        variant={live ? 'secondary' : 'destructive'}
        size="icon"
        className={cn('relative', className)}
        onClick={onToggle}
        aria-keyshortcuts={shortcut}
      >
        <Icon />
        {!available && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-amber-400 text-[10px] font-bold text-black"
          >
            !
          </span>
        )}
      </Button>
    </Hint>
  )
}
