import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'

import { useDevicePrefs } from '@/hooks/device-prefs'
import { useLatest } from '@/hooks/latest'
import {
  createMicPipeline,
  DEFAULT_AV_PREFS,
  DEVICE_LABELS,
  facingFromLabel,
  facingFromTrack,
  isMobileDevice,
  openTrack,
  openTrackWithFallback,
  stopMediaStream,
  trackConstraints,
  useMediaDevices,
  type AvPrefs,
  type CameraFacing,
  type CameraResolution,
  type DeviceKind,
  type MicPipeline,
  type TrackKind,
} from '@/hooks/media'
import { usePersistentState } from '@/hooks/persistent'
import { startBlur, type BlurPipeline } from '@/lib/blur'
import type { RoomClient } from '@/lib/sfu'

export interface Controls {
  mic: boolean
  cam: boolean
  sharing: boolean
}

export type SwitchMode = 'switch' | 'recover' | 'enable'

export interface SwitchOptions {
  mode?: SwitchMode
  facing?: CameraFacing
}

function blockedMessage(kind: TrackKind): string {
  return `Your browser is blocking the ${DEVICE_LABELS[kind].toLowerCase()}. Allow it in the site settings next to the address bar, then try again.`
}

function migrateAvPrefs(stored: AvPrefs): AvPrefs {
  return {
    mic: typeof stored.mic === 'boolean' ? stored.mic : true,
    cam: typeof stored.cam === 'boolean' ? stored.cam : true,
  }
}

export function useLocalMedia(clientRef: RefObject<RoomClient | null>) {
  const { devices, refresh: refreshDevices } = useMediaDevices()
  const { devicePrefs, prefsRef, updateDevicePrefs } = useDevicePrefs(devices)
  const devicesRef = useLatest(devices)

  const [avPrefs, setAvPrefs] = usePersistentState<AvPrefs>('conference:av', DEFAULT_AV_PREFS, migrateAvPrefs)
  const [controls, setControls] = useState<Controls>({ mic: avPrefs.mic, cam: avPrefs.cam, sharing: false })
  const controlsRef = useLatest(controls)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [mediaError, setMediaError] = useState('')
  const [mediaBusy, setMediaBusy] = useState(false)

  const localStreamRef = useRef<MediaStream | null>(null)
  const micPipelineRef = useRef<MicPipeline | null>(null)
  const blurPipelineRef = useRef<BlurPipeline | null>(null)
  const blurIntentRef = useRef(false)
  const rawCamRef = useRef<MediaStreamTrack | null>(null)
  const lossGuardRef = useRef<Partial<Record<TrackKind, MediaStreamTrack>>>({})

  useEffect(() => {
    blurIntentRef.current = devicePrefs.blur
  }, [devicePrefs.blur])

  useEffect(() => {
    return () => {
      micPipelineRef.current?.dispose()
      blurPipelineRef.current?.stop()
      rawCamRef.current = null
      stopMediaStream(localStreamRef.current)
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
    [clientRef, controlsRef],
  )

  const blurDied = useCallback(
    (err: unknown) => {
      blurFailed(err)
      const raw = rawCamRef.current
      if (raw) void publishCamera(raw)
    },
    [blurFailed, publishCamera],
  )

  const cameraTrackFor = useCallback(
    (raw: MediaStreamTrack, blur: boolean): MediaStreamTrack => {
      if (!blur) {
        blurPipelineRef.current?.stop()
        blurPipelineRef.current = null

        return raw
      }

      try {
        const pipeline = blurPipelineRef.current ?? startBlur(raw, { onUnavailable: blurDied })
        blurPipelineRef.current = pipeline
        pipeline.rewire(raw)

        return pipeline.track
      } catch (err) {
        blurFailed(err)

        return raw
      }
    },
    [blurFailed, blurDied],
  )

  const toggleBlur = useCallback(async () => {
    const next = !blurIntentRef.current
    blurIntentRef.current = next
    updateDevicePrefs({ blur: next })

    const raw = rawCamRef.current
    if (!raw) return

    await publishCamera(cameraTrackFor(raw, next))
  }, [cameraTrackFor, publishCamera, updateDevicePrefs])

  const onToggleBlur = useCallback(() => void toggleBlur(), [toggleBlur])

  const acquireMedia = useCallback(async () => {
    setMediaBusy(true)
    setMediaError('')
    try {
      const prefs = prefsRef.current
      const mobile = isMobileDevice()
      const chosenCam = devicesRef.current.cams.find((device) => device.deviceId === prefs.cam)
      const camFacing = mobile
        ? prefs.camFacing || facingFromLabel(chosenCam?.label ?? '') || undefined
        : undefined
      if (mobile) {
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
      const client = clientRef.current
      if (client) {
        for (const [kind, track] of [['mic', outboundMic], ['cam', outboundCam]] as const) {
          if (!track) continue
          await client.replaceLocalTrack(kind, track)
          client.setTrackEnabled(kind, controlsRef.current[kind])
        }
      }
    } finally {
      setMediaBusy(false)
    }
  }, [clientRef, refreshDevices, controlsRef, prefsRef, devicesRef, updateDevicePrefs, watchLocalTrack, cameraTrackFor])

  const switchDevice = useCallback(
    async (kind: TrackKind, deviceId: string, resolution?: CameraResolution, opts: SwitchOptions = {}) => {
      const mode = opts.mode ?? 'switch'
      const failed = () => {
        if (mode === 'switch') toast.error(`Could not switch ${DEVICE_LABELS[kind].toLowerCase()}.`)
        if (mode === 'enable') toast.error(blockedMessage(kind))
      }
      const prefs = prefsRef.current
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
          failed()
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
        failed()
        return
      }
      if (deviceId && fallback && mode !== 'recover') {
        toast(
          `That ${DEVICE_LABELS[kind].toLowerCase()} is unavailable here, using the system default.`,
        )
      }
      track.enabled = controlsRef.current[kind]

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
        if (resolution) updateDevicePrefs({ resolution })
      } else {
        updateDevicePrefs({ cam: usedId, ...(resolution ? { resolution } : {}) })
      }
      setMediaError('')
      void refreshDevices()
      await clientRef.current?.replaceLocalTrack(kind, outbound)
      clientRef.current?.setTrackEnabled(kind, controlsRef.current[kind])
      if (mode === 'recover') toast.success(`${DEVICE_LABELS[kind]} is back in the call`)
    },
    [clientRef, updateDevicePrefs, refreshDevices, controlsRef, prefsRef, devicesRef, watchLocalTrack, cameraTrackFor],
  )

  const toggleTrack = useCallback(
    (kind: TrackKind) => {
      const current = localStreamRef.current
      const tracks = (kind === 'mic' ? current?.getAudioTracks() : current?.getVideoTracks()) ?? []
      if (tracks.length === 0) {
        updateControls(kind === 'mic' ? { mic: true } : { cam: true })
        void switchDevice(kind, prefsRef.current[kind], undefined, { mode: 'enable' })
        return
      }
      const enabled = !controlsRef.current[kind]
      for (const track of tracks) track.enabled = enabled
      if (kind === 'mic') micPipelineRef.current?.setInputEnabled(enabled)
      clientRef.current?.setTrackEnabled(kind, enabled)
      updateControls(kind === 'mic' ? { mic: enabled } : { cam: enabled })
    },
    [clientRef, updateControls, controlsRef, switchDevice, prefsRef],
  )

  const toggleMic = useCallback(() => toggleTrack('mic'), [toggleTrack])
  const toggleCam = useCallback(() => toggleTrack('cam'), [toggleTrack])

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

  return {
    devices,
    refreshDevices,
    devicePrefs,
    prefsRef,
    controls,
    controlsRef,
    updateControls,
    localStream,
    localStreamRef,
    mediaError,
    mediaBusy,
    hasMic: Boolean(localStream?.getAudioTracks().length),
    hasCam: Boolean(localStream?.getVideoTracks().length),
    acquireMedia,
    switchDevice,
    toggleTrack,
    toggleMic,
    toggleCam,
    onToggleBlur,
    handleDeviceChange,
    handleResolutionChange,
    handleVolumeChange,
    handleMicGainChange,
  }
}
