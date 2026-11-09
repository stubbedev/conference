import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'

import type { Controls } from '@/hooks/local-media'
import { stopMediaStream } from '@/hooks/media'
import { requestDisplay } from '@/lib/screen'
import type { RoomClient } from '@/lib/sfu'

export function useScreenShare(
  clientRef: RefObject<RoomClient | null>,
  controlsRef: RefObject<Controls>,
  updateControls: (patch: Partial<Controls>) => void,
) {
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    return () => stopMediaStream(screenStreamRef.current)
  }, [])

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
    } catch (err) {
      stopMediaStream(screenStreamRef.current)
      screenStreamRef.current = null
      if (err instanceof DOMException && err.name === 'NotAllowedError') return
      console.error('screen share: starting the share', err)
      toast.error(`Your screen could not be shared: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [clientRef, updateControls, controlsRef])

  const toggleScreen = useCallback(() => void toggleShare(), [toggleShare])

  return { screenStream, screenStreamRef, toggleShare, toggleScreen }
}
