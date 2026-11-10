import { useState } from 'react'
import { Check, Copy, ShieldCheck, X } from 'lucide-react'

import { Button } from '@/components/ui/button'

interface MeetingReadyProps {
  link: string
  passwordProtected: boolean
  onCopy: () => Promise<void>
  onClose: () => void
}

export function MeetingReady({ link, passwordProtected, onCopy, onClose }: MeetingReadyProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await onCopy()
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section
      aria-label="Your meeting's ready"
      className="absolute bottom-24 left-4 z-30 w-[min(22rem,calc(100%-2rem))] rounded-2xl border bg-popover p-5 text-popover-foreground shadow-xl animate-in fade-in-0 slide-in-from-bottom-2"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-medium">Your meeting's ready</h2>
        <Button variant="ghost" size="icon" className="-mt-1 -mr-2 size-8 rounded-full" onClick={onClose} aria-label="Close">
          <X />
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">Share this joining link with the people you want in the meeting.</p>
      <div className="mt-4 flex items-center gap-2 rounded-lg bg-muted py-1.5 pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
        <Button variant="ghost" size="icon" className="size-8 shrink-0 rounded-full" onClick={() => void copy()} aria-label="Copy joining link">
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <p className="mt-4 flex gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-px size-4 shrink-0 text-emerald-500" />
        {passwordProtected
          ? 'People also need the room password. Your calls stay end-to-end encrypted.'
          : 'The link carries the encryption key, so share it privately. The server never sees it.'}
      </p>
    </section>
  )
}
