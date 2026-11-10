import { Mic, MicOff, Video, VideoOff } from 'lucide-react'

import type { TrackKind } from '@/hooks/media'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const LABELS: Record<TrackKind, { on: string; off: string; blocked: string; shortcut: string }> = {
  mic: { on: 'Mute microphone', off: 'Unmute microphone', blocked: 'Allow microphone', shortcut: 'M' },
  cam: { on: 'Turn camera off', off: 'Turn camera on', blocked: 'Allow camera', shortcut: 'V' },
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
  const hint = !available
    ? `Your browser has not allowed the ${kind === 'mic' ? 'microphone' : 'camera'} yet. Click to ask again.`
    : withShortcut
      ? `${label} (${labels.shortcut})`
      : label
  const Icon = kind === 'mic' ? (live ? Mic : MicOff) : live ? Video : VideoOff

  return (
    <Hint label={hint} name={label}>
      <Button
        variant={live ? 'secondary' : 'destructive'}
        size="icon"
        className={cn('relative', className)}
        onClick={onToggle}
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
