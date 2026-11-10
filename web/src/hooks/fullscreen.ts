import { useCallback, useEffect, useState } from 'react'

function refused(attempt: string): (err: unknown) => void {
  return (err) => console.warn(`fullscreen: ${attempt}`, err)
}

export function useFullscreen() {
  const [fullscreen, setFullscreen] = useState(false)

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
    const root = document.documentElement
    if (typeof root.requestFullscreen === 'function') {
      void root.requestFullscreen().catch(refused('entering full screen'))
    }
  }, [])

  return { fullscreen, toggleFullscreen }
}
