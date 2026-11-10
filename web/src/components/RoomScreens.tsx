import { CircleAlert, Loader2 } from 'lucide-react'

import { HudBackdrop } from '@/components/HudBackdrop'
import { JoinGate } from '@/components/JoinGate'
import { Button } from '@/components/ui/button'

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

interface ErrorScreenProps {
  message: string
  onBack: () => void
}

export function ErrorScreen({ message, onBack }: ErrorScreenProps) {
  return (
    <div className="grid h-dvh place-items-center">
      <div className="grid gap-3 text-center">
        <CircleAlert className="mx-auto size-8 text-muted-foreground" />
        <p className="text-lg font-medium">Could not open this room</p>
        <p className="text-sm text-muted-foreground">{message}</p>
        <Button variant="secondary" onClick={onBack}>
          Back to start
        </Button>
      </div>
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
