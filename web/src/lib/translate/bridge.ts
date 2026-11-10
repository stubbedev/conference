// ServerTranslator: one member's bridge to the speech service on the
// conference server. While a member has live translation switched on,
// every member's browser runs one, because only that browser holds its
// speaker's microphone before encryption:
//
//   own mic ──16 kHz PCM──► speech service (our own server)
//   subtitles ◄── JSON ── speech service ──► sealed `caption` messages
//   translated voice ◄── PCM ──► one E2EE audio track per other language
//
// The SFU only ever relays the sealed captions and encrypted tracks.
// Each speaker's voice stays its own track, which is also where a
// speaker's own voice comes in: their recording goes to the speech
// service, which makes the translated voice from it.

import { serverSocketURL, type RoomClient } from '@/lib/sfu'
import { MicCapture } from '@/lib/translate/capture'
import type { OwnVoiceSample } from '@/lib/translate/own-voice'
import type { CaptionLine, LangPrefs, RoomMessage, TranslatorStatus } from '@/lib/translate/types'
import type { Translator, TranslatorEvents } from '@/lib/translate/translator'
import { VoicePlayer } from '@/lib/translate/voice'

const HEADER_BYTES = 2
const MAX_REFUSED_CONNECTS = 3
const RECONNECT_DELAY_MS = 2_000
// How long start() waits for the token the server sends on its own before asking.
const TOKEN_GRACE_MS = 1_500
// A translated voice queued further behind than this is skipped (its
// subtitle still shows), so a voice engine that can't keep up doesn't
// build an ever growing delay. Far beyond what a talkative speaker
// queues with a normal voice engine.
const MAX_VOICE_LAG_S = 10
// A recorded voice sample goes out in frames well under the stream's message limit.
const SAMPLE_FRAME = 8_000

interface VoiceHeader {
  lang: string
  rate: number
}

function pack(header: object, pcm: ArrayBuffer): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const frame = new Uint8Array(HEADER_BYTES + json.length + pcm.byteLength)
  new DataView(frame.buffer).setUint16(0, json.length)
  frame.set(json, HEADER_BYTES)
  frame.set(new Uint8Array(pcm), HEADER_BYTES + json.length)
  return frame.buffer
}

function unpack(frame: ArrayBuffer): { header: VoiceHeader; pcm: Float32Array } {
  const size = new DataView(frame).getUint16(0)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(frame, HEADER_BYTES, size))) as VoiceHeader
  const samples = new Int16Array(frame.slice(HEADER_BYTES + size))
  const pcm = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) pcm[i] = samples[i] / 0x8000
  return { header, pcm }
}

export class ServerTranslator implements Translator {
  private client: RoomClient | null = null
  private unsubscribe: (() => void)[] = []
  private speech: WebSocket | null = null
  private capture: MicCapture
  private playbackContext: AudioContext | null = null
  private player: VoicePlayer | null = null
  /** The other members' announced languages, and whether they listen to a translated voice. */
  private others = new Map<string, { lang: string; voice: boolean }>()
  /** The speaker's own voice, recorded before the call, and whether this connection has it. */
  private ownSample: OwnVoiceSample | null = null
  private sampleSent = false
  private refusedConnects = 0
  private status: TranslatorStatus = {
    state: 'claiming',
    detail: '',
    sameLanguage: false,
    failedTranslations: 0,
    loading: null,
    ownVoice: 'off',
    droppedVoices: 0,
  }
  private selfPrefs: LangPrefs
  private stopped = false
  private readonly events: TranslatorEvents

  constructor(selfPrefs: LangPrefs, events: TranslatorEvents) {
    this.selfPrefs = selfPrefs
    this.events = events
    this.capture = new MicCapture({
      onAudio: (pcm) => this.sendAudio(pcm),
      onStop: () => this.endSpeech(),
    })
  }

  /**
   * Follows a client's events. On a reconnect, call this before the
   * client connects so no early token or language message is missed.
   */
  attach(client: RoomClient): void {
    this.detach()
    this.client = client
    this.playbackContext ??= new AudioContext()
    this.player ??= new VoicePlayer(this.playbackContext, this.publishTrack)
    // Until a segment arrives there is no track to publish.
    if (this.playbackContext.state === 'suspended') void this.playbackContext.resume()

    // Members announce their language once, on joining, so the ones that
    // arrived before this bridge started come from the client's record.
    for (const [memberId, prefs] of client.memberLangPrefs) {
      this.others.set(memberId, { lang: prefs.lang, voice: prefs.voice })
    }

    this.unsubscribe = [
      client.on('translate-token', ({ token }) => {
        this.setStatus({ state: 'connecting', detail: '' })
        this.openSpeech(token)
      }),
      client.on('lang', ({ from, prefs }) => {
        this.others.set(from, { lang: prefs.lang, voice: prefs.voice })
        this.sendTargets()
      }),
      // A recording mixes in the recorder's language, voice switch or not.
      client.on('recording', () => this.sendTargets()),
      client.on('member-left', ({ id }) => {
        this.others.delete(id)
        this.sendTargets()
      }),
    ]
  }

  /**
   * Starts translating this member's speech on the attached, connected
   * client. The first time, call it from a user gesture where possible,
   * so the audio contexts may start.
   */
  start(localMic: MediaStreamTrack | null): void {
    const client = this.client
    if (!client) return
    void this.capture.start(localMic)
    this.setStatus({ state: 'claiming', detail: '' })
    // The server sends a token when translation turns on, but a joiner's
    // may have come before its bridge existed: ask if none arrives.
    setTimeout(() => {
      if (!this.stopped && this.client === client && !this.speech) client.requestSpeechToken()
    }, TOKEN_GRACE_MS)
  }

  setLocalMic(track: MediaStreamTrack | null): void {
    this.capture.setTrack(track)
  }

  setSelfPrefs(prefs: LangPrefs): void {
    const droppedOwn = this.selfPrefs.voiceChoice === 'own' && prefs.voiceChoice !== 'own'
    this.selfPrefs = prefs
    if (droppedOwn) this.forgetVoice()
    this.sendTargets()
    this.sendSample()
  }

  /** The recorded own voice, sent to the speech service while the speaker has chosen it. */
  setOwnVoiceSample(sample: OwnVoiceSample | null): void {
    if (sample === this.ownSample) return
    const deleted = this.ownSample !== null && sample === null
    this.ownSample = sample
    this.sampleSent = false
    if (deleted) this.forgetVoice()
    this.sendSample()
  }

  // The speech service drops the speaker's recorded voice at once.
  private forgetVoice(): void {
    this.sampleSent = false
    this.setStatus({ ownVoice: 'off' })
    const speaker = this.client?.memberId
    if (!speaker || this.speech?.readyState !== WebSocket.OPEN) return
    this.speech.send(JSON.stringify({ type: 'forget-voice', speaker }))
  }

  /** The speech service already translated what it relays: nothing to do. */
  receive(caption: RoomMessage): void {
    if (caption.k === 'caption') this.events.onCaption(caption)
  }

  /** Stops translating this member's speech and removes its voice tracks. */
  async stop(): Promise<void> {
    this.stopped = true
    const client = this.client
    this.detach()
    await client?.removeTranslationTracks()
    await this.capture.close()
    await this.playbackContext?.close()
    this.playbackContext = null
    this.player = null
  }

  private detach(): void {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
    this.speech?.close()
    this.speech = null
    this.capture.stop()
    // The tracks belonged to the old connection; the next client publishes afresh.
    this.player = this.playbackContext ? new VoicePlayer(this.playbackContext, this.publishTrack) : null
    this.client = null
  }

  private readonly publishTrack = (lang: string, track: MediaStreamTrack): void => {
    void this.client?.addTranslationTrack(lang, track)
  }

  private openSpeech(token: string): void {
    this.speech?.close()
    const speech = new WebSocket(`${serverSocketURL('/ws/speech')}?token=${encodeURIComponent(token)}`)
    speech.binaryType = 'arraybuffer'
    this.speech = speech

    let opened = false
    speech.onopen = () => {
      opened = true
      this.refusedConnects = 0
      this.setStatus({ state: 'live', detail: '' })
      this.sendTargets()
      // The service keeps a sample per connection, so each new one gets it again.
      this.sampleSent = false
      this.sendSample()
    }
    speech.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data === 'string') this.onSpeechText(event.data)
      else this.onVoice(event.data)
    }
    speech.onclose = () => {
      if (this.speech !== speech || this.stopped) return
      this.speech = null
      if (!opened && ++this.refusedConnects >= MAX_REFUSED_CONNECTS) {
        const reason = 'The speech service cannot be reached or refused the connection.'
        this.setStatus({ state: 'failed', detail: reason })
        this.events.onFailure(reason)
        return
      }
      this.setStatus({
        state: 'retrying',
        detail: opened
          ? 'The speech connection dropped; reconnecting.'
          : `The speech service did not answer (try ${this.refusedConnects} of ${MAX_REFUSED_CONNECTS}).`,
      })
      // A fresh token for the new connection (they expire after an hour).
      setTimeout(() => {
        if (!this.stopped) this.client?.requestSpeechToken()
      }, RECONNECT_DELAY_MS)
    }
  }

  /** The languages this speech goes out in: its own (as subtitles) and every other member's. */
  private targets(): string[] {
    return [...new Set([this.selfPrefs.lang, ...[...this.others.values()].map((other) => other.lang)])]
  }

  /**
   * The other languages a translated voice is wanted in: by everyone who
   * listens to one, and by the recorder, whose recording mixes it in.
   */
  private voiceTargets(): string[] {
    const recorder = this.client?.recorder ?? ''
    const wanted = [...this.others.entries()]
      .filter(([id, other]) => (other.voice || id === recorder) && other.lang !== this.selfPrefs.lang)
      .map(([, other]) => other.lang)
    return [...new Set(wanted)]
  }

  private sendTargets(): void {
    const sameLanguage = this.targets().length < 2
    if (sameLanguage !== this.status.sameLanguage) this.setStatus({ sameLanguage })
    if (this.speech?.readyState !== WebSocket.OPEN) return
    this.speech.send(JSON.stringify({ type: 'hello', targets: this.targets(), voiceTargets: this.voiceTargets() }))
  }

  private sendSample(): void {
    const sample = this.ownSample
    const speaker = this.client?.memberId
    if (this.sampleSent || !sample || !speaker || this.selfPrefs.voiceChoice !== 'own') return
    if (this.speech?.readyState !== WebSocket.OPEN) return
    this.sampleSent = true
    const header = { speaker, lang: sample.lang, voice: 'own', sample: true }
    for (let offset = 0; offset < sample.pcm.length; offset += SAMPLE_FRAME) {
      this.speech.send(pack(header, sample.pcm.slice(offset, offset + SAMPLE_FRAME).buffer))
    }
    this.speech.send(JSON.stringify({ type: 'voice-sample', speaker, lang: sample.lang }))
  }

  private endSpeech(): void {
    const speaker = this.client?.memberId
    if (speaker && this.speech?.readyState === WebSocket.OPEN) {
      this.speech.send(JSON.stringify({ type: 'end', speaker }))
    }
  }

  private setStatus(patch: Partial<TranslatorStatus>): void {
    this.status = { ...this.status, ...patch }
    this.events.onStatus?.(this.status)
  }

  private sendAudio(pcm: ArrayBuffer): void {
    const speaker = this.client?.memberId
    if (!speaker || this.speech?.readyState !== WebSocket.OPEN) return
    this.speech.send(pack({ speaker, lang: this.selfPrefs.lang, voice: this.selfPrefs.voiceChoice }, pcm))
  }

  private onSpeechText(data: string): void {
    let message: { type?: string; code?: string } & Partial<CaptionLine>
    try {
      message = JSON.parse(data) as typeof message
    } catch {
      return
    }
    if (message.type === 'notice') {
      if (message.code === 'translation-failed') {
        this.setStatus({ failedTranslations: this.status.failedTranslations + 1 })
      } else if (message.code === 'own-voice-ready') {
        this.setStatus({ ownVoice: 'ready' })
      } else if (message.code === 'own-voice-rejected') {
        this.setStatus({ ownVoice: 'rejected' })
      }
      return
    }
    if (message.type !== 'caption') return

    const caption: CaptionLine = {
      k: 'caption',
      speaker: message.speaker ?? '',
      segId: message.segId ?? '',
      sourceLang: message.sourceLang ?? '',
      lang: message.lang ?? '',
      text: message.text ?? '',
      final: message.final ?? false,
    }
    void this.client?.sendCaption(caption)
    this.events.onCaption(caption)
  }

  private onVoice(frame: ArrayBuffer): void {
    const player = this.player
    if (!player) return
    const { header, pcm } = unpack(frame)
    if (pcm.length === 0) return
    if (player.backlog(header.lang) > MAX_VOICE_LAG_S) {
      this.setStatus({ droppedVoices: this.status.droppedVoices + 1 })
      return
    }

    player.play(header.lang, pcm, header.rate)
  }
}
