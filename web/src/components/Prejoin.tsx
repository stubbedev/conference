import { useState, type ReactNode } from 'react'
import { Contrast, Loader2, Mic, MicOff, RotateCcw, ShieldCheck, Video, VideoOff } from 'lucide-react'

import { FALLBACK_ASPECT_RATIO } from '@/hooks/media'
import { Button } from '@/components/ui/button'
import { Disclosure } from '@/components/Disclosure'
import { Hint } from '@/components/Hint'
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
  mic: boolean
  cam: boolean
  /** Whether the camera goes out with its background blurred. */
  blur: boolean
  canBlur: boolean
  onNameChange: (name: string) => void
  onToggleMic: () => void
  onToggleCam: () => void
  onToggleBlur: () => void
  onRetryMedia: () => void
  onJoin: () => void
  /** Live-translation settings, when the server offers it. */
  translation?: ReactNode
}

// Joining asks for a name and one click. Microphone and camera keep the
// state they were left in, so the two buttons here are enough to change
// that; everything else that can be adjusted (devices, quality, volumes,
// language) lives in the call, where it is actually used.
export function Prejoin({
  roomName,
  slug,
  stream,
  mediaError,
  mediaBusy,
  name,
  mic,
  cam,
  blur,
  canBlur,
  onNameChange,
  onToggleMic,
  onToggleCam,
  onToggleBlur,
  onRetryMedia,
  onJoin,
  translation,
}: PrejoinProps) {
  const [ratio, setRatio] = useState(FALLBACK_ASPECT_RATIO)
  const canJoin = !mediaBusy && !mediaError && Boolean(stream)

  return (
    <div className="relative grid h-dvh place-items-center overflow-y-auto bg-muted/40 p-4">
      <div className="grid w-full max-w-3xl gap-6 md:grid-cols-[1.4fr_1fr] md:gap-8">
        <div
          className="relative mx-auto w-full overflow-hidden rounded-2xl border bg-card shadow-xs"
          style={{
            aspectRatio: `${ratio}`,
            maxWidth: `calc(min(70dvh, 100%) * ${ratio})`,
          }}
        >
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
              <VideoTile
                tileKey="prejoin"
                stream={stream}
                name={name || 'You'}
                muted
                mirrored
                onAspectRatio={(_tileKey, ratio) => setRatio(ratio)}
              />
              <div className="absolute inset-x-0 bottom-3 z-20 flex items-center justify-center gap-2">
                <Hint label={mic ? 'Mute microphone' : 'Unmute microphone'} side="top">
                  <Button
                    variant={mic ? 'secondary' : 'destructive'}
                    size="icon"
                    aria-label={mic ? 'Mute microphone' : 'Unmute microphone'}
                    onClick={onToggleMic}
                  >
                    {mic ? <Mic /> : <MicOff />}
                  </Button>
                </Hint>
                <Hint label={cam ? 'Turn off camera' : 'Turn on camera'} side="top">
                  <Button
                    variant={cam ? 'secondary' : 'destructive'}
                    size="icon"
                    aria-label={cam ? 'Turn off camera' : 'Turn on camera'}
                    onClick={onToggleCam}
                  >
                    {cam ? <Video /> : <VideoOff />}
                  </Button>
                </Hint>
                {canBlur && onToggleBlur && (
                  <Hint label={blur ? 'Turn off background blur' : 'Blur background'} side="top">
                    <Button
                      variant={blur ? 'default' : 'secondary'}
                      size="icon"
                      aria-label={blur ? 'Turn off background blur' : 'Blur background'}
                      aria-pressed={blur}
                      disabled={!cam}
                      onClick={onToggleBlur}
                    >
                      <Contrast />
                    </Button>
                  </Hint>
                )}
              </div>
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

          {translation && <Disclosure title="Language and subtitles">{translation}</Disclosure>}

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
