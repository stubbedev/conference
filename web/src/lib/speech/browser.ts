// The engines as this member's browser runs them: four workers, one per
// purpose, each started the first time it is needed and kept for the rest
// of the call. Nothing here loads a model; that happens inside a worker,
// on its own thread, so the page keeps drawing while a telephone-sized
// model is read and a GPU session is built.
//
// Every call into a worker goes through one queue per worker, because the
// page asks the same engine for work from several places at once (an
// interim caption while a sentence is still being spoken, one translation
// per listener language) and a worker holds one session.
//
// A worker that fails says so in words a member can read, and those words
// become the error the page shows. There is no silent fall back to a
// stand-in voice or a stand-in sentence here: if the engines cannot run,
// the member is told why rather than shown something that is not a
// translation.

import type { AsrEngine, Detector, Engines, MtEngine, TtsEngine, Voiced } from '@/lib/speech/engines'
import type { SpeechModels } from '@/lib/speech/models'
import { Serial } from '@/lib/speech/serial'
import { WorkerRpc, type WorkerReply } from '@/lib/speech/worker'
import type { VoiceChoice } from '@/lib/translate/types'

/** The four things a worker can be asked to do. */
type Purpose = 'vad' | 'asr' | 'mt' | 'tts'

/** Where the web UI serves the voice detection model the build vendors. */
const VAD_BASE = '/vad/'

interface ProbabilityReply extends WorkerReply {
  probability: number
}

interface TextReply extends WorkerReply {
  text: string
}

interface SpokenReply extends WorkerReply {
  pcm: Float32Array
  rate: number
}

/** One worker and the one request it is running. */
class Channel {
  private readonly rpc: WorkerRpc
  private readonly queue = new Serial()

  constructor(worker: Worker) {
    this.rpc = new WorkerRpc(worker)
  }

  /**
   * Calls the worker once everything asked of it before has answered.
   * What the page sends is copied rather than handed over: a detection
   * frame is a window on audio the page still needs, and taking its
   * buffer would take that audio too.
   */
  call<T extends WorkerReply>(message: Record<string, unknown>): Promise<T> {
    return this.queue.run(() => this.rpc.call<T>(message))
  }

  close(): void {
    this.rpc.close()
  }
}

/** Starts the worker for purpose. The URL has to stay literal for the bundler. */
function start(purpose: Purpose): Worker {
  switch (purpose) {
    case 'vad':
      return new Worker(new URL('./vad.worker.ts', import.meta.url), { type: 'module' })
    case 'asr':
      return new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' })
    case 'mt':
      return new Worker(new URL('./mt.worker.ts', import.meta.url), { type: 'module' })
    case 'tts':
      return new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' })
  }
}

class BrowserEngines implements Engines {
  /**
   * Transcription needs a GPU: a whisper-sized model on the CPU cannot keep
   * up with a conversation, so the page says so before anyone speaks.
   */
  readonly requiresWebGpu = true

  private readonly models: SpeechModels
  private readonly channels = new Map<Purpose, Channel>()
  private readonly loading = new Map<Purpose, Promise<void>>()
  private detectorEngine: Promise<Detector> | null = null
  private asrEngine: AsrEngine | null = null
  private mtEngine: MtEngine | null = null
  private ttsEngine: TtsEngine | null = null

  constructor(models: SpeechModels) {
    this.models = models
  }

  async detector(): Promise<Detector> {
    this.detectorEngine ??= this.makeDetector()
    return this.detectorEngine
  }

  async asr(lang: string): Promise<AsrEngine> {
    await this.load('asr', {
      base: this.models.base,
      model: this.models.asr.model,
      dtype: this.models.asr.dtype,
      languages: this.models.asr.languages,
      lang,
    })

    this.asrEngine ??= {
      transcribe: async (audio, transcribeIn) => {
        const reply = await this.channel('asr').call<TextReply>({ type: 'transcribe', audio, lang: transcribeIn })
        return reply.text
      },
    }

    return this.asrEngine
  }

  async mt(_source: string, _target: string): Promise<MtEngine> {
    await this.load('mt', { base: this.models.base, model: this.models.mt.model, dtype: this.models.mt.dtype })

    this.mtEngine ??= {
      translate: async (text, source, target) => {
        const reply = await this.channel('mt').call<TextReply>({ type: 'translate', text, source, target })
        return reply.text
      },
    }

    return this.mtEngine
  }

  async tts(_lang: string): Promise<TtsEngine> {
    await this.load('tts', { base: this.models.base, voices: this.models.voices })

    this.ttsEngine ??= {
      speak: async (text, lang, voice) => this.speak(text, lang, voice),
    }

    return this.ttsEngine
  }

  close(): void {
    for (const purpose of [...this.channels.keys()]) this.closeChannel(purpose)
  }

  private async speak(text: string, lang: string, voice: VoiceChoice): Promise<Voiced> {
    const reply = await this.channel('tts').call<SpokenReply>({ type: 'speak', text, lang, voice })
    return { pcm: reply.pcm, rate: reply.rate }
  }

  private makeDetector(): Promise<Detector> {
    return this.load('vad', { base: VAD_BASE }).then(() => ({
      probability: async (frame) => {
        const reply = await this.channel('vad').call<ProbabilityReply>({ type: 'detect', frame })
        return reply.probability
      },
      close: () => {
        this.closeChannel('vad')
        this.detectorEngine = null
      },
    }))
  }

  private channel(purpose: Purpose): Channel {
    const known = this.channels.get(purpose)
    if (known) return known

    const channel = new Channel(start(purpose))
    this.channels.set(purpose, channel)
    return channel
  }

  /**
   * Loads what purpose needs, once. A load that fails is not remembered,
   * so the next call tries again and the member sees the new reason.
   */
  private load(purpose: Purpose, settings: Record<string, unknown>): Promise<void> {
    const known = this.loading.get(purpose)
    if (known) return known

    const pending = this.channel(purpose)
      .call<WorkerReply>({ ...settings, type: 'init' })
      .then(() => undefined)
      .catch((err: unknown) => {
        this.loading.delete(purpose)
        throw err
      })

    this.loading.set(purpose, pending)
    return pending
  }

  private closeChannel(purpose: Purpose): void {
    this.loading.delete(purpose)

    const channel = this.channels.get(purpose)
    if (!channel) return

    this.channels.delete(purpose)
    channel.close()
  }
}

/** Engines this member's browser runs itself, from the models the server serves. */
export function browserEngines(models: SpeechModels): Engines {
  return new BrowserEngines(models)
}
