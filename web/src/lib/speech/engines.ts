// The three engines live translation needs, each of which runs in the
// member's own browser when this server does not run it for them:
// transcription of what this member says, translation into a listener's
// language, and a voice for it.

import type { VoiceChoice } from '../translate/types.ts'

/** Audio the engines hand back: what a buffer needs to play it. */
export interface Voiced {
  pcm: Float32Array
  rate: number
}

export interface AsrEngine {
  /** Transcribes audio this member's microphone produced, in their language. */
  transcribe(audio: Int16Array, lang: string): Promise<string>
}

export interface MtEngine {
  /** Translates one sentence of source into target. */
  translate(text: string, source: string, target: string): Promise<string>
}

export interface TtsEngine {
  /** Speaks one sentence of lang. */
  speak(text: string, lang: string, voice: VoiceChoice): Promise<Voiced>
}

/** Says how likely one frame of 16 kHz audio is speech. */
export interface Detector {
  probability(frame: Int16Array): Promise<number>
  close(): void
}

/** Engines as this member's browser runs them, made once and reused. */
export interface Engines {
  /** Whether transcription needs a WebGPU device, which a phone may not have. */
  readonly requiresWebGpu: boolean
  /** Detects speech in this member's own microphone audio. */
  detector(): Promise<Detector>
  /** Transcribes a speaker of lang, loading what it needs on first use. */
  asr(lang: string): Promise<AsrEngine>
  /** Translates between two languages. */
  mt(source: string, target: string): Promise<MtEngine>
  /** Speaks lang. */
  tts(lang: string): Promise<TtsEngine>
  /** Stops every engine and frees what it held. */
  close(): void
}
