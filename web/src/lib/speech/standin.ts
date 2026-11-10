// Engines that answer without listening or speaking: a numbered
// transcript, "[lang] …" translations and a tone for a voice, exactly
// what the speech service's stand-ins answer (SPEECH_ENGINES=fake). They
// run the real capture, voice detection, room mode and caption relay, so
// a test sees the whole pipeline without a model or a GPU.

import { asError } from '../errors.ts'
import type { AsrEngine, Engines, MtEngine, Prepared, Segmenter, SegmenterEvents, Sentence, TtsEngine, Voiced } from './engines.ts'
import { loudness } from './energy.ts'
import { RATE, Segmentation } from './vad.ts'
import type { VoiceChoice } from '../translate/types.ts'

const TONE_SECONDS = 0.4
const TONE_HZ = 440
const TONE_LEVEL = 0.2

export function standInTranscript(lang: string, count: number): string {
  return `${lang} utterance ${count}`
}

export function standInTranslation(target: string, text: string): string {
  return `[${target}] ${text}`
}

export function standInTone(): Voiced {
  const pcm = new Float32Array(Math.round(TONE_SECONDS * RATE))
  for (let i = 0; i < pcm.length; i++) pcm[i] = TONE_LEVEL * Math.sin((2 * Math.PI * TONE_HZ * i) / RATE)
  return { pcm, rate: RATE }
}

export class StandInAsr implements AsrEngine {
  private count = 0

  async transcribe(_audio: Int16Array, lang: string): Promise<string> {
    this.count += 1
    return standInTranscript(lang, this.count)
  }
}

export class StandInMt implements MtEngine {
  async translate(sentence: Sentence): Promise<string> {
    return standInTranslation(sentence.target, sentence.text)
  }
}

export class StandInTts implements TtsEngine {
  async speak(_text: string, _lang: string, _voice: VoiceChoice): Promise<Voiced> {
    return standInTone()
  }
}

export class StandInSegmenter implements Segmenter {
  private readonly segmentation = new Segmentation()
  private readonly events: SegmenterEvents
  private pending: Promise<void> = Promise.resolve()

  constructor(events: SegmenterEvents) {
    this.events = events
  }

  push(pcm: Int16Array): void {
    this.pending = this.pending
      .then(async () => {
        for (const segment of await this.segmentation.push(pcm, loudness)) this.events.onSegment(segment)
      })
      .catch((err: unknown) => this.events.onError(asError(err)))
  }

  flush(): void {
    this.pending = this.pending.then(() => {
      const segment = this.segmentation.flush()
      if (segment) this.events.onSegment(segment)
    })
  }

  reset(): void {
    this.pending = this.pending.then(() => this.segmentation.reset())
  }

  close(): void {
    this.reset()
  }
}

export class StandInEngines implements Engines {
  readonly requiresWebGpu = false

  private readonly asrEngine = new StandInAsr()
  private readonly mtEngine = new StandInMt()
  private readonly ttsEngine = new StandInTts()

  async prepare(): Promise<Prepared> {
    return { transcribes: true, translates: 'plain', problems: [] }
  }

  async segmenter(events: SegmenterEvents): Promise<Segmenter> {
    return new StandInSegmenter(events)
  }

  async asr(_lang: string): Promise<AsrEngine> {
    return this.asrEngine
  }

  async stepDown(_lang: string): Promise<string | null> {
    return null
  }

  async mt(_source: string, _target: string): Promise<MtEngine> {
    return this.mtEngine
  }

  async tts(_lang: string): Promise<TtsEngine> {
    return this.ttsEngine
  }

  close(): void {}
}
