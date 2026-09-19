import { Check, Copy, KeyRound, Link2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import type { CreatedRoom } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'

interface CreatedRoomProps {
  room: CreatedRoom
}

export function CreatedRoom({ room }: CreatedRoomProps) {
  const navigate = useNavigate()
  const [copied, setCopied] = useState('')

  const origin = window.location.origin
  const privilegedLink = `${origin}/r/${room.slug}?p=${room.privToken}#k=${room.roomKey}`
  const shortLink = `${origin}/r/${room.slug}`

  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value)
    setCopied(label)
    toast.success(`${label} copied`)
    setTimeout(() => setCopied(''), 1500)
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <ShieldCheck className="size-5 text-emerald-500" />
        <h1 className="text-xl font-semibold">Room “{room.name || room.slug}” is ready</h1>
      </div>

      <div className="grid gap-5">
        <div className="grid gap-1.5">
          <Label className="items-center gap-1.5">
            <ShieldCheck className="size-3.5" /> Privileged link — opens without a password
          </Label>
          <div className="flex gap-2">
            <Input readOnly value={privilegedLink} className="font-mono text-xs" />
            <Button variant="secondary" size="icon" onClick={() => void copy('Privileged link', privilegedLink)}>
              {copied === 'Privileged link' ? <Check /> : <Copy />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Keep this link private: it carries both the entry token and the room key.
          </p>
        </div>

        <Separator />

        <div className="grid gap-1.5">
          <Label className="items-center gap-1.5">
            <Link2 className="size-3.5" /> Short link — share freely
          </Label>
          <div className="flex gap-2">
            <Input readOnly value={shortLink} className="font-mono text-xs" />
            <Button variant="secondary" size="icon" onClick={() => void copy('Short link', shortLink)}>
              {copied === 'Short link' ? <Check /> : <Copy />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {room.e2ee
              ? 'Anyone with this link can join, but media stays end-to-end encrypted either way.'
              : 'Anyone with this link can join.'}
          </p>
        </div>

        {room.e2ee && (
          <>
            <Separator />
            <div className="grid gap-1.5">
              <Label className="items-center gap-1.5">
                <KeyRound className="size-3.5" /> Room key (shown once)
              </Label>
              <div className="flex gap-2">
                <Input readOnly value={room.roomKey} className="font-mono text-xs" />
                <Button variant="secondary" size="icon" onClick={() => void copy('Room key', room.roomKey)}>
                  {copied === 'Room key' ? <Check /> : <Copy />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The server never stores this key for password rooms. Store it somewhere safe if
                you want to re-create privileged links later.
              </p>
            </div>
          </>
        )}

        <Button onClick={() => navigate(`/r/${room.slug}?p=${room.privToken}#k=${room.roomKey}`)}>
          Join now
        </Button>
      </div>
    </div>
  )
}
