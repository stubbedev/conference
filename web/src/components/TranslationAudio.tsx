import { useEffect, useRef } from 'react'

import { playMediaElement } from '@/hooks/media'

interface TranslationAudioProps {
  stream: MediaStream
  sinkId?: string
  volume: number
}

// Plays the translated voice in this member's language. Like a tile's
// audio it uses its own element, so autoplay policy retries apply.
export function TranslationAudio({ stream, sinkId, volume }: TranslationAudioProps) {
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.srcObject = stream
    playMediaElement(audio)
    return () => {
      audio.srcObject = null
    }
  }, [stream])

  useEffect(() => {
    const audio = audioRef.current
    if (audio && sinkId && 'setSinkId' in audio) audio.setSinkId(sinkId).catch(() => {})
  }, [sinkId])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.min(1, Math.max(0, volume))
  }, [volume])

  return <audio ref={audioRef} autoPlay playsInline className="hidden" />
}
