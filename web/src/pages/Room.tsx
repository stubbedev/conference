import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { api, type RoomInfo } from '@/lib/api'
import { RoomClient, type ChatMessage, type MemberInfo } from '@/lib/sfu'
import {
  deriveChatKey,
  deriveMediaKeyMaterial,
  deriveProof,
  fromB64,
  openKeyblob,
  toB64,
} from '@/lib/roomkeys'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChatPanel } from '@/components/ChatPanel'
import { ControlsBar } from '@/components/ControlsBar'
import { JoinGate } from '@/components/JoinGate'
import { VideoTile } from '@/components/VideoTile'

interface Tile {
  key: string
  sourceId: string
  kind: string
  stream: MediaStream
}

const SCREEN_KIND = 'screen'

function supportsE2EE(): boolean {
  return 'RTCRtpScriptTransform' in window || 'createEncodedStreams' in RTCRtpSender.prototype
}

export default function Room() {
  const { slug = '' } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const [phase, setPhase] = useState<'checking' | 'gate' | 'joining' | 'live' | 'error'>('checking')
  const [gateError, setGateError] = useState('')
  const [fatalError, setFatalError] = useState('')
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null)
  const [members, setMembers] = useState<MemberInfo[]>([])
  const [tiles, setTiles] = useState<Tile[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const [controls, setControls] = useState({ mic: true, cam: true, sharing: false })

  const clientRef = useRef<RoomClient | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)

  const privToken = searchParams.get('p') ?? ''
  const hashKey = useMemo(() => {
    const match = window.location.hash.match(/#k=([A-Za-z0-9_-]+)/)
    return match ? match[1] : ''
  }, [])
  const displayName = useMemo(() => `Guest-${Math.random().toString(36).slice(2, 6)}`, [])

  const bootstrap = useCallback(
    async (password?: string) => {
      setPhase((prev) => (prev === 'checking' ? 'joining' : prev))
      try {
        const info = await api.roomInfo(slug)
        setRoomInfo(info)

        let session = ''
        let keyB64 = hashKey

        if (privToken) {
          const res = await api.auth(slug, { token: privToken })
          session = res.session
          if (res.key) keyB64 = res.key
        } else if (!info.requiresPassword) {
          const res = await api.auth(slug, {})
          session = res.session
          if (res.key) keyB64 = res.key
        } else {
          if (!password) {
            setGateError('')
            setPhase('gate')
            return
          }
          if (!info.authSalt) throw new Error('This room is missing its password salt.')
          const proof = await deriveProof(password, info.authSalt)
          const res = await api.auth(slug, { proof })
          session = res.session
          if (res.key) keyB64 = res.key
          else if (res.keyblob && res.keySalt) {
            const raw = await openKeyblob(res.keyblob, res.keySalt, password)
            keyB64 = toB64(raw)
          }
        }

        if (!keyB64) {
          setGateError('')
          setPhase('gate')
          return
        }

        const roomKey = fromB64(keyB64)

        if (info.e2ee && !supportsE2EE()) {
          throw new Error(
            'This browser cannot do end-to-end encrypted media. Use a recent Chrome, Edge or Safari.',
          )
        }

        setPhase('joining')

        const [cfg, media] = await Promise.all([
          api.config(),
          navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 } } }),
        ])
        localStreamRef.current = media

        const [mediaKeyMaterial, chatKey] = await Promise.all([
          deriveMediaKeyMaterial(roomKey),
          deriveChatKey(roomKey),
        ])

        const client = new RoomClient({
          slug,
          session,
          name: displayName,
          e2ee: info.e2ee,
          mediaKey: info.e2ee ? mediaKeyMaterial : null,
          chatKey,
          iceServers: cfg.iceServers,
        })
        clientRef.current = client

        client.on('welcome', ({ members: initial }) => setMembers(initial))
        client.on('member-joined', (member) =>
          setMembers((prev) => [...prev.filter((m) => m.id !== member.id), member]),
        )
        client.on('member-left', ({ id }) => {
          setMembers((prev) => prev.filter((m) => m.id !== id))
          setTiles((prev) => prev.filter((t) => t.sourceId !== id))
        })
        client.on('member-state', ({ id, mic, cam, sharing }) => {
          setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, mic, cam, sharing } : m)))
          if (id !== client.memberId && !sharing) {
            setTiles((prev) => prev.filter((t) => !(t.sourceId === id && t.kind === SCREEN_KIND)))
          }
        })
        client.on('track', ({ sourceId, stream, kind }) => {
          setTiles((prev) => {
            if (kind === 'audio') {
              const cam = prev.find((t) => t.sourceId === sourceId && t.kind === 'cam')
              if (cam) return prev
            }
            const key = `${sourceId}:${kind === 'audio' ? 'cam' : kind}`
            const rest = prev.filter((t) => t.key !== key)
            return [...rest, { key, sourceId, kind, stream }]
          })
        })
        client.on('chat', (message) => setMessages((prev) => [...prev, message]))
        client.on('error', ({ text }) => toast.error(text))
        client.on('closed', () => {
          toast.error('The connection was closed.')
          navigate('/')
        })

        await client.connect()
        await client.publish(media)
        setLocalStream(media)
        setPhase('live')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not join the room.'
        if (/password/i.test(message)) {
          setGateError(message)
          setPhase('gate')
        } else {
          setFatalError(message)
          setPhase('error')
        }
      }
    },
    [slug, privToken, hashKey, displayName],
  )

  useEffect(() => {
    void bootstrap()
    return () => clientRef.current?.leave()
  }, [bootstrap])

  const toggleMic = () => {
    const next = !controls.mic
    clientRef.current?.setMic(next)
    setControls((prev) => ({ ...prev, mic: next }))
  }

  const toggleCam = () => {
    const next = !controls.cam
    clientRef.current?.setCam(next)
    setControls((prev) => ({ ...prev, cam: next }))
  }

  const toggleShare = async () => {
    const client = clientRef.current
    if (!client) return

    if (controls.sharing) {
      await client.removeScreen()
      screenStreamRef.current?.getTracks().forEach((track) => track.stop())
      screenStreamRef.current = null
      setScreenStream(null)
      setControls((prev) => ({ ...prev, sharing: false }))
      return
    }

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true })
      screenStreamRef.current = display
      await client.addScreen(display)
      setScreenStream(display)
      setControls((prev) => ({ ...prev, sharing: true }))
      display.getVideoTracks()[0]?.addEventListener('ended', () => {
        void client.removeScreen()
        setScreenStream(null)
        setControls((prev) => ({ ...prev, sharing: false }))
      })
    } catch {
      // The user closed the picker without sharing.
    }
  }

  const copyInvite = async () => {
    await navigator.clipboard.writeText(`${location.origin}/r/${slug}`)
    toast.success('Invite link copied')
  }

  const leave = () => {
    clientRef.current?.leave()
    navigate('/')
  }

  const sendChat = async (text: string) => {
    await clientRef.current?.sendChat(text)
    setMessages((prev) => [
      ...prev,
      { id: `me:${Date.now()}`, name: 'You', text, ts: Date.now(), mine: true },
    ])
  }

  if (phase === 'checking') {
    return (
      <div className="grid h-dvh place-items-center text-sm text-muted-foreground">
        Checking the room…
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="grid h-dvh place-items-center">
        <div className="grid gap-3 text-center">
          <p className="text-lg font-medium">Could not open this room</p>
          <p className="text-sm text-muted-foreground">{fatalError}</p>
          <Button variant="secondary" onClick={() => navigate('/')}>
            Back to start
          </Button>
        </div>
      </div>
    )
  }

  const renderTile = (tile: Tile) => {
    const member = members.find((m) => m.id === tile.sourceId)
    return (
      <VideoTile
        key={tile.key}
        stream={tile.stream}
        name={member?.name ?? 'Guest'}
        micOff={member ? !member.mic : false}
        camOff={member ? !member.cam : false}
        sharing={tile.kind === SCREEN_KIND}
      />
    )
  }

  const camTiles = tiles.filter((tile) => tile.kind !== SCREEN_KIND)
  const screenTiles = tiles.filter((tile) => tile.kind === SCREEN_KIND)
  const inCall = members.length + (phase === 'live' ? 1 : 0)

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <h1 className="font-medium">{roomInfo?.name || slug}</h1>
          <code className="text-xs text-muted-foreground">{slug}</code>
        </div>
        <div className="flex items-center gap-2">
          {roomInfo?.e2ee && (
            <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-500">
              <ShieldCheck className="size-3" /> E2EE
            </Badge>
          )}
          <Badge variant="secondary">{inCall} in call</Badge>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main
          className="grid flex-1 content-start gap-2 overflow-y-auto p-2"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}
        >
          {screenStream && <VideoTile stream={screenStream} name="Your screen" sharing muted />}
          {screenTiles.map(renderTile)}
          <VideoTile
            stream={localStream}
            name={`${displayName} (you)`}
            muted
            mirrored
            micOff={!controls.mic}
            camOff={!controls.cam}
          />
          {camTiles.map(renderTile)}
        </main>
        <aside className="hidden w-80 shrink-0 border-l md:block">
          <ChatPanel messages={messages} members={members} onSend={sendChat} />
        </aside>
      </div>

      <ControlsBar
        mic={controls.mic}
        cam={controls.cam}
        sharing={controls.sharing}
        onMic={toggleMic}
        onCam={toggleCam}
        onShare={() => void toggleShare()}
        onInvite={() => void copyInvite()}
        onLeave={leave}
      />

      <JoinGate
        open={phase === 'gate'}
        roomName={roomInfo?.name ?? ''}
        error={gateError}
        onSubmit={(password) => void bootstrap(password)}
      />
    </div>
  )
}
