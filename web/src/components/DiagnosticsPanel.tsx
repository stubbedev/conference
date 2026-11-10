import { useEffect, useState, type RefObject } from 'react'

import { errorText } from '@/lib/errors'
import type { RoomClient } from '@/lib/sfu'

interface DiagnosticsPanelProps {
  clientRef: RefObject<RoomClient | null>
  errorsRef: RefObject<string[]>
}

export function DiagnosticsPanel({ clientRef, errorsRef }: DiagnosticsPanelProps) {
  const [text, setText] = useState('')

  useEffect(() => {
    let alive = true

    const sample = async () => {
      const client = clientRef.current
      const report = client
        ? await client.debugStats().catch((err: unknown) => `stats unavailable: ${errorText(err)}`)
        : 'not joined yet'

      if (!alive) return

      setText(`${report}\n--- page errors ---\n${errorsRef.current.join('\n') || 'none'}`)
    }

    void sample()

    const timer = window.setInterval(() => void sample(), 1000)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [clientRef, errorsRef])

  return (
    <pre className="fixed bottom-20 left-2 z-50 max-h-64 w-[22rem] max-w-[90vw] overflow-auto rounded-lg bg-black/85 p-2 font-mono text-[10px] leading-tight break-all whitespace-pre-wrap text-emerald-300">
      {text || 'collecting…'}
    </pre>
  )
}
