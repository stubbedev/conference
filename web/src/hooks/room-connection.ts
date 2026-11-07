import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { deriveChatKey, deriveMediaKeyMaterial } from '@/lib/roomkeys'
import { JoinError, RoomClient } from '@/lib/sfu'

const RECONNECT_TOAST = 'reconnect'
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, ...Array<number>(14).fill(10_000)]

export type AfterConnect = (published: MediaStream) => void
export type BindClient = (client: RoomClient) => AfterConnect | void
export type ListenClient = (client: RoomClient) => () => void

export interface RoomConnectionOptions {
  slug: string
  displayName: string
  live: boolean
  clientRef: RefObject<RoomClient | null>
  sessionRef: RefObject<string>
  roomKeyRef: RefObject<Uint8Array<ArrayBuffer> | null>
  localStreamRef: RefObject<MediaStream | null>
  screenStreamRef: RefObject<MediaStream | null>
  binders: readonly BindClient[]
  liveListeners: readonly ListenClient[]
  stopRecording: () => Promise<void>
  stopTranslation: () => Promise<void>
  onReconnected: () => void
  onLost: () => void
}

function waitForRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer)
      window.removeEventListener('online', done)
      resolve()
    }
    const timer = window.setTimeout(done, ms)
    window.addEventListener('online', done)
  })
}

export function useRoomConnection({
  slug,
  displayName,
  live,
  clientRef,
  sessionRef,
  roomKeyRef,
  localStreamRef,
  screenStreamRef,
  binders,
  liveListeners,
  stopRecording,
  stopTranslation,
  onReconnected,
  onLost,
}: RoomConnectionOptions) {
  const navigate = useNavigate()
  const [clientGeneration, setClientGeneration] = useState(0)
  const kickedRef = useRef(false)
  const endedRef = useRef(false)
  const reconnectingRef = useRef(false)
  const reconnectRef = useRef<((lost: RoomClient) => Promise<void>) | null>(null)

  useEffect(() => {
    return () => {
      endedRef.current = true
      clientRef.current?.leave()
    }
  }, [clientRef])

  const connectClient = useCallback(
    async (resume: string): Promise<RoomClient> => {
      const stream = localStreamRef.current
      const roomKey = roomKeyRef.current
      if (!stream || !roomKey) throw new Error('Local media or the room key is missing.')

      const [mediaKey, chatKey] = await Promise.all([
        deriveMediaKeyMaterial(roomKey),
        deriveChatKey(roomKey),
      ])

      const client = new RoomClient({
        slug,
        session: sessionRef.current,
        name: displayName.trim() || 'Guest',
        mediaKey,
        chatKey,
        resume,
      })
      clientRef.current = client

      client.on('error', ({ code, text }) => {
        toast.error(text)
        if (code === 'room-closed') endedRef.current = true
      })
      client.on('closed', () => {
        if (clientRef.current !== client || kickedRef.current) return
        if (endedRef.current) {
          void stopRecording().finally(() => navigate('/'))
          return
        }
        void reconnectRef.current?.(client)
      })
      const afterConnect = binders.flatMap((bind) => bind(client) ?? [])

      try {
        await client.connect()
        await client.publish(stream)
        const screen = screenStreamRef.current
        if (screen?.getVideoTracks().some((track) => track.readyState === 'live')) {
          await client.addScreen(screen)
        }
      } catch (err) {
        client.leave()
        if (clientRef.current === client) clientRef.current = null
        throw err
      }
      for (const after of afterConnect) after(stream)
      setClientGeneration((generation) => generation + 1)
      return client
    },
    [slug, displayName, navigate, clientRef, sessionRef, roomKeyRef, localStreamRef, screenStreamRef, binders, stopRecording],
  )

  const reconnect = useCallback(
    async (lost: RoomClient) => {
      if (reconnectingRef.current) return
      reconnectingRef.current = true
      const resume = lost.resume
      lost.pause()
      clientRef.current = null
      toast.loading('Connection lost, reconnecting…', { id: RECONNECT_TOAST })

      try {
        for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
          await waitForRetry(RECONNECT_DELAYS_MS[attempt])
          if (endedRef.current) break
          try {
            await connectClient(resume)
            onReconnected()
            toast.success('Reconnected', { id: RECONNECT_TOAST })
            return
          } catch (err) {
            if (err instanceof JoinError && err.final) break
          }
        }
      } finally {
        lost.destroy()
        reconnectingRef.current = false
      }

      onLost()
      if (endedRef.current) return
      toast.error('The connection was lost.', { id: RECONNECT_TOAST })
      endedRef.current = true
      await stopRecording()
      navigate('/')
    },
    [clientRef, connectClient, onReconnected, onLost, stopRecording, navigate],
  )
  useEffect(() => {
    reconnectRef.current = reconnect
  }, [reconnect])

  useEffect(() => {
    const client = clientRef.current
    if (!live || !client) return

    const unsubscribers = [
      ...liveListeners.map((listen) => listen(client)),
      client.on('kicked', () => {
        kickedRef.current = true
        endedRef.current = true
        toast('You were removed from the call')
        navigate('/')
      }),
    ]

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [live, clientGeneration, clientRef, liveListeners, navigate])

  const leave = useCallback(async () => {
    endedRef.current = true
    await stopRecording()
    await stopTranslation()
    clientRef.current?.leave()
    navigate('/')
  }, [clientRef, navigate, stopRecording, stopTranslation])

  return { connectClient, clientGeneration, leave }
}
