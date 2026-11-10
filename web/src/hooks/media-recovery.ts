import { useEffect, useRef } from 'react'

import { isMobileDevice, type TrackKind } from '@/hooks/media'
import type { useLocalMedia } from '@/hooks/local-media'
import { queryPermission, type QueriedPermission } from '@/lib/permission'

const RECOVER_BACKOFF_MS = 5000
const DEVICE_POLL_MS = 3000

const PERMISSION_NAMES: Record<TrackKind, PermissionName> = { mic: 'microphone', cam: 'camera' }

function permission(kind: TrackKind): Promise<QueriedPermission> {
  return queryPermission(navigator.permissions, PERMISSION_NAMES[kind])
}

async function mayReopen(kind: TrackKind): Promise<boolean> {
  const status = await permission(kind)
  return status === 'unknown' || status.state === 'granted'
}

export function useMediaRecovery(active: boolean, media: ReturnType<typeof useLocalMedia>) {
  const { devices, localStream, localStreamRef, mediaBusy, switchDevice, prefsRef, refreshDevices } = media
  const recoverLockRef = useRef(false)
  const lastRecoverRef = useRef(0)

  useEffect(() => {
    if (!active) return
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
        if (wantsCam && (await mayReopen('cam'))) {
          const prefs = prefsRef.current
          await switchDevice('cam', prefs.cam, undefined, {
            mode: 'recover',
            ...(isMobileDevice() && prefs.camFacing ? { facing: prefs.camFacing } : {}),
          })
        }
        if (!localStreamRef.current?.getAudioTracks().length && devices.mics.length > 0 && (await mayReopen('mic'))) {
          await switchDevice('mic', prefsRef.current.mic, undefined, { mode: 'recover' })
        }
      } finally {
        recoverLockRef.current = false
      }
    })()
  }, [active, devices, localStream, localStreamRef, mediaBusy, switchDevice, prefsRef])

  useEffect(() => {
    if (!active) return
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
    const watched: PermissionStatus[] = []
    let disposed = false
    const onPermission = () => void refreshDevices()
    void Promise.all([permission('mic'), permission('cam')]).then((statuses) => {
      for (const status of statuses) {
        if (status === 'unknown') continue
        if (disposed) return
        status.addEventListener('change', onPermission)
        watched.push(status)
      }
    })

    return () => {
      disposed = true
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibility)
      for (const status of watched) status.removeEventListener('change', onPermission)
    }
  }, [active, localStream, localStreamRef, refreshDevices])
}
