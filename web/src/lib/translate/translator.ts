// What Room needs of the bridge that translates this member's speech,
// whichever machine runs the engines: the server's speech service, or
// this member's own browser.

import type { RoomClient } from '@/lib/sfu'
import type { LangPrefs, RoomMessage, TranslatorStatus } from '@/lib/translate/types'

export interface TranslatorEvents {
  /**
   * A line for this member to read, as this member gets it: a caption, or
   * the translation another member made of one.
   */
  onCaption: (line: RoomMessage) => void
  /** Transcription or translation failed; this member's speech is not translated. */
  onFailure: (reason: string) => void
  /** The bridge's state and anything that keeps speech from being translated. */
  onStatus?: (status: TranslatorStatus) => void
  /**
   * The translated voice this member's own engines give a speaker, in
   * this member's language and played on this machine only. It is null
   * when the speaker's last sentence got no voice here: until the next
   * one has, the speaker's own voice is what there is to hear.
   */
  onVoice?: (speaker: string, track: MediaStreamTrack | null) => void
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
}
