// What members exchange about live translation. Both travel sealed with
// the room's chat key, so the SFU only relays ciphertext.

/** 'own' is the speaker's own voice, cloned from what they say in the call. */
export type VoiceChoice = 'female' | 'male' | 'own'

export const VOICE_CHOICES: readonly VoiceChoice[] = ['female', 'male', 'own']

/** A member's language settings, announced to the room. */
export interface LangPrefs {
  /** The language this member speaks and wants to hear and read. */
  lang: string
  voice: boolean
  subtitles: boolean
  /** The voice others hear this member's speech translated in. */
  voiceChoice: VoiceChoice
}

export function isVoiceChoice(value: unknown): value is VoiceChoice {
  return VOICE_CHOICES.includes(value as VoiceChoice)
}

/** A subtitle line: interim lines are replaced in place by segId. */
export interface CaptionLine {
  k: 'caption'
  speaker: string
  segId: string
  sourceLang: string
  lang: string
  text: string
  final: boolean
}

/** The translated voice of one segment starts playing on the lang track. */
export interface VoiceCue {
  k: 'voice'
  speaker: string
  segId: string
  lang: string
  startInMs: number
  durationMs: number
  /** The speaker's own, cloned voice rather than a stock one. */
  cloned?: boolean
}

export type RoomCaption = CaptionLine | VoiceCue

/** What a member sees about its own bridge, for spotting problems. */
export interface TranslatorStatus {
  state: 'claiming' | 'connecting' | 'live' | 'retrying' | 'failed'
  /** Why it is retrying or failed. */
  detail: string
  /** Everyone else announced this member's language: nothing to translate into. */
  sameLanguage: boolean
  /** Sentences the speech service could not translate and sent as said. */
  failedTranslations: number
  /** This member's recorded own voice: in use, or turned down as too short or silent. */
  ownVoice: 'off' | 'ready' | 'rejected'
  /** Translated voices skipped because they would have played too late. */
  droppedVoices: number
}

export function isRoomCaption(value: unknown): value is RoomCaption {
  if (typeof value !== 'object' || value === null) return false
  const k = (value as { k?: unknown }).k
  return k === 'caption' || k === 'voice'
}

export function isLangPrefs(value: unknown): value is LangPrefs {
  if (typeof value !== 'object' || value === null) return false
  const prefs = value as Partial<LangPrefs>
  return (
    typeof prefs.lang === 'string' &&
    typeof prefs.voice === 'boolean' &&
    typeof prefs.subtitles === 'boolean' &&
    isVoiceChoice(prefs.voiceChoice)
  )
}
