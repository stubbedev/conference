// LocalTranslator: live translation with the engines in this member's
// own browser, so no audio or text leaves the machine.
//
//   own mic ──16 kHz PCM──► voice detection ─► transcription ─► sealed
//                                                              `caption`
//   another member's caption ─► translation ─► subtitles ─► voice
//
// What travels to the room is the text of what this member said, sealed
// with the room's chat key, exactly as the speech service's subtitles
// do: a listener translates it into its own language on its own machine,
// which is why a room of ten languages costs the speaker nothing.

import type { RoomClient } from '@/lib/sfu'
import type { Detector, Engines } from '@/lib/speech/engines'
import { Frames, MIN_UTTERANCE_SAMPLES, Utterances } from '@/lib/speech/vad'
import { webgpuAvailable } from '@/lib/speech/webgpu'
import { MicCapture } from '@/lib/translate/capture'
import type { CaptionLine, LangPrefs, RoomCaption, TranslatorStatus } from '@/lib/translate/types'
import type { Translator, TranslatorEvents } from '@/lib/translate/translator'
import { VoicePlayer } from '@/lib/translate/voice'

/** How many sentences wait their turn to be transcribed; older ones are dropped. */
const QUEUED_UTTERANCES = 8

const NO_WEBGPU = 'This browser cannot transcribe: it needs WebGPU.'

export class LocalTranslator implements Translator {
  private client: RoomClient | null = null
  private unsubscribe: (() => void)[] = []
  private capture: MicCapture
  private playbackContext: AudioContext | null = null
  private player: VoicePlayer | null = null
  private readonly engines: Engines
  private detector: Detector | null = null
  private readonly frames = new Frames()
  private readonly utterances = new Utterances()
  /** Detection runs in order, one chunk of audio after another. */
  private detecting: Promise<void> = Promise.resolve()
  /** Transcription runs in order too, so subtitles cannot overtake each other. */
  private transcribing: Promise<void> = Promise.resolve()
  private queued = 0
  private segs = 0
  /** Whether this browser can transcribe at all, which a phone without WebGPU cannot. */
  private canTranscribe = true
  /** The other members' announced languages: what this member translates into. */
  private otherLangs = new Map<string, string>()
  private status: TranslatorStatus = { state: 'claiming', detail: '', sameLanguage: false, failedTranslations: 0 }
  private selfPrefs: LangPrefs
  private stopped = false
  private readonly events: TranslatorEvents

  constructor(selfPrefs: LangPrefs, events: TranslatorEvents, engines: Engines) {
    this.selfPrefs = selfPrefs
    this.events = events
    this.engines = engines
    this.capture = new MicCapture({
      onAudio: (pcm) => this.addAudio(pcm),
      // A sentence cut short by the microphone closing is still a sentence.
      onStop: () => {
        const tail = this.utterances.flush()
        if (tail) this.enqueue(tail)
      },
    })
  }

  attach(client: RoomClient): void {
    this.detach()
    this.client = client
    this.playbackContext ??= new AudioContext()
    this.player ??= new VoicePlayer(this.playbackContext, (speaker, track) => {
      this.events.onStream?.(speaker, this.selfPrefs.lang, track)
    })

    for (const [memberId, prefs] of client.memberLangPrefs) this.otherLangs.set(memberId, prefs.lang)

    this.unsubscribe = [
      client.on('lang', ({ from, prefs }) => {
        this.otherLangs.set(from, prefs.lang)
        this.setSameLanguage()
      }),
      client.on('member-left', ({ id }) => {
        this.otherLangs.delete(id)
        this.player?.forget(id)
        this.setSameLanguage()
      }),
    ]
  }

  start(localMic: MediaStreamTrack | null): void {
    const client = this.client
    if (!client) return
    void this.capture.start(localMic)
    if (this.playbackContext && this.playbackContext.state === 'suspended') void this.playbackContext.resume()
    this.setStatus({ state: 'live', detail: '' })
    void this.checkWebGpu()
  }

  setLocalMic(track: MediaStreamTrack | null): void {
    this.capture.setTrack(track)
  }

  setSelfPrefs(prefs: LangPrefs): void {
    this.selfPrefs = prefs
    this.setSameLanguage()
  }

  /** Another member's caption, in whatever language they spoke it. */
  receive(caption: RoomCaption): void {
    if (caption.k !== 'caption' || caption.lang === this.selfPrefs.lang) {
      this.events.onCaption(caption)
      return
    }

    void this.translate(caption).catch((error: unknown) => this.failed(error, caption))
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.detach()
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
    this.frames.reset()
    this.utterances.flush()
    this.client = null
  }

  /** Says so before anyone speaks into a browser that cannot transcribe, and keeps the rest running. */
  private async checkWebGpu(): Promise<void> {
    if (!this.engines.requiresWebGpu || this.stopped) return

    const available = await webgpuAvailable()
    if (available || this.stopped) return

    // Translating what others say still works without a GPU; this member's
    // own speech is the part that cannot be recognised.
    this.canTranscribe = false
    this.capture.stop()
    this.setStatus({ state: 'failed', detail: NO_WEBGPU })
  }

  private setSameLanguage(): void {
    const languages = new Set([this.selfPrefs.lang, ...this.otherLangs.values()])
    const sameLanguage = languages.size < 2
    if (sameLanguage !== this.status.sameLanguage) this.setStatus({ sameLanguage })
  }

  private setStatus(patch: Partial<TranslatorStatus>): void {
    this.status = { ...this.status, ...patch }
    this.events.onStatus?.(this.status)
  }

  private addAudio(pcm: ArrayBuffer): void {
    if (this.stopped) return
    const samples = new Int16Array(pcm)
    this.detecting = this.detecting.then(() => this.segment(samples)).catch((error: unknown) => this.failed(error))
  }

  /** Cuts the audio into utterances, one detector call per frame. */
  private async segment(pcm: Int16Array): Promise<void> {
    const detector = this.detector ?? (this.detector = await this.engines.detector())

    for (const frame of this.frames.push(pcm)) {
      const utterance = this.utterances.detect(await detector.probability(frame), frame)
      if (utterance) this.enqueue(utterance)
    }
  }

  private enqueue(audio: Int16Array): void {
    if (!this.canTranscribe || audio.length < MIN_UTTERANCE_SAMPLES || this.queued >= QUEUED_UTTERANCES) return
    this.queued += 1
    this.transcribing = this.transcribing
      .then(() => this.transcribe(audio))
      .catch((error: unknown) => this.failed(error))
      .finally(() => {
        this.queued -= 1
      })
  }

  /** Subtitle of what this member just said, in the language they said it. */
  private async transcribe(audio: Int16Array): Promise<void> {
    const speaker = this.client?.memberId
    const lang = this.selfPrefs.lang
    if (!speaker || this.stopped) return

    const asr = await this.engines.asr(lang)
    const text = (await asr.transcribe(audio, lang)).trim()
    if (!text || this.stopped) return

    this.publish({
      k: 'caption',
      speaker,
      segId: `${speaker}-${this.segs++}`,
      sourceLang: lang,
      lang,
      text,
      final: true,
    })
  }

  /** Turns another member's sentence into this member's language. */
  private async translate(caption: CaptionLine): Promise<void> {
    const prefs = this.selfPrefs
    const mt = await this.engines.mt(caption.lang, prefs.lang)
    const text = await mt.translate(caption.text, caption.lang, prefs.lang)
    if (this.stopped) return

    const segId = `${caption.segId}-${prefs.lang}`
    this.events.onCaption({ ...caption, segId, lang: prefs.lang, text })

    if (prefs.voice) await this.speak(caption.speaker, segId, text)
  }

  /** Speaks a translated sentence here; a language without a voice still gets its subtitles. */
  private async speak(speaker: string, segId: string, text: string): Promise<void> {
    const prefs = this.selfPrefs

    try {
      const tts = await this.engines.tts(prefs.lang)
      const voiced = await tts.speak(text, prefs.lang, prefs.voiceChoice)
      const cue = this.player?.play(speaker, voiced.pcm, voiced.rate)
      if (!cue || this.stopped) return

      this.events.onCaption({
        k: 'voice',
        speaker,
        segId,
        lang: prefs.lang,
        startInMs: cue.startInMs,
        durationMs: cue.durationMs,
      })
    } catch (error) {
      console.warn('live translation has no voice for', prefs.lang, error)
    }
  }

  /** A sentence that could not be translated reaches this member as it was said. */
  private failed(error: unknown, caption?: CaptionLine): void {
    if (this.stopped) return
    if (caption) this.events.onCaption(caption)
    this.setStatus({ failedTranslations: this.status.failedTranslations + 1 })
    console.warn('live translation:', error)
  }

  private publish(caption: CaptionLine): void {
    void this.client?.sendCaption(caption)
    this.events.onCaption(caption)
  }
}
