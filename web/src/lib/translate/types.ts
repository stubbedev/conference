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

/** A member id, a segment id or a language code: a name, never prose. */
export const LABEL_MAX = 128

/**
 * The longest text a line carries, in UTF-16 units. A tile shows three
 * lines of it and an utterance is cut after twelve seconds, so nothing
 * said comes near, and anything longer would only be work for the
 * translator and the voice.
 */
export const LINE_TEXT_MAX = 1000

/** Why something that arrived as a room message is not handed on. */
export interface Refused {
  refused: string
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= LABEL_MAX
}

function noLabel(field: string): Refused {
  return { refused: `its ${field} is not a name of 1 to ${LABEL_MAX} characters` }
}

function parseLine(fields: Record<string, unknown>): Omit<CaptionLine, 'k'> | Refused {
  const { speaker, segId, sourceLang, lang, text, final } = fields
  if (!isLabel(speaker)) return noLabel('speaker')
  if (!isLabel(segId)) return noLabel('segId')
  if (!isLabel(sourceLang)) return noLabel('sourceLang')
  if (!isLabel(lang)) return noLabel('lang')
  if (typeof text !== 'string') return { refused: 'its text is not a string' }
  if (text.length > LINE_TEXT_MAX) return { refused: `its text is longer than ${LINE_TEXT_MAX} characters` }
  if (typeof final !== 'boolean') return { refused: 'its final is not a boolean' }

  return { speaker, segId, sourceLang, lang, text, final }
}

/**
 * parseRoomMessage reads what another member sealed for the room: every
 * field checked and nothing else kept, or the reason it is refused.
 * Everyone captions their own speech and a translation names its
 * translator, so a line claiming to come from anyone but its sender is
 * refused, and so is a translation of someone who is not in the call.
 */
export function parseRoomMessage(value: unknown, sender: string, inCall: (member: string) => boolean): RoomMessage | Refused {
  if (typeof value !== 'object' || value === null) return { refused: 'it is not an object' }

  const fields = value as Record<string, unknown>
  if (fields.k !== 'caption' && fields.k !== 'translation') return { refused: 'it is neither a caption nor a translation' }

  const line = parseLine(fields)
  if ('refused' in line) return line

  if (fields.k === 'caption') {
    if (line.speaker !== sender) return { refused: 'it captions someone other than its sender' }
    return { k: 'caption', ...line }
  }

  if (fields.by !== sender) return { refused: 'it names someone other than its sender as its translator' }
  if (!inCall(line.speaker)) return { refused: 'it translates someone who is not in the call' }
  return { k: 'translation', by: sender, ...line }
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
