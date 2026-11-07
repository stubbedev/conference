import { useEffect, useRef, useState } from 'react'

import { toggleTileDebug } from '@/hooks/tileDebug'

const TAP_WINDOW_MS = 2500
const TAPS_TO_OPEN = 5
const SINGLE_TAP_DELAY_MS = 450
const KEPT_ERRORS = 10

export function useDiagnostics(onSingleTap: () => void) {
  const [open, setOpen] = useState(false)
  const errorsRef = useRef<string[]>([])
  const tapsRef = useRef<number[]>([])
  const singleTapTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const record = (text: string) => {
      errorsRef.current = [...errorsRef.current.slice(-(KEPT_ERRORS - 1)), text]
    }
    const onError = (event: ErrorEvent) =>
      record(`${new Date().toLocaleTimeString()} ${event.message} @${event.lineno}`)
    const onRejection = (event: PromiseRejectionEvent) =>
      record(`${new Date().toLocaleTimeString()} promise ${String(event.reason)}`)

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  const onTitleTap = () => {
    const now = Date.now()
    tapsRef.current = tapsRef.current.filter((tap) => now - tap < TAP_WINDOW_MS)
    tapsRef.current.push(now)
    window.clearTimeout(singleTapTimerRef.current)

    if (tapsRef.current.length >= TAPS_TO_OPEN) {
      tapsRef.current = []
      setOpen(!open)
      toggleTileDebug()

      return
    }

    singleTapTimerRef.current = window.setTimeout(onSingleTap, SINGLE_TAP_DELAY_MS)
  }

  return { open, errorsRef, onTitleTap }
}
