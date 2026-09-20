import { useCallback, useEffect, useState } from 'react'

export interface DeviceGroups {
  mics: MediaDeviceInfo[]
  cams: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
}

export type TrackKind = 'mic' | 'cam'
export type DeviceKind = TrackKind | 'speaker'

export type CameraResolution = 'auto' | '360' | '720' | '1080'

export interface DevicePrefs {
  mic: string
  cam: string
  speaker: string
  resolution: CameraResolution
  volume: number
}

export const DEFAULT_DEVICE_PREFS: DevicePrefs = {
  mic: '',
  cam: '',
  speaker: '',
  resolution: 'auto',
  volume: 1,
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

// Chrome on Android lists each physical camera multiple times (distinct
// deviceIds, "Camera N, facing X" labels for the same lens), so on phones
// the picker collapses cameras by the facing direction parsed from the
// label — the front/back pair mobile apps present.
export function dedupeCameras(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  if (!isMobileDevice()) return devices

  const seen = new Set<string>()
  return devices.filter((device) => {
    const facing = device.label.match(/facing\s+(front|back)/i)
    if (!facing) return true
    const key = facing[1].toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function useMediaDevices(): { devices: DeviceGroups; refresh: () => Promise<void> } {
  const [groups, setGroups] = useState<DeviceGroups>({ mics: [], cams: [], speakers: [] })

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setGroups({
        mics: dedupeDevices(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== '')),
        cams: dedupeCameras(dedupeDevices(all.filter((d) => d.kind === 'videoinput' && d.deviceId !== ''))),
        speakers: dedupeDevices(all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== '')),
      })
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
// the audio element never carries video. The derived streams follow
// track additions and removals on the source.
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

    const video = new MediaStream(stream.getVideoTracks())
    const audio = new MediaStream(stream.getAudioTracks())

    const sync = (event: MediaStreamTrackEvent) => {
      const target = event.track.kind === 'video' ? video : audio
      if (event.type === 'addtrack') target.addTrack(event.track)
      else target.removeTrack(event.track)
    }

    stream.addEventListener('addtrack', sync)
    stream.addEventListener('removetrack', sync)
    setSplit({ video, audio })

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
): MediaTrackConstraints {
  if (kind === 'mic') return deviceId ? { deviceId: { exact: deviceId } } : {}
  const size =
    resolution === 'auto'
      ? { width: { ideal: 1280 }, height: { ideal: 720 } }
      : {
          width: { ideal: RESOLUTION_DIMENSIONS[resolution].width },
          height: { ideal: RESOLUTION_DIMENSIONS[resolution].height },
        }
  return deviceId ? { deviceId: { exact: deviceId }, ...size } : size
}

async function requestTrack(
  kind: TrackKind,
  deviceId: string,
  resolution: CameraResolution,
): Promise<MediaStreamTrack | null> {
  const constraints = trackConstraints(kind, deviceId, resolution)
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
}

// Tries the requested device, then the system default, and reports which
// one produced the track: some listed devices cannot actually be opened
// (Android communication routes, ephemeral ids on iOS).
export async function openTrackWithFallback(
  kind: TrackKind,
  deviceId: string,
  resolution: CameraResolution = 'auto',
): Promise<OpenTrackResult> {
  for (const attempt of deviceId ? [deviceId, ''] : ['']) {
    const track = await requestTrack(kind, attempt, resolution)
    if (track) return { track, deviceId: attempt }
  }
  return { track: null, deviceId }
}

export async function openTrack(
  kind: TrackKind,
  deviceId: string,
  allowFallback = true,
  resolution: CameraResolution = 'auto',
): Promise<MediaStreamTrack | null> {
  if (!allowFallback) return requestTrack(kind, deviceId, resolution)
  return (await openTrackWithFallback(kind, deviceId, resolution)).track
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

function installGestureRetry(): void {
  if (gestureListenerActive || typeof window === 'undefined') return
  gestureListenerActive = true
  const retry = () => {
    retryAwaiting()
    if (awaitingGesture.size === 0) {
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
