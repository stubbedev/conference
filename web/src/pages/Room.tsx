import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Circle, CircleAlert, Languages, Link2, Loader2, TriangleAlert, Users } from 'lucide-react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { useLatest } from '@/hooks/latest'
import {
  aspectRatioChanged,
  CAMERA_RESOLUTIONS,
  createMicPipeline,
  DEFAULT_AV_PREFS,
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
  type AvPrefs,
  type CameraFacing,
  type CameraResolution,
  type DeviceKind,
  type DevicePrefs,
  type MicPipeline,
  type TrackKind,
} from '@/hooks/media'
import { usePersistentState } from '@/hooks/persistent'
import { api, type RoomInfo, type TranslationConfig } from '@/lib/api'
import { randomDisplayName } from '@/lib/names'
import {
  deriveChatKey,
  deriveMediaKeyMaterial,
  deriveProof,
  fromB64,
  importPassword,
  openKeyblob,
  toB64,
} from '@/lib/roomkeys'
import { forgetRoomPassword, rememberRoomPassword, savedRoomPassword } from '@/lib/roompass'
import { CallRecorder, recorderSupported, type RecorderTile } from '@/lib/recorder'
import { requestDisplay, SCREEN_AUDIO_KIND, screenTracks } from '@/lib/screen'
import { tilesOfMembers } from '@/lib/reconnect'
import { Translator } from '@/lib/translate/bridge'
import { DEFAULT_LANGUAGE, languageName, type Language } from '@/lib/translate/languages'
import { isVoiceChoice, type LangPrefs, type RoomCaption, type TranslatorStatus } from '@/lib/translate/types'
import {
  JoinError,
  RoomClient,
  type ChatMessage,
  type Layer,
  type MemberInfo,
  type ModerateAction,
} from '@/lib/sfu'
import { Button } from '@/components/ui/button'
import { ChatPanel } from '@/components/ChatPanel'
import { blurSupported, startBlur, type BlurPipeline } from '@/lib/blur'
import { ControlsBar } from '@/components/ControlsBar'
import { DeviceSettingsPopover } from '@/components/MediaSettings'
import { Hint } from '@/components/Hint'
import { JoinGate } from '@/components/JoinGate'
import { PeoplePanel } from '@/components/PeoplePanel'
import { SidePanel, type SidePanelTab } from '@/components/SidePanel'
import { Prejoin } from '@/components/Prejoin'
import { ThemeToggle } from '@/components/ThemeToggle'
import { HudBackdrop } from '@/components/HudBackdrop'
import { VideoTile } from '@/components/VideoTile'
import { toggleTileDebug } from '@/hooks/tileDebug'
import { TranslationAudio } from '@/components/TranslationAudio'
import { TranslationSettings } from '@/components/TranslationSettings'

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
const CAMERA_KIND = 'camera'
const LOCAL_SOURCE = 'local'
const NO_PIN = 'none'
const RECOVER_BACKOFF_MS = 5000
const RECONNECT_TOAST = 'reconnect'
const RECORDING_HIDDEN_TOAST = 'recording-hidden'
const TRANSLATION_KIND_PREFIX = 'translation-'
// A final subtitle stays up this long; an interim one that never got its
// final (the speaker trailed off) is dropped after the longer hold.
const CAPTION_HOLD_MS = 5000
const INTERIM_HOLD_MS = 10_000
const CAPTION_PRUNE_MS = 500

// Until /api/config answers, and when it cannot be read.
const TRANSLATION_CHECKING: TranslationConfig = {
  available: false,
  reason: 'Checking whether live translation is available…',
  languages: [],
  external: false,
}
const TRANSLATION_UNKNOWN: TranslationConfig = {
  available: false,
  reason: 'Live translation is unavailable: the server configuration could not be read.',
  languages: [],
  external: false,
}

const TRANSLATOR_STATE_LABELS: Record<TranslatorStatus['state'], string> = {
  claiming: 'starting…',
  connecting: 'connecting…',
  live: 'live',
  retrying: 'reconnecting…',
  failed: 'failed',
}

interface ShownCaption {
  segId: string
  text: string
  final: boolean
  at: number
}

function localMicTrack(stream: MediaStream | null): MediaStreamTrack | null {
  return stream?.getAudioTracks()[0] ?? null
}
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, ...Array<number>(14).fill(10_000)]

// layoutLayer is the camera layer a tile's on-screen size can use: the
// pinned tile fills the stage, the filmstrip is thumbnails, and grid
// cells shrink as the call grows.
function layoutLayer(key: string, pinnedKey: string | null, tileCount: number): Layer {
  if (pinnedKey) return key === pinnedKey ? 'h' : 'l'
  if (tileCount <= 2) return 'h'
  if (tileCount <= 6) return 'm'
  return 'l'
}

// waitForRetry sleeps for ms, cut short when the browser comes back
// online so a restored network reconnects at once.
function waitForRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer)
      window.removeEventListener('online', done)
      resolve()
    }
    const timer = window.setTimeout(done, ms)
    window.addEventListener('online', done)
  })
}
const DEVICE_POLL_MS = 3000

function supportsE2EE(): boolean {
  return 'RTCRtpScriptTransform' in window
}

// The name a tile carries, on screen and in the recording composite;
// screens are labeled by their owner, since the picture alone does not
// say whose it is.
// What keeps this member's speech from being translated, in words.
function translationWarnings(status: TranslatorStatus, selfLang: string, languages: readonly Language[]): string[] {
  const warnings: string[] = []
  if (status.sameLanguage) {
    warnings.push(`Everyone here speaks ${languageName(languages, selfLang)}: nothing to translate`)
  }
  if (status.failedTranslations > 0) {
    warnings.push(`${status.failedTranslations} sentence${status.failedTranslations === 1 ? '' : 's'} sent untranslated`)
  }
  return warnings
}

function tileLabel(tile: Tile, displayName: string, members: MemberInfo[]): string {
  if (tile.sourceId === LOCAL_SOURCE) {
    return tile.kind === SCREEN_KIND ? 'Your screen' : `${displayName} (you)`
  }
  const name = members.find((member) => member.id === tile.sourceId)?.name ?? 'Guest'
  return tile.kind === SCREEN_KIND ? `${name}'s screen` : name
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
  // Microphone and camera stay as the member last left them, across page
  // reloads and other rooms: someone who joins muted stays muted.
  const [avPrefs, setAvPrefs] = usePersistentState<AvPrefs>(
    'conference:av',
    DEFAULT_AV_PREFS,
    (stored) => ({
      mic: typeof stored.mic === 'boolean' ? stored.mic : true,
      cam: typeof stored.cam === 'boolean' ? stored.cam : true,
    }),
  )
  const [controls, setControls] = useState<Controls>({ mic: avPrefs.mic, cam: avPrefs.cam, sharing: false })
  const [mediaError, setMediaError] = useState('')
  const [mediaBusy, setMediaBusy] = useState(false)
  const [unread, setUnread] = useState(0)
  const [userPin, setUserPin] = useState<string | null>(null)
  const [tileRatios, setTileRatios] = useState<Record<string, number>>({})
  const [fullscreen, setFullscreen] = useState(false)
  const [privileged, setPrivileged] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [recorder, setRecorder] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [translation, setTranslation] = useState<TranslationConfig>(TRANSLATION_CHECKING)
  const translationAvailable = translation.available
  // The room's live translation: the host who switched it on, null when off.
  const [translationBy, setTranslationBy] = useState<string | null>(null)
  const [selfId, setSelfId] = useState('')
  const [captions, setCaptions] = useState<Record<string, ShownCaption>>({})
  // Each speaker's translated voices, by speaker and then language.
  const [translationStreams, setTranslationStreams] = useState<Record<string, Record<string, MediaStream>>>({})
  // Each member's announced language.
  const [memberLangs, setMemberLangs] = useState<Record<string, string>>({})
  // Speakers whose translated voice is playing right now, driven by the
  // bridge's voice cues; voiceEndsRef holds when each one's last ends.
  const [voicePlaying, setVoicePlaying] = useState<Record<string, true>>({})
  const [translatorStatus, setTranslatorStatus] = useState<TranslatorStatus | null>(null)
  // Why live translation stopped on its own; stays until dismissed or restarted.
  const [translationFailure, setTranslationFailure] = useState('')
  const voiceEndsRef = useRef(new Map<string, number>())
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
      blur: stored.blur === true,
      camFacing:
        stored.camFacing === 'user' || stored.camFacing === 'environment'
          ? stored.camFacing
          : '',
    }),
  )
  const [sidebar, setSidebar] = usePersistentState<SidePanelTab | null>(
    'conference:sidebar',
    null,
    (stored) => (stored === 'people' || stored === 'chat' ? stored : null),
  )
  const chatOpen = sidebar === 'chat'
  const [langPrefs, setLangPrefs] = usePersistentState<LangPrefs>(
    'conference:translation',
    { lang: DEFAULT_LANGUAGE, voice: true, subtitles: true, voiceChoice: 'female' },
    (stored) => ({
      lang: typeof stored.lang === 'string' && stored.lang ? stored.lang : DEFAULT_LANGUAGE,
      voice: typeof stored.voice === 'boolean' ? stored.voice : true,
      subtitles: typeof stored.subtitles === 'boolean' ? stored.subtitles : true,
      voiceChoice: isVoiceChoice(stored.voiceChoice) ? stored.voiceChoice : 'female',
    }),
  )

  const { devices, refresh: refreshDevices } = useMediaDevices()
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  const canBlur = blurSupported()

  const clientRef = useRef<RoomClient | null>(null)
  const recorderRef = useRef<CallRecorder | null>(null)
  const translatorRef = useRef<Translator | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const micPipelineRef = useRef<MicPipeline | null>(null)
  const blurPipelineRef = useRef<BlurPipeline | null>(null)
  const blurIntentRef = useRef(false)
  const rawCamRef = useRef<MediaStreamTrack | null>(null)
  const sessionRef = useRef('')
  const roomKeyRef = useRef<Uint8Array<ArrayBuffer> | null>(null)

  const controlsRef = useLatest(controls)
  const prefsRef = useLatest(devicePrefs)

  // Background blur follows a ref as well as the stored preference: the
  // camera is opened asynchronously, and it must land on the choice the
  // person made last, even if they made it while the lens was opening.
  useEffect(() => {
    blurIntentRef.current = devicePrefs.blur
  }, [devicePrefs.blur])
  const devicesRef = useLatest(devices)
  const chatOpenRef = useLatest(chatOpen)
  const membersRef = useLatest(members)
  const langPrefsRef = useLatest(langPrefs)
  const kickedRef = useRef(false)
  const endedRef = useRef(false)
  const reconnectingRef = useRef(false)
  const reconnectRef = useRef<((lost: RoomClient) => Promise<void>) | null>(null)
  const [clientGeneration, setClientGeneration] = useState(0)
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
      const next = { ...controlsRef.current, ...patch }
      controlsRef.current = next
      setControls(next)
      if (patch.mic !== undefined || patch.cam !== undefined) {
        setAvPrefs((prev) =>
          prev.mic === next.mic && prev.cam === next.cam ? prev : { mic: next.mic, cam: next.cam },
        )
      }
    },
    [controlsRef, setAvPrefs],
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

  // The camera's outbound track: the capture itself, or the blurred
  // composite of it. The pipeline is built the first time blur is needed
  // and pointed at whatever capture is live from then on.
  // One message for a machine that cannot run the model at all, and the
  // switch goes back where it was: a camera that silently ignores the
  // toggle is worse than one that says why.
  const blurFailed = useCallback(
    (err: unknown) => {
      console.error('blur: starting the background blur', err)
      blurIntentRef.current = false
      updateDevicePrefs({ blur: false })
      blurPipelineRef.current?.stop()
      blurPipelineRef.current = null
      toast.error('Background blur is unavailable here, so your camera goes out as it is.')
    },
    [updateDevicePrefs],
  )

  const cameraTrackFor = useCallback(
    (raw: MediaStreamTrack, blur: boolean): MediaStreamTrack => {
      if (!blur) {
        blurPipelineRef.current?.stop()
        blurPipelineRef.current = null

        return raw
      }

      try {
        const pipeline = blurPipelineRef.current ?? startBlur(raw, { onUnavailable: blurFailed })
        blurPipelineRef.current = pipeline
        pipeline.rewire(raw)

        return pipeline.track
      } catch (err) {
        blurFailed(err)

        return raw
      }
    },
    [blurFailed],
  )

  // publishCamera swaps the track this member sends as its camera, keeping
  // the raw capture alive: blur can be turned back off, and the pipeline
  // is only ever pointed at it.
  const publishCamera = useCallback(
    async (outbound: MediaStreamTrack) => {
      const current = localStreamRef.current
      if (!current) return

      const previous = current.getVideoTracks()[0]
      if (previous && previous !== outbound) {
        current.removeTrack(previous)
        if (previous !== rawCamRef.current) previous.stop()
      }

      if (!current.getTracks().some((track) => track === outbound)) current.addTrack(outbound)
      setLocalStream(new MediaStream(current.getTracks()))
      await clientRef.current?.replaceLocalTrack('cam', outbound)
      clientRef.current?.setTrackEnabled('cam', controlsRef.current.cam)
    },
    [controlsRef],
  )

  const toggleBlur = useCallback(async () => {
    const next = !blurIntentRef.current
    // The intent is recorded before the state is, so a camera that is
    // still being opened joins the call the way it was just switched.
    blurIntentRef.current = next
    updateDevicePrefs({ blur: next })

    const raw = rawCamRef.current
    if (!raw) return

    await publishCamera(cameraTrackFor(raw, next))
  }, [cameraTrackFor, publishCamera, updateDevicePrefs])

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
        blurPipelineRef.current?.stop()
        blurPipelineRef.current = null
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
        const pipeline = await createMicPipeline(micTrack, prefs.micGain)
        if (pipeline) {
          micPipelineRef.current = pipeline
          outboundMic = pipeline.track
        }
      }

      if (micTrack) micTrack.enabled = controlsRef.current.mic
      if (camTrack) camTrack.enabled = controlsRef.current.cam

      rawCamRef.current = camTrack
      const outboundCam = camTrack ? cameraTrackFor(camTrack, blurIntentRef.current) : null

      stopMediaStream(localStreamRef.current)
      const stream = new MediaStream([outboundMic, outboundCam].filter(Boolean) as MediaStreamTrack[])
      localStreamRef.current = stream
      setLocalStream(stream)
      if (micTrack && outboundMic) watchLocalTrack('mic', micTrack, outboundMic)
      if (camTrack && outboundCam) watchLocalTrack('cam', camTrack, outboundCam)
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
  }, [refreshDevices, controlsRef, prefsRef, devicesRef, updateDevicePrefs, watchLocalTrack, cameraTrackFor])

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
          const pass = password ? await importPassword(password) : await savedRoomPassword(slug)
          if (!pass) {
            setGateError('')
            setPhase('gate')
            return
          }
          if (!info.authSalt) throw new Error('This room is missing its password salt.')
          const proof = await deriveProof(pass, info.authSalt)
          const res = await api.auth(slug, { proof }).catch(async (err: unknown) => {
            if (!password) await forgetRoomPassword(slug)
            throw err
          })
          if (password) await rememberRoomPassword(slug, pass)
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
            'This browser cannot do end-to-end encrypted media. Use a current Chrome or Edge, or Safari 15.4 or newer.',
          )
        }

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
    // oxlint-disable-next-line react/set-state-in-effect -- bootstrap awaits the room lookup before its first state update
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    return () => {
      endedRef.current = true
      clientRef.current?.leave()
      recorderRef.current?.stop().catch(() => {})
      translatorRef.current?.stop().catch(() => {})
      micPipelineRef.current?.dispose()
      blurPipelineRef.current?.stop()
      rawCamRef.current = null
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

  const stopRecording = useCallback(async () => {
    const active = recorderRef.current
    if (!active) return
    recorderRef.current = null
    setRecording(false)
    try {
      await active.stop()
    } catch {
      toast.error('The recording could not be saved.')
    }
    clientRef.current?.announceRecording(false)
  }, [])

  const startRecording = useCallback(() => {
    if (recorderRef.current) return
    if (!recorderSupported()) {
      toast.error('This browser cannot record the call.')
      return
    }

    let instance: CallRecorder
    try {
      instance = new CallRecorder(slug, (reason) => {
        // The recorder gave up on its own (the browser stopped it, or it
        // could not keep writing): the file is already downloading, so
        // release the room's badge and say what happened instead of
        // leaving a recording that looks like it is still running.
        if (recorderRef.current !== instance) return
        recorderRef.current = null
        setRecording(false)
        clientRef.current?.announceRecording(false)
        toast.error(`Recording stopped: ${reason}. Everything captured until then has been saved.`)
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Recording is unavailable.')
      return
    }
    recorderRef.current = instance
    setRecording(true)
    instance.start().catch((err: unknown) => {
      recorderRef.current = null
      setRecording(false)
      toast.error(err instanceof Error ? err.message : 'Recording failed to start.')
      clientRef.current?.announceRecording(false)
    })
    clientRef.current?.announceRecording(true)
  }, [slug])

  const toggleRecording = useCallback(() => {
    if (recorderRef.current) void stopRecording()
    else startRecording()
  }, [startRecording, stopRecording])

  useEffect(() => {
    api
      .config()
      .then((config) => setTranslation(config.translation))
      .catch(() => setTranslation(TRANSLATION_UNKNOWN))
  }, [])

  // A language the speech service no longer speaks falls back to the default.
  useEffect(() => {
    const codes = translation.languages.map((language) => language.code)
    if (codes.length === 0 || codes.includes(langPrefs.lang)) return
    setLangPrefs({ ...langPrefs, lang: codes.includes(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : codes[0] })
  }, [translation, langPrefs, setLangPrefs])

  // Captions for this member's own language only; interim lines are
  // replaced in place by the next line from the same speaker.
  const handleRoomCaption = useCallback(
    (caption: RoomCaption) => {
      const prefs = langPrefsRef.current
      if (caption.lang !== prefs.lang) return
      if (caption.k === 'caption') {
        if (!prefs.subtitles) return
        const shown: ShownCaption = {
          segId: caption.segId,
          text: caption.text,
          final: caption.final,
          at: Date.now(),
        }
        setCaptions((prev) => ({ ...prev, [caption.speaker]: shown }))
        return
      }
      const { speaker, startInMs, durationMs } = caption
      const ends = Date.now() + startInMs + durationMs
      voiceEndsRef.current.set(speaker, Math.max(voiceEndsRef.current.get(speaker) ?? 0, ends))
      window.setTimeout(() => setVoicePlaying((prev) => ({ ...prev, [speaker]: true })), startInMs)
      window.setTimeout(() => {
        // A later segment of the same speaker keeps the ring on.
        if (Date.now() < (voiceEndsRef.current.get(speaker) ?? 0) - 50) return
        setVoicePlaying(({ [speaker]: _ended, ...rest }) => rest)
      }, startInMs + durationMs)
    },
    [langPrefsRef],
  )

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      setCaptions((prev) => {
        const kept = Object.entries(prev).filter(
          ([, caption]) => now - caption.at < (caption.final ? CAPTION_HOLD_MS : INTERIM_HOLD_MS),
        )
        return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
      })
    }, CAPTION_PRUNE_MS)
    return () => window.clearInterval(timer)
  }, [])

  // This member's own bridge: it runs while the room's live translation
  // is on, translating this member's speech only.
  const stopTranslation = useCallback(async () => {
    const translator = translatorRef.current
    translatorRef.current = null
    setTranslatorStatus(null)
    await translator?.stop()
  }, [])

  const startTranslation = useCallback(
    (client: RoomClient) => {
      if (translatorRef.current) return
      setTranslationFailure('')
      const translator = new Translator(langPrefsRef.current, {
        onCaption: handleRoomCaption,
        onFailure: (reason) => {
          toast.error(reason, { duration: 10_000 })
          setTranslationFailure(reason)
          void stopTranslation()
        },
        onStatus: setTranslatorStatus,
      })
      translatorRef.current = translator
      translator.attach(client)
      translator.start(localMicTrack(localStreamRef.current))
    },
    [langPrefsRef, handleRoomCaption, stopTranslation],
  )

  // The host's switch for the whole room; each browser's bridge follows
  // the translating events.
  const toggleTranslation = useCallback(() => {
    clientRef.current?.announceTranslating(translationBy === null)
  }, [translationBy])

  useEffect(() => {
    clientRef.current?.setLangPrefs(langPrefs)
    translatorRef.current?.setSelfPrefs(langPrefs)
  }, [langPrefs])

  // Subtitles on screen are in the old language once it changes.
  const changeLangPrefs = useCallback(
    (prefs: LangPrefs) => {
      setLangPrefs(prefs)
      setCaptions({})
    },
    [setLangPrefs],
  )

  useEffect(() => {
    translatorRef.current?.setLocalMic(localMicTrack(localStream))
  }, [localStream])

  const connectClient = useCallback(
    async (resume: string): Promise<RoomClient> => {
      const stream = localStreamRef.current
      const roomKey = roomKeyRef.current
      if (!stream || !roomKey) throw new Error('Local media or the room key is missing.')

      const [mediaKey, chatKey] = await Promise.all([
        deriveMediaKeyMaterial(roomKey),
        deriveChatKey(roomKey),
      ])

      const client = new RoomClient({
        slug,
        session: sessionRef.current,
        name: displayName.trim() || 'Guest',
        mediaKey,
        chatKey,
        resume,
      })
      clientRef.current = client
      client.setLangPrefs(langPrefsRef.current)
      // A rejoining member's bridge follows the new client before it connects.
      translatorRef.current?.attach(client)
      let translatingAtJoin = false

      client.on('welcome', ({ self, members: initial, recorder, translatingBy }) => {
        setMembers(initial)
        setRecorder(recorder || null)
        setTranslationBy(translatingBy || null)
        translatingAtJoin = Boolean(translatingBy)
        setSelfId(self.id)
        setMemberLangs({})
      })
      client.on('member-joined', ({ member, replaces }) => {
        setMembers((prev) => [
          ...prev.filter((m) => m.id !== member.id && m.id !== replaces),
          member,
        ])
        if (replaces) {
          setTiles((prev) => prev.filter((t) => t.sourceId !== replaces))
          return
        }
        toast(`${member.name} joined`)
      })
      client.on('member-left', ({ id }) => {
        const name = membersRef.current.find((m) => m.id === id)?.name ?? 'Someone'
        toast(`${name} left`)
        setMembers((prev) => prev.filter((m) => m.id !== id))
        setTiles((prev) => prev.filter((t) => t.sourceId !== id))
        setMemberLangs(({ [id]: _left, ...rest }) => rest)
        setTranslationStreams(({ [id]: _gone, ...rest }) => rest)
      })
      client.on('member-state', ({ id, mic, cam, sharing }) => {
        setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, mic, cam, sharing } : m)))
        if (id !== client.memberId && !sharing) {
          setTiles((prev) => prev.filter((t) => !(t.sourceId === id && t.kind === SCREEN_KIND)))
        }
      })
      client.on('track', ({ sourceId, stream: stream_, kind }) => {
        if (kind.startsWith(TRANSLATION_KIND_PREFIX)) {
          const lang = kind.slice(TRANSLATION_KIND_PREFIX.length)
          setTranslationStreams((prev) => ({ ...prev, [sourceId]: { ...prev[sourceId], [lang]: stream_ } }))
          return
        }
        // A member's microphone and camera share one tile (and one
        // MediaStream from the SFU); a screen share gets its own, and
        // its sound joins it there whatever order the tracks arrive in.
        const tileKind = kind === SCREEN_KIND || kind === SCREEN_AUDIO_KIND ? SCREEN_KIND : CAMERA_KIND
        const key = `${sourceId}:${tileKind}`
        setTiles((prev) => {
          const existing = prev.find((t) => t.key === key)
          const stream =
            tileKind === SCREEN_KIND
              ? new MediaStream(screenTracks(existing?.stream?.getTracks() ?? [], stream_.getTracks()))
              : stream_
          const rest = prev.filter((t) => t.key !== key)
          return [...rest, { key, sourceId, kind: tileKind, stream }]
        })
      })
      client.on('chat', (message) => {
        setMessages((prev) => [...prev, message])
        if (!message.mine && !chatOpenRef.current) setUnread((count) => count + 1)
      })
      client.on('recording', ({ from, on }) => {
        setRecorder(on ? from : null)
        if (from === client.memberId) {
          setRecording(on)
          if (on) toast.success('Recording started')
          else toast('Recording stopped, the file is downloading')
          return
        }
        const name = client.memberName(from)
        if (on) toast(`${name} started recording this call`)
        else toast(`${name} stopped recording`)
      })
      client.on('caption', ({ caption }) => handleRoomCaption(caption))
      client.on('lang', ({ from, prefs }) => setMemberLangs((prev) => ({ ...prev, [from]: prefs.lang })))
      client.on('translating', ({ from, on }) => {
        setTranslationBy(on ? from : null)
        if (on) startTranslation(client)
        else {
          setTranslationStreams({})
          void stopTranslation()
        }
        if (from === client.memberId) {
          if (on) toast.success('Live translation started')
          else toast('Live translation stopped')
          return
        }
        const name = client.memberName(from)
        if (on) toast(`${name} started live translation`)
        else toast(`${name} stopped live translation`)
      })
      client.on('error', ({ code, text }) => {
        toast.error(text)
        if (code === 'room-closed') endedRef.current = true
        // A rejected announce (someone else got there first) rolls the
        // local recorder back so the badge and the button match what the
        // room actually accepted.
        if (code === 'record-busy' && recorderRef.current) {
          void stopRecording()
        }
      })
      client.on('closed', () => {
        if (clientRef.current !== client || kickedRef.current) return
        if (endedRef.current) {
          void stopRecording().finally(() => navigate('/'))
          return
        }
        void reconnectRef.current?.(client)
      })

      try {
        await client.connect()
        await client.publish(stream)
        const screen = screenStreamRef.current
        if (screen?.getVideoTracks().some((track) => track.readyState === 'live')) {
          await client.addScreen(screen)
        }
      } catch (err) {
        client.leave()
        if (clientRef.current === client) clientRef.current = null
        throw err
      }
      if (recorderRef.current) client.announceRecording(true)
      // A rejoining bridge resumes; a fresh joiner starts one if the room
      // was already translating.
      if (translatorRef.current) translatorRef.current.start(localMicTrack(stream))
      else if (translatingAtJoin) startTranslation(client)
      setClientGeneration((generation) => generation + 1)
      return client
    },
    [
      slug,
      displayName,
      navigate,
      chatOpenRef,
      membersRef,
      kickedRef,
      stopRecording,
      langPrefsRef,
      handleRoomCaption,
      startTranslation,
      stopTranslation,
    ],
  )

  const reconnect = useCallback(
    async (lost: RoomClient) => {
      if (reconnectingRef.current) return
      reconnectingRef.current = true
      const resume = lost.resume
      lost.pause()
      clientRef.current = null
      toast.loading('Connection lost, reconnecting…', { id: RECONNECT_TOAST })

      try {
        for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
          await waitForRetry(RECONNECT_DELAYS_MS[attempt])
          if (endedRef.current) break
          try {
            await connectClient(resume)
            // Whoever left during the gap is not on screen any more; the
            // tiles of everyone who stayed have been replaced by the new
            // connections' tracks.
            setTiles((prev) => tilesOfMembers(prev, membersRef.current.map((member) => member.id)))
            toast.success('Reconnected', { id: RECONNECT_TOAST })
            return
          } catch (err) {
            if (err instanceof JoinError && err.final) break
          }
        }
      } finally {
        lost.destroy()
        reconnectingRef.current = false
      }

      setTiles([])
      setMembers([])
      if (endedRef.current) return
      toast.error('The connection was lost.', { id: RECONNECT_TOAST })
      endedRef.current = true
      await stopRecording()
      navigate('/')
    },
    [connectClient, membersRef, stopRecording, navigate],
  )
  useEffect(() => {
    reconnectRef.current = reconnect
  }, [reconnect])

  const joinCall = useCallback(async () => {
    const stream = localStreamRef.current
    if (!stream || stream.getTracks().length === 0 || !roomInfo || !roomKeyRef.current) return

    resumeAudio()
    setPhase('joining')
    try {
      await connectClient('')
      setPhase('live')
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : 'Could not join the room.')
      setPhase('error')
    }
  }, [roomInfo, connectClient])

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

  const sidebarRef = useLatest(sidebar)
  const showSidebar = useCallback(
    (tab: SidePanelTab | null) => {
      setSidebar(tab)
      if (tab === 'chat') setUnread(0)
    },
    [setSidebar],
  )
  const toggleSidebar = useCallback(
    (tab: SidePanelTab) => showSidebar(sidebarRef.current === tab ? null : tab),
    [showSidebar, sidebarRef],
  )
  const toggleChat = useCallback(() => toggleSidebar('chat'), [toggleSidebar])
  const togglePeople = useCallback(() => toggleSidebar('people'), [toggleSidebar])
  const closeSidebar = useCallback(() => showSidebar(null), [showSidebar])

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
      const display = await requestDisplay()
      screenStreamRef.current = display
      await client.addScreen(display)
      setScreenStream(display)
      updateControls({ sharing: true })
      display.getVideoTracks()[0]?.addEventListener('ended', () => {
        void clientRef.current?.removeScreen()
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
        endedRef.current = true
        toast('You were removed from the call')
        navigate('/')
      }),
    ]

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [phase, clientGeneration, toggleTrack, toggleShare, navigate, controlsRef, kickedRef])

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
          const created = await createMicPipeline(track, prefsRef.current.micGain)
          if (created) {
            micPipelineRef.current = created
            outbound = created.track
          }
        }
      } else {
        rawCamRef.current = track
        outbound = cameraTrackFor(track, blurIntentRef.current)
      }

      const current = localStreamRef.current
      if (current) {
        const old = kind === 'mic' ? current.getAudioTracks()[0] : current.getVideoTracks()[0]
        if (old && old !== outbound) {
          current.removeTrack(old)
          if (old !== rawCamRef.current) old.stop()
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
    [updateDevicePrefs, refreshDevices, controlsRef, prefsRef, devicesRef, watchLocalTrack, cameraTrackFor],
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
        translation={
          <TranslationSettings config={translation} prefs={langPrefs} onChange={changeLangPrefs} />
        }
      />
    ),
    [
      translation,
      langPrefs,
      changeLangPrefs,
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

  const leave = useCallback(async () => {
    endedRef.current = true
    await stopRecording()
    await stopTranslation()
    clientRef.current?.leave()
    navigate('/')
  }, [navigate, stopRecording, stopTranslation])

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

  useEffect(() => {
    const client = clientRef.current
    if (phase !== 'live' || !client) return
    for (const tile of allTiles) {
      if (tile.sourceId === LOCAL_SOURCE || tile.kind !== CAMERA_KIND) continue
      client.preferLayer(tile.sourceId, layoutLayer(tile.key, pinnedKey, allTiles.length))
    }
  }, [phase, clientGeneration, allTiles, pinnedKey])

  // While recording, every tile change (member joins or leaves, a pin
  // changes, a screen share starts or stops) re-lays out the composite
  // to mirror what the recorder sees on screen.
  // While live translation runs, a remote speaker of another language is
  // heard through their translation instead of their own voice.
  const speaksOtherLanguage = useCallback(
    (sourceId: string) => {
      if (!translationBy || sourceId === LOCAL_SOURCE) return false
      const lang = memberLangs[sourceId]
      return Boolean(lang) && lang !== langPrefs.lang
    },
    [translationBy, memberLangs, langPrefs.lang],
  )

  const recorderTiles = useMemo<RecorderTile[]>(
    () =>
      allTiles.map((tile) => ({
        key: tile.key,
        stream: tile.stream,
        name: tileLabel(tile, displayName, members),
        local: tile.sourceId === LOCAL_SOURCE,
        pinned: pinnedKey === tile.key,
        audioMuted: tile.kind !== SCREEN_KIND && speaksOtherLanguage(tile.sourceId),
      })),
    [allTiles, displayName, members, pinnedKey, speaksOtherLanguage],
  )

  useEffect(() => {
    if (!recording) return
    recorderRef.current?.setTiles(recorderTiles)
  }, [recording, recorderTiles])

  // A hidden tab records a slideshow: browsers throttle a page's capture
  // pipeline to about a frame a second once it is out of sight, sound
  // keeps flowing, and no compositor can talk them out of it. Say so the
  // first time it happens rather than let someone discover it in the file.
  useEffect(() => {
    if (!recording) return

    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return

      toast('Recording continues, but the video slows to about one frame a second while this tab is in the background.', {
        id: RECORDING_HIDDEN_TOAST,
      })
    }

    document.addEventListener('visibilitychange', onVisibility)

    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [recording])

  // The recording plays as one conversation in the recorder's language:
  // other-language speakers are left out of the mix (above) and each
  // one's translated voice goes in.
  const recordingVoices = useMemo(
    () =>
      Object.entries(translationStreams)
        .filter(([sourceId, langs]) => speaksOtherLanguage(sourceId) && langs[langPrefs.lang])
        .map(([, langs]) => langs[langPrefs.lang]),
    [translationStreams, speaksOtherLanguage, langPrefs.lang],
  )
  useEffect(() => {
    if (!recording) return
    recorderRef.current?.setTranslations(recordingVoices.map((stream) => ({ stream, local: false })))
  }, [recording, recordingVoices])

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

  const renderTile = (tile: Tile, compact = false) => {
    const isLocal = tile.sourceId === LOCAL_SOURCE
    const isScreen = tile.kind === SCREEN_KIND
    const member = isLocal ? selfMember : members.find((m) => m.id === tile.sourceId)
    // Only a remote camera tile plays audio; local and screen tiles get
    // no sink or volume so a volume drag does not re-render them.
    const playsAudio = !isLocal && !isScreen
    const speakerId = isLocal ? selfId : tile.sourceId
    const caption = isScreen ? undefined : captions[speakerId]?.text
    const replaced = langPrefs.voice && speaksOtherLanguage(tile.sourceId)
    return (
      <VideoTile
        key={tile.key}
        tileKey={tile.key}
        stream={tile.stream}
        name={tileLabel(tile, displayName, members)}
        muted={isLocal}
        mirrored={isLocal && !isScreen}
        micOff={!isScreen ? !(member?.mic ?? true) : false}
        camOff={!isScreen ? !(member?.cam ?? true) : false}
        sharing={isScreen}
        sinkId={playsAudio ? devicePrefs.speaker : undefined}
        volume={playsAudio ? (replaced ? 0 : devicePrefs.volume) : undefined}
        caption={caption}
        speaking={replaced ? speakerId in voicePlaying : undefined}
        pinned={pinnedKey === tile.key}
        onTogglePin={allTiles.length > 1 ? togglePin : undefined}
        compact={compact}
        onAspectRatio={compact ? undefined : handleTileRatio}
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
        <HudBackdrop />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking the room…
        </p>
      </div>
    )
  }

  if (phase === 'gate') {
    return (
      <div className="relative grid h-dvh place-items-center bg-muted/40">
        <HudBackdrop />
        {gate}
      </div>
    )
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
        <HudBackdrop />
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
          mic={controls.mic}
          cam={controls.cam}
          blur={devicePrefs.blur}
          canBlur={canBlur}
          onNameChange={setDisplayName}
          onToggleMic={toggleMic}
          onToggleCam={toggleCam}
          onToggleBlur={() => void toggleBlur()}
          onRetryMedia={() => void acquireMedia()}
          onJoin={() => void joinCall()}
          translation={
            translationAvailable ? (
              <TranslationSettings config={translation} prefs={langPrefs} onChange={changeLangPrefs} />
            ) : undefined
          }
        />
      </>
    )
  }

  if (phase === 'joining') {
    return (
      <div className="grid h-dvh place-items-center">
        <HudBackdrop />
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
          <Hint label="Copy invite link (tap 5× for diagnostics)" side="bottom">
            <button
              type="button"
              onClick={onTitleTap}
              aria-label="Copy invite link"
              className="group -mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-sm font-medium transition-colors hover:bg-secondary"
            >
              <span className="hud-title truncate">{roomInfo?.name || slug}</span>
              <Link2 className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          </Hint>
          {recorder && (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              <Circle className="size-2 animate-pulse fill-current" />
              Recording
            </span>
          )}
          {translationBy && (
            <Hint
              label={[
                `Started by ${translationBy === selfId ? 'you' : (members.find((m) => m.id === translationBy)?.name ?? 'a host')}.`,
                translatorStatus?.detail ?? '',
              ].join(' ')}
              side="bottom"
            >
              <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                <Languages className="size-3 shrink-0" />
                <span className="truncate">
                  {translation.external ? 'Live translation via an external service' : 'Live translation'}
                  {translatorStatus && ` · ${TRANSLATOR_STATE_LABELS[translatorStatus.state]}`}
                </span>
              </span>
            </Hint>
          )}
          {translationFailure && (
            <Hint label={`${translationFailure} Click to dismiss.`} side="bottom">
              <button
                type="button"
                onClick={() => setTranslationFailure('')}
                className="flex min-w-0 items-center gap-1.5 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
              >
                <TriangleAlert className="size-3 shrink-0" />
                <span className="truncate">Live translation failed: {translationFailure}</span>
              </button>
            </Hint>
          )}
          {translatorStatus && translationWarnings(translatorStatus, langPrefs.lang, translation.languages).map((warning) => (
            <span
              key={warning}
              className="flex min-w-0 items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400"
            >
              <TriangleAlert className="size-3 shrink-0" />
              <span className="truncate">{warning}</span>
            </span>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Hint label={sidebar === 'people' ? 'Hide participants' : 'Show participants'} side="bottom">
            <Button
              variant={sidebar === 'people' ? 'default' : 'secondary'}
              className="h-7 gap-1 px-2.5 text-xs"
              aria-label="Participants"
              aria-pressed={sidebar === 'people'}
              onClick={togglePeople}
            >
              <Users className="size-3.5" />
              {memberList.length}
            </Button>
          </Hint>
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

        {sidebar && (
          <>
            <button
              type="button"
              aria-label="Close panel"
              className="absolute inset-0 z-30 cursor-default bg-black/50 md:hidden"
              onClick={closeSidebar}
            />
            <aside className="absolute inset-y-0 right-0 z-40 flex w-[85%] max-w-sm flex-col bg-background shadow-xl md:static md:z-auto md:w-[22rem] md:max-w-none md:shrink-0 md:border-l md:shadow-none">
              <SidePanel
                tab={sidebar}
                peopleCount={memberList.length}
                unread={unread}
                onTab={showSidebar}
                onClose={closeSidebar}
                people={
                  <PeoplePanel
                    members={memberList}
                    selfId={selfMember.id}
                    canModerate={privileged}
                    onModerate={moderateMember}
                  />
                }
                chat={<ChatPanel messages={messages} onSend={sendChat} />}
              />
            </aside>
          </>
        )}
      </div>

      <ControlsBar
        mic={controls.mic}
        cam={controls.cam}
        sharing={controls.sharing}
        blur={devicePrefs.blur}
        canBlur={canBlur}
        onBlur={() => void toggleBlur()}
        chatOpen={chatOpen}
        unread={unread}
        fullscreen={fullscreen}
        canShare={canShare}
        canRecord={recorderSupported()}
        recording={recording}
        onMic={toggleMic}
        onCam={toggleCam}
        onShare={toggleScreen}
        onRecord={toggleRecording}
        canTranslate={privileged}
        translateUnavailable={translationAvailable ? undefined : translation.reason || TRANSLATION_UNKNOWN.reason}
        translating={translationBy !== null}
        onTranslate={toggleTranslation}
        onLeave={leave}
        onToggleChat={toggleChat}
        onToggleFullscreen={toggleFullscreen}
      >
        {settingsPopover}
      </ControlsBar>
      {langPrefs.voice &&
        Object.entries(translationStreams)
          .filter(([sourceId, langs]) => speaksOtherLanguage(sourceId) && langs[langPrefs.lang])
          .map(([sourceId, langs]) => (
            <TranslationAudio
              key={sourceId}
              stream={langs[langPrefs.lang]}
              sinkId={devicePrefs.speaker}
              volume={devicePrefs.volume}
            />
          ))}
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
