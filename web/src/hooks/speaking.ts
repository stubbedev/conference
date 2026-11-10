import { useEffect, useState } from 'react'

import { audioContext } from '@/hooks/media'
import { SPEAKING_SAMPLE_MS } from '@/lib/speaking'
import { VoiceMeter } from '@/lib/voice-meter'

// Speaking detection for every tile in the call runs on one loop. A
// per-tile requestAnimationFrame loop wakes the page at display refresh
// for as many participants as are on screen, which is pure battery drain
// in a call that is already decoding and compositing. This loop samples
// every probe a few times a second instead, which is all an indicator can
// show anyway.

interface Probe {
  stream: MediaStream
  meter: VoiceMeter
  source: MediaStreamAudioSourceNode | null
  active: boolean
  listeners: Set<(active: boolean) => void>
}

const probes = new Map<MediaStream, Probe>()

let frame = 0
let lastSample = 0

function bind(probe: Probe, ctx: AudioContext): void {
  if (probe.source) return

  const track = probe.stream.getAudioTracks()[0]
  if (!track) return

  probe.source = ctx.createMediaStreamSource(new MediaStream([track]))
  probe.source.connect(probe.meter.input)
}

function sample(probe: Probe, now: number): void {
  probe.meter.sample(now)

  const active = probe.meter.speaking(now)
  if (active === probe.active) return

  probe.active = active
  for (const listener of probe.listeners) listener(active)
}

function tick(now: number): void {
  if (now - lastSample >= SPEAKING_SAMPLE_MS) {
    lastSample = now
    for (const probe of probes.values()) sample(probe, now)
  }

  frame = probes.size > 0 ? requestAnimationFrame(tick) : 0
}

function probeFor(stream: MediaStream, ctx: AudioContext): Probe {
  const known = probes.get(stream)
  if (known) return known

  const probe: Probe = {
    stream,
    meter: new VoiceMeter(ctx),
    source: null,
    active: false,
    listeners: new Set(),
  }

  probes.set(stream, probe)
  bind(probe, ctx)

  return probe
}

/**
 * watchSpeaking calls listener whenever stream starts or stops carrying a
 * voice, and returns the function that stops watching it.
 */
function watchSpeaking(stream: MediaStream, listener: (active: boolean) => void): () => void {
  const ctx = audioContext()
  if (!ctx) return () => {}

  const probe = probeFor(stream, ctx)
  probe.listeners.add(listener)

  const onTrack = () => bind(probe, ctx)
  stream.addEventListener('addtrack', onTrack)

  if (frame === 0) {
    lastSample = 0
    frame = requestAnimationFrame(tick)
  }

  return () => {
    probe.listeners.delete(listener)
    stream.removeEventListener('addtrack', onTrack)

    if (probe.listeners.size > 0) return

    probe.source?.disconnect()
    probe.meter.input.disconnect()
    probes.delete(stream)
  }
}

/** Whether the voice heard on this stream is speaking right now, for the tile's ring. */
export function useIsSpeaking(stream: MediaStream | null): boolean {
  const [speaking, setSpeaking] = useState<{ source: MediaStream | null; active: boolean }>({
    source: null,
    active: false,
  })

  useEffect(() => {
    if (!stream) return

    return watchSpeaking(stream, (active) => setSpeaking({ source: stream, active }))
  }, [stream])

  return speaking.source === stream && speaking.active
}
