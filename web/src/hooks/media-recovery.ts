import { useEffect, useRef } from 'react'

import { isMobileDevice } from '@/hooks/media'
import type { useLocalMedia } from '@/hooks/local-media'

const RECOVER_BACKOFF_MS = 5000
const DEVICE_POLL_MS = 3000

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

    return () => {
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, localStream, localStreamRef, refreshDevices])
}
