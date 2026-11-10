import { useCallback, useEffect, useState } from 'react'

export function useFullscreen() {
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    const root = document.documentElement
    if (typeof root.requestFullscreen === 'function') {
      void root.requestFullscreen().catch(() => {})
    }
  }, [])

  return { fullscreen, toggleFullscreen }
}
