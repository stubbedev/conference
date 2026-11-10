import { useEffect, useRef } from 'react'

import { useAudioSink } from '@/hooks/audio-output'
import { clampVolume, playMediaElement } from '@/hooks/media'

interface TranslationAudioProps {
  stream: MediaStream
  sinkId: string
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

  useAudioSink(audioRef, sinkId)

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = clampVolume(volume)
  }, [volume])

  return <audio ref={audioRef} autoPlay playsInline className="hidden" />
}
