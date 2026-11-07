// Cuts a speaker's audio into utterances the way the speech service's
// voice detection does (internal/speech/vad): an utterance starts at the
// first frame that is probably speech and ends after 400 ms of silence,
// after 160 ms once it has run for 3 s, or after MAX_UTTERANCE_SECONDS at
// the latest. The probabilities come from the Silero model, or from
// whatever stands in for it in a test.

/** The samples one detection covers, and what Silero takes. */
export const FRAME = 512

/** The rate the browsers capture and detect at. */
export const RATE = 16_000

/** The longest an utterance runs before it is cut. */
export const MAX_UTTERANCE_SECONDS = 12

/** The shortest audio the speech service transcribes at all. */
export const MIN_UTTERANCE_SAMPLES = RATE / 4

const START_PROBABILITY = 0.5
const END_PROBABILITY = 0.35
const PREROLL_FRAMES = 10
const SILENCE_SECONDS = 0.4
const LONG_SPEECH_SECONDS = 3
const SHORT_SILENCE_SECONDS = 0.16

const FRAMES_PER_SECOND = RATE / FRAME
const END_FRAMES = Math.floor(SILENCE_SECONDS * FRAMES_PER_SECOND)
const SHORT_END_FRAMES = Math.floor(SHORT_SILENCE_SECONDS * FRAMES_PER_SECOND)
const LONG_FRAMES = Math.floor(LONG_SPEECH_SECONDS * FRAMES_PER_SECOND)
const MAX_FRAMES = Math.floor(MAX_UTTERANCE_SECONDS * FRAMES_PER_SECOND)

function join(chunks: readonly Int16Array[], length: number): Int16Array {
  const audio = new Int16Array(length)
  let offset = 0
  for (const chunk of chunks) {
    audio.set(chunk, offset)
    offset += chunk.byteLength / Int16Array.BYTES_PER_ELEMENT
  }
  return audio
}

/** Collects audio into the whole frames the detection reads. */
export class Frames {
  private pending: Int16Array = new Int16Array(0)

  /** Adds audio and returns every whole frame in it. */
  push(pcm: Int16Array): Int16Array[] {
    const total = this.pending.length + pcm.length
    const whole = Math.floor(total / FRAME)
    if (whole === 0) {
      const kept = new Int16Array(total)
      kept.set(this.pending)
      kept.set(pcm, this.pending.length)
      this.pending = kept
      return []
    }

    const joined = new Int16Array(total)
    joined.set(this.pending)
    joined.set(pcm, this.pending.length)

    const frames: Int16Array[] = []
    for (let i = 0; i < whole; i++) frames.push(joined.subarray(i * FRAME, (i + 1) * FRAME))
    this.pending = joined.slice(whole * FRAME)
    return frames
  }

  /** Drops what is left of a partial frame, as the end of a stream does. */
  reset(): void {
    this.pending = new Int16Array(0)
  }
}

/** One speaker's utterances, from frame probabilities. */
export class Utterances {
  private preroll: Int16Array[] = []
  private speech: Int16Array[] = []
  private length = 0
  private silent = 0

  /** Whether an utterance has started and not yet ended. */
  get active(): boolean {
    return this.speech.length > 0
  }

  /** The length of the utterance so far, in samples. */
  get samples(): number {
    return this.length
  }

  /**
   * Adds one frame and the probability that it is speech, and returns the
   * utterance it ends, or null.
   */
  detect(probability: number, frame: Int16Array): Int16Array | null {
    if (!this.active) {
      this.preroll.push(frame)
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift()

      if (probability >= START_PROBABILITY) {
        this.speech = [...this.preroll]
        this.length = this.samplesOf(this.speech)
        this.silent = 0
      }
      return null
    }

    this.speech.push(frame)
    this.length += frame.length

    if (probability < END_PROBABILITY) this.silent++
    else this.silent = 0

    const frames = Math.floor(this.length / FRAME)
    const end = frames >= LONG_FRAMES ? SHORT_END_FRAMES : END_FRAMES

    if (this.silent >= end || frames >= MAX_FRAMES) return this.flush()
    return null
  }

  snapshot(): Int16Array {
    return join(this.speech, this.length)
  }

  /** Ends the current utterance and returns it, or null if there is none. */
  flush(): Int16Array | null {
    if (!this.active) return null

    const done = join(this.speech, this.length)
    this.speech = []
    this.preroll = []
    this.length = 0
    this.silent = 0
    return done
  }

  private samplesOf(chunks: readonly Int16Array[]): number {
    return chunks.reduce((total, chunk) => total + chunk.length, 0)
  }
}

export const INTERIM_SAMPLES = Math.round(RATE * 0.6)

export interface Segment {
  kind: 'partial' | 'utterance'
  audio: Int16Array
}

export type Probability = (frame: Int16Array) => Promise<number> | number

export class Segmentation {
  private readonly frames = new Frames()
  private readonly utterances = new Utterances()
  private reported = 0

  async push(pcm: Int16Array, probability: Probability): Promise<Segment[]> {
    const segments: Segment[] = []
    for (const frame of this.frames.push(pcm)) {
      const utterance = this.utterances.detect(await probability(frame), frame)
      if (utterance) {
        this.reported = 0
        segments.push({ kind: 'utterance', audio: utterance })
        continue
      }

      const samples = this.utterances.samples
      if (samples >= MIN_UTTERANCE_SAMPLES && samples - this.reported >= INTERIM_SAMPLES) {
        this.reported = samples
        segments.push({ kind: 'partial', audio: this.utterances.snapshot() })
      }
    }
    return segments
  }

  flush(): Segment | null {
    this.reported = 0
    const utterance = this.utterances.flush()
    return utterance ? { kind: 'utterance', audio: utterance } : null
  }

  reset(): void {
    this.frames.reset()
    this.utterances.flush()
    this.reported = 0
  }
}
