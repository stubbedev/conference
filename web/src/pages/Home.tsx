import { useEffect, useState } from 'react'
import { Video } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { api, type CreatedRoom as CreatedRoomInfo, type ServerConfig } from '@/lib/api'
import { CreatedRoom } from '@/components/CreatedRoom'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function parseSlug(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/\/r\/([a-z0-9-]+)/)
  if (match) return match[1]
  if (/^[a-z0-9-]+$/.test(trimmed)) return trimmed
  return ''
}

export default function Home() {
  const navigate = useNavigate()
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [maxMembers, setMaxMembers] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [joinSlug, setJoinSlug] = useState('')
  const [created, setCreated] = useState<CreatedRoomInfo | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setConfig(null))
  }, [])

  const create = async () => {
    setBusy(true)
    try {
      const room = await api.createRoom(
        { name, password, maxMembers: Number(maxMembers) || 0 },
        apiKey,
      )
      setCreated(room)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the room.')
    } finally {
      setBusy(false)
    }
  }

  const join = () => {
    const slug = parseSlug(joinSlug)
    if (!slug) {
      toast.error('Enter a room code like abc-def-ghi or a room link.')
      return
    }
    navigate(`/r/${slug}`)
  }

  if (created) {
    return <CreatedRoom room={created} />
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Video className="size-6" />
            <h1 className="text-2xl font-semibold tracking-tight">Conference</h1>
            <Badge variant="secondary">E2EE</Badge>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Self-hosted video rooms with end-to-end encrypted media and chat. The server only ever
            relays ciphertext.
          </p>
        </div>
        <ThemeToggle />
      </div>

      <div className="grid gap-4">
        <section className="grid gap-4 rounded-xl border bg-card p-6 shadow-xs">
          <h2 className="text-base font-medium">Create a room</h2>
          <div className="grid gap-1.5">
            <Label htmlFor="room-name">Name (optional)</Label>
            <Input
              id="room-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Weekly standup"
              maxLength={80}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="room-password">Password (optional)</Label>
            <Input
              id="room-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Leave empty for an open room"
              maxLength={128}
            />
            <p className="text-xs text-muted-foreground">
              The password never reaches the server: joining sends a proof, and the room key is
              unsealed in your browser.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="room-max">Member limit (optional)</Label>
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
          {config?.createAuthRequired && (
            <div className="grid gap-1.5">
              <Label htmlFor="api-key">API key</Label>
              <Input
                id="api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="This server requires a key to create rooms"
              />
            </div>
          )}
          <Button disabled={busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create room'}
          </Button>
        </section>

        <section className="grid gap-3 rounded-xl border bg-card p-6 shadow-xs">
          <h2 className="text-base font-medium">Join a room</h2>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              join()
            }}
          >
            <Input
              value={joinSlug}
              onChange={(event) => setJoinSlug(event.target.value)}
              placeholder="abc-def-ghi or a room link"
              autoComplete="off"
            />
            <Button type="submit" variant="secondary">
              Join
            </Button>
          </form>
        </section>
      </div>
    </div>
  )
}
