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

export function useMediaDevices(): { devices: DeviceGroups; refresh: () => Promise<void> } {
  const [groups, setGroups] = useState<DeviceGroups>({ mics: [], cams: [], speakers: [] })

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setGroups({
        mics: all.filter((device) => device.kind === 'audioinput' && device.deviceId !== ''),
        cams: all.filter((device) => device.kind === 'videoinput' && device.deviceId !== ''),
        speakers: all.filter((device) => device.kind === 'audiooutput' && device.deviceId !== ''),
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

export function trackConstraints(
  kind: TrackKind,
  deviceId: string,
  resolution: CameraResolution = 'auto',
): MediaTrackConstraints {
  if (kind === 'mic') return deviceId ? { deviceId: { exact: deviceId } } : {}
  const size =
    resolution === 'auto'
      ? { width: { ideal: 1280 } }
      : {
          width: { ideal: RESOLUTION_DIMENSIONS[resolution].width },
          height: { ideal: RESOLUTION_DIMENSIONS[resolution].height },
        }
  return deviceId ? { deviceId: { exact: deviceId }, ...size } : size
}

export async function openTrack(
  kind: TrackKind,
  deviceId: string,
  allowFallback = true,
  resolution: CameraResolution = 'auto',
): Promise<MediaStreamTrack | null> {
  const asks =
    allowFallback && deviceId
      ? [trackConstraints(kind, deviceId, resolution), trackConstraints(kind, '', resolution)]
      : [trackConstraints(kind, deviceId, resolution)]

  for (const ask of asks) {
    const request: MediaStreamConstraints = kind === 'mic' ? { audio: ask } : { video: ask }
    const stream = await navigator.mediaDevices.getUserMedia(request).catch(() => null)
    if (stream) {
      return kind === 'mic'
        ? (stream.getAudioTracks()[0] ?? null)
        : (stream.getVideoTracks()[0] ?? null)
    }
  }
  return null
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

export function resumeAudio(): void {
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
