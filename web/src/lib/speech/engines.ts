import type { Loading, VoiceChoice } from '../translate/types.ts'
import type { Segment } from './vad.ts'

export interface Voiced {
  pcm: Float32Array
  rate: number
}

export interface AsrEngine {
  transcribe(audio: Int16Array, lang: string): Promise<string>
}

export interface Sentence {
  text: string
  source: string
  target: string
  earlier: readonly string[]
}

export interface MtEngine {
  translate(sentence: Sentence): Promise<string>
}

export interface TtsEngine {
  speak(text: string, lang: string, voice: VoiceChoice): Promise<Voiced>
}

export interface Segmenter {
  push(pcm: Int16Array): void
  flush(): void
  reset(): void
  close(): void
}

export interface SegmenterEvents {
  onSegment(segment: Segment): void
  onError(error: Error): void
}


export interface Prepared {
  transcribes: boolean
  translates: boolean
  problems: string[]
}

export interface Engines {
  readonly requiresWebGpu: boolean
  prepare(lang: string, onLoading: (loading: Loading | null) => void): Promise<Prepared>
  segmenter(events: SegmenterEvents): Promise<Segmenter>
  asr(lang: string): Promise<AsrEngine>
  stepDown(lang: string): Promise<string | null>
  mt(source: string, target: string): Promise<MtEngine>
  tts(lang: string): Promise<TtsEngine>
  close(): void
}
