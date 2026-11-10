import { useEffect, useState } from 'react'

import { audioContext } from '@/hooks/media'
import { heard, holdLeft, isVoiced, SPEAKING_SAMPLE_MS, type LastVoiced } from '@/lib/speaking'

// Speaking detection for every tile in the call runs on one loop. A
// per-tile requestAnimationFrame loop wakes the page at display refresh
// for as many participants as are on screen, which is pure battery drain
// in a call that is already decoding and compositing. This loop samples
// every probe a few times a second instead, which is all an indicator can
// show anyway.

interface Probe {
  stream: MediaStream
  analyser: AnalyserNode
  source: MediaStreamAudioSourceNode | null
  samples: Uint8Array<ArrayBuffer>
  lastVoiced: LastVoiced
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
  probe.source.connect(probe.analyser)
}

function sample(probe: Probe, now: number): void {
  probe.analyser.getByteTimeDomainData(probe.samples)

  let sum = 0
  for (const value of probe.samples) {
    const deviation = (value - 128) / 128
    sum += deviation * deviation
  }

  probe.lastVoiced = heard(probe.lastVoiced, isVoiced(Math.sqrt(sum / probe.samples.length)), now)

  const active = holdLeft(probe.lastVoiced, now) > 0
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

  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024

  const probe: Probe = {
    stream,
    analyser,
    source: null,
    samples: new Uint8Array(analyser.fftSize),
    lastVoiced: null,
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
export function watchSpeaking(stream: MediaStream, listener: (active: boolean) => void): () => void {
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
    probe.analyser.disconnect()
    probes.delete(stream)
  }
}

/** Whether this member is speaking right now, for the tile's ring. */
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

/**
 * useHeldSpeaking is active held on for as long as a voice measured by
 * the probes would be, for a voice that is only known to be playing or
 * not, such as a member's translation.
 */
export function useHeldSpeaking(active: boolean): boolean {
  const [lastVoiced, setLastVoiced] = useState<LastVoiced>(null)
  const [now, setNow] = useState(0)

  useEffect(() => {
    if (!active) return

    return () => {
      const stoppedAt = performance.now()
      setLastVoiced((last) => heard(last, true, stoppedAt))
      setNow(stoppedAt)
    }
  }, [active])

  const left = holdLeft(lastVoiced, now)

  useEffect(() => {
    if (active || left === 0) return

    const timer = window.setTimeout(() => setNow(performance.now()), left)
    return () => window.clearTimeout(timer)
  }, [active, left])

  return active || left > 0
}
