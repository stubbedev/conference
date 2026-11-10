// What members exchange about live translation. Both travel sealed with
// the room's chat key, so the SFU only relays ciphertext.

/** 'own' is the speaker's own voice, made from a recording they make. */
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

export interface TranslationLine {
  k: 'translation'
  by: string
  speaker: string
  segId: string
  sourceLang: string
  lang: string
  text: string
  final: boolean
}

export type RoomMessage = CaptionLine | TranslationLine

export const TRANSLATION_LEVELS = ['none', 'plain', 'prompted'] as const

export type TranslationLevel = (typeof TRANSLATION_LEVELS)[number]

export interface LangAnnouncement extends LangPrefs {
  translates: TranslationLevel
  /** This member's translated voice is made from their own recording, so listeners can say so. */
  ownVoice: boolean
}

export const LOADING_PARTS = ['runtime', 'transcription', 'translation', 'voice'] as const

export type LoadingPart = (typeof LOADING_PARTS)[number]

export interface LoadingRetry {
  attempt: number
  attempts: number
  reason: string
}

export interface PartLoading {
  part: LoadingPart
  loaded: number
  total: number
  retry: LoadingRetry | null
}

export type Loading =
  | { state: 'loading'; parts: readonly PartLoading[] }
  | { state: 'failed'; reason: string; retry: () => void }

/** What a member sees about its own bridge, for spotting problems. */
export interface TranslatorStatus {
  state: 'claiming' | 'connecting' | 'live' | 'retrying' | 'failed'
  /** Why it is retrying or failed. */
  detail: string
  /** Everyone else announced this member's language: nothing to translate into. */
  sameLanguage: boolean
  /** Sentences the speech service could not translate and sent as said. */
  failedTranslations: number
  loading: Loading | null
  /** This member's recorded own voice: in use, or turned down as too short or silent. */
  ownVoice: 'off' | 'ready' | 'rejected'
  /** Translated voices skipped because they would have played too late. */
  droppedVoices: number
}

function isTranslationLine(value: Record<string, unknown>): boolean {
  return (
    ['by', 'speaker', 'segId', 'sourceLang', 'lang', 'text'].every((key) => typeof value[key] === 'string') &&
    typeof value.final === 'boolean'
  )
}

export function isRoomMessage(value: unknown): value is RoomMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  if (message.k === 'translation') return isTranslationLine(message)
  return message.k === 'caption'
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

export function announcement(value: unknown): LangAnnouncement | null {
  if (!isLangPrefs(value)) return null
  const { translates, ownVoice } = value as { translates?: unknown; ownVoice?: unknown }
  return {
    ...value,
    translates: TRANSLATION_LEVELS.find((level) => level === translates) ?? 'none',
    ownVoice: ownVoice === true,
  }
}
