import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { resumeAudio } from '@/hooks/media'
import { api, type RoomInfo } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { deriveProof, fromB64, importPassword, openKeyblob, toB64 } from '@/lib/roomkeys'
import { forgetRoomPassword, rememberRoomPassword, savedRoomPassword } from '@/lib/roompass'

export type Phase = 'checking' | 'gate' | 'prejoin' | 'joining' | 'live' | 'error'

function supportsE2EE(): boolean {
  return 'RTCRtpScriptTransform' in window
}

export function useRoomSession(slug: string, onReady: () => Promise<void>) {
  const [searchParams] = useSearchParams()
  const [phase, setPhase] = useState<Phase>('checking')
  const [gateBusy, setGateBusy] = useState(false)
  const [gateError, setGateError] = useState('')
  const [fatalError, setFatalError] = useState('')
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null)
  const [roomKeyText, setRoomKeyText] = useState('')
  const [privileged, setPrivileged] = useState(false)
  const sessionRef = useRef('')
  const roomKeyRef = useRef<Uint8Array<ArrayBuffer> | null>(null)

  const privToken = searchParams.get('p') ?? ''
  const hashKey = useMemo(() => {
    const match = window.location.hash.match(/#k=([A-Za-z0-9_-]+)/)
    return match ? match[1] : ''
  }, [])

  const bootstrap = useCallback(
    async (password?: string) => {
      try {
        const info = await api.roomInfo(slug)
        setRoomInfo(info)

        let session = ''
        let keyB64 = hashKey

        if (privToken) {
          const res = await api.auth(slug, { token: privToken })
          session = res.session
          setPrivileged(res.priv)
          if (res.key) keyB64 = res.key
        } else if (!info.requiresPassword) {
          const res = await api.auth(slug, {})
          session = res.session
          if (res.key) keyB64 = res.key
        } else {
          const pass = password ? await importPassword(password) : await savedRoomPassword(slug)
          if (!pass) {
            setGateError('')
            setPhase('gate')
            return
          }
          if (!info.authSalt) throw new Error('This room is missing its password salt.')
          const proof = await deriveProof(pass, info.authSalt)
          const res = await api.auth(slug, { proof }).catch(async (err: unknown) => {
            if (!password) await forgetRoomPassword(slug)
            throw err
          })
          if (password) await rememberRoomPassword(slug, pass)
          session = res.session
          if (res.key) keyB64 = res.key
          else if (res.keyblob && res.keySalt) {
            const raw = await openKeyblob(res.keyblob, res.keySalt, pass)
            keyB64 = toB64(raw)
          }
        }

        if (!keyB64) {
          setGateError('')
          setPhase('gate')
          return
        }

        if (!supportsE2EE()) {
          throw new Error(
            'This browser cannot do end-to-end encrypted media. Use a current Chrome or Edge, or Safari 15.4 or newer.',
          )
        }

        sessionRef.current = session
        roomKeyRef.current = fromB64(keyB64)
        setRoomKeyText(keyB64)
        setPhase('prejoin')
        void onReady()
      } catch (err) {
        const message = errorMessage(err)
        if (/password/i.test(message)) {
          setGateError(message)
          setPhase('gate')
        } else {
          setFatalError(message)
          setPhase('error')
        }
      } finally {
        setGateBusy(false)
      }
    },
    [slug, privToken, hashKey, onReady],
  )

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- bootstrap awaits the room lookup before its first state update
    void bootstrap()
  }, [bootstrap])

  const submitPassword = useCallback(
    (password: string) => {
      setGateBusy(true)
      void bootstrap(password)
    },
    [bootstrap],
  )

  const join = useCallback(
    async (connect: () => Promise<unknown>) => {
      if (!roomInfo || !roomKeyRef.current) return

      resumeAudio()
      setPhase('joining')
      try {
        await connect()
        setPhase('live')
      } catch (err) {
        setFatalError(errorMessage(err))
        setPhase('error')
      }
    },
    [roomInfo],
  )

  return {
    phase,
    gateBusy,
    gateError,
    fatalError,
    roomInfo,
    roomKeyText,
    privileged,
    sessionRef,
    roomKeyRef,
    submitPassword,
    join,
  }
}
