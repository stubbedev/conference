// One member's microphone as 16 kHz PCM: the same capture feeds the
// speech service when the server runs the engines and the browser's own
// engine when it does not. The AudioContext runs at 16 kHz, so the
// browser has already resampled the input before the worklet chunks it.

import captureWorkletUrl from '@/lib/translate/pcm-capture.worklet.ts?worker&url'

export const CAPTURE_RATE = 16_000

export interface CaptureEvents {
  /** 20 ms of 16-bit PCM, in the worklet's own chunk. */
  onAudio: (pcm: ArrayBuffer) => void
  /** The microphone stopped feeding, or started over on another track. */
  onStop: () => void
}

export class MicCapture {
  private context: AudioContext | null = null
  private worklet: Promise<void> | null = null
  private graph: { source: MediaStreamAudioSourceNode; node: AudioWorkletNode } | null = null
  private track: MediaStreamTrack | null = null
  private readonly events: CaptureEvents

  constructor(events: CaptureEvents) {
    this.events = events
  }

  /** Starts sending track's audio. Call it from a user gesture where possible, so the context may start. */
  async start(track: MediaStreamTrack | null): Promise<void> {
    this.context ??= new AudioContext({ sampleRate: CAPTURE_RATE })
    this.worklet ??= this.context.audioWorklet.addModule(captureWorkletUrl)
    void this.context.resume()
    this.track = track
    await this.connect()
  }

  setTrack(track: MediaStreamTrack | null): void {
    if (this.track === track) return
    this.stop()
    this.track = track
    void this.connect()
  }

  /** Stops sending audio and says so, so a listener can end the stream. */
  stop(): void {
    const graph = this.graph
    if (!graph) return
    graph.node.port.onmessage = null
    graph.source.disconnect()
    graph.node.disconnect()
    this.graph = null
    this.events.onStop()
  }

  async close(): Promise<void> {
    this.stop()
    const context = this.context
    this.context = null
    this.worklet = null
    await context?.close()
  }

  private async connect(): Promise<void> {
    const context = this.context
    const worklet = this.worklet
    const track = this.track
    if (!context || !worklet || !track) return
    await worklet
    if (this.context !== context || this.track !== track || this.graph) return

    const source = context.createMediaStreamSource(new MediaStream([track]))
    const node = new AudioWorkletNode(context, 'pcm-capture')
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => this.events.onAudio(event.data)
    // A worklet only runs while the graph pulls it, so it feeds a muted
    // gain into the destination.
    const mute = context.createGain()
    mute.gain.value = 0
    source.connect(node).connect(mute).connect(context.destination)
    this.graph = { source, node }
  }
}
