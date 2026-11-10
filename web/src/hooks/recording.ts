import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'

import { errorMessage } from '@/lib/errors'
import { CallRecorder, recorderKeepsPaceHidden, recorderSupported, type RecorderTile } from '@/lib/recorder'
import type { RoomClient } from '@/lib/sfu'

const RECORDING_HIDDEN_TOAST = 'recording-hidden'

export function useRecording(slug: string, clientRef: RefObject<RoomClient | null>, tiles: RecorderTile[]) {
  const [recorder, setRecorder] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<CallRecorder | null>(null)

  useEffect(() => {
    return () => {
      recorderRef.current?.stop().catch((err: unknown) => console.error('recording: saving the recording as the call is left', err))
    }
  }, [])

  const stopRecording = useCallback(async () => {
    const active = recorderRef.current
    if (!active) return
    recorderRef.current = null
    setRecording(false)
    try {
      await active.stop()
    } catch (err) {
      console.error('recording: saving the recording', err)
      toast.error('The recording could not be saved.')
    }
    clientRef.current?.announceRecording(false)
  }, [clientRef])

  const startRecording = useCallback(() => {
    if (recorderRef.current) return
    if (!recorderSupported()) {
      toast.error('This browser cannot record the call.')
      return
    }

    let instance: CallRecorder
    try {
      instance = new CallRecorder(slug, (reason) => {
        if (recorderRef.current !== instance) return
        recorderRef.current = null
        setRecording(false)
        clientRef.current?.announceRecording(false)
        toast.error(`Recording stopped: ${reason}. Everything captured until then has been saved.`)
      })
    } catch (err) {
      toast.error(errorMessage(err))
      return
    }
    recorderRef.current = instance
    setRecording(true)
    instance.start().catch((err: unknown) => {
      recorderRef.current = null
      setRecording(false)
      toast.error(errorMessage(err))
      clientRef.current?.announceRecording(false)
    })
    clientRef.current?.announceRecording(true)
  }, [slug, clientRef])

  const toggleRecording = useCallback(() => {
    if (recorderRef.current) void stopRecording()
    else startRecording()
  }, [startRecording, stopRecording])

  const bind = useCallback(
    (client: RoomClient) => {
      client.on('welcome', ({ recorder: initial }) => setRecorder(initial || null))
      client.on('recording', ({ from, on }) => {
        setRecorder(on ? from : null)
        if (from === client.memberId) {
          setRecording(on)
          if (on) toast.success('Recording started')
          else toast('Recording stopped, the file is downloading')
          return
        }
        const name = client.memberName(from)
        if (on) toast(`${name} started recording this call`)
        else toast(`${name} stopped recording`)
      })
      client.on('error', ({ code }) => {
        if (code === 'record-busy' && recorderRef.current) {
          void stopRecording()
        }
      })

      return () => {
        if (recorderRef.current) client.announceRecording(true)
      }
    },
    [stopRecording],
  )

  useEffect(() => {
    if (!recording) return
    recorderRef.current?.setTiles(tiles)
  }, [recording, tiles])

  useEffect(() => {
    if (!recording || recorderKeepsPaceHidden()) return

    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return

      toast('Recording continues, but the video slows to about one frame a second while this tab is in the background.', {
        id: RECORDING_HIDDEN_TOAST,
      })
    }

    document.addEventListener('visibilitychange', onVisibility)

    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [recording])

  return { recorder, recording, canRecord: recorderSupported(), toggleRecording, stopRecording, bind }
}
