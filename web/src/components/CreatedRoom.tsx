import { Check, ChevronDown, Copy, Eye, EyeOff, KeyRound, Link2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import type { CreatedRoom } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface CreatedRoomProps {
  room: CreatedRoom
}

export function CreatedRoom({ room }: CreatedRoomProps) {
  const navigate = useNavigate()
  const [copied, setCopied] = useState('')
  const [keyRevealed, setKeyRevealed] = useState(false)

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

      <div className="grid gap-5 rounded-xl border bg-card p-6 shadow-xs">
        <div className="grid gap-1.5">
          <Label>Invite link</Label>
          <div className="flex gap-2">
            <Input readOnly value={privilegedLink} className="font-mono text-xs" />
            <Button
              variant="secondary"
              size="icon"
              aria-label="Copy invite link"
              onClick={() => void copy('Invite link', privilegedLink)}
            >
              {copied === 'Invite link' ? <Check /> : <Copy />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Keep it private — it carries the room key and opens without a password.
          </p>
        </div>

        <Button
          size="lg"
          onClick={() => navigate(`/r/${room.slug}?p=${room.privToken}#k=${room.roomKey}`)}
        >
          Join now
        </Button>

        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="group mx-auto w-fit justify-center text-muted-foreground"
            >
              Room details
              <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-4 pt-4">
            <div className="grid gap-1.5">
              <Label className="items-center gap-1.5">
                <Link2 className="size-3.5" /> Short link — safe to share
              </Label>
              <div className="flex gap-2">
                <Input readOnly value={shortLink} className="font-mono text-xs" />
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Copy short link"
                  onClick={() => void copy('Short link', shortLink)}
                >
                  {copied === 'Short link' ? <Check /> : <Copy />}
                </Button>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label className="items-center gap-1.5">
                <KeyRound className="size-3.5" /> Room key — shown once, store it somewhere safe
              </Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  type={keyRevealed ? 'text' : 'password'}
                  value={room.roomKey}
                  className="font-mono text-xs"
                />
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={keyRevealed ? 'Hide room key' : 'Reveal room key'}
                  onClick={() => setKeyRevealed((revealed) => !revealed)}
                >
                  {keyRevealed ? <EyeOff /> : <Eye />}
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Copy room key"
                  onClick={() => void copy('Room key', room.roomKey)}
                >
                  {copied === 'Room key' ? <Check /> : <Copy />}
                </Button>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
}
