import { Loader2, RotateCcw, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { VideoTile } from '@/components/VideoTile'

interface PrejoinProps {
  roomName: string
  slug: string
  stream: MediaStream | null
  mediaError: string
  mediaBusy: boolean
  name: string
  onNameChange: (name: string) => void
  onRetryMedia: () => void
  onJoin: () => void
}

export function Prejoin({
  roomName,
  slug,
  stream,
  mediaError,
  mediaBusy,
  name,
  onNameChange,
  onRetryMedia,
  onJoin,
}: PrejoinProps) {
  const canJoin = !mediaBusy && !mediaError && Boolean(stream)

  return (
    <div className="relative grid h-dvh place-items-center overflow-y-auto bg-muted/40 p-4">
      <div className="grid w-full max-w-3xl gap-6 md:grid-cols-[1.4fr_1fr] md:gap-8">
        <div className="aspect-video overflow-hidden rounded-2xl border bg-card shadow-xs">
          {mediaError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm font-medium">{mediaError}</p>
              <Button variant="secondary" size="sm" onClick={onRetryMedia}>
                <RotateCcw /> Retry
              </Button>
            </div>
          ) : (
            <div className="relative h-full w-full">
              {mediaBusy && (
                <div className="absolute inset-0 z-10 grid place-items-center bg-background/60">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              )}
              <VideoTile stream={stream} name={name || 'You'} muted mirrored />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Ready to join?</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {roomName || slug}
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="size-3.5" /> End-to-end encrypted
              </span>
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="display-name">Your name</Label>
            <Input
              id="display-name"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              maxLength={40}
              placeholder="Your name"
            />
          </div>

          <Button size="lg" onClick={onJoin} disabled={!canJoin}>
            {mediaBusy ? (
              <>
                <Loader2 className="animate-spin" /> Setting up…
              </>
            ) : (
              'Join call'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
