import { useEffect } from 'react'

import type { Phase } from '@/hooks/room-session'

const TYPING_TARGETS =
  'input, textarea, [contenteditable="true"], [data-slot="select-trigger"], [data-slot="select-content"], [role="menu"]'

export interface ShortcutActions {
  toggleMic: () => void
  toggleCam: () => void
  toggleChat: () => void
  toggleFullscreen: () => void
}

export function useShortcuts(phase: Phase, { toggleMic, toggleCam, toggleChat, toggleFullscreen }: ShortcutActions) {
  useEffect(() => {
    if (phase !== 'live' && phase !== 'prejoin') return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof Element && target.closest(TYPING_TARGETS)) return
      const key = event.key.toLowerCase()
      if (key === 'm') toggleMic()
      else if (key === 'v') toggleCam()
      else if (key === 'c' && phase === 'live') toggleChat()
      else if (key === 'f') toggleFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, toggleMic, toggleCam, toggleChat, toggleFullscreen])
}
