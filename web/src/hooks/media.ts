import { useCallback, useEffect, useState } from 'react'

export interface DeviceGroups {
  mics: MediaDeviceInfo[]
  cams: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
}

export type TrackKind = 'mic' | 'cam'
export type DeviceKind = TrackKind | 'speaker'

export type CameraResolution = 'auto' | '360' | '720' | '1080'

export type CameraFacing = 'user' | 'environment'

export interface EqualizerBands {
  low: number
  mid: number
  high: number
}

export type EqualizerPreset = 'flat' | 'voice' | 'warm' | 'bright' | 'custom'

export const MIN_EQ_DB = -12
export const MAX_EQ_DB = 12
export const FLAT_EQ: EqualizerBands = { low: 0, mid: 0, high: 0 }

export const EQ_PRESETS: Record<Exclude<EqualizerPreset, 'custom'>, EqualizerBands> = {
  flat: { low: 0, mid: 0, high: 0 },
  voice: { low: -3, mid: 2, high: 4 },
  warm: { low: 3, mid: 1, high: -2 },
  bright: { low: -2, mid: 0, high: 5 },
}

export function clampEqDb(db: number): number {
  return Number.isFinite(db) ? Math.min(MAX_EQ_DB, Math.max(MIN_EQ_DB, Math.round(db))) : 0
}

export function clampEqBands(bands: EqualizerBands): EqualizerBands {
  return { low: clampEqDb(bands.low), mid: clampEqDb(bands.mid), high: clampEqDb(bands.high) }
}

export function isFlatEq(bands: EqualizerBands): boolean {
  return bands.low === 0 && bands.mid === 0 && bands.high === 0
}

export function eqPresetFor(bands: EqualizerBands): EqualizerPreset {
  const clamped = clampEqBands(bands)
  for (const [name, preset] of Object.entries(EQ_PRESETS) as [
    Exclude<EqualizerPreset, 'custom'>,
    EqualizerBands,
  ][]) {
    if (
      preset.low === clamped.low &&
      preset.mid === clamped.mid &&
      preset.high === clamped.high
    ) {
      return name
    }
  }
  return 'custom'
}

export function sanitizeEqBands(stored: Partial<EqualizerBands> | undefined): EqualizerBands {
  if (!stored) return FLAT_EQ
  return clampEqBands({
    low: typeof stored.low === 'number' ? stored.low : 0,
    mid: typeof stored.mid === 'number' ? stored.mid : 0,
    high: typeof stored.high === 'number' ? stored.high : 0,
  })
}

export interface DevicePrefs {
  mic: string
  cam: string
  camFacing: CameraFacing | ''
  speaker: string
  resolution: CameraResolution
  volume: number
  micGain: number
  eqBands: EqualizerBands
}

export const DEFAULT_DEVICE_PREFS: DevicePrefs = {
  mic: '',
  cam: '',
  camFacing: '',
  speaker: '',
  resolution: 'auto',
  volume: 1,
  micGain: 1,
  eqBands: FLAT_EQ,
}

// Mic gain is stored linear (1 = untouched) but presented in dB; the
// slider range keeps gain between a whisper and a runaway boost.
export const MIN_MIC_GAIN_DB = -20
export const MAX_MIC_GAIN_DB = 12

export function clampMicGain(gain: number): number {
  return Number.isFinite(gain) ? Math.min(4, Math.max(0, gain)) : 1
}

export function micGainToDb(gain: number): number {
  const db = 20 * Math.log10(Math.max(gain, 0.01))
  return Math.max(MIN_MIC_GAIN_DB, Math.min(MAX_MIC_GAIN_DB, db))
}

export function micDbToGain(db: number): number {
  return clampMicGain(10 ** (db / 20))
}

export const CAMERA_RESOLUTIONS: { value: CameraResolution; label: string }[] = [
  { value: 'auto', label: 'Auto (recommended)' },
  { value: '360', label: '360p' },
  { value: '720', label: '720p (HD)' },
  { value: '1080', label: '1080p (Full HD)' },
]

const RESOLUTION_DIMENSIONS: Record<
  Exclude<CameraResolution, 'auto'>,
  { width: number; height: number }
> = {
  '360': { width: 640, height: 360 },
  '720': { width: 1280, height: 720 },
  '1080': { width: 1920, height: 1080 },
}

export const DEVICE_LABELS: Record<DeviceKind, string> = {
  mic: 'Microphone',
  cam: 'Camera',
  speaker: 'Speaker',
}

export function supportsSinkSelection(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
}

// Mobile browsers have device lists full of entries the page cannot
// actually select (Android exposes communication routes as inputs and has
// no real output switching), so device pickers are desktop-only there.
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
  )
}

// Chrome prefixes duplicate aliases with "Default -"; collapse aliases so
// every listed entry is a distinct, selectable device.
export function dedupeDevices(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const byGroup = new Map<string, MediaDeviceInfo>()
  for (const device of devices) {
    const key = device.groupId || device.deviceId
    const current = byGroup.get(key)
    if (!current || (/^default\b/i.test(current.label) && !/^default\b/i.test(device.label))) {
      byGroup.set(key, device)
    }
  }

  const seenLabels = new Set<string>()
  const unique: MediaDeviceInfo[] = []
  for (const device of byGroup.values()) {
    const label = device.label.replace(/^default\b[\s-]*/i, '').trim().toLowerCase()
    if (label) {
      if (seenLabels.has(label)) continue
      seenLabels.add(label)
    }
    unique.push(device)
  }
  return unique
}

// Chrome on Android labels cameras "Camera N, facing front/back" while
// iOS Safari writes "Front Camera"/"Back Camera"; both wordings must
// resolve to the lens the user means.
export function facingFromLabel(label: string): CameraFacing | null {
  if (/facing\s+front/i.test(label)) return 'user'
  if (/facing\s+back/i.test(label)) return 'environment'
  if (/\bfront[-\s]?facing\b/i.test(label)) return 'user'
  if (/\bback[-\s]?facing\b/i.test(label)) return 'environment'
  if (/\bfront\s+camera\b/i.test(label)) return 'user'
  if (/\bback\s+camera\b/i.test(label)) return 'environment'
  return null
}

// Chrome on Android lists each physical camera multiple times (distinct
// deviceIds, "Camera N, facing X" labels for the same lens), so on phones
// the picker collapses cameras by the facing direction parsed from the
// label — the front/back pair mobile apps present.
export function dedupeCameras(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  if (!isMobileDevice()) return devices

  const seen = new Set<CameraFacing>()
  return devices.filter((device) => {
    const facing = facingFromLabel(device.label)
    if (!facing) return true
    if (seen.has(facing)) return false
    seen.add(facing)
    return true
  })
}

function sameDeviceList(a: MediaDeviceInfo[], b: MediaDeviceInfo[]): boolean {
  if (a.length !== b.length) return false
  const key = (device: MediaDeviceInfo) => `${device.deviceId}:${device.label}`
  const ka = a.map(key).sort()
  const kb = b.map(key).sort()
  return ka.every((k, i) => k === kb[i])
}

function sameDeviceGroups(a: DeviceGroups, b: DeviceGroups): boolean {
  return (
    sameDeviceList(a.mics, b.mics) &&
    sameDeviceList(a.cams, b.cams) &&
    sameDeviceList(a.speakers, b.speakers)
  )
}

export function useMediaDevices(): { devices: DeviceGroups; refresh: () => Promise<void> } {
  const [groups, setGroups] = useState<DeviceGroups>({ mics: [], cams: [], speakers: [] })

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const next: DeviceGroups = {
        mics: dedupeDevices(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== '')),
        cams: dedupeCameras(dedupeDevices(all.filter((d) => d.kind === 'videoinput' && d.deviceId !== ''))),
        speakers: dedupeDevices(all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== '')),
      }
      setGroups((prev) => (sameDeviceGroups(prev, next) ? prev : next))
    } catch {
      return
    }
  }, [])

  useEffect(() => {
    void refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
  }, [refresh])

  return { devices: groups, refresh }
}

// Splits a stream into single-kind views: the video element never carries
// an audio track (the case mobile autoplay policy is strictest about) and
// the audio element never carries video.
//
// When the source gains or loses a track (the SFU negotiates audio first
// and adds video moments later), the affected view is replaced by a
// fresh MediaStream instead of mutated in place. A media element bound
// to a stream that grows a track under it is exactly the case Android
// Chrome mishandles (first frame, then nothing); a new stream object
// goes through the element's normal load path.
export function useSplitStreams(stream: MediaStream | null): {
  video: MediaStream | null
  audio: MediaStream | null
} {
  const [split, setSplit] = useState<{ video: MediaStream | null; audio: MediaStream | null }>({
    video: null,
    audio: null,
  })

  useEffect(() => {
    if (!stream) {
      setSplit({ video: null, audio: null })
      return
    }

    const view = (kind: 'video' | 'audio') =>
      new MediaStream(kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks())

    const sync = (event: MediaStreamTrackEvent) => {
      const kind = event.track.kind === 'video' ? 'video' : 'audio'
      setSplit((prev) => ({ ...prev, [kind]: view(kind) }))
    }

    stream.addEventListener('addtrack', sync)
    stream.addEventListener('removetrack', sync)
    setSplit({ video: view('video'), audio: view('audio') })

    return () => {
      stream.removeEventListener('addtrack', sync)
      stream.removeEventListener('removetrack', sync)
    }
  }, [stream])

  return split
}

export function trackConstraints(
  kind: TrackKind,
  deviceId: string,
  resolution: CameraResolution = 'auto',
  facing?: CameraFacing,
): MediaTrackConstraints {
  if (kind === 'mic') return deviceId ? { deviceId: { exact: deviceId } } : {}
  const size =
    resolution === 'auto'
      ? { width: { ideal: 1280 }, height: { ideal: 720 } }
      : {
          width: { ideal: RESOLUTION_DIMENSIONS[resolution].width },
          height: { ideal: RESOLUTION_DIMENSIONS[resolution].height },
        }
  // On phones the facing is the stable identity of a camera: duplicate
  // Android deviceIds and iOS id rotation never get a chance to make a
  // lens unselectable when the lens itself is what gets requested.
  if (facing) return { facingMode: { exact: facing }, ...size }
  return deviceId ? { deviceId: { exact: deviceId }, ...size } : size
}

async function requestTrack(
  kind: TrackKind,
  deviceId: string,
  resolution: CameraResolution,
  facing?: CameraFacing,
): Promise<MediaStreamTrack | null> {
  const constraints = trackConstraints(kind, deviceId, resolution, facing)
  const request: MediaStreamConstraints = kind === 'mic' ? { audio: constraints } : { video: constraints }
  const stream = await navigator.mediaDevices.getUserMedia(request).catch(() => null)
  if (!stream) return null
  return kind === 'mic'
    ? (stream.getAudioTracks()[0] ?? null)
    : (stream.getVideoTracks()[0] ?? null)
}

export interface OpenTrackResult {
  track: MediaStreamTrack | null
  deviceId: string
  facing?: CameraFacing
  fallback: boolean
}

// Tries the requested device, then the system default, and reports which
// one produced the track: some listed devices cannot actually be opened
// (Android communication routes, ephemeral ids on iOS). On phones a known
// facing is requested directly, so the fallback path stays rare.
export async function openTrackWithFallback(
  kind: TrackKind,
  deviceId: string,
  resolution: CameraResolution = 'auto',
  facing?: CameraFacing,
): Promise<OpenTrackResult> {
  if (kind === 'cam' && facing) {
    const track = await requestTrack(kind, '', resolution, facing)
    if (track) return { track, deviceId, facing: facingFromTrack(track) ?? facing, fallback: false }
    if (deviceId) {
      const byId = await requestTrack(kind, deviceId, resolution)
      if (byId) return { track: byId, deviceId, facing: facingFromTrack(byId), fallback: false }
    }
    const fallbackTrack = await requestTrack(kind, '', resolution)
    if (fallbackTrack) {
      return {
        track: fallbackTrack,
        deviceId: '',
        facing: facingFromTrack(fallbackTrack),
        fallback: true,
      }
    }
    return { track: null, deviceId, fallback: false }
  }
  for (const attempt of deviceId ? [deviceId, ''] : ['']) {
    const track = await requestTrack(kind, attempt, resolution)
    if (track) {
      return {
        track,
        deviceId: attempt,
        facing: kind === 'cam' ? facingFromTrack(track) : undefined,
        fallback: Boolean(deviceId) && attempt === '',
      }
    }
  }
  return { track: null, deviceId, fallback: false }
}

export async function openTrack(
  kind: TrackKind,
  deviceId: string,
  allowFallback = true,
  resolution: CameraResolution = 'auto',
  facing?: CameraFacing,
): Promise<MediaStreamTrack | null> {
  if (!allowFallback) return requestTrack(kind, deviceId, resolution, facing)
  return (await openTrackWithFallback(kind, deviceId, resolution, facing)).track
}

export function stopMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
}

export function validDeviceId(devices: MediaDeviceInfo[], deviceId: string): string {
  if (!deviceId || devices.length === 0) return deviceId
  if (devices.some((device) => device.deviceId === deviceId)) return deviceId
  return devices.every((device) => device.label !== '') ? '' : deviceId
}

// The facing of the camera that actually opened, straight from the live
// track: labels lie on some Android builds and deviceIds rotate on iOS,
// so the track's own settings are the only trustworthy source.
export function facingFromTrack(track: MediaStreamTrack): CameraFacing | undefined {
  try {
    const facing = track.getSettings().facingMode
    return facing === 'user' || facing === 'environment' ? facing : undefined
  } catch {
    return undefined
  }
}

// The picker highlights the entry matching the stored id, or on phones
// the lens matching the remembered facing when the id rotated away
// (iOS Safari regenerates videoinput deviceIds on every page load).
export function selectedCameraId(cams: MediaDeviceInfo[], prefs: DevicePrefs): string {
  if (prefs.cam && cams.some((device) => device.deviceId === prefs.cam)) return prefs.cam
  if (isMobileDevice() && prefs.camFacing) {
    const match = cams.find((device) => facingFromLabel(device.label) === prefs.camFacing)
    if (match) return match.deviceId
  }
  return prefs.cam
}

const RATIO_EPSILON = 0.01

export const FALLBACK_ASPECT_RATIO = 16 / 9

export function aspectRatioChanged(prev: number, next: number): boolean {
  return next > 0 && Math.abs(next - prev) > RATIO_EPSILON
}

let sharedContext: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (sharedContext) return sharedContext
  try {
    sharedContext = new AudioContext()
    return sharedContext
  } catch {
    return null
  }
}

// Mobile autoplay policies stall or block any element that carries sound.
// When play() is rejected we keep the element registered and retry on the
// next user gesture, which unlocks it for the rest of the call.
const awaitingGesture = new Map<HTMLMediaElement, ((blocked: boolean) => void) | undefined>()
let gestureListenerActive = false

function retryAwaiting(): void {
  if (awaitingGesture.size === 0) return
  for (const [element, onBlocked] of awaitingGesture) {
    if (!element.isConnected) {
      awaitingGesture.delete(element)
      continue
    }
    void element
      .play()
      .then(() => {
        awaitingGesture.delete(element)
        onBlocked?.(false)
      })
      .catch(() => {})
  }
}

// One shared gesture listener unblocks stalled playback elements and
// resumes the shared AudioContext: without a prior gesture iOS and
// Chrome start it suspended, which would leave the mic gain graph
// (and its meter) silent.
function installGestureRetry(): void {
  if (gestureListenerActive || typeof window === 'undefined') return
  gestureListenerActive = true
  const retry = () => {
    retryAwaiting()
    const ctx = sharedContext
    if (ctx?.state === 'suspended') void ctx.resume().catch(() => {})
    if (awaitingGesture.size === 0 && ctx?.state !== 'suspended') {
      window.removeEventListener('pointerdown', retry)
      window.removeEventListener('keydown', retry)
      gestureListenerActive = false
    }
  }
  window.addEventListener('pointerdown', retry)
  window.addEventListener('keydown', retry)
}

export function playMediaElement(
  element: HTMLMediaElement,
  onBlocked?: (blocked: boolean) => void,
): void {
  element
    .play()
    .then(
      () => {
        awaitingGesture.delete(element)
        onBlocked?.(false)
      },
      (err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          awaitingGesture.set(element, onBlocked)
          installGestureRetry()
          onBlocked?.(true)
        }
      },
    )
    .catch(() => {})
}

export function resumeAudio(): void {
  retryAwaiting()
  const ctx = audioContext()
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {})
}

// The microphone is routed through a Web Audio graph before it reaches
// the sender: raw capture track -> [low shelf -> peaking -> high shelf]
// -> GainNode -> MediaStreamAudioDestinationNode, and the destination's
// track is what gets published and previewed, so gain, EQ and hold-to-
// test monitoring apply live without re-acquiring the mic. With flat EQ
// the filter chain is bypassed entirely (source straight into the gain
// node, which is bit-exact at unity) and the filters add no algorithmic
// latency when engaged; the analyser is a post-gain tap feeding the
// level meter and the clipping indicator. Muting still flips .enabled
// on the raw capture track: a disabled source track makes the whole
// graph emit silence, so gain can never defeat mute. Everything runs on
// the shared AudioContext, which resumeAudio() and the gesture listener
// above unlock.
export interface MicPipeline {
  readonly track: MediaStreamTrack
  setGain(gain: number): void
  setEqualizer(bands: EqualizerBands): void
  setInputEnabled(enabled: boolean): void
  setMonitoring(on: boolean): void
  rewire(rawTrack: MediaStreamTrack): void
  /** Post-gain level 0..1, for meters. */
  level(): number
  /** Whether the post-gain signal hit full scale recently. */
  clipping(): boolean
  dispose(): void
}

const EQ_LOW_HZ = 200
const EQ_MID_HZ = 1000
const EQ_MID_Q = 1
const EQ_HIGH_HZ = 4000
const CLIP_THRESHOLD = 0.98
const CLIP_HOLD_MS = 1500

export function createMicPipeline(
  rawTrack: MediaStreamTrack,
  gain: number,
  eq: EqualizerBands = FLAT_EQ,
): MicPipeline | null {
  const ctx = audioContext()
  if (!ctx) return null

  try {
    let input = rawTrack
    let source = ctx.createMediaStreamSource(new MediaStream([input]))
    let bands = clampEqBands(eq)
    let monitoring = false
    let clipUntil = 0

    const gainNode = ctx.createGain()
    const low = ctx.createBiquadFilter()
    low.type = 'lowshelf'
    low.frequency.value = EQ_LOW_HZ
    const mid = ctx.createBiquadFilter()
    mid.type = 'peaking'
    mid.frequency.value = EQ_MID_HZ
    mid.Q.value = EQ_MID_Q
    const high = ctx.createBiquadFilter()
    high.type = 'highshelf'
    high.frequency.value = EQ_HIGH_HZ
    low.connect(mid)
    mid.connect(high)
    high.connect(gainNode)

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    const destination = ctx.createMediaStreamDestination()

    gainNode.connect(destination)
    gainNode.connect(analyser)

    const connectSource = () => {
      try {
        source.disconnect()
      } catch {
        // already detached
      }
      source.connect(isFlatEq(bands) ? gainNode : low)
    }

    const samples = new Uint8Array(analyser.fftSize)
    let metered = 0

    const pipeline: MicPipeline = {
      track: destination.stream.getAudioTracks()[0],
      setGain(value) {
        gainNode.gain.setTargetAtTime(clampMicGain(value), ctx.currentTime, 0.02)
      },
      setEqualizer(next) {
        bands = clampEqBands(next)
        const now = ctx.currentTime
        low.gain.setTargetAtTime(bands.low, now, 0.05)
        mid.gain.setTargetAtTime(bands.mid, now, 0.05)
        high.gain.setTargetAtTime(bands.high, now, 0.05)
        connectSource()
      },
      setInputEnabled(enabled) {
        input.enabled = enabled
      },
      setMonitoring(on) {
        if (monitoring === on) return
        monitoring = on
        try {
          if (on) gainNode.connect(ctx.destination)
          else gainNode.disconnect(ctx.destination)
        } catch {
          // no monitoring edge to remove
        }
      },
      rewire(next) {
        if (next === input) return
        const nextSource = ctx.createMediaStreamSource(new MediaStream([next]))
        const oldSource = source
        source = nextSource
        connectSource()
        try {
          oldSource.disconnect()
        } catch {
          // already detached
        }
        input.stop()
        input = next
      },
      level() {
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        let peak = 0
        for (const value of samples) {
          const deviation = (value - 128) / 128
          sum += deviation * deviation
          const magnitude = Math.abs(deviation)
          if (magnitude > peak) peak = magnitude
        }
        if (peak >= CLIP_THRESHOLD) clipUntil = performance.now() + CLIP_HOLD_MS
        const rms = Math.sqrt(sum / samples.length)
        metered = Math.max(rms, metered * 0.8)
        return Math.min(1, metered * 3)
      },
      clipping() {
        return performance.now() < clipUntil
      },
      dispose() {
        try {
          source.disconnect()
        } catch {
          // already detached
        }
        low.disconnect()
        mid.disconnect()
        high.disconnect()
        gainNode.disconnect()
        analyser.disconnect()
        input.stop()
      },
    }

    connectSource()
    pipeline.setGain(gain)
    pipeline.setEqualizer(bands)
    if (ctx.state === 'suspended') installGestureRetry()
    return pipeline
  } catch {
    return null
  }
}

export interface MicMeterSource {
  level(): number
  clipping(): boolean
}

// Polls a mic pipeline meter each frame while mounted; re-renders only
// when the level or the clip flag actually moves.
export function useMicMeter(meter: MicMeterSource | null | undefined): {
  level: number
  clipping: boolean
} {
  const [state, setState] = useState({ level: 0, clipping: false })

  useEffect(() => {
    if (!meter) return
    let frame = 0
    let lastLevel = -1
    let lastClipping = false
    const tick = () => {
      const level = meter.level()
      const clipping = meter.clipping()
      if (Math.abs(level - lastLevel) >= 0.01 || clipping !== lastClipping) {
        lastLevel = level
        lastClipping = clipping
        setState({ level, clipping })
      }
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [meter])

  return state
}

export function useIsSpeaking(stream: MediaStream | null): boolean {
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    if (!stream) {
      setSpeaking(false)
      return
    }
    const ctx = audioContext()
    if (!ctx) {
      setSpeaking(false)
      return
    }

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    let source: MediaStreamAudioSourceNode | null = null

    const bind = () => {
      if (source) return
      const track = stream.getAudioTracks()[0]
      if (!track) return
      source = ctx.createMediaStreamSource(new MediaStream([track]))
      source.connect(analyser)
    }
    bind()
    stream.addEventListener('addtrack', bind)

    const samples = new Uint8Array(analyser.fftSize)
    let level = 0
    let current = false
    let frame = 0

    const tick = () => {
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const value of samples) {
        const deviation = (value - 128) / 128
        sum += deviation * deviation
      }
      const rms = Math.sqrt(sum / samples.length)
      level = rms > 0.04 ? Math.min(1, level + 0.55) : level * 0.8
      const next = level > 0.08
      if (next !== current) {
        current = next
        setSpeaking(next)
      }
      frame = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(frame)
      stream.removeEventListener('addtrack', bind)
      source?.disconnect()
      analyser.disconnect()
      setSpeaking(false)
    }
  }, [stream])

  return speaking
}
