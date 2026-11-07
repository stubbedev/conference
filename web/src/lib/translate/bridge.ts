// ServerTranslator: one member's bridge to the speech service on the
// conference server. While a host has live translation switched on,
// every member's browser runs one, because only that browser holds its
// speaker's microphone before encryption:
//
//   own mic ──16 kHz PCM──► speech service (our own server)
//   subtitles ◄── JSON ── speech service ──► sealed `caption` messages
//   translated voice ◄── PCM ──► one E2EE audio track per other language
//
// The SFU only ever relays the sealed captions and encrypted tracks.
// Each speaker's voice stays its own track, which is also where a
// speaker's own (cloned) voice would come in.

import { serverSocketURL, type RoomClient } from '@/lib/sfu'
import { MicCapture } from '@/lib/translate/capture'
import type { CaptionLine, LangPrefs, RoomCaption, RoomMessage, TranslatorStatus } from '@/lib/translate/types'
import type { Translator, TranslatorEvents } from '@/lib/translate/translator'
import { VoicePlayer } from '@/lib/translate/voice'

const HEADER_BYTES = 2
const MAX_REFUSED_CONNECTS = 3
const RECONNECT_DELAY_MS = 2_000
// How long start() waits for the token the server sends on its own before asking.
const TOKEN_GRACE_MS = 1_500

interface VoiceHeader {
  speaker: string
  segId: string
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
  /** The other members' announced languages: what this speech is translated into. */
  private otherLangs = new Map<string, string>()
  private refusedConnects = 0
  private status: TranslatorStatus = { state: 'claiming', detail: '', sameLanguage: false, failedTranslations: 0, loading: null }
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
    for (const [memberId, prefs] of client.memberLangPrefs) this.otherLangs.set(memberId, prefs.lang)

    this.unsubscribe = [
      client.on('translate-token', ({ token }) => {
        this.setStatus({ state: 'connecting', detail: '' })
        this.openSpeech(token)
      }),
      client.on('lang', ({ from, prefs }) => {
        this.otherLangs.set(from, prefs.lang)
        this.sendTargets()
      }),
      client.on('member-left', ({ id }) => {
        this.otherLangs.delete(id)
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
    this.selfPrefs = prefs
    this.sendTargets()
  }

  /** The speech service already translated what it relays: nothing to do. */
  receive(caption: RoomMessage): void {
    if (caption.k !== 'translation') this.events.onCaption(caption)
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
    return [...new Set([this.selfPrefs.lang, ...this.otherLangs.values()])]
  }

  private sendTargets(): void {
    const sameLanguage = this.targets().length < 2
    if (sameLanguage !== this.status.sameLanguage) this.setStatus({ sameLanguage })
    if (this.speech?.readyState !== WebSocket.OPEN) return
    this.speech.send(JSON.stringify({ type: 'hello', targets: this.targets() }))
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
    if (message.type === 'notice' && message.code === 'translation-failed') {
      this.setStatus({ failedTranslations: this.status.failedTranslations + 1 })
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
    this.publish(caption)
  }

  private onVoice(frame: ArrayBuffer): void {
    const player = this.player
    if (!player) return
    const { header, pcm } = unpack(frame)
    if (pcm.length === 0) return

    const cue = player.play(header.lang, pcm, header.rate)
    this.publish({
      k: 'voice',
      speaker: header.speaker,
      segId: header.segId,
      lang: header.lang,
      startInMs: cue.startInMs,
      durationMs: cue.durationMs,
    })
  }

  private publish(caption: RoomCaption): void {
    void this.client?.sendCaption(caption)
    this.events.onCaption(caption)
  }
}
