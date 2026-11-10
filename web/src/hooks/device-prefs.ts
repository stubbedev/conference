import { useCallback, useEffect, useRef } from 'react'

import { useLatest } from '@/hooks/latest'
import {
  CAMERA_RESOLUTIONS,
  clampMicGain,
  clampVolume,
  DEFAULT_AV_PREFS,
  DEFAULT_DEVICE_PREFS,
  validDeviceId,
  type AvPrefs,
  type CameraFacing,
  type CameraResolution,
  type DeviceGroups,
  type DevicePrefs,
} from '@/hooks/media'
import { usePersistentState } from '@/hooks/persistent'
import { storedFields } from '@/lib/storage'

function isResolution(value: unknown): value is CameraResolution {
  return CAMERA_RESOLUTIONS.some((option) => option.value === value)
}

function isFacing(value: unknown): value is CameraFacing {
  return value === 'user' || value === 'environment'
}

// Whatever an older build (or a hand edit) left in storage becomes
// complete, valid prefs here, so nothing past this point checks.
function parseDevicePrefs(stored: unknown): DevicePrefs {
  const { mic, cam, speaker, resolution, volume, micGain, blur, camFacing } = storedFields<DevicePrefs>(stored)
  return {
    mic: typeof mic === 'string' ? mic : DEFAULT_DEVICE_PREFS.mic,
    cam: typeof cam === 'string' ? cam : DEFAULT_DEVICE_PREFS.cam,
    speaker: typeof speaker === 'string' ? speaker : DEFAULT_DEVICE_PREFS.speaker,
    resolution: isResolution(resolution) ? resolution : DEFAULT_DEVICE_PREFS.resolution,
    volume: typeof volume === 'number' ? clampVolume(volume) : DEFAULT_DEVICE_PREFS.volume,
    micGain: typeof micGain === 'number' ? clampMicGain(micGain) : DEFAULT_DEVICE_PREFS.micGain,
    blur: typeof blur === 'boolean' ? blur : DEFAULT_DEVICE_PREFS.blur,
    camFacing: isFacing(camFacing) ? camFacing : DEFAULT_DEVICE_PREFS.camFacing,
  }
}

export function parseAvPrefs(stored: unknown): AvPrefs {
  const { mic, cam } = storedFields<AvPrefs>(stored)
  return {
    mic: typeof mic === 'boolean' ? mic : DEFAULT_AV_PREFS.mic,
    cam: typeof cam === 'boolean' ? cam : DEFAULT_AV_PREFS.cam,
  }
}

export function useDevicePrefs(devices: DeviceGroups) {
  const [devicePrefs, setDevicePrefs] = usePersistentState('conference:devices', { parse: parseDevicePrefs })
  const prefsRef = useLatest(devicePrefs)
  const seenDeviceIdsRef = useRef<Set<string>>(new Set())

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

  // The speaker is left alone: useSpeaker decides whether it still works
  // and says so when it does not.
  useEffect(() => {
    const seen = seenDeviceIdsRef.current
    for (const device of [...devices.mics, ...devices.cams]) seen.add(device.deviceId)
    const sanitize = (list: MediaDeviceInfo[], deviceId: string) => {
      const validated = validDeviceId(list, deviceId)
      return validated === deviceId || seen.has(deviceId) ? deviceId : validated
    }
    setDevicePrefs((prev) => {
      const mic = sanitize(devices.mics, prev.mic)
      const cam = sanitize(devices.cams, prev.cam)
      return mic === prev.mic && cam === prev.cam ? prev : { ...prev, mic, cam }
    })
  }, [devices, setDevicePrefs])

  return { devicePrefs, prefsRef, updateDevicePrefs }
}
