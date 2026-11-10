import type { AsrEngine, Engines, MtEngine, Prepared, PrepareEvents, Segmenter, SegmenterEvents, Sentence, TtsEngine } from '@/lib/speech/engines'
import { BuiltinTranslators } from '@/lib/speech/builtin'
import { browserFetchDeps } from '@/lib/speech/fetching'
import { asrExport, bytesFor, exportKey, loadsUpFront, renderPrompt, voiceKey, type SpeechModels } from '@/lib/speech/models'
import { budgetFor, fingerprint, parseHistory, withUnusable, withQuiet, type GpuHistory } from '@/lib/speech/gpu-history'
import { GpuWatch } from '@/lib/speech/gpu-watch'
import { Progress } from '@/lib/speech/progress'
import { message } from '@/lib/speech/runtime'
import { Serial } from '@/lib/speech/serial'
import { fetchRuntime, type Runtime } from '@/lib/speech/wasm'
import { WorkerRpc, type WorkerEvent, type WorkerReply } from '@/lib/speech/worker'
import { Workers } from '@/lib/speech/workers'
import { readStored, writeStored } from '@/lib/storage'
import { languageName, type Language } from '@/lib/translate/languages'
import type { LoadingPart, TranslationLevel, VoiceChoice } from '@/lib/translate/types'

const PURPOSES = ['vad', 'asr', 'mt', 'tts'] as const
type Purpose = (typeof PURPOSES)[number]

const PARTS: Record<Purpose, LoadingPart> = {
  vad: 'transcription',
  asr: 'transcription',
  mt: 'translation',
  tts: 'voice',
}

const VAD_BASE = '/vad/'
const MODEL_CACHE = 'transformers-cache'
const MEGABYTE = 1e6
const LOADING_REPORT_MS = 250
const GPU_HISTORY_KEY = 'speech-gpu-history'

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

class BrowserEngines implements Engines {
  readonly requiresWebGpu: boolean

  private readonly models: SpeechModels
  private readonly languages: readonly Language[]
  private readonly workers = new Workers<Purpose, Channel>((purpose) => new Channel(start(purpose), (event) => this.event(purpose, event)))
  private readonly progress = new Progress()
  private readonly noGpu = new Set<Purpose>()
  private readonly gpuRefused = new Set<Purpose>()
  private readonly watches = new Map<Purpose, GpuWatch>()
  private gpuHistory: GpuHistory<Purpose>
  private runtime: Promise<Runtime> | null = null
  private loadingReport: ReturnType<typeof setTimeout> | null = null
  private readonly builtin = new BuiltinTranslators((warning) => this.warn(warning))
  private events: PrepareEvents | null = null
  private segments: SegmenterEvents | null = null

  constructor(models: SpeechModels, languages: readonly Language[]) {
    this.models = models
    this.languages = languages
    this.requiresWebGpu = !models.asr.fallback
    this.gpuHistory = parseHistory(readStored(GPU_HISTORY_KEY), `${navigator.userAgent}\n${fingerprint(JSON.stringify(models))}`, PURPOSES)
    for (const purpose of this.gpuHistory.unusable) this.noGpu.add(purpose)
  }

  async prepare(lang: string, events: PrepareEvents): Promise<Prepared> {
    this.events = events
    for (const purpose of this.gpuHistory.unusable) {
      this.warn(`The GPU failed or stopped responding with the ${PARTS[purpose]} models on an earlier visit, so they run on the CPU until this browser is updated.`)
    }
    this.builtin.startPreparation()
    const room = await this.storageProblem(lang)
    if (room) return { transcribes: false, translates: 'none', problems: [room] }

    const [vad, asr, mt, tts] = await Promise.all([
      settle(this.loadVad()),
      settle(this.loadAsr(lang)),
      settle(this.loadMt()),
      settle(this.models.voices[lang] ? this.loadTts(lang) : Promise.resolve(null)),
    ])

    const problems = new Set([vad, asr, mt, tts].flatMap((result) => (result.status === 'rejected' ? [message(result.reason)] : [])))
    return {
      transcribes: vad.status === 'fulfilled' && asr.status === 'fulfilled',
      translates: mt.status === 'fulfilled' ? (mt.value as LevelReply).level : 'none',
      problems: [...problems],
    }
  }

  async segmenter(events: SegmenterEvents): Promise<Segmenter> {
    this.segments = events
    await this.loadVad()
    const channel = this.workers.port('vad')

    return {
      push: (pcm) => channel.post({ type: 'audio', pcm }, [pcm.buffer]),
      flush: () => channel.post({ type: 'flush' }),
      reset: () => channel.post({ type: 'reset' }),
      close: () => {
        if (this.segments !== events) return
        this.segments = null
        this.workers.close('vad')
      },
    }
  }

  async asr(lang: string): Promise<AsrEngine> {
    await this.loadAsr(lang)
    return {
      transcribe: async (audio, transcribeIn) => {
        await this.loadAsr(lang)
        const reply = await this.workers.port('asr').call<TextReply>({ type: 'transcribe', audio, lang: transcribeIn }, [audio.buffer])
        return reply.text
      },
    }
  }

  async stepDown(lang: string): Promise<string | null> {
    if (!asrExport(this.models.asr, 'fallback', lang)) return null
    const reply = await this.onWorker(
      'asr',
      () => this.loadAsr(lang),
      () => this.workers.port('asr').call<SteppedReply>({ type: 'step-down', lang }),
    )
    return reply.model
  }

  async mt(source: string, target: string): Promise<MtEngine> {
    const builtin = this.models.mt.builtin ? await this.builtin.for(source, target) : null
    if (builtin) return { translate: (sentence) => builtin.translate(sentence.text) }

    await this.onWorker(
      'mt',
      () => this.loadMt(),
      () => this.workers.port('mt').call<WorkerReply>({ type: 'warm-up', source, target }),
    )
    return { translate: (sentence) => this.translate(sentence) }
  }

  async tts(lang: string): Promise<TtsEngine> {
    await this.loadTts(lang)
    return { speak: (text, speakIn, voice) => this.speak(text, speakIn, voice) }
  }

  close(): void {
    for (const watch of this.watches.values()) watch.stop()
    this.workers.closeAll()
  }

  private onWorker<T>(purpose: Purpose, load: () => Promise<WorkerReply>, call: () => Promise<T>): Promise<T> {
    return this.cpuAfterGpu(purpose, async () => {
      await load()
      return call()
    })
  }

  private async cpuAfterGpu<T>(purpose: Purpose, attempt: () => Promise<T>): Promise<T> {
    if (purpose === 'vad' || this.noGpu.has(purpose)) return attempt()
    try {
      return await attempt()
    } catch (err) {
      const switched = this.noGpu.has(purpose)
      if (!switched && !this.gpuRefused.has(purpose)) throw err
      if (!switched) {
        this.noGpu.add(purpose)
        this.workers.close(purpose)
      }
      const done = await attempt()
      if (!switched) {
        this.remember(withUnusable(this.gpuHistory, purpose))
        this.warn(`The GPU failed with the ${PARTS[purpose]} models (${message(err)}), so they run on the CPU until this browser is updated.`)
      }
      return done
    }
  }

  private watch(purpose: Purpose): GpuWatch {
    const known = this.watches.get(purpose)
    if (known) return known

    const watch = new GpuWatch(() => this.gpuStalled(purpose))
    this.watches.set(purpose, watch)
    return watch
  }

  private gpuStalled(purpose: Purpose): void {
    const budget = budgetFor(this.gpuHistory, purpose)
    this.noGpu.add(purpose)
    this.remember(withUnusable(this.gpuHistory, purpose))
    this.warn(`The GPU stopped responding for ${Math.round(budget / 1000)} s while loading the ${PARTS[purpose]} models, so they run on the CPU until this browser is updated.`)
    this.workers.close(purpose)
  }

  private gpuSettled(purpose: Purpose): void {
    const quiet = this.watch(purpose).settled()
    if (quiet !== null) this.remember(withQuiet(this.gpuHistory, purpose, quiet))
  }

  private remember(history: GpuHistory<Purpose>): void {
    if (history === this.gpuHistory) return
    this.gpuHistory = history
    writeStored(GPU_HISTORY_KEY, history)
  }

  private async translate(sentence: Sentence): Promise<string> {
    const reply = await this.onWorker(
      'mt',
      () => this.loadMt(),
      () =>
        this.workers.port('mt').call<TextReply>({
          type: 'translate',
          text: sentence.text,
          source: sentence.source,
          target: sentence.target,
          system: this.system(sentence),
        }),
    )
    return reply.text
  }

  private system(sentence: Sentence): string {
    const prompt = this.models.prompt
    if (!prompt) return ''
    const language = (code: string): Language => ({ code, name: languageName(this.languages, code) })
    return renderPrompt(prompt, language(sentence.source), language(sentence.target), sentence.earlier)
  }

  private async speak(text: string, lang: string, voice: VoiceChoice) {
    const reply = await this.onWorker(
      'tts',
      () => this.loadTts(lang),
      () => this.workers.port('tts').call<SpokenReply>({ type: 'speak', text, lang, voice }),
    )
    return { pcm: reply.pcm, rate: reply.rate }
  }

  private async storageProblem(lang: string): Promise<string | null> {
    const storage = navigator.storage
    if (!storage?.estimate) return null

    void this.keepModels(storage)
    const { quota, usage } = await storage.estimate()
    if (quota === undefined || usage === undefined) return null

    const needed = bytesFor(this.models, lang)
    if (needed <= quota - usage || (await this.cached(lang))) return null

    return `Live translation needs ${megabytes(needed)} of storage for its models, and this browser has ${megabytes(Math.max(quota - usage, 0))} left.`
  }

  private async keepModels(storage: StorageManager): Promise<void> {
    try {
      await storage.persist?.()
    } catch (err) {
      this.warn(`This browser could not be asked to keep the speech models (${message(err)}), so it may delete them when it runs short of space and they would be downloaded again.`)
    }
  }

  private warn(warning: string): void {
    console.warn('live translation:', warning)
    this.events?.onWarning(warning)
  }

  private async cached(lang: string): Promise<boolean> {
    const asr = asrExport(this.models.asr, 'primary', lang)
    if (!asr || typeof caches === 'undefined') return false
    const cache = await caches.open(MODEL_CACHE)
    return Boolean(await cache.match(new URL(`${this.models.base}${asr.model}/config.json`, location.href).href))
  }

  private event(purpose: Purpose, event: WorkerEvent): void {
    this.watch(purpose).active()
    switch (event.event) {
      case 'gpu-started':
        this.watch(purpose).started(budgetFor(this.gpuHistory, purpose))
        return
      case 'gpu-settled':
        this.gpuSettled(purpose)
        return
      case 'gpu-refused':
        this.gpuRefused.add(purpose)
        return
      case 'expect':
        this.progress.expect(PARTS[purpose], this.models.sizes[String(event.key)] ?? 0)
        this.reportLoading()
        return
      case 'loading':
        this.progress.file(PARTS[purpose], String(event.file), Number(event.loaded), Number(event.total))
        this.reportLoading()
        return
      case 'retrying':
        this.retrying(PARTS[purpose], event)
        return
      case 'warning':
        this.warn(String(event.message))
        return
      case 'segment':
        this.segments?.onSegment({ kind: event.kind === 'partial' ? 'partial' : 'utterance', audio: event.audio as Int16Array })
        return
      case 'error':
        this.segments?.onError(new Error(String(event.message)))
        return
    }
  }

  private retrying(part: LoadingPart, retry: Record<string, unknown>): void {
    this.progress.retrying(part, { attempt: Number(retry.attempt), attempts: Number(retry.attempts), reason: String(retry.reason) })
    this.reportLoading()
  }

  private reportLoading(): void {
    this.loadingReport ??= setTimeout(() => {
      this.loadingReport = null
      this.publishLoading()
    }, LOADING_REPORT_MS)
  }

  private publishLoading(): void {
    const parts = this.progress.snapshot()
    if (parts) {
      this.events?.onLoading(parts)
      return
    }

    if (this.loadingReport) clearTimeout(this.loadingReport)
    this.loadingReport = null
    this.progress.clear()
    this.events?.onLoading(null)
  }

  private fetchRuntime(): Promise<Runtime> {
    this.runtime ??= this.tracked('runtime', () =>
      fetchRuntime(
        browserFetchDeps((retry) => this.retrying('runtime', { ...retry })),
        (file, loaded, total) => {
          this.progress.file('runtime', file, loaded, total)
          this.reportLoading()
        },
      ),
    ).catch((err: unknown) => {
      this.runtime = null
      throw err
    })
    return this.runtime
  }

  private async tracked<T>(part: LoadingPart, work: () => Promise<T>): Promise<T> {
    this.progress.begin(part)
    this.reportLoading()
    let succeeded = false
    try {
      const done = await work()
      succeeded = true
      return done
    } finally {
      this.progress.end(part, succeeded)
      this.publishLoading()
    }
  }

  private loadVad(): Promise<WorkerReply> {
    return this.load('vad', { base: VAD_BASE }, null)
  }

  private loadAsr(lang: string): Promise<WorkerReply> {
    const primary = asrExport(this.models.asr, 'primary', lang)
    return this.load('asr', { base: this.models.base, asr: this.models.asr, sizes: this.models.sizes, lang }, primary ? exportKey(primary) : null)
  }

  private loadMt(): Promise<WorkerReply> {
    return this.load('mt', { base: this.models.base, mt: this.models.mt, sizes: this.models.sizes }, loadsUpFront(this.models.mt) ? exportKey(this.models.mt) : null)
  }

  private loadTts(lang: string): Promise<WorkerReply> {
    const voice = this.models.voices[lang]
    return this.load('tts', { base: this.models.base, voices: this.models.voices, lang }, voice === undefined ? null : voiceKey(voice))
  }

  private load(purpose: Purpose, settings: Record<string, unknown>, expected: string | null): Promise<WorkerReply> {
    return this.cpuAfterGpu(purpose, () => this.init(purpose, settings, expected))
  }

  private init(purpose: Purpose, settings: Record<string, unknown>, expected: string | null): Promise<WorkerReply> {
    return this.workers.load(purpose, (channel) => {
      if (expected !== null) this.progress.expect(PARTS[purpose], this.models.sizes[expected] ?? 0)
      return this.tracked(PARTS[purpose], async () => {
        const runtime = await this.fetchRuntime()
        return channel.call<WorkerReply>({ ...settings, gpu: !this.noGpu.has(purpose), runtime, type: 'init' })
      })
    })
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
