import { useState } from 'react'
import { Loader2, Lock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface JoinGateProps {
  open: boolean
  busy?: boolean
  roomName: string
  error?: string
  onSubmit: (password: string) => void
}

export function JoinGate({ open, busy, roomName, error, onSubmit }: JoinGateProps) {
  const [password, setPassword] = useState('')

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="size-4" /> This room is locked
          </DialogTitle>
          <DialogDescription>
            {roomName ? `"${roomName}" is protected` : 'This room is protected'} — enter its
            password to join. The password never leaves this device; only a proof is sent.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (password && !busy) onSubmit(password)
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="room-password">Room password</Label>
            <Input
              id="room-password"
              type="password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !password}>
              {busy && <Loader2 className="animate-spin" />} Unlock and join
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
