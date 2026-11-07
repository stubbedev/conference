// LocalTranslator: live translation with the engines in this member's
// own browser, so no audio or text leaves the machine.
//
//   own mic ──16 kHz PCM──► voice detection ─► transcription ─► sealed
//                                                              `caption`
//   another member's caption ─► translation ─► subtitles ─► voice
//
// What travels to the room is the text of what this member said, sealed
// with the room's chat key, exactly as the speech service's subtitles
// do. One member per language translates it for everyone who speaks that
// language and shares the translation the same way; the others fall back
// to translating it themselves when no translation arrives.

import type { RoomClient } from '@/lib/sfu'
import { clauses } from '@/lib/speech/clauses'
import { translatorFor, type Candidate } from '@/lib/speech/election'
import type { Engines, Segmenter } from '@/lib/speech/engines'
import { invented } from '@/lib/speech/invented'
import { Pace } from '@/lib/speech/pace'
import { Sentences, type Line } from '@/lib/speech/sentences'
import { MIN_UTTERANCE_SAMPLES, RATE, type Segment } from '@/lib/speech/vad'
import { webgpuAvailable } from '@/lib/speech/webgpu'
import { MicCapture } from '@/lib/translate/capture'
import type { CaptionLine, LangPrefs, RoomMessage, TranslationLine, TranslatorStatus } from '@/lib/translate/types'
import type { Translator, TranslatorEvents } from '@/lib/translate/translator'
import { VoicePlayer } from '@/lib/translate/voice'

const QUEUED_UTTERANCES = 8
const HOLD_MS = 1_500
const TRANSLATION_WAIT_MS = 5_000
const EARLIER_SENTENCES = 8

const NO_WEBGPU = 'This browser cannot transcribe: it needs WebGPU, and this server has no smaller model for the CPU.'

type Translation = Pick<CaptionLine, 'speaker' | 'segId' | 'sourceLang' | 'lang' | 'text' | 'final'>

export class LocalTranslator implements Translator {
  private client: RoomClient | null = null
  private unsubscribe: (() => void)[] = []
  private readonly capture: MicCapture
  private playbackContext: AudioContext | null = null
  private player: VoicePlayer | null = null
  private readonly engines: Engines
  private segmenter: Segmenter | null = null
  private readonly sentences = new Sentences()
  private readonly pace = new Pace()
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private transcribing: Promise<void> = Promise.resolve()
  private queued = 0
  private steppedDown = false
  private canTranscribe = true
  private translates = false
  private readonly earlier = new Map<string, string[]>()
  private readonly awaited = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly interims = new Map<string, CaptionLine>()
  private readonly interimBusy = new Set<string>()
  private readonly spoken = new Set<string>()
  private status: TranslatorStatus = { state: 'claiming', detail: '', sameLanguage: false, failedTranslations: 0, loading: null }
  private selfPrefs: LangPrefs
  private stopped = false
  private readonly events: TranslatorEvents

  constructor(selfPrefs: LangPrefs, events: TranslatorEvents, engines: Engines) {
    this.selfPrefs = selfPrefs
    this.events = events
    this.engines = engines
    this.capture = new MicCapture({
      onAudio: (pcm) => this.segmenter?.push(new Int16Array(pcm)),
      onStop: () => this.segmenter?.flush(),
    })
  }

  attach(client: RoomClient): void {
    this.detach()
    this.client = client
    client.setTranslates(this.translates)
    this.playbackContext ??= new AudioContext()
    this.player ??= new VoicePlayer(this.playbackContext, (speaker, track) => {
      this.events.onStream?.(speaker, this.selfPrefs.lang, track)
    })

    this.unsubscribe = [
      client.on('lang', () => this.setSameLanguage()),
      client.on('member-left', ({ id }) => {
        this.player?.forget(id)
        this.earlier.delete(id)
        this.setSameLanguage()
      }),
    ]
    this.setSameLanguage()
  }

  start(localMic: MediaStreamTrack | null): void {
    if (!this.client) return
    void this.capture.start(localMic)
    if (this.playbackContext?.state === 'suspended') void this.playbackContext.resume()
    this.setStatus({ state: 'live', detail: '' })
    void this.prepare().catch((error: unknown) => this.fail(error))
  }

  setLocalMic(track: MediaStreamTrack | null): void {
    this.capture.setTrack(track)
  }

  setSelfPrefs(prefs: LangPrefs): void {
    this.selfPrefs = prefs
    this.setSameLanguage()
  }

  receive(message: RoomMessage): void {
    switch (message.k) {
      case 'voice':
        this.events.onCaption(message)
        return
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
    this.detach()
    for (const timer of this.awaited.values()) clearTimeout(timer)
    this.awaited.clear()
    this.segmenter?.close()
    this.segmenter = null
    await this.capture.close()
    await this.playbackContext?.close()
    this.playbackContext = null
    this.player = null
    this.engines.close()
  }

  private detach(): void {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
    this.capture.stop()
    this.segmenter?.reset()
    this.expire()
    this.client = null
  }

  private async prepare(): Promise<void> {
    if (this.engines.requiresWebGpu && !(await webgpuAvailable())) {
      this.canTranscribe = false
      this.setStatus({ state: 'failed', detail: NO_WEBGPU })
    }

    const prepared = await this.engines.prepare(this.selfPrefs.lang, (loading) => this.setStatus({ loading }))
    if (this.stopped) return

    this.canTranscribe &&= prepared.transcribes
    this.translates = prepared.translates
    this.client?.setTranslates(this.translates)

    if (prepared.problems.length > 0) {
      const detail = prepared.problems.join(' ')
      this.setStatus(this.canTranscribe ? { detail } : { state: 'failed', detail })
      console.warn('live translation:', detail)
    }

    if (!this.canTranscribe) return
    this.segmenter = await this.engines.segmenter({
      onSegment: (segment) => this.segmented(segment),
      onError: (error) => this.fail(error),
    })

    for (const prefs of this.client?.memberLangPrefs.values() ?? []) {
      if (prefs.lang !== this.selfPrefs.lang) void this.engines.mt(prefs.lang, this.selfPrefs.lang).catch(() => {})
    }
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
      if (this.queued > 0) return
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
        const text = await this.transcribe(audio, utterance)
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
    if (model) this.setStatus({ detail: `This device could not transcribe in time, so it now uses the smaller ${model}.` })
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
  }

  private candidates(): Candidate[] {
    const client = this.client
    if (!client) return []
    const others = [...client.memberLangPrefs].map(([id, prefs]) => ({ id, lang: prefs.lang, translates: prefs.translates }))
    return [...others, { id: client.memberId, lang: this.selfPrefs.lang, translates: this.translates }]
  }

  private heard(caption: CaptionLine): void {
    const context = this.earlier.get(caption.speaker) ?? []
    if (caption.final) this.earlier.set(caption.speaker, [...context, caption.text].slice(-EARLIER_SENTENCES))

    if (caption.lang === this.selfPrefs.lang) {
      this.events.onCaption(caption)
      return
    }

    const translator = translatorFor(this.selfPrefs.lang, this.candidates())
    const self = this.client?.memberId
    if (translator === self) {
      this.translateFor(caption, context, true)
      return
    }
    if (!caption.final) return

    const segId = this.translatedId(caption.segId)
    if (translator === null) {
      this.translateFor(caption, context, false)
      return
    }

    this.awaited.set(
      segId,
      setTimeout(() => {
        this.awaited.delete(segId)
        this.translateFor(caption, context, false)
      }, TRANSLATION_WAIT_MS),
    )
  }

  private translated(line: TranslationLine): void {
    if (line.lang !== this.selfPrefs.lang || line.by !== translatorFor(this.selfPrefs.lang, this.candidates())) return

    const timer = this.awaited.get(line.segId)
    if (timer !== undefined) clearTimeout(timer)
    this.awaited.delete(line.segId)
    this.show(line, false)
  }

  private translatedId(segId: string): string {
    return `${segId}-${this.selfPrefs.lang}`
  }

  private translateFor(caption: CaptionLine, earlier: readonly string[], share: boolean): void {
    if (!caption.final) {
      if (this.interimBusy.has(caption.speaker)) {
        this.interims.set(caption.speaker, caption)
        return
      }
      this.interimBusy.add(caption.speaker)
    } else {
      this.interims.delete(caption.speaker)
    }

    void this.translate(caption, earlier, share)
      .catch((error: unknown) => this.failed(error, caption))
      .finally(() => {
        if (caption.final) return
        this.interimBusy.delete(caption.speaker)
        const next = this.interims.get(caption.speaker)
        this.interims.delete(caption.speaker)
        if (next) this.translateFor(next, earlier, share)
      })
  }

  private async translate(caption: CaptionLine, earlier: readonly string[], share: boolean): Promise<void> {
    const target = this.selfPrefs.lang
    const mt = await this.engines.mt(caption.lang, target)
    const text = await mt.translate({ text: caption.text, source: caption.lang, target, earlier })
    if (this.stopped) return

    const line: Translation = { speaker: caption.speaker, segId: this.translatedId(caption.segId), sourceLang: caption.lang, lang: target, text, final: caption.final }
    const self = this.client?.memberId
    if (share && self) void this.client?.sendCaption({ k: 'translation', by: self, ...line })
    this.show(line, true)
  }

  private show(line: Translation, own: boolean): void {
    if (!own && !line.final && this.spoken.has(line.segId)) return
    this.events.onCaption({ k: 'caption', ...line })
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
        const cue = this.player?.play(speaker, pcm, rate)
        if (!cue || this.stopped) return
        this.events.onCaption({ k: 'voice', speaker, segId, lang: prefs.lang, startInMs: cue.startInMs, durationMs: cue.durationMs })
      }
    } catch (error) {
      console.warn('live translation has no voice for', prefs.lang, error)
    }
  }

  private fail(error: unknown): void {
    if (this.stopped) return
    console.warn('live translation:', error)
    this.setStatus({ detail: error instanceof Error ? error.message : String(error) })
  }

  private failed(error: unknown, caption: CaptionLine): void {
    if (this.stopped) return
    this.events.onCaption(caption)
    this.setStatus({ failedTranslations: this.status.failedTranslations + 1 })
    console.warn('live translation:', error)
  }
}
