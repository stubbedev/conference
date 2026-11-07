import type { AsrEngine, Engines, MtEngine, Prepared, Segmenter, SegmenterEvents, Sentence, TtsEngine } from '@/lib/speech/engines'
import { BuiltinTranslators } from '@/lib/speech/builtin'
import { asrExport, bytesFor, renderPrompt, type SpeechModels } from '@/lib/speech/models'
import { Serial } from '@/lib/speech/serial'
import { WorkerRpc, type WorkerEvent, type WorkerReply } from '@/lib/speech/worker'
import { languageName, type Language } from '@/lib/translate/languages'
import type { Loading, TranslationLevel, VoiceChoice } from '@/lib/translate/types'

type Purpose = 'vad' | 'asr' | 'mt' | 'tts'

const VAD_BASE = '/vad/'
const MODEL_CACHE = 'transformers-cache'
const MEGABYTE = 1e6
const LOADING_REPORT_MS = 250

interface TextReply extends WorkerReply {
  text: string
}

interface SpokenReply extends WorkerReply {
  pcm: Float32Array
  rate: number
}

interface LevelReply extends WorkerReply {
  level: TranslationLevel
}

interface SteppedReply extends WorkerReply {
  model: string | null
}

class Channel {
  private readonly rpc: WorkerRpc
  private readonly queue = new Serial()

  constructor(worker: Worker, onEvent: (event: WorkerEvent) => void) {
    this.rpc = new WorkerRpc(worker, onEvent)
  }

  call<T extends WorkerReply>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    return this.queue.run(() => this.rpc.call<T>(message, transfer))
  }

  post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
    this.rpc.post(message, transfer)
  }

  close(): void {
    this.rpc.close()
  }
}

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

function megabytes(bytes: number): string {
  return `${Math.round(bytes / MEGABYTE)} MB`
}

function settle<T>(pending: Promise<T>): Promise<PromiseSettledResult<T>> {
  return pending.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  )
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

class BrowserEngines implements Engines {
  readonly requiresWebGpu: boolean

  private readonly models: SpeechModels
  private readonly languages: readonly Language[]
  private readonly channels = new Map<Purpose, Channel>()
  private readonly loading = new Map<Purpose, Promise<WorkerReply>>()
  private readonly files = new Map<string, Loading>()
  private readonly expected = new Set<string>()
  private loadingReport: ReturnType<typeof setTimeout> | null = null
  private preparing = false
  private readonly builtin = new BuiltinTranslators()
  private onLoading: (loading: Loading | null) => void = () => {}
  private segments: SegmenterEvents | null = null

  constructor(models: SpeechModels, languages: readonly Language[]) {
    this.models = models
    this.languages = languages
    this.requiresWebGpu = !models.asr.fallback
  }

  async prepare(lang: string, onLoading: (loading: Loading | null) => void): Promise<Prepared> {
    this.onLoading = onLoading
    this.preparing = true
    const room = await this.storageProblem(lang).catch((err: unknown) => {
      this.preparing = false
      throw err
    })
    if (room) {
      this.preparing = false
      return { transcribes: false, translates: 'none', problems: [room] }
    }

    const [vad, asr, mt, tts] = await Promise.all([
      settle(this.load('vad', { base: VAD_BASE })),
      settle(this.load('asr', { base: this.models.base, asr: this.models.asr, lang })),
      settle(this.load('mt', { base: this.models.base, mt: this.models.mt })),
      settle(this.models.voices[lang] ? this.load('tts', { base: this.models.base, voices: this.models.voices, lang }) : Promise.resolve(null)),
    ])
    this.preparing = false
    this.publishLoading()

    const problems = [vad, asr, mt, tts].flatMap((result) => (result.status === 'rejected' ? [reason(result.reason)] : []))
    return {
      transcribes: vad.status === 'fulfilled' && asr.status === 'fulfilled',
      translates: mt.status === 'fulfilled' ? (mt.value as LevelReply).level : 'none',
      problems,
    }
  }

  async segmenter(events: SegmenterEvents): Promise<Segmenter> {
    this.segments = events
    await this.load('vad', { base: VAD_BASE })
    const channel = this.channel('vad')

    return {
      push: (pcm) => channel.post({ type: 'audio', pcm }, [pcm.buffer]),
      flush: () => channel.post({ type: 'flush' }),
      reset: () => channel.post({ type: 'reset' }),
      close: () => {
        this.segments = null
        this.closeChannel('vad')
      },
    }
  }

  async asr(lang: string): Promise<AsrEngine> {
    await this.load('asr', { base: this.models.base, asr: this.models.asr, lang })
    return {
      transcribe: async (audio, transcribeIn) => {
        const reply = await this.channel('asr').call<TextReply>({ type: 'transcribe', audio, lang: transcribeIn }, [audio.buffer])
        return reply.text
      },
    }
  }

  async stepDown(lang: string): Promise<string | null> {
    if (!asrExport(this.models.asr, 'fallback', lang)) return null
    const reply = await this.channel('asr').call<SteppedReply>({ type: 'step-down', lang })
    return reply.model
  }

  async mt(source: string, target: string): Promise<MtEngine> {
    const builtin = this.models.mt.builtin ? await this.builtin.for(source, target) : null
    if (builtin) return { translate: (sentence) => builtin.translate(sentence.text) }

    await this.load('mt', { base: this.models.base, mt: this.models.mt })
    return { translate: (sentence) => this.translate(sentence) }
  }

  async tts(lang: string): Promise<TtsEngine> {
    await this.load('tts', { base: this.models.base, voices: this.models.voices, lang })
    return { speak: (text, speakIn, voice) => this.speak(text, speakIn, voice) }
  }

  close(): void {
    for (const purpose of [...this.channels.keys()]) this.closeChannel(purpose)
  }

  private async translate(sentence: Sentence): Promise<string> {
    const reply = await this.channel('mt').call<TextReply>({
      type: 'translate',
      text: sentence.text,
      source: sentence.source,
      target: sentence.target,
      system: this.system(sentence),
    })
    return reply.text
  }

  private system(sentence: Sentence): string {
    const prompt = this.models.prompt
    if (!prompt) return ''
    const language = (code: string): Language => ({ code, name: languageName(this.languages, code) })
    return renderPrompt(prompt, language(sentence.source), language(sentence.target), sentence.earlier)
  }

  private async speak(text: string, lang: string, voice: VoiceChoice) {
    const reply = await this.channel('tts').call<SpokenReply>({ type: 'speak', text, lang, voice })
    return { pcm: reply.pcm, rate: reply.rate }
  }

  private async storageProblem(lang: string): Promise<string | null> {
    const storage = navigator.storage
    if (!storage?.estimate) return null

    await storage.persist?.().catch(() => false)
    const { quota, usage } = await storage.estimate()
    if (quota === undefined || usage === undefined) return null

    const needed = bytesFor(this.models, lang)
    if (needed <= quota - usage || (await this.cached(lang))) return null

    return `Live translation needs ${megabytes(needed)} of storage for its models, and this browser has ${megabytes(Math.max(quota - usage, 0))} left.`
  }

  private async cached(lang: string): Promise<boolean> {
    const asr = asrExport(this.models.asr, 'primary', lang)
    if (!asr || typeof caches === 'undefined') return false
    const cache = await caches.open(MODEL_CACHE)
    return Boolean(await cache.match(new URL(`${this.models.base}${asr.model}/config.json`, location.href).href))
  }

  private event(event: WorkerEvent): void {
    switch (event.event) {
      case 'expect':
        this.expected.add(String(event.key))
        this.reportLoading()
        return
      case 'loading':
        this.files.set(String(event.file), { loaded: Number(event.loaded), total: Number(event.total) })
        this.reportLoading()
        return
      case 'segment':
        this.segments?.onSegment({ kind: event.kind === 'partial' ? 'partial' : 'utterance', audio: event.audio as Int16Array })
        return
      case 'error':
        this.segments?.onError(new Error(String(event.message)))
        return
    }
  }

  private reportLoading(): void {
    this.loadingReport ??= setTimeout(() => {
      this.loadingReport = null
      this.publishLoading()
    }, LOADING_REPORT_MS)
  }

  private publishLoading(): void {
    const downloading = [...this.files.values()].some((file) => file.loaded < file.total)
    if (this.preparing || downloading) {
      this.onLoading(this.total())
      return
    }

    if (this.loadingReport) clearTimeout(this.loadingReport)
    this.loadingReport = null
    this.files.clear()
    this.expected.clear()
    this.onLoading(null)
  }

  private total(): Loading {
    let loaded = 0
    let started = 0
    for (const file of this.files.values()) {
      loaded += file.loaded
      started += file.total
    }
    let expected = 0
    for (const key of this.expected) expected += this.models.sizes[key] ?? 0
    return { loaded, total: Math.max(started, expected) }
  }

  private channel(purpose: Purpose): Channel {
    const known = this.channels.get(purpose)
    if (known) return known

    const channel = new Channel(start(purpose), (event) => this.event(event))
    this.channels.set(purpose, channel)
    return channel
  }

  private load(purpose: Purpose, settings: Record<string, unknown>): Promise<WorkerReply> {
    const known = this.loading.get(purpose)
    if (known) return known

    const pending = this.channel(purpose)
      .call<WorkerReply>({ ...settings, type: 'init' })
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

let shared: { key: string; engines: BrowserEngines } | null = null

export function browserEngines(models: SpeechModels, languages: readonly Language[]): Engines {
  const key = JSON.stringify([models, languages])
  if (shared?.key === key) return shared.engines

  shared?.engines.close()
  shared = { key, engines: new BrowserEngines(models, languages) }
  return shared.engines
}
