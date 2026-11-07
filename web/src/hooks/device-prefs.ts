import { useCallback, useEffect, useRef } from 'react'

import { useLatest } from '@/hooks/latest'
import {
  CAMERA_RESOLUTIONS,
  DEFAULT_DEVICE_PREFS,
  validDeviceId,
  type DeviceGroups,
  type DevicePrefs,
} from '@/hooks/media'
import { usePersistentState } from '@/hooks/persistent'

function migrateDevicePrefs(stored: DevicePrefs): DevicePrefs {
  return {
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
  }
}

export function useDevicePrefs(devices: DeviceGroups) {
  const [devicePrefs, setDevicePrefs] = usePersistentState<DevicePrefs>(
    'conference:devices',
    DEFAULT_DEVICE_PREFS,
    migrateDevicePrefs,
  )
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

  return { devicePrefs, prefsRef, updateDevicePrefs }
}
