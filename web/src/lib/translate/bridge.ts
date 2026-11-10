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
// speaker's own (cloned) voice would come in.

import { Refusals } from '@/lib/sealed'
import { serverSocketURL, type RoomClient } from '@/lib/sfu'
import { MicCapture } from '@/lib/translate/capture'
import { afterEnd, CONNECT_TIMEOUT_MS, RECONNECT_DELAY_MS, type Ended } from '@/lib/translate/speech-link'
import { PROVIDES_NOTHING, type LangPrefs, type RoomMessage, type TranslatorStatus } from '@/lib/translate/types'
import type { Translator, TranslatorEvents } from '@/lib/translate/translator'
import { VoicePlayer } from '@/lib/translate/voice'
import { packAudio, parseSpeechMessage, parseVoice } from '@/lib/translate/wire'

const SPEECH_SERVICE = 'the speech service'
// How long start() waits for the token the server sends on its own before asking.
const TOKEN_GRACE_MS = 1_500

export class ServerTranslator implements Translator {
  private client: RoomClient | null = null
  private unsubscribe: (() => void)[] = []
  private speech: WebSocket | null = null
  private capture: MicCapture
  private playbackContext: AudioContext | null = null
  private player: VoicePlayer | null = null
  /** The languages this member's last sentence went out in as a voice. */
  private voiced = new Set<string>()
  private failures = 0
  private asking: ReturnType<typeof setTimeout> | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  private status: TranslatorStatus = { state: 'claiming', detail: '', sameLanguage: false, failedTranslations: 0, loading: null }
  private selfPrefs: LangPrefs
  private stopped = false
  private readonly events: TranslatorEvents
  private readonly refusals = new Refusals((line, ...detail) => console.warn(`translate: ${line}`, ...detail))

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

    this.unsubscribe = [
      client.on('translate-token', ({ token }) => this.openSpeech(token)),
      client.on('lang', () => this.sendTargets()),
      client.on('member-gone', () => this.sendTargets()),
    ]
    this.announce()
  }

  /**
   * Starts translating this member's speech on the attached, connected
   * client. The first time, call it from a user gesture where possible,
   * so the audio contexts may start.
   */
  start(localMic: MediaStreamTrack | null): void {
    if (!this.client) return
    void this.capture.start(localMic)
    if (this.speech) return
    this.setStatus({ state: 'claiming', detail: '' })
    // The server sends a token when translation turns on, but a joiner's
    // may have come before its bridge existed: ask if none arrives.
    this.attempt(TOKEN_GRACE_MS)
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
    if (caption.k === 'caption') this.events.onCaption(caption)
  }

  /** Stops translating this member's speech and removes its voice tracks. */
  async stop(): Promise<void> {
    this.stopped = true
    const client = this.client
    this.detach()
    client?.setProvides(PROVIDES_NOTHING)
    await client?.removeTranslationTracks()
    await this.capture.close()
    await this.playbackContext?.close()
    this.playbackContext = null
    this.player = null
  }

  private detach(): void {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
    this.clearAttempt()
    this.speech?.close()
    this.speech = null
    this.capture.stop()
    // The tracks belonged to the old connection; the next client publishes afresh.
    this.player = this.playbackContext ? new VoicePlayer(this.playbackContext, this.publishTrack) : null
    this.voiced.clear()
    this.client = null
  }

  private readonly publishTrack = (lang: string, track: MediaStreamTrack): void => {
    void this.client?.addTranslationTrack(lang, track)
  }

  // An attempt at the speech connection asks for a token after
  // askAfterMs, unless one has come by then, and is over when nothing
  // has opened a while after that: a token that never comes and a
  // connection that never opens must not leave the bridge waiting.
  private attempt(askAfterMs: number): void {
    this.clearAttempt()
    this.asking = setTimeout(() => {
      this.asking = null
      if (!this.speech) this.client?.requestSpeechToken()
    }, askAfterMs)
    this.deadline = setTimeout(() => this.ended({ how: 'refused' }), askAfterMs + CONNECT_TIMEOUT_MS)
  }

  private clearAttempt(): void {
    if (this.asking !== null) clearTimeout(this.asking)
    if (this.deadline !== null) clearTimeout(this.deadline)
    this.asking = null
    this.deadline = null
  }

  private openSpeech(token: string): void {
    if (this.stopped) return
    this.clearAttempt()
    this.speech?.close()
    this.voiced.clear()
    const speech = new WebSocket(`${serverSocketURL('/ws/speech')}?token=${encodeURIComponent(token)}`)
    speech.binaryType = 'arraybuffer'
    this.speech = speech
    this.setStatus({ state: 'connecting', detail: '' })
    this.deadline = setTimeout(() => this.ended({ how: 'refused' }), CONNECT_TIMEOUT_MS)

    let openedAt: number | null = null
    speech.onopen = () => {
      openedAt = performance.now()
      this.clearAttempt()
      this.setStatus({ state: 'live', detail: '' })
      this.sendTargets()
    }
    speech.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data === 'string') this.onSpeechText(event.data)
      else this.onVoice(event.data)
    }
    speech.onclose = () => {
      if (this.speech !== speech || this.stopped) return
      this.ended(openedAt === null ? { how: 'refused' } : { how: 'dropped', lastedMs: performance.now() - openedAt })
    }
  }

  // The attempt at the speech connection is over. Nothing is captioned
  // or voiced until the next one opens, and after too many in a row
  // that did not last there is no next one.
  private ended(end: Ended): void {
    this.clearAttempt()
    this.speech?.close()
    this.speech = null
    this.voiced.clear()
    this.announce()

    const verdict = afterEnd(this.failures, end)
    this.failures = verdict.failures
    if (verdict.next === 'give-up') {
      this.setStatus({ state: 'failed', detail: verdict.detail })
      this.events.onFailure(verdict.detail)
      return
    }
    this.setStatus({ state: 'retrying', detail: verdict.detail })
    // A fresh token for the new connection (they expire after an hour).
    this.attempt(RECONNECT_DELAY_MS)
  }

  /** The languages this speech goes out in: its own (as subtitles) and every other member's. */
  private targets(): string[] {
    const others = [...(this.client?.memberLangPrefs.values() ?? [])].map((prefs) => prefs.lang)
    return [...new Set([this.selfPrefs.lang, ...others])]
  }

  private sendTargets(): void {
    const targets = this.targets()
    const sameLanguage = targets.length < 2
    if (sameLanguage !== this.status.sameLanguage) this.setStatus({ sameLanguage })
    for (const lang of this.voiced) if (!targets.includes(lang)) this.voiced.delete(lang)
    this.announce()
    if (this.speech?.readyState !== WebSocket.OPEN) return
    this.speech.send(JSON.stringify({ type: 'hello', targets }))
  }

  // While the connection is open this member's speech is captioned. A
  // language is voiced from the sentence that comes back spoken in it to
  // the sentence that comes back without a voice, so a listener hears
  // this member's own voice from then until the next sentence is spoken.
  private announce(): void {
    this.client?.setProvides({
      captions: this.speech?.readyState === WebSocket.OPEN,
      translates: 'none',
      voices: [...this.voiced].sort(),
    })
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
    this.speech.send(packAudio({ speaker, lang: this.selfPrefs.lang, voice: this.selfPrefs.voiceChoice }, pcm))
  }

  private onSpeechText(data: string): void {
    const client = this.client
    if (!client) return

    const message = parseSpeechMessage(data, client.memberId)
    if ('refused' in message) {
      this.refusals.report('a message', SPEECH_SERVICE, message.refused)
      return
    }
    switch (message.type) {
      case 'ready':
        return
      case 'unvoiced':
        if (!message.translated) this.setStatus({ failedTranslations: this.status.failedTranslations + 1 })
        if (this.voiced.delete(message.lang)) this.announce()
        return
      case 'caption':
        void client.sendCaption(message.caption)
        this.events.onCaption(message.caption)
        return
    }
  }

  private onVoice(frame: ArrayBuffer): void {
    const player = this.player
    if (!player) return

    const voice = parseVoice(frame)
    if ('refused' in voice) {
      this.refusals.report('a voice', SPEECH_SERVICE, voice.refused)
      return
    }
    if (voice.pcm.length === 0) return

    player.play(voice.lang, voice.pcm, voice.rate)
    if (this.voiced.has(voice.lang)) return
    this.voiced.add(voice.lang)
    this.announce()
  }
}
