// What Room needs of the bridge that translates this member's speech,
// whichever machine runs the engines: the server's speech service, or
// this member's own browser.

import type { RoomClient } from '@/lib/sfu'
import type { OwnVoiceSample } from '@/lib/translate/own-voice'
import type { CaptionLine, LangPrefs, RoomMessage, TranslatorStatus } from '@/lib/translate/types'

export interface TranslatorEvents {
  /** A caption for this member, as this member gets it. */
  onCaption: (caption: CaptionLine) => void
  /** Transcription or translation failed; this member's speech is not translated. */
  onFailure: (reason: string) => void
  /** The bridge's state and anything that keeps speech from being translated. */
  onStatus?: (status: TranslatorStatus) => void
  /**
   * A translated voice this member plays on its own machine, which no
   * other member needs: the browser's own engines make one per speaker.
   */
  onStream?: (speaker: string, lang: string, track: MediaStreamTrack) => void
}

export interface Translator {
  /** Follows a client's events; call it before the client connects, so no early message is missed. */
  attach(client: RoomClient): void
  /** Starts translating this member's speech; call it from a user gesture where possible. */
  start(localMic: MediaStreamTrack | null): void
  setLocalMic(track: MediaStreamTrack | null): void
  setSelfPrefs(prefs: LangPrefs): void
  /** A caption or translation another member's bridge sent the room. */
  receive(caption: RoomMessage): void
  /** Stops translating this member's speech. */
  stop(): Promise<void>
  /** The speaker's recorded own voice, for a runtime that makes voices from it; null to forget it. */
  setOwnVoiceSample?(sample: OwnVoiceSample | null): void
}
