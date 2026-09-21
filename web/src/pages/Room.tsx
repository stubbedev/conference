import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CircleAlert, Link2, Loader2 } from 'lucide-react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { useLatest } from '@/hooks/latest'
import {
  aspectRatioChanged,
  CAMERA_RESOLUTIONS,
  createMicPipeline,
  DEFAULT_DEVICE_PREFS,
  DEVICE_LABELS,
  FALLBACK_ASPECT_RATIO,
  facingFromLabel,
  facingFromTrack,
  isMobileDevice,
  openTrack,
  openTrackWithFallback,
  resumeAudio,
  stopMediaStream,
  trackConstraints,
  useMediaDevices,
  validDeviceId,
  type CameraFacing,
  type CameraResolution,
  type DeviceKind,
  type DevicePrefs,
  type MicPipeline,
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
import { forgetRoomPassword, rememberRoomPassword, savedRoomPassword } from '@/lib/roompass'
import { RoomClient, type ChatMessage, type MemberInfo, type ModerateAction } from '@/lib/sfu'
import { Button } from '@/components/ui/button'
import { ChatPanel } from '@/components/ChatPanel'
import { ControlsBar } from '@/components/ControlsBar'
import { DeviceSettingsPopover } from '@/components/MediaSettings'
import { JoinGate } from '@/components/JoinGate'
import { ParticipantsPanel } from '@/components/ParticipantsPanel'
import { Prejoin } from '@/components/Prejoin'
import { ThemeToggle } from '@/components/ThemeToggle'
import { toggleTileDebug, VideoTile } from '@/components/VideoTile'

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

interface TileHandlers {
  canPin: boolean
  onTogglePin: () => void
  onAspectRatio: (ratio: number) => void
}

type Phase = 'checking' | 'gate' | 'prejoin' | 'joining' | 'live' | 'error'

const SCREEN_KIND = 'screen'
const CAMERA_KIND = 'camera'
const LOCAL_SOURCE = 'local'
const NO_PIN = 'none'
const RECOVER_BACKOFF_MS = 5000
const DEVICE_POLL_MS = 3000

function supportsE2EE(): boolean {
  return 'RTCRtpScriptTransform' in window
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
  const [tileRatios, setTileRatios] = useState<Record<string, number>>({})
  const [fullscreen, setFullscreen] = useState(false)
  const [privileged, setPrivileged] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const titleTapsRef = useRef<number[]>([])
  const copyTimerRef = useRef<number | undefined>(undefined)
  const pageErrorsRef = useRef<string[]>([])

  const [displayName, setDisplayName] = usePersistentState('conference:name', randomDisplayName)
  const [devicePrefs, setDevicePrefs] = usePersistentState<DevicePrefs>(
    'conference:devices',
    DEFAULT_DEVICE_PREFS,
    // Built field by field so keys from earlier versions (the
    // equalizer bands) are dropped instead of carried along forever.
    (stored) => ({
      mic: typeof stored.mic === 'string' ? stored.mic : '',
      cam: typeof stored.cam === 'string' ? stored.cam : '',
      speaker: typeof stored.speaker === 'string' ? stored.speaker : '',
      resolution: CAMERA_RESOLUTIONS.some((option) => option.value === stored.resolution)
        ? stored.resolution
        : 'auto',
      volume: typeof stored.volume === 'number' ? Math.min(1, Math.max(0, stored.volume)) : 1,
      micGain: typeof stored.micGain === 'number' ? Math.min(4, Math.max(0, stored.micGain)) : 1,
      camFacing:
        stored.camFacing === 'user' || stored.camFacing === 'environment'
          ? stored.camFacing
          : '',
    }),
  )
  const [chatOpen, setChatOpen] = usePersistentState('conference:chat-open', false)

  const { devices, refresh: refreshDevices } = useMediaDevices()
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function'

  const clientRef = useRef<RoomClient | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const micPipelineRef = useRef<MicPipeline | null>(null)
  const sessionRef = useRef('')
  const roomKeyRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const iceRef = useRef<RTCIceServer[]>([])

  const controlsRef = useLatest(controls)
  const prefsRef = useLatest(devicePrefs)
  const devicesRef = useLatest(devices)
  const chatOpenRef = useLatest(chatOpen)
  const membersRef = useLatest(members)
  const kickedRef = useRef(false)
  const seenDeviceIdsRef = useRef<Set<string>>(new Set())
  const lossGuardRef = useRef<Partial<Record<TrackKind, MediaStreamTrack>>>({})
  const recoverLockRef = useRef(false)
  const lastRecoverRef = useRef(0)

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

  // Returns the previous object when nothing in the patch differs, so
  // the re-affirmations after a device switch (same id, same facing)
  // never re-render the settings popover or persist to storage.
  const updateDevicePrefs = useCallback(
    (patch: Partial<DevicePrefs>) => {
      setDevicePrefs((prev) => {
        const changed = (Object.keys(patch) as (keyof DevicePrefs)[]).some(
          (key) => !Object.is(prev[key], patch[key]),
        )
        return changed ? { ...prev, ...patch } : prev
      })
    },
    [setDevicePrefs],
  )

  const handleLocalTrackLoss = useCallback(
    (kind: TrackKind, outbound: MediaStreamTrack) => {
      lossGuardRef.current[kind] = undefined
      const stream = localStreamRef.current
      if (!stream || !stream.getTracks().includes(outbound)) return
      stream.removeTrack(outbound)
      if (kind === 'mic' && micPipelineRef.current?.track === outbound) {
        micPipelineRef.current.dispose()
        micPipelineRef.current = null
      }
      setLocalStream(new MediaStream(stream.getTracks()))
      toast.warning(
        `${DEVICE_LABELS[kind]} disconnected; it rejoins automatically when available again.`,
      )
      void refreshDevices()
    },
    [refreshDevices],
  )

  const watchLocalTrack = useCallback(
    (kind: TrackKind, rawTrack: MediaStreamTrack, outbound: MediaStreamTrack) => {
      lossGuardRef.current[kind] = rawTrack
      rawTrack.addEventListener('ended', () => {
        if (lossGuardRef.current[kind] !== rawTrack) return
        handleLocalTrackLoss(kind, outbound)
      })
    },
    [handleLocalTrackLoss],
  )

  const acquireMedia = useCallback(async () => {
    setMediaBusy(true)
    setMediaError('')
    try {
      const prefs = prefsRef.current
      // On a phone the lens, not the deviceId, is the stable identity:
      // open the remembered facing directly so an iOS id rotation can
      // never reset the camera choice to the system default.
      const mobile = isMobileDevice()
      const chosenCam = devicesRef.current.cams.find((device) => device.deviceId === prefs.cam)
      const camFacing = mobile
        ? prefs.camFacing || facingFromLabel(chosenCam?.label ?? '') || undefined
        : undefined
      if (mobile) {
        // Android lets a page hold one camera at a time: a retry that
        // asks for the other lens while the current one is still
        // capturing fails outright, so release everything first.
        lossGuardRef.current = {}
        micPipelineRef.current?.dispose()
        micPipelineRef.current = null
        stopMediaStream(localStreamRef.current)
      }
      const combined = await navigator.mediaDevices
        .getUserMedia({
          audio: trackConstraints('mic', prefs.mic),
          video: trackConstraints('cam', prefs.cam, prefs.resolution, camFacing),
        })
        .catch(() => null)
      const micTrack = combined
        ? (combined.getAudioTracks()[0] ?? null)
        : await openTrack('mic', prefs.mic)
      const camTrack = combined
        ? (combined.getVideoTracks()[0] ?? null)
        : await openTrack('cam', prefs.cam, true, prefs.resolution, camFacing)

      if (!micTrack && !camTrack) {
        stopMediaStream(localStreamRef.current)
        localStreamRef.current = null
        setLocalStream(null)
        setMediaError('Camera and microphone are unavailable. Allow access in your browser, then retry.')
        return
      }
      if (!micTrack) toast.warning('No microphone found — others will not hear you.')
      if (!camTrack) toast.warning('No camera found — others will not see you.')

      // Route the mic through the gain graph; the pipeline's track is
      // what the stream (and the sender) carries, while the raw capture
      // track stays owned by the pipeline for muting and rewiring.
      micPipelineRef.current?.dispose()
      micPipelineRef.current = null
      let outboundMic: MediaStreamTrack | null = micTrack
      if (micTrack) {
        const pipeline = createMicPipeline(micTrack, prefs.micGain)
        if (pipeline) {
          micPipelineRef.current = pipeline
          outboundMic = pipeline.track
        }
      }

      if (micTrack) micTrack.enabled = controlsRef.current.mic
      if (camTrack) camTrack.enabled = controlsRef.current.cam

      stopMediaStream(localStreamRef.current)
      const stream = new MediaStream([outboundMic, camTrack].filter(Boolean) as MediaStreamTrack[])
      localStreamRef.current = stream
      setLocalStream(stream)
      if (micTrack && outboundMic) watchLocalTrack('mic', micTrack, outboundMic)
      if (camTrack) watchLocalTrack('cam', camTrack, camTrack)
      if (camTrack && mobile) {
        // Remember the facing of the camera that actually opened so the
        // picker names the live lens and the next page load (iOS rotates
        // deviceIds) restores the same one.
        const facing = facingFromTrack(camTrack) ?? camFacing
        const cams = devicesRef.current.cams
        let cam = prefs.cam
        if (facing && (!cam || !cams.some((device) => device.deviceId === cam))) {
          cam = cams.find((device) => facingFromLabel(device.label) === facing)?.deviceId ?? cam
        }
        if (cam !== prefs.cam || (facing ?? '') !== prefs.camFacing) {
          updateDevicePrefs({ cam, camFacing: facing ?? '' })
        }
      }
      void refreshDevices()
    } finally {
      setMediaBusy(false)
    }
  }, [refreshDevices, controlsRef, prefsRef, devicesRef, updateDevicePrefs, watchLocalTrack])

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
          const pass = password ?? savedRoomPassword(slug)
          if (!pass) {
            setGateError('')
            setPhase('gate')
            return
          }
          if (!info.authSalt) throw new Error('This room is missing its password salt.')
          const proof = await deriveProof(pass, info.authSalt)
          const res = await api.auth(slug, { proof }).catch((err: unknown) => {
            // A remembered password that no longer works falls back to
            // the prompt instead of failing the join.
            if (!password) forgetRoomPassword(slug)
            throw err
          })
          if (password) rememberRoomPassword(slug, password)
          session = res.session
          if (res.key) keyB64 = res.key
          else if (res.keyblob && res.keySalt) {
            const raw = await openKeyblob(res.keyblob, res.keySalt, pass)
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
      micPipelineRef.current?.dispose()
      stopMediaStream(localStreamRef.current)
      stopMediaStream(screenStreamRef.current)
    }
  }, [])

  // Stored device ids are re-validated against the device list, which
  // is the only thing that can invalidate them: the pickers only ever
  // store ids taken from that list, so a pref change on its own (a
  // volume tick, a camera-quality pick) must not run this.
  useEffect(() => {
    const seen = seenDeviceIdsRef.current
    for (const device of [...devices.mics, ...devices.cams, ...devices.speakers]) {
      seen.add(device.deviceId)
    }
    const sanitize = (list: MediaDeviceInfo[], deviceId: string) => {
      const validated = validDeviceId(list, deviceId)
      return validated === deviceId || seen.has(deviceId) ? deviceId : validated
    }
    setDevicePrefs((prev) => {
      const mic = sanitize(devices.mics, prev.mic)
      const cam = sanitize(devices.cams, prev.cam)
      const speaker = sanitize(devices.speakers, prev.speaker)
      return mic === prev.mic && cam === prev.cam && speaker === prev.speaker
        ? prev
        : { ...prev, mic, cam, speaker }
    })
  }, [devices, setDevicePrefs])

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
        // A member's microphone and camera share one tile (and one
        // MediaStream from the SFU); only a screen share gets its own.
        const tileKind = kind === SCREEN_KIND ? SCREEN_KIND : CAMERA_KIND
        const key = `${sourceId}:${tileKind}`
        setTiles((prev) => {
          const rest = prev.filter((t) => t.key !== key)
          return [...rest, { key, sourceId, kind: tileKind, stream: stream_ }]
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
      // Mute the raw capture track too: gain must not defeat mute.
      if (kind === 'mic') micPipelineRef.current?.setInputEnabled(enabled)
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
    async (
      kind: TrackKind,
      deviceId: string,
      resolution?: CameraResolution,
      opts: { silent?: boolean; facing?: CameraFacing } = {},
    ) => {
      const silent = opts.silent === true
      const prefs = prefsRef.current
      // On phones the picked camera opens by its facing — the lens, not
      // the deviceId, is the stable identity there — so an unopenable
      // duplicate id or an iOS id rotation cannot make a lens dead.
      const requestedFacing =
        kind === 'cam' && isMobileDevice()
          ? (opts.facing ??
            (deviceId
              ? (facingFromLabel(
                  devicesRef.current.cams.find((device) => device.deviceId === deviceId)?.label ??
                    '',
                ) ??
                (deviceId === prefs.cam ? prefs.camFacing || undefined : undefined))
              : undefined))
          : undefined
      // Android (and iOS) let a page hold one camera at a time: while the
      // current lens is still capturing, opening the other one fails with
      // NotReadableError and only the already-open lens can be "opened"
      // again, which is how picking the back camera used to land on the
      // front one with a fallback toast. Release the current camera
      // first, and put it back if the new one does not start.
      const live = localStreamRef.current
      const previous = kind === 'cam' && isMobileDevice() ? live?.getVideoTracks()[0] : undefined
      let previousOpen: { deviceId: string; facing?: CameraFacing } | undefined
      if (previous) {
        previousOpen = {
          deviceId: previous.getSettings().deviceId ?? '',
          facing: facingFromTrack(previous),
        }
        lossGuardRef.current.cam = undefined
        previous.stop()
      }
      let opened = await openTrackWithFallback(
        kind,
        deviceId,
        resolution ?? prefs.resolution,
        requestedFacing,
      )
      if (!opened.track && previousOpen) {
        const restored = await openTrackWithFallback(
          'cam',
          previousOpen.deviceId,
          prefs.resolution,
          previousOpen.facing,
        )
        if (restored.track) {
          if (!silent) toast.error(`Could not switch ${DEVICE_LABELS[kind].toLowerCase()}.`)
          opened = { ...restored, fallback: true }
          deviceId = ''
        }
      }
      const { track, deviceId: usedId, facing: usedFacing, fallback } = opened
      if (!track) {
        if (previous && live) {
          live.removeTrack(previous)
          setLocalStream(new MediaStream(live.getTracks()))
        }
        if (!silent) toast.error(`Could not switch ${DEVICE_LABELS[kind].toLowerCase()}.`)
        return
      }
      if (deviceId && fallback && !silent) {
        toast(
          `That ${DEVICE_LABELS[kind].toLowerCase()} is unavailable here, using the system default.`,
        )
      }
      track.enabled = controlsRef.current[kind]

      // A mic switch reroutes the new capture track through the gain
      // graph; when the pipeline already exists the published track is
      // unchanged, so no replaceTrack churn is needed.
      let outbound = track
      if (kind === 'mic') {
        const pipeline = micPipelineRef.current
        if (pipeline) {
          pipeline.rewire(track)
          outbound = pipeline.track
        } else {
          const created = createMicPipeline(track, prefsRef.current.micGain)
          if (created) {
            micPipelineRef.current = created
            outbound = created.track
          }
        }
      }

      const current = localStreamRef.current
      if (current) {
        const old = kind === 'mic' ? current.getAudioTracks()[0] : current.getVideoTracks()[0]
        if (old && old !== outbound) {
          current.removeTrack(old)
          old.stop()
        }
        if (!current.getTracks().some((existing) => existing === outbound)) {
          current.addTrack(outbound)
        }
        setLocalStream(new MediaStream(current.getTracks()))
      } else {
        const stream = new MediaStream([outbound])
        localStreamRef.current = stream
        setLocalStream(stream)
      }

      watchLocalTrack(kind, track, outbound)
      if (kind === 'mic') {
        updateDevicePrefs({ mic: usedId })
      } else if (!fallback) {
        const effectiveFacing = usedFacing ?? requestedFacing
        let cam = usedId
        if (effectiveFacing && isMobileDevice()) {
          // The open may have come back on a sibling id of the same lens
          // (Android duplicates): re-point at the entry the user picked,
          // resolved by facing, so the selection stays visible.
          const cams = devicesRef.current.cams
          if (!cam || !cams.some((device) => device.deviceId === cam)) {
            cam =
              cams.find((device) => facingFromLabel(device.label) === effectiveFacing)?.deviceId ??
              cam
          }
        }
        updateDevicePrefs({
          cam,
          ...(isMobileDevice() ? { camFacing: effectiveFacing ?? '' } : {}),
          ...(resolution ? { resolution } : {}),
        })
      } else if (isMobileDevice()) {
        // The open fell back to the system default; the picked entry
        // stays selected in the picker (the toast already says why) and
        // only an explicit resolution change is remembered.
        if (resolution) updateDevicePrefs({ resolution })
      } else {
        updateDevicePrefs({ cam: usedId, ...(resolution ? { resolution } : {}) })
      }
      setMediaError('')
      void refreshDevices()
      await clientRef.current?.replaceLocalTrack(kind, outbound)
      clientRef.current?.setTrackEnabled(kind, controlsRef.current[kind])
      if (silent) toast.success(`${DEVICE_LABELS[kind]} is back in the call`)
    },
    [updateDevicePrefs, refreshDevices, controlsRef, prefsRef, devicesRef, watchLocalTrack],
  )

  useEffect(() => {
    if (phase !== 'prejoin' && phase !== 'live') return
    if (mediaBusy || recoverLockRef.current) return
    const stream = localStreamRef.current
    const wantsCam = !stream?.getVideoTracks().length && devices.cams.length > 0
    const wantsMic = !stream?.getAudioTracks().length && devices.mics.length > 0
    if (!wantsCam && !wantsMic) return
    if (Date.now() - lastRecoverRef.current < RECOVER_BACKOFF_MS) return

    lastRecoverRef.current = Date.now()
    recoverLockRef.current = true
    void (async () => {
      try {
        if (wantsCam) {
          const prefs = prefsRef.current
          await switchDevice('cam', prefs.cam, undefined, {
            silent: true,
            ...(isMobileDevice() && prefs.camFacing ? { facing: prefs.camFacing } : {}),
          })
        }
        if (!localStreamRef.current?.getAudioTracks().length && devices.mics.length > 0) {
          await switchDevice('mic', prefsRef.current.mic, undefined, { silent: true })
        }
      } finally {
        recoverLockRef.current = false
      }
    })()
  }, [devices, phase, localStream, mediaBusy, switchDevice, prefsRef])

  useEffect(() => {
    if (phase !== 'prejoin' && phase !== 'live') return
    const missingTrack = () => {
      const stream = localStreamRef.current
      return !stream?.getVideoTracks().length || !stream?.getAudioTracks().length
    }
    if (!missingTrack()) return

    const poll = window.setInterval(() => {
      if (missingTrack()) void refreshDevices()
    }, DEVICE_POLL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && missingTrack()) void refreshDevices()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [phase, localStream, refreshDevices])

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

  const handleMicGainChange = useCallback(
    (gain: number) => {
      updateDevicePrefs({ micGain: gain })
      micPipelineRef.current?.setGain(gain)
    },
    [updateDevicePrefs],
  )

  // Keyed on mic presence, not stream identity: a camera switch replaces
  // the stream but must not toggle the mic slider in and out.
  const hasMic = Boolean(localStream?.getAudioTracks().length)

  const settingsPopover = useMemo(
    () => (
      <DeviceSettingsPopover
        devices={devices}
        selected={devicePrefs}
        hasMic={hasMic}
        onChange={handleDeviceChange}
        onResolutionChange={handleResolutionChange}
        onVolumeChange={handleVolumeChange}
        onMicGainChange={handleMicGainChange}
      />
    ),
    [
      devices,
      devicePrefs,
      hasMic,
      handleDeviceChange,
      handleResolutionChange,
      handleVolumeChange,
      handleMicGainChange,
    ],
  )

  useEffect(() => {
    const record = (text: string) => {
      pageErrorsRef.current = [...pageErrorsRef.current.slice(-9), text]
    }
    const onError = (event: ErrorEvent) =>
      record(`${new Date().toLocaleTimeString()} ${event.message} @${event.lineno}`)
    const onRejection = (event: PromiseRejectionEvent) =>
      record(`${new Date().toLocaleTimeString()} promise ${String(event.reason)}`)

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

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

  // Five taps on the room name toggle the diagnostics panel and the
  // per-tile overlays; a single tap still copies the invite link.
  const onTitleTap = () => {
    const now = Date.now()
    titleTapsRef.current = titleTapsRef.current.filter((tap) => now - tap < 2500)
    titleTapsRef.current.push(now)
    window.clearTimeout(copyTimerRef.current)

    if (titleTapsRef.current.length >= 5) {
      titleTapsRef.current = []
      setDebugOpen(!debugOpen)
      toggleTileDebug()

      return
    }

    copyTimerRef.current = window.setTimeout(() => void copyInvite(), 450)
  }

  const leave = useCallback(() => {
    clientRef.current?.leave()
    navigate('/')
  }, [navigate])

  const sendChat = useCallback(async (text: string) => {
    await clientRef.current?.sendChat(text)
    setMessages((prev) => [
      ...prev,
      { id: `me:${Date.now()}`, name: 'You', text, ts: Date.now(), mine: true },
    ])
  }, [])

  const moderateMember = useCallback(
    (target: string, action: ModerateAction) => clientRef.current?.moderate(target, action),
    [],
  )

  const toggleMic = useCallback(() => toggleTrack('mic'), [toggleTrack])
  const toggleCam = useCallback(() => toggleTrack('cam'), [toggleTrack])
  const toggleScreen = useCallback(() => void toggleShare(), [toggleShare])

  const selfMember: MemberInfo = useMemo(
    () => ({
      id: LOCAL_SOURCE,
      short: 0,
      name: displayName,
      mic: controls.mic,
      cam: controls.cam,
      sharing: controls.sharing,
    }),
    [displayName, controls],
  )
  const memberList = useMemo(() => [selfMember, ...members], [selfMember, members])

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

  const handleTileRatio = useCallback((key: string, ratio: number) => {
    setTileRatios((prev) =>
      aspectRatioChanged(prev[key] ?? 0, ratio) ? { ...prev, [key]: ratio } : prev,
    )
  }, [])

  const pinnedKeyRef = useLatest(pinnedKey)

  const togglePin = useCallback(
    (key: string) => {
      setUserPin(pinnedKeyRef.current === key ? NO_PIN : key)
    },
    [pinnedKeyRef],
  )

  const tileHandlersRef = useRef(new Map<string, TileHandlers>())
  const tileHandlers = useCallback(
    (key: string, canPin: boolean): TileHandlers => {
      const cached = tileHandlersRef.current.get(key)
      if (cached && cached.canPin === canPin) return cached
      const entry: TileHandlers = {
        canPin,
        onTogglePin: () => togglePin(key),
        onAspectRatio: (ratio: number) => handleTileRatio(key, ratio),
      }
      tileHandlersRef.current.set(key, entry)
      return entry
    },
    [togglePin, handleTileRatio],
  )

  const renderTile = (tile: Tile, compact = false) => {
    const isLocal = tile.sourceId === LOCAL_SOURCE
    const isScreen = tile.kind === SCREEN_KIND
    const member = isLocal ? selfMember : members.find((m) => m.id === tile.sourceId)
    const handlers = tileHandlers(tile.key, allTiles.length > 1)
    // Only a remote camera tile plays audio; local and screen tiles get
    // no sink or volume so a volume drag does not re-render them.
    const playsAudio = !isLocal && !isScreen
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
        sinkId={playsAudio ? devicePrefs.speaker : undefined}
        volume={playsAudio ? devicePrefs.volume : undefined}
        pinned={pinnedKey === tile.key}
        onTogglePin={handlers.canPin ? handlers.onTogglePin : undefined}
        compact={compact}
        onAspectRatio={compact ? undefined : handlers.onAspectRatio}
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
            onClick={onTitleTap}
            title="Copy invite link (tap 5× for diagnostics)"
            className="group -mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-sm font-medium transition-colors hover:bg-secondary"
          >
            <span className="truncate">{roomInfo?.name || slug}</span>
            <Link2 className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ParticipantsPanel
            members={memberList}
            selfId={selfMember.id}
            canModerate={privileged}
            onModerate={moderateMember}
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
            {allTiles.map((tile) => {
              const ratio = tileRatios[tile.key] ?? FALLBACK_ASPECT_RATIO
              return (
                <div
                  key={tile.key}
                  className="w-full justify-self-center"
                  style={{ aspectRatio: `${ratio}`, maxWidth: `calc(96cqh * ${ratio})` }}
                >
                  {renderTile(tile, false)}
                </div>
              )
            })}
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
                members={memberList}
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
        canShare={canShare}
        onMic={toggleMic}
        onCam={toggleCam}
        onShare={toggleScreen}
        onLeave={leave}
        onToggleChat={toggleChat}
        onToggleFullscreen={toggleFullscreen}
      >
        {settingsPopover}
      </ControlsBar>
      {debugOpen && <DiagnosticsPanel clientRef={clientRef} errorsRef={pageErrorsRef} />}
    </div>
  )
}

function DiagnosticsPanel({
  clientRef,
  errorsRef,
}: {
  clientRef: RefObject<RoomClient | null>
  errorsRef: RefObject<string[]>
}) {
  const [text, setText] = useState('')

  useEffect(() => {
    let alive = true

    const sample = async () => {
      const client = clientRef.current
      const report = client
        ? await client.debugStats().catch(() => 'stats unavailable')
        : 'not joined yet'

      if (!alive) return

      setText(`${report}\n--- page errors ---\n${errorsRef.current.join('\n') || 'none'}`)
    }

    void sample()

    const timer = window.setInterval(() => void sample(), 1000)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [clientRef, errorsRef])

  return (
    <pre className="fixed bottom-20 left-2 z-50 max-h-64 w-[22rem] max-w-[90vw] overflow-auto rounded-lg bg-black/85 p-2 font-mono text-[10px] leading-tight break-all whitespace-pre-wrap text-emerald-300">
      {text || 'collecting…'}
    </pre>
  )
}
