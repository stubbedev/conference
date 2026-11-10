import { useCallback, useEffect, useState } from 'react'

function refused(attempt: string): (err: unknown) => void {
  return (err) => console.warn(`fullscreen: ${attempt}`, err)
}

// Whether this page can go full screen at all: an iPhone's browsers have
// no requestFullscreen on the page, and an embedding page may forbid it.
function canFullscreen(): boolean {
  return Boolean(document.fullscreenEnabled) && typeof document.documentElement.requestFullscreen === 'function'
}

export interface Fullscreen {
  fullscreen: boolean
  /** Null where the page cannot go full screen, so nothing offers it. */
  toggleFullscreen: (() => void) | null
}

export function useFullscreen(): Fullscreen {
  const [fullscreen, setFullscreen] = useState(false)
  const [available] = useState(canFullscreen)

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(refused('leaving full screen'))
      return
    }
    void document.documentElement.requestFullscreen().catch(refused('entering full screen'))
  }, [])

  return { fullscreen, toggleFullscreen: available ? toggleFullscreen : null }
}
