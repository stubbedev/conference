import { useEffect, useState } from 'react'
import { Keyboard, Loader2, Lock, Settings2, ShieldCheck, Video } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { api, type ServerConfig } from '@/lib/api'
import { Logo } from '@/components/Logo'
import { HudBackdrop, HudTitle } from '@/components/HudBackdrop'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

function parseSlug(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/\/r\/([a-z0-9-]+)/)
  if (match?.[1]) return match[1]
  if (/^[a-z0-9-]+$/.test(trimmed)) return trimmed
  return ''
}

function roomPath(input: string): string {
  const trimmed = input.trim()
  const slug = parseSlug(trimmed)
  if (!slug) return ''
  const hash = trimmed.match(/#k=[A-Za-z0-9_-]+/)?.[0] ?? ''
  return `/r/${slug}${hash}`
}

export default function Home() {
  const navigate = useNavigate()
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [maxMembers, setMaxMembers] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [code, setCode] = useState('')
  const [options, setOptions] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setConfig(null))
  }, [])

  const needsKey = Boolean(config?.createAuthRequired) && !apiKey

  const create = async () => {
    if (needsKey) {
      setOptions(true)
      toast('This server needs an API key to start a meeting.')
      return
    }
    setBusy(true)
    try {
      const room = await api.createRoom({ name, password, maxMembers: Number(maxMembers) || 0 }, apiKey)
      navigate(`/r/${room.slug}?p=${room.privToken}#k=${room.roomKey}`, { state: { created: true } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the meeting.')
      setBusy(false)
    }
  }

  const join = () => {
    const path = roomPath(code)
    if (!path) {
      toast.error('Enter a meeting code like abc-def-ghi, or paste a meeting link.')
      return
    }
    navigate(path)
  }

  return (
    <div className="relative flex min-h-dvh flex-col">
      <HudBackdrop />
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <Logo className="hud-hide size-9" />
        </div>
        <ThemeToggle />
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 pb-24">
        <HudTitle />
        <h1 className="text-balance text-4xl font-normal tracking-tight sm:text-5xl">Video calls that only you can see</h1>
        <p className="mt-4 max-w-xl text-pretty text-lg text-muted-foreground">
          Video, voice, chat and live translation are encrypted in your browser. The server relays what it cannot read.
        </p>

        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
          {config && !config.joinOnly && (
            <div className="flex shrink-0 items-center gap-1">
              <Button size="lg" className="h-12 gap-2 rounded-full px-6 text-base" disabled={busy} onClick={() => void create()}>
                {busy ? <Loader2 className="animate-spin" /> : <Video />}
                New meeting
              </Button>
              <Popover open={options} onOpenChange={setOptions}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-12 rounded-full" aria-label="Meeting options">
                    <Settings2 />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="grid w-80 gap-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor="room-name">Meeting name</Label>
                    <Input
                      id="room-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Weekly standup"
                      maxLength={80}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="room-password" className="gap-1.5">
                      <Lock className="size-3.5" /> Password
                    </Label>
                    <Input
                      id="room-password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="None"
                      maxLength={128}
                    />
                    <p className="text-xs text-muted-foreground">Never sent to the server: joining proves it in your browser.</p>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="room-max">Member limit</Label>
                    <Input
                      id="room-max"
                      type="number"
                      min={0}
                      max={256}
                      value={maxMembers}
                      onChange={(event) => setMaxMembers(event.target.value)}
                      placeholder="Server default"
                    />
                  </div>
                  {config.createAuthRequired && (
                    <div className="grid gap-1.5">
                      <Label htmlFor="api-key">API key</Label>
                      <Input
                        id="api-key"
                        type="password"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder="Required on this server"
                      />
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          )}
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              join()
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Keyboard className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Enter a code or link"
                autoComplete="off"
                aria-label="Meeting code or link"
                className="h-12 rounded-full pl-12 text-base"
              />
            </div>
            <Button type="submit" variant="ghost" className="h-12 rounded-full px-5 text-base" disabled={!code.trim()}>
              Join
            </Button>
          </form>
        </div>

        <p className="mt-12 flex items-center gap-2 border-t pt-6 text-sm text-muted-foreground">
          <ShieldCheck className="size-4 shrink-0 text-emerald-500" />
          End-to-end encrypted, from your browser to theirs.
        </p>
      </main>
    </div>
  )
}
