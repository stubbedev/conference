import { Loader2 } from 'lucide-react'

import { HudBackdrop } from '@/components/HudBackdrop'
import { JoinGate } from '@/components/JoinGate'

export function CheckingScreen() {
  return (
    <div className="grid h-dvh place-items-center">
      <HudBackdrop />
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking the room…
      </p>
    </div>
  )
}

interface GateScreenProps {
  busy: boolean
  roomName: string
  error: string
  onSubmit: (password: string) => void
}

export function GateScreen({ busy, roomName, error, onSubmit }: GateScreenProps) {
  return (
    <div className="relative grid h-dvh place-items-center bg-muted/40">
      <HudBackdrop />
      <JoinGate open busy={busy} roomName={roomName} error={error} onSubmit={onSubmit} />
    </div>
  )
}

export function JoiningScreen() {
  return (
    <div className="grid h-dvh place-items-center">
      <HudBackdrop />
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Joining…</p>
      </div>
    </div>
  )
}
