import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'

import type { Controls } from '@/hooks/local-media'
import { stopMediaStream } from '@/hooks/media'
import { errorMessage, errorName } from '@/lib/errors'
import { requestDisplay } from '@/lib/screen'
import type { RoomClient } from '@/lib/sfu'

export type ShareState = 'off' | 'starting' | 'on'

export function shareState(sharing: boolean, starting: boolean): ShareState {
  if (starting) return 'starting'
  return sharing ? 'on' : 'off'
}

export function useScreenShare(
  clientRef: RefObject<RoomClient | null>,
  controlsRef: RefObject<Controls>,
  updateControls: (patch: Partial<Controls>) => void,
) {
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)

  useEffect(() => {
    return () => stopMediaStream(screenStreamRef.current)
  }, [])

  const toggleShare = useCallback(async () => {
    const client = clientRef.current
    if (!client || startingRef.current) return

    if (controlsRef.current.sharing) {
      await client.removeScreen()
      stopMediaStream(screenStreamRef.current)
      screenStreamRef.current = null
      setScreenStream(null)
      updateControls({ sharing: false })
      return
    }

    startingRef.current = true
    setStarting(true)
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
    } catch (err) {
      stopMediaStream(screenStreamRef.current)
      screenStreamRef.current = null
      if (errorName(err) === 'NotAllowedError') return
      console.error('screen share: starting the share', err)
      toast.error(`Your screen could not be shared: ${errorMessage(err)}`)
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }, [clientRef, updateControls, controlsRef])

  const toggleScreen = useCallback(() => void toggleShare(), [toggleShare])

  return { screenStream, screenStreamRef, starting, toggleShare, toggleScreen }
}
