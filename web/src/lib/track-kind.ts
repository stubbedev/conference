// What a published track carries, as an offer labels it for the SFU and
// the SFU labels it for viewers. It mirrors Kind in internal/sfu, which
// refuses an offer that names anything else: change the two together.

export const AUDIO_KIND = 'audio'
export const CAMERA_KIND = 'camera'
export const SCREEN_KIND = 'screen'
export const SCREEN_AUDIO_KIND = 'screen-audio'

const TRANSLATION_KIND_PREFIX = 'translation-'

/** The pictures: each has a tile, and is published as layers a viewer chooses between. */
export const TILE_KINDS = [CAMERA_KIND, SCREEN_KIND] as const

export type TileKind = (typeof TILE_KINDS)[number]

/** A translated voice: the prefix, then the language it speaks. */
export type TranslationKind = `${typeof TRANSLATION_KIND_PREFIX}${string}`

/** The sounds: a microphone, what a share plays and a translated voice. */
export type AudioKind = typeof AUDIO_KIND | typeof SCREEN_AUDIO_KIND | TranslationKind

export type TrackKind = TileKind | AudioKind

const OWN_KINDS: readonly TrackKind[] = [AUDIO_KIND, SCREEN_AUDIO_KIND, ...TILE_KINDS]

function isTranslationKind(kind: string): kind is TranslationKind {
  return kind.startsWith(TRANSLATION_KIND_PREFIX) && kind.length > TRANSLATION_KIND_PREFIX.length
}

export function translationKind(lang: string): TranslationKind {
  if (!lang) throw new Error('A translated voice is published in a language, and none was given.')
  return `${TRANSLATION_KIND_PREFIX}${lang}`
}

/** The language of a translated voice; null for every other kind. */
export function translationLang(kind: TrackKind): string | null {
  return isTranslationKind(kind) ? kind.slice(TRANSLATION_KIND_PREFIX.length) : null
}

/** Reads a kind off the wire; null for anything that is not one. */
export function parseTrackKind(wire: unknown): TrackKind | null {
  if (typeof wire !== 'string') return null
  return OWN_KINDS.find((kind) => kind === wire) ?? (isTranslationKind(wire) ? wire : null)
}

/** What an offer says its media sections carry. */
export interface Announced {
  /** The kind of each section, by mid. */
  kinds: Map<string, TrackKind>
  /** What it says of sections this client cannot place: no mid, or no kind it knows. */
  refused: unknown[]
}

/** Reads the track list of an offer off the wire. An offer that sends nothing has none. */
export function announcedKinds(tracks: unknown): Announced {
  const announced: Announced = { kinds: new Map(), refused: [] }
  if (tracks === undefined) return announced
  if (!Array.isArray(tracks)) return { ...announced, refused: [tracks] }

  for (const entry of tracks as unknown[]) {
    const { mid, kind: wire } = (typeof entry === 'object' && entry !== null ? entry : {}) as { mid?: unknown; kind?: unknown }
    const kind = parseTrackKind(wire)
    if (typeof mid === 'string' && kind !== null) announced.kinds.set(mid, kind)
    else announced.refused.push(entry)
  }
  return announced
}

export function isTileKind(kind: TrackKind | undefined): kind is TileKind {
  return TILE_KINDS.some((tile) => tile === kind)
}

export function isAudioKind(kind: TrackKind): kind is AudioKind {
  return !isTileKind(kind)
}

/**
 * tileOf is the tile a track is seen or heard in: a microphone belongs
 * to its camera, a share's sound to the share. A translated voice has
 * none, since it replaces its speaker's own.
 */
export function tileOf(kind: TrackKind): TileKind | null {
  if (translationLang(kind) !== null) return null
  return kind === SCREEN_KIND || kind === SCREEN_AUDIO_KIND ? SCREEN_KIND : CAMERA_KIND
}
