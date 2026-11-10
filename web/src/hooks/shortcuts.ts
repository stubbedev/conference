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

export type Shortcut = keyof ShortcutActions

// The key of each shortcut, as KeyboardEvent.key gives it in lower case.
const KEYS: Record<Shortcut, string> = { toggleMic: 'm', toggleCam: 'v', toggleChat: 'c', toggleFullscreen: 'f' }

/** The key as a hint shows it and as aria-keyshortcuts names it. */
export function shortcutKey(shortcut: Shortcut): string {
  return KEYS[shortcut].toUpperCase()
}

export function useShortcuts(phase: Phase, { toggleMic, toggleCam, toggleChat, toggleFullscreen }: ShortcutActions) {
  useEffect(() => {
    if (phase !== 'live' && phase !== 'prejoin') return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof Element && target.closest(TYPING_TARGETS)) return
      const key = event.key.toLowerCase()
      if (key === KEYS.toggleMic) toggleMic()
      else if (key === KEYS.toggleCam) toggleCam()
      else if (key === KEYS.toggleChat && phase === 'live') toggleChat()
      else if (key === KEYS.toggleFullscreen) toggleFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, toggleMic, toggleCam, toggleChat, toggleFullscreen])
}
