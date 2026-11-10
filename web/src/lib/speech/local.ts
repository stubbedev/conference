// LocalTranslator: live translation with the engines in this member's
// own browser, so no audio or text leaves the machine.
//
//   own mic ──16 kHz PCM──► voice detection ─► transcription ─► sealed
//                                                              `caption`
//   another member's caption ─► translation ─► subtitles ─► voice
//
// What travels to the room is the text of what this member said, sealed
// with the room's chat key, exactly as the speech service's subtitles
// do. The languages are shared out among the members who translate best,
// each translating every sentence into the languages it was given and
// sharing the translations the same way, whichever language it speaks;
// the others show them, and translate a sentence themselves, as well as
// they can, when no translation arrives.

import { errorMessage } from '@/lib/errors'
import type { RoomClient } from '@/lib/sfu'
import { clauses } from '@/lib/speech/clauses'
import type { Engines, Segmenter } from '@/lib/speech/engines'
import { invented } from '@/lib/speech/invented'
import { nextRunAt, Pace } from '@/lib/speech/pace'
import { Recent } from '@/lib/speech/recent'
import { ResourceSlot } from '@/lib/speech/resource-slot'
import { Sentences, type Line } from '@/lib/speech/sentences'
import { MIN_UTTERANCE_SAMPLES, RATE, type Segment } from '@/lib/speech/vad'
import { WarmUps } from '@/lib/speech/warm-ups'
import { webgpuAvailable } from '@/lib/speech/webgpu'
import { MicCapture } from '@/lib/translate/capture'
import { PROVIDES_NOTHING, type CaptionLine, type LangPrefs, type RoomMessage, type TranslationLevel, type TranslationLine, type TranslatorStatus } from '@/lib/translate/types'
import type { Translator, TranslatorEvents } from '@/lib/translate/translator'
import { VoicePlayer } from '@/lib/translate/voice'

const QUEUED_UTTERANCES = 8
const HOLD_MS = 1_500
const TRANSLATION_WAIT_MS = 5_000
const EARLIER_SENTENCES = 8
const INTERIM_TRANSCRIPTION_GAP_MS = 1_000
const INTERIM_TRANSLATION_GAP_MS = 1_500
const REMEMBERED_TRANSLATIONS = 64

interface PendingInterim {
  caption: CaptionLine
  earlier: readonly string[]
  share: boolean
}

const NO_WEBGPU = 'This browser cannot transcribe: it needs WebGPU, and this server has no smaller model for the CPU.'

type Translation = Pick<CaptionLine, 'speaker' | 'segId' | 'sourceLang' | 'lang' | 'text' | 'final'>

interface Awaited {
  timer: ReturnType<typeof setTimeout> | null
  latest: CaptionLine
  earlier: readonly string[]
  arrived: boolean
  taken: boolean
}

export class LocalTranslator implements Translator {
  private client: RoomClient | null = null
  private unsubscribe: (() => void)[] = []
  private readonly capture: MicCapture
  private playbackContext: AudioContext | null = null
  private player: VoicePlayer | null = null
  private readonly engines: Engines
  private readonly segmenter = new ResourceSlot<Segmenter>()
  private readonly sentences = new Sentences()
  private readonly pace = new Pace()
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private transcribing: Promise<void> = Promise.resolve()
  private queued = 0
  private steppedDown = false
  private canTranscribe = true
  private translates: TranslationLevel = 'none'
  private captioning = false
  private readonly earlier = new Map<string, string[]>()
  private readonly awaited = new Map<string, Awaited>()
  private readonly interims = new Map<string, PendingInterim>()
  private readonly interimBusy = new Set<string>()
  private readonly interimTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly interimAfter = new Map<string, number>()
  private readonly translations = new Recent<string>(REMEMBERED_TRANSLATIONS)
  private interimTranscriptionAfter = 0
  private readonly spoken = new Set<string>()
  private readonly voiceless = new Set<string>()
  private readonly notes = new Set<string>()
  private warmUps: WarmUps | null = null
  private status: TranslatorStatus = { state: 'claiming', detail: '', sameLanguage: false, failedTranslations: 0, loading: null }
  private selfPrefs: LangPrefs
  private stopped = false
  private readonly events: TranslatorEvents

  constructor(selfPrefs: LangPrefs, events: TranslatorEvents, engines: Engines) {
    this.selfPrefs = selfPrefs
    this.events = events
    this.engines = engines
    this.capture = new MicCapture({
      onAudio: (pcm) => this.segmenter.current?.push(new Int16Array(pcm)),
      onStop: () => this.segmenter.current?.flush(),
    })
  }

  attach(client: RoomClient): void {
    this.detach()
    this.client = client
    this.announce()
    this.playbackContext ??= new AudioContext()
    this.player ??= new VoicePlayer(this.playbackContext, this.events.onStream)

    this.unsubscribe = [
      client.on('lang', () => {
        this.setSameLanguage()
        this.warmUpMembers()
      }),
      client.on('member-gone', ({ id }) => {
        this.player?.forget(id)
        this.earlier.delete(id)
        this.setSameLanguage()
      }),
    ]
    this.setSameLanguage()
    this.warmUpMembers()
  }

  start(localMic: MediaStreamTrack | null): void {
    if (!this.client) return
    void this.capture.start(localMic)
    if (this.playbackContext?.state === 'suspended') void this.playbackContext.resume()
    this.notes.clear()
    this.setStatus({ state: 'live', detail: '' })
    void this.prepare().catch((error: unknown) => this.fail(error))
  }

  setLocalMic(track: MediaStreamTrack | null): void {
    this.capture.setTrack(track)
  }

  setSelfPrefs(prefs: LangPrefs): void {
    this.selfPrefs = prefs
    this.setSameLanguage()
    this.warmUpMembers()
  }

  receive(message: RoomMessage): void {
    switch (message.k) {
      case 'caption':
        this.heard(message)
        return
      case 'translation':
        this.translated(message)
        return
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.client?.setProvides(PROVIDES_NOTHING)
    this.detach()
    for (const { timer } of this.awaited.values()) if (timer) clearTimeout(timer)
    this.awaited.clear()
    for (const timer of this.interimTimers.values()) clearTimeout(timer)
    this.interimTimers.clear()
    this.interims.clear()
    this.segmenter.close()
    await this.capture.close()
    await this.playbackContext?.close()
    this.playbackContext = null
    this.player = null
  }

  private detach(): void {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
    this.capture.stop()
    this.segmenter.current?.reset()
    this.expire()
    this.client = null
  }

  private async prepare(): Promise<void> {
    this.warmUps = null
    this.canTranscribe = true
    if (this.engines.requiresWebGpu && !(await webgpuAvailable())) {
      this.canTranscribe = false
      this.setStatus({ state: 'failed' })
      this.note(NO_WEBGPU)
    }

    const prepared = await this.engines.prepare(this.selfPrefs.lang, {
      onLoading: (parts) => this.setStatus({ loading: parts ? { state: 'loading', parts } : null }),
      onWarning: (warning) => this.note(warning),
    })
    if (this.stopped) return

    this.canTranscribe &&= prepared.transcribes
    this.captioning &&= this.canTranscribe
    this.translates = prepared.translates
    this.announce()

    if (prepared.problems.length > 0) {
      const detail = prepared.problems.join(' ')
      const loading = { state: 'failed', reason: detail, retry: () => this.retryPreparing() } as const
      this.setStatus(this.canTranscribe ? { loading } : { state: 'failed', loading })
      this.note(detail)
      console.warn('live translation:', detail)
    }

    if (!this.canTranscribe) return
    const segmenter = await this.segmenter.fill(() =>
      this.engines.segmenter({
        onSegment: (segment) => this.segmented(segment),
        onError: (error) => this.fail(error),
      }),
    )
    if (!segmenter) return

    this.captioning = true
    this.announce()
    this.warmUps = new WarmUps()
    this.warmUpMembers()
  }

  private warmUpMembers(): void {
    if (this.stopped || !this.warmUps || !this.client) return
    const sources = [...this.client.memberLangPrefs.values()].map((prefs) => prefs.lang)
    for (const { source, target } of this.warmUps.claim(sources, this.selfPrefs.lang)) void this.warmUp(source, target)
  }

  private async warmUp(source: string, target: string): Promise<void> {
    try {
      await this.engines.mt(source, target)
    } catch (error) {
      console.warn(`live translation could not prepare translating ${source} into ${target}:`, error)
      this.note(`Translating ${source} into ${target} could not be prepared, so those sentences may arrive untranslated: ${errorMessage(error)}`)
    }
  }

  private retryPreparing(): void {
    if (this.stopped) return
    this.notes.clear()
    this.setStatus({ state: 'live', detail: '', loading: null })
    void this.prepare().catch((error: unknown) => this.fail(error))
  }

  private announce(): void {
    this.client?.setProvides({ captions: this.captioning, translates: this.translates, voices: [] })
  }

  private setSameLanguage(): void {
    const languages = new Set([this.selfPrefs.lang, ...[...(this.client?.memberLangPrefs.values() ?? [])].map((prefs) => prefs.lang)])
    const sameLanguage = languages.size < 2
    if (sameLanguage !== this.status.sameLanguage) this.setStatus({ sameLanguage })
  }

  private setStatus(patch: Partial<TranslatorStatus>): void {
    this.status = { ...this.status, ...patch }
    this.events.onStatus?.(this.status)
  }

  private segmented(segment: Segment): void {
    if (this.stopped || !this.canTranscribe) return
    this.clearHold()

    if (segment.kind === 'partial') {
      if (this.queued > 0 || performance.now() < this.interimTranscriptionAfter) return
      this.queue(segment.audio, (text) => this.sentences.partial(text))
      return
    }

    if (segment.audio.length < MIN_UTTERANCE_SAMPLES || this.queued >= QUEUED_UTTERANCES) return
    this.queue(segment.audio, (text) => this.sentences.utterance(text), true)
  }

  private queue(audio: Int16Array, line: (text: string) => Line | null, utterance = false): void {
    this.queued += 1
    this.transcribing = this.transcribing
      .then(async () => {
        const started = performance.now()
        const text = await this.transcribe(audio, utterance)
        if (!utterance) {
          const finished = performance.now()
          this.interimTranscriptionAfter = nextRunAt(finished, finished - started, INTERIM_TRANSCRIPTION_GAP_MS)
        }
        if (text === null || this.stopped) return
        const said = line(text)
        if (said) this.publish(said)
        if (utterance && this.sentences.holding) this.holdTimer = setTimeout(() => this.expire(), HOLD_MS)
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.queued -= 1
      })
  }

  private async transcribe(audio: Int16Array, utterance: boolean): Promise<string | null> {
    const lang = this.selfPrefs.lang
    const seconds = audio.length / RATE
    const started = performance.now()

    const asr = await this.engines.asr(lang)
    const text = (await asr.transcribe(audio, lang)).trim()

    if (utterance) {
      this.pace.record(seconds, (performance.now() - started) / 1000)
      void this.keepUp()
    }

    if (!text || (await invented(text))) return null
    return text
  }

  private async keepUp(): Promise<void> {
    if (this.steppedDown || !(this.pace.behind || this.queued >= QUEUED_UTTERANCES / 2)) return
    this.steppedDown = true

    const model = await this.engines.stepDown(this.selfPrefs.lang)
    this.pace.reset()
    if (model) this.note(`This device could not transcribe in time, so it now uses the smaller ${model}.`)
  }

  private clearHold(): void {
    if (this.holdTimer === null) return
    clearTimeout(this.holdTimer)
    this.holdTimer = null
  }

  private expire(): void {
    this.clearHold()
    const line = this.sentences.expire()
    if (line) this.publish(line)
  }

  private publish(line: Line): void {
    const speaker = this.client?.memberId
    if (!speaker) return

    const lang = this.selfPrefs.lang
    const caption: CaptionLine = { k: 'caption', speaker, segId: `${speaker}-${line.seq}`, sourceLang: lang, lang, text: line.text, final: line.final }
    void this.client?.sendCaption(caption)
    this.events.onCaption(caption)
    this.translateForOthers(caption, this.remember(caption))
  }

  private remember(caption: CaptionLine): readonly string[] {
    const context = this.earlier.get(caption.speaker) ?? []
    if (caption.final) this.earlier.set(caption.speaker, [...context, caption.text].slice(-EARLIER_SENTENCES))
    return context
  }

  private translateForOthers(caption: CaptionLine, earlier: readonly string[]): void {
    const client = this.client
    if (!client) return
    for (const [target, translator] of client.translators) {
      if (target === caption.lang || target === this.selfPrefs.lang || translator !== client.memberId) continue
      this.translateFor(caption, target, earlier, true)
    }
  }

  private heard(caption: CaptionLine): void {
    const context = this.remember(caption)
    this.translateForOthers(caption, context)

    const mine = this.selfPrefs.lang
    if (caption.lang === mine) {
      this.events.onCaption(caption)
      return
    }

    const client = this.client
    if (!client) return

    const translator = client.translatorFor(mine)
    if (translator === client.memberId) {
      this.translateFor(caption, mine, context, true)
      return
    }
    if (translator === null) {
      this.translateOwn(caption, context)
      return
    }
    this.await(caption, context)
  }

  private await(caption: CaptionLine, earlier: readonly string[]): void {
    const { segId } = caption
    const awaited = this.awaited.get(segId) ?? { timer: null, latest: caption, earlier, arrived: false, taken: false }
    awaited.latest = caption
    awaited.earlier = earlier
    this.awaited.set(segId, awaited)

    if (awaited.taken) {
      this.translateOwn(caption, earlier)
      if (caption.final) this.awaited.delete(segId)
      return
    }

    if (awaited.timer !== null || (awaited.arrived && !caption.final)) return
    awaited.timer = setTimeout(() => {
      awaited.timer = null
      awaited.taken = true
      this.translateOwn(awaited.latest, awaited.earlier)
      if (awaited.latest.final) this.awaited.delete(segId)
    }, TRANSLATION_WAIT_MS)
  }

  private translateOwn(caption: CaptionLine, earlier: readonly string[]): void {
    const mine = this.selfPrefs.lang
    if (this.translates !== 'none') this.translateFor(caption, mine, earlier, false)
    else this.events.onCaption({ ...caption, lang: mine })
  }

  private translated(line: TranslationLine): void {
    if (line.lang !== this.selfPrefs.lang) return

    const awaited = this.awaited.get(line.segId)
    if (awaited?.timer) clearTimeout(awaited.timer)
    if (awaited) {
      awaited.timer = null
      awaited.arrived = true
      if (line.final) this.awaited.delete(line.segId)
    }
    this.show(line)
  }

  private translateFor(caption: CaptionLine, target: string, earlier: readonly string[], share: boolean): void {
    const key = `${caption.speaker}:${target}`
    if (caption.final) {
      this.interims.delete(key)
      void this.translate(caption, target, earlier, share).catch((error: unknown) => this.failed(error, caption, target))
      return
    }
    this.interims.set(key, { caption, earlier, share })
    this.pumpInterim(key, target)
  }

  private pumpInterim(key: string, target: string): void {
    if (this.stopped || this.interimBusy.has(key) || this.interimTimers.has(key)) return
    const wait = (this.interimAfter.get(key) ?? 0) - performance.now()
    if (wait > 0) {
      this.interimTimers.set(key, setTimeout(() => {
        this.interimTimers.delete(key)
        this.pumpInterim(key, target)
      }, wait))
      return
    }
    const next = this.interims.get(key)
    if (!next) return
    this.interims.delete(key)
    this.interimBusy.add(key)
    const started = performance.now()
    void this.translate(next.caption, target, next.earlier, next.share)
      .catch((error: unknown) => this.failed(error, next.caption, target))
      .finally(() => {
        const finished = performance.now()
        this.interimAfter.set(key, nextRunAt(finished, finished - started, INTERIM_TRANSLATION_GAP_MS))
        this.interimBusy.delete(key)
        this.pumpInterim(key, target)
      })
  }

  private async translate(caption: CaptionLine, target: string, earlier: readonly string[], share: boolean): Promise<void> {
    const remembered = `${caption.lang}\n${target}\n${caption.text}`
    let text = this.translations.get(remembered)
    if (text === undefined) {
      const mt = await this.engines.mt(caption.lang, target)
      text = await mt.translate({ text: caption.text, source: caption.lang, target, earlier })
      this.translations.set(remembered, text)
    }
    if (this.stopped) return

    const line: Translation = { speaker: caption.speaker, segId: caption.segId, sourceLang: caption.lang, lang: target, text, final: caption.final }
    const self = this.client?.memberId
    if (share && self) void this.client?.sendCaption({ k: 'translation', by: self, ...line })
    if (target === this.selfPrefs.lang) this.show({ k: 'caption', ...line })
  }

  private show(line: RoomMessage): void {
    if (line.k === 'translation' && !line.final && this.spoken.has(line.segId)) return
    this.events.onCaption(line)
    if (line.final && this.selfPrefs.voice) void this.speak(line.speaker, line.segId, line.text)
  }

  private async speak(speaker: string, segId: string, text: string): Promise<void> {
    if (this.spoken.has(segId)) return
    this.spoken.add(segId)

    const prefs = this.selfPrefs
    try {
      const tts = await this.engines.tts(prefs.lang)
      const pending = clauses(text).map((clause) => tts.speak(clause, prefs.lang, prefs.voiceChoice))
      for (const voiced of pending) {
        const { pcm, rate } = await voiced
        if (this.stopped || !this.player) return
        this.player.play(speaker, pcm, rate)
      }
    } catch (error) {
      console.warn('live translation has no voice for', prefs.lang, error)
      if (this.voiceless.has(prefs.lang)) return
      this.voiceless.add(prefs.lang)
      this.note(`Translations are shown but not spoken: ${errorMessage(error)}`)
    }
  }

  private fail(error: unknown): void {
    if (this.stopped) return
    console.warn('live translation:', error)
    this.note(errorMessage(error))
  }

  private note(warning: string): void {
    if (this.stopped || this.notes.has(warning)) return
    this.notes.add(warning)
    this.setStatus({ detail: [...this.notes].join(' ') })
  }

  private failed(error: unknown, caption: CaptionLine, target: string): void {
    if (this.stopped) return
    if (target === this.selfPrefs.lang) this.events.onCaption({ ...caption, lang: target })
    this.setStatus({ failedTranslations: this.status.failedTranslations + 1 })
    console.warn('live translation:', error)
  }
}
