// Engines that answer without listening or speaking: a numbered
// transcript, "[lang] …" translations and a tone for a voice, exactly
// what the speech service's stand-ins answer (SPEECH_ENGINES=fake). They
// run the real capture, voice detection, room mode and caption relay, so
// a test sees the whole pipeline without a model or a GPU.

import type { AsrEngine, Detector, Engines, MtEngine, TtsEngine, Voiced } from './engines.ts'
import { loudness } from './energy.ts'
import { RATE } from './vad.ts'
import type { VoiceChoice } from '../translate/types.ts'

const TONE_SECONDS = 0.4
const TONE_HZ = 440
const TONE_LEVEL = 0.2

/** How the stand-in answers, in the words the speech service uses. */
export function standInTranscript(lang: string, count: number): string {
  return `${lang} utterance ${count}`
}

export function standInTranslation(target: string, text: string): string {
  return `[${target}] ${text}`
}

/** The tone a stand-in voice is: what a translated voice sounds like in a test. */
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
  async translate(text: string, _source: string, target: string): Promise<string> {
    return standInTranslation(target, text)
  }
}

export class StandInTts implements TtsEngine {
  async speak(_text: string, _lang: string, _voice: VoiceChoice): Promise<Voiced> {
    return standInTone()
  }
}

/** Engines that answer without a model: one of each, shared. */
export class StandInEngines implements Engines {
  readonly requiresWebGpu = false

  private readonly asrEngine = new StandInAsr()
  private readonly mtEngine = new StandInMt()
  private readonly ttsEngine = new StandInTts()

  async detector(): Promise<Detector> {
    return { probability: async (frame) => loudness(frame), close: () => {} }
  }

  async asr(_lang: string): Promise<AsrEngine> {
    return this.asrEngine
  }

  async mt(_source: string, _target: string): Promise<MtEngine> {
    return this.mtEngine
  }

  async tts(_lang: string): Promise<TtsEngine> {
    return this.ttsEngine
  }

  close(): void {}
}
