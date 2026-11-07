// Plays translated speech into one stream, scheduling each segment after
// the one before it so sentences do not overlap. The speech service
// publishes these streams to the room per language; the browser's own
// engine keeps them on this machine, one per speaker.

/** When a segment starts and how long it lasts, for the talking ring. */
export interface VoiceCue {
  startInMs: number
  durationMs: number
}

interface Output {
  destination: MediaStreamAudioDestinationNode
  nextStart: number
}

export class VoicePlayer {
  private readonly context: AudioContext
  private readonly outputs = new Map<string, Output>()
  private readonly onStream?: (key: string, track: MediaStreamTrack) => void

  constructor(context: AudioContext, onStream?: (key: string, track: MediaStreamTrack) => void) {
    this.context = context
    this.onStream = onStream
  }

  /** Plays pcm under key, after whatever it played before. */
  play(key: string, pcm: Float32Array, rate: number): VoiceCue {
    const output = this.output(key)
    const buffer = this.context.createBuffer(1, Math.max(pcm.length, 1), rate)
    buffer.getChannelData(0).set(pcm)

    const start = Math.max(this.context.currentTime, output.nextStart)
    output.nextStart = start + buffer.duration

    const node = this.context.createBufferSource()
    node.buffer = buffer
    node.connect(output.destination)
    node.start(start)

    return {
      startInMs: Math.round((start - this.context.currentTime) * 1000),
      durationMs: Math.round(buffer.duration * 1000),
    }
  }

  /** The stream key's voice arrives on, or null when it has none yet. */
  track(key: string): MediaStreamTrack | null {
    return this.outputs.get(key)?.destination.stream.getAudioTracks()[0] ?? null
  }

  /** Drops what key played, as a departed speaker's stream should be. */
  forget(key: string): void {
    this.outputs.delete(key)
  }

  private output(key: string): Output {
    const known = this.outputs.get(key)
    if (known) return known

    const destination = this.context.createMediaStreamDestination()
    const output: Output = { destination, nextStart: 0 }
    this.outputs.set(key, output)

    const track = destination.stream.getAudioTracks()[0]
    if (track) this.onStream?.(key, track)
    return output
  }
}
