import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, Link2, Loader2 } from 'lucide-react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { useLatest } from '@/hooks/latest'
import {
  CAMERA_RESOLUTIONS,
  DEFAULT_DEVICE_PREFS,
  DEVICE_LABELS,
  openTrack,
  resumeAudio,
  stopMediaStream,
  trackConstraints,
  useMediaDevices,
  validDeviceId,
  type CameraResolution,
  type DeviceKind,
  type DevicePrefs,
  type TrackKind,
} from '@/hooks/media'
import { usePersistentState } from '@/hooks/persistent'
import { api, type RoomInfo } from '@/lib/api'
import { randomDisplayName } from '@/lib/names'
import {
  deriveChatKey,
  deriveMediaKeyMaterial,
  deriveProof,
  fromB64,
  openKeyblob,
  toB64,
} from '@/lib/roomkeys'
import { RoomClient, type ChatMessage, type MemberInfo } from '@/lib/sfu'
import { Button } from '@/components/ui/button'
import { ChatPanel } from '@/components/ChatPanel'
import { ControlsBar } from '@/components/ControlsBar'
import { DeviceSettingsPopover } from '@/components/MediaSettings'
import { JoinGate } from '@/components/JoinGate'
import { ParticipantsPanel } from '@/components/ParticipantsPanel'
import { Prejoin } from '@/components/Prejoin'
import { ThemeToggle } from '@/components/ThemeToggle'
import { VideoTile } from '@/components/VideoTile'

interface Controls {
  mic: boolean
  cam: boolean
  sharing: boolean
}

interface Tile {
  key: string
  sourceId: string
  kind: string
  stream: MediaStream | null
}

type Phase = 'checking' | 'gate' | 'prejoin' | 'joining' | 'live' | 'error'

const SCREEN_KIND = 'screen'
const LOCAL_SOURCE = 'local'
const NO_PIN = 'none'

function supportsE2EE(): boolean {
  return 'RTCRtpScriptTransform' in window || 'createEncodedStreams' in RTCRtpSender.prototype
}

export default function Room() {
  const { slug = '' } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const [phase, setPhase] = useState<Phase>('checking')
  const [gateBusy, setGateBusy] = useState(false)
  const [gateError, setGateError] = useState('')
  const [fatalError, setFatalError] = useState('')
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null)
  const [members, setMembers] = useState<MemberInfo[]>([])
  const [tiles, setTiles] = useState<Tile[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const [controls, setControls] = useState<Controls>({ mic: true, cam: true, sharing: false })
  const [mediaError, setMediaError] = useState('')
  const [mediaBusy, setMediaBusy] = useState(false)
  const [unread, setUnread] = useState(0)
  const [userPin, setUserPin] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [privileged, setPrivileged] = useState(false)

  const [displayName, setDisplayName] = usePersistentState('conference:name', randomDisplayName)
  const [devicePrefs, setDevicePrefs] = usePersistentState<DevicePrefs>(
    'conference:devices',
    DEFAULT_DEVICE_PREFS,
    (stored) => ({
      ...DEFAULT_DEVICE_PREFS,
      ...stored,
      resolution: CAMERA_RESOLUTIONS.some((option) => option.value === stored.resolution)
        ? stored.resolution
        : 'auto',
      volume:
        typeof stored.volume === 'number' ? Math.min(1, Math.max(0, stored.volume)) : 1,
    }),
  )
  const [chatOpen, setChatOpen] = usePersistentState(
    'conference:chat-open',
    window.innerWidth >= 768,
  )

  const { devices, refresh: refreshDevices } = useMediaDevices()

  const clientRef = useRef<RoomClient | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const sessionRef = useRef('')
  const roomKeyRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const iceRef = useRef<RTCIceServer[]>([])

  const controlsRef = useLatest(controls)
  const prefsRef = useLatest(devicePrefs)
  const chatOpenRef = useLatest(chatOpen)
  const membersRef = useLatest(members)
  const kickedRef = useRef(false)

  const privToken = searchParams.get('p') ?? ''
  const hashKey = useMemo(() => {
    const match = window.location.hash.match(/#k=([A-Za-z0-9_-]+)/)
    return match ? match[1] : ''
  }, [])

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    const root = document.documentElement
    if (typeof root.requestFullscreen === 'function') {
      void root.requestFullscreen().catch(() => {})
    }
  }, [])

  const updateControls = useCallback(
    (patch: Partial<Controls>) => {
      controlsRef.current = { ...controlsRef.current, ...patch }
      setControls(controlsRef.current)
    },
    [controlsRef],
  )

  const updateDevicePrefs = useCallback(
    (patch: Partial<DevicePrefs>) => {
      setDevicePrefs((prev) => ({ ...prev, ...patch }))
    },
    [setDevicePrefs],
  )

  const acquireMedia = useCallback(async () => {
    setMediaBusy(true)
    setMediaError('')
    try {
      const prefs = prefsRef.current
      const combined = await navigator.mediaDevices
        .getUserMedia({
          audio: trackConstraints('mic', prefs.mic),
          video: trackConstraints('cam', prefs.cam, prefs.resolution),
        })
        .catch(() => null)
      const micTrack = combined
        ? (combined.getAudioTracks()[0] ?? null)
        : await openTrack('mic', prefs.mic)
      const camTrack = combined
        ? (combined.getVideoTracks()[0] ?? null)
        : await openTrack('cam', prefs.cam, true, prefs.resolution)

      if (!micTrack && !camTrack) {
        stopMediaStream(localStreamRef.current)
        localStreamRef.current = null
        setLocalStream(null)
        setMediaError('Camera and microphone are unavailable. Allow access in your browser, then retry.')
        return
      }
      if (!micTrack) toast.warning('No microphone found — others will not hear you.')
      if (!camTrack) toast.warning('No camera found — others will not see you.')

      if (micTrack) micTrack.enabled = controlsRef.current.mic
      if (camTrack) camTrack.enabled = controlsRef.current.cam

      stopMediaStream(localStreamRef.current)
      const stream = new MediaStream([micTrack, camTrack].filter(Boolean) as MediaStreamTrack[])
      localStreamRef.current = stream
      setLocalStream(stream)
      void refreshDevices()
    } finally {
      setMediaBusy(false)
    }
  }, [refreshDevices, controlsRef, prefsRef])

  const bootstrap = useCallback(
    async (password?: string) => {
      try {
        const info = await api.roomInfo(slug)
        setRoomInfo(info)

        let session = ''
        let keyB64 = hashKey

        if (privToken) {
          const res = await api.auth(slug, { token: privToken })
          session = res.session
          setPrivileged(res.priv)
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

        if (!supportsE2EE()) {
          throw new Error(
            'This browser cannot do end-to-end encrypted media. Use a recent Chrome, Edge or Safari.',
          )
        }

        const cfg = await api.config()
        iceRef.current = cfg.iceServers
        sessionRef.current = session
        roomKeyRef.current = fromB64(keyB64)
        setPhase('prejoin')
        void acquireMedia()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not join the room.'
        if (/password/i.test(message)) {
          setGateError(message)
          setPhase('gate')
        } else {
          setFatalError(message)
          setPhase('error')
        }
      } finally {
        setGateBusy(false)
      }
    },
    [slug, privToken, hashKey, acquireMedia],
  )

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    return () => {
      clientRef.current?.leave()
      stopMediaStream(localStreamRef.current)
      stopMediaStream(screenStreamRef.current)
    }
  }, [])

  useEffect(() => {
    const next: DevicePrefs = {
      ...devicePrefs,
      mic: validDeviceId(devices.mics, devicePrefs.mic),
      cam: validDeviceId(devices.cams, devicePrefs.cam),
      speaker: validDeviceId(devices.speakers, devicePrefs.speaker),
    }
    if (
      next.mic !== devicePrefs.mic ||
      next.cam !== devicePrefs.cam ||
      next.speaker !== devicePrefs.speaker
    ) {
      setDevicePrefs(next)
    }
  }, [devices, devicePrefs, setDevicePrefs])

  const joinCall = useCallback(async () => {
    const stream = localStreamRef.current
    const info = roomInfo
    const roomKey = roomKeyRef.current
    if (!stream || stream.getTracks().length === 0 || !info || !roomKey) return

    resumeAudio()
    setPhase('joining')
    try {
      const [mediaKey, chatKey] = await Promise.all([
        deriveMediaKeyMaterial(roomKey),
        deriveChatKey(roomKey),
      ])

      const client = new RoomClient({
        slug,
        session: sessionRef.current,
        name: displayName.trim() || 'Guest',
        mediaKey: mediaKey,
        chatKey,
        iceServers: iceRef.current,
      })
      clientRef.current = client

      client.on('welcome', ({ members: initial }) => setMembers(initial))
      client.on('member-joined', (member) => {
        setMembers((prev) => [...prev.filter((m) => m.id !== member.id), member])
        toast(`${member.name} joined`)
      })
      client.on('member-left', ({ id }) => {
        const name = membersRef.current.find((m) => m.id === id)?.name ?? 'Someone'
        toast(`${name} left`)
        setMembers((prev) => prev.filter((m) => m.id !== id))
        setTiles((prev) => prev.filter((t) => t.sourceId !== id))
      })
      client.on('member-state', ({ id, mic, cam, sharing }) => {
        setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, mic, cam, sharing } : m)))
        if (id !== client.memberId && !sharing) {
          setTiles((prev) => prev.filter((t) => !(t.sourceId === id && t.kind === SCREEN_KIND)))
        }
      })
      client.on('track', ({ sourceId, stream: stream_, kind }) => {
        setTiles((prev) => {
          if (kind === 'audio') {
            const cam = prev.find((t) => t.sourceId === sourceId && t.kind === 'cam')
            if (cam) return prev
          }
          const key = `${sourceId}:${kind === 'audio' ? 'cam' : kind}`
          const rest = prev.filter((t) => t.key !== key)
          return [...rest, { key, sourceId, kind, stream: stream_ }]
        })
      })
      client.on('chat', (message) => {
        setMessages((prev) => [...prev, message])
        if (!message.mine && !chatOpenRef.current) setUnread((count) => count + 1)
      })
      client.on('error', ({ text }) => toast.error(text))
      client.on('closed', () => {
        if (kickedRef.current) return
        toast.error('The connection was closed.')
        navigate('/')
      })

      await client.connect()
      await client.publish(stream)
      setPhase('live')
    } catch (err) {
      clientRef.current?.leave()
      clientRef.current = null
      setFatalError(err instanceof Error ? err.message : 'Could not join the room.')
      setPhase('error')
    }
  }, [slug, displayName, roomInfo, navigate, chatOpenRef, membersRef, kickedRef])

  const toggleTrack = useCallback(
    (kind: TrackKind) => {
      const enabled = !controlsRef.current[kind]
      const current = localStreamRef.current
      const tracks = kind === 'mic' ? current?.getAudioTracks() : current?.getVideoTracks()
      for (const track of tracks ?? []) track.enabled = enabled
      clientRef.current?.setTrackEnabled(kind, enabled)
      updateControls(kind === 'mic' ? { mic: enabled } : { cam: enabled })
    },
    [updateControls, controlsRef],
  )

  const toggleChat = useCallback(() => {
    const next = !chatOpenRef.current
    setChatOpen(next)
    if (next) setUnread(0)
  }, [setChatOpen, chatOpenRef])

  const toggleShare = useCallback(async () => {
    const client = clientRef.current
    if (!client) return

    if (controlsRef.current.sharing) {
      await client.removeScreen()
      stopMediaStream(screenStreamRef.current)
      screenStreamRef.current = null
      setScreenStream(null)
      updateControls({ sharing: false })
      return
    }

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true })
      screenStreamRef.current = display
      await client.addScreen(display)
      setScreenStream(display)
      updateControls({ sharing: true })
      display.getVideoTracks()[0]?.addEventListener('ended', () => {
        void client.removeScreen()
        setScreenStream(null)
        updateControls({ sharing: false })
      })
    } catch {
      // The user closed the picker without sharing.
    }
  }, [updateControls, controlsRef])

  useEffect(() => {
    const client = clientRef.current
    if (phase !== 'live' || !client) return

    const unsubscribers = [
      client.on('forced', ({ action }) => {
        if (action === 'mute') {
          toast('The host muted your microphone')
          if (controlsRef.current.mic) toggleTrack('mic')
        } else if (action === 'cam') {
          toast('The host turned off your camera')
          if (controlsRef.current.cam) toggleTrack('cam')
        } else {
          toast('The host stopped your screen share')
          if (controlsRef.current.sharing) void toggleShare()
        }
      }),
      client.on('kicked', () => {
        kickedRef.current = true
        toast('You were removed from the call')
        navigate('/')
      }),
    ]

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [phase, toggleTrack, toggleShare, navigate, controlsRef, kickedRef])

  const switchDevice = useCallback(
    async (kind: TrackKind, deviceId: string, resolution?: CameraResolution) => {
      const prefs = prefsRef.current
      const track =
        kind === 'cam'
          ? await openTrack('cam', deviceId, false, resolution ?? prefs.resolution)
          : await openTrack('mic', deviceId, false)
      if (!track) {
        toast.error(`Could not switch ${DEVICE_LABELS[kind].toLowerCase()}.`)
        return
      }
      track.enabled = controlsRef.current[kind]

      const current = localStreamRef.current
      if (current) {
        const old = kind === 'mic' ? current.getAudioTracks()[0] : current.getVideoTracks()[0]
        if (old) {
          current.removeTrack(old)
          old.stop()
        }
        current.addTrack(track)
        setLocalStream(new MediaStream(current.getTracks()))
      } else {
        const stream = new MediaStream([track])
        localStreamRef.current = stream
        setLocalStream(stream)
      }

      updateDevicePrefs(
        kind === 'mic'
          ? { mic: deviceId }
          : { cam: deviceId, ...(resolution ? { resolution } : {}) },
      )
      setMediaError('')
      void refreshDevices()
      await clientRef.current?.replaceLocalTrack(kind, track)
    },
    [updateDevicePrefs, refreshDevices, controlsRef, prefsRef],
  )

  const handleDeviceChange = useCallback(
    (kind: DeviceKind, deviceId: string) => {
      if (kind === 'speaker') {
        updateDevicePrefs({ speaker: deviceId })
        return
      }
      void switchDevice(kind, deviceId)
    },
    [updateDevicePrefs, switchDevice],
  )

  const handleResolutionChange = useCallback(
    (resolution: CameraResolution) => {
      void switchDevice('cam', prefsRef.current.cam, resolution)
    },
    [switchDevice, prefsRef],
  )

  const handleVolumeChange = useCallback(
    (volume: number) => {
      updateDevicePrefs({ volume })
    },
    [updateDevicePrefs],
  )

  useEffect(() => {
    if (phase !== 'live' && phase !== 'prejoin') return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          'input, textarea, [contenteditable="true"], [data-slot="select-trigger"], [data-slot="select-content"]',
        )
      ) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'm') toggleTrack('mic')
      else if (key === 'v') toggleTrack('cam')
      else if (key === 'c' && phase === 'live') toggleChat()
      else if (key === 'f') toggleFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, toggleTrack, toggleChat, toggleFullscreen])

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

  const selfMember: MemberInfo = {
    id: LOCAL_SOURCE,
    short: 0,
    name: displayName,
    mic: controls.mic,
    cam: controls.cam,
    sharing: controls.sharing,
  }

  const allTiles = useMemo<Tile[]>(() => {
    const list: Tile[] = []
    if (screenStream) {
      list.push({
        key: 'local:screen',
        sourceId: LOCAL_SOURCE,
        kind: SCREEN_KIND,
        stream: screenStream,
      })
    }
    list.push({ key: 'local:cam', sourceId: LOCAL_SOURCE, kind: 'cam', stream: localStream })
    for (const tile of tiles) {
      if (tile.kind === SCREEN_KIND) list.push(tile)
    }
    for (const tile of tiles) {
      if (tile.kind !== SCREEN_KIND) list.push(tile)
    }
    return list
  }, [screenStream, localStream, tiles])

  const pinnedKey =
    userPin === NO_PIN
      ? null
      : userPin && allTiles.some((tile) => tile.key === userPin)
        ? userPin
        : (allTiles.find((tile) => tile.kind === SCREEN_KIND)?.key ?? null)
  const pinnedTile = pinnedKey ? (allTiles.find((tile) => tile.key === pinnedKey) ?? null) : null
  const stripTiles = pinnedTile ? allTiles.filter((tile) => tile.key !== pinnedKey) : []

  const togglePin = (key: string) => {
    setUserPin(pinnedKey === key ? NO_PIN : key)
  }

  const renderTile = (tile: Tile, compact = false) => {
    const isLocal = tile.sourceId === LOCAL_SOURCE
    const isScreen = tile.kind === SCREEN_KIND
    const member = isLocal ? selfMember : members.find((m) => m.id === tile.sourceId)
    return (
      <VideoTile
        key={tile.key}
        stream={tile.stream}
        name={
          isLocal ? (isScreen ? 'Your screen' : `${displayName} (you)`) : member?.name ?? 'Guest'
        }
        muted={isLocal}
        mirrored={isLocal && !isScreen}
        micOff={!isScreen ? !(member?.mic ?? true) : false}
        camOff={!isScreen ? !(member?.cam ?? true) : false}
        sharing={isScreen}
        sinkId={isLocal ? undefined : devicePrefs.speaker}
        volume={isLocal ? undefined : devicePrefs.volume}
        pinned={pinnedKey === tile.key}
        onTogglePin={allTiles.length > 1 ? () => togglePin(tile.key) : undefined}
        compact={compact}
      />
    )
  }

  const gate = (
    <JoinGate
      open={phase === 'gate'}
      busy={gateBusy}
      roomName={roomInfo?.name ?? ''}
      error={gateError}
      onSubmit={(password) => {
        setGateBusy(true)
        void bootstrap(password)
      }}
    />
  )

  if (phase === 'checking') {
    return (
      <div className="grid h-dvh place-items-center">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking the room…
        </p>
      </div>
    )
  }

  if (phase === 'gate') {
    return <div className="relative grid h-dvh place-items-center bg-muted/40">{gate}</div>
  }

  if (phase === 'error') {
    return (
      <div className="grid h-dvh place-items-center">
        <div className="grid gap-3 text-center">
          <CircleAlert className="mx-auto size-8 text-muted-foreground" />
          <p className="text-lg font-medium">Could not open this room</p>
          <p className="text-sm text-muted-foreground">{fatalError}</p>
          <Button variant="secondary" onClick={() => navigate('/')}>
            Back to start
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'prejoin') {
    return (
      <>
        <div className="absolute top-3 right-3 z-10">
          <ThemeToggle />
        </div>
        <Prejoin
          roomName={roomInfo?.name ?? ''}
          slug={slug}
          stream={localStream}
          mediaError={mediaError}
          mediaBusy={mediaBusy}
          name={displayName}
          onNameChange={setDisplayName}
          onRetryMedia={() => void acquireMedia()}
          onJoin={() => void joinCall()}
        />
      </>
    )
  }

  if (phase === 'joining') {
    return (
      <div className="grid h-dvh place-items-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Joining…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void copyInvite()}
            title="Copy invite link"
            className="group -mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-sm font-medium transition-colors hover:bg-secondary"
          >
            <span className="truncate">{roomInfo?.name || slug}</span>
            <Link2 className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ParticipantsPanel
            members={[selfMember, ...members]}
            selfId={selfMember.id}
            canModerate={privileged}
            onModerate={(target, action) => clientRef.current?.moderate(target, action)}
          />
          <ThemeToggle />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 bg-muted/40">
        {pinnedTile ? (
          <main className="flex min-h-0 flex-1 flex-col gap-2 p-2">
            <div className="min-h-0 flex-1">{renderTile(pinnedTile)}</div>
            {stripTiles.length > 0 && (
              <div className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto pb-0.5">
                {stripTiles.map((tile) => (
                  <div key={tile.key} className="aspect-video w-40 shrink-0 sm:w-52">
                    {renderTile(tile, true)}
                  </div>
                ))}
              </div>
            )}
          </main>
        ) : (
          <main
            className="grid min-h-0 flex-1 gap-2 overflow-y-auto p-2"
            style={{
              containerType: 'size',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
              alignContent: 'safe center',
            }}
          >
            {allTiles.map((tile) => (
              <div
                key={tile.key}
                className="aspect-video w-full justify-self-center"
                style={{ maxWidth: 'min(100%, 172cqh)' }}
              >
                {renderTile(tile)}
              </div>
            ))}
          </main>
        )}

        {chatOpen && (
          <>
            <button
              type="button"
              aria-label="Close chat"
              className="absolute inset-0 z-30 cursor-default bg-black/50 md:hidden"
              onClick={toggleChat}
            />
            <aside className="absolute inset-y-0 right-0 z-40 flex w-[85%] max-w-xs flex-col bg-background shadow-xl md:static md:z-auto md:w-80 md:max-w-none md:shrink-0 md:border-l md:shadow-none">
              <ChatPanel
                messages={messages}
                members={[selfMember, ...members]}
                onSend={sendChat}
                onClose={toggleChat}
              />
            </aside>
          </>
        )}
      </div>

      <ControlsBar
        mic={controls.mic}
        cam={controls.cam}
        sharing={controls.sharing}
        chatOpen={chatOpen}
        unread={unread}
        fullscreen={fullscreen}
        onMic={() => toggleTrack('mic')}
        onCam={() => toggleTrack('cam')}
        onShare={() => void toggleShare()}
        onLeave={leave}
        onToggleChat={toggleChat}
        onToggleFullscreen={toggleFullscreen}
      >
        <DeviceSettingsPopover
          devices={devices}
          selected={devicePrefs}
          onChange={handleDeviceChange}
          onResolutionChange={handleResolutionChange}
          onVolumeChange={handleVolumeChange}
        />
      </ControlsBar>
    </div>
  )
}
