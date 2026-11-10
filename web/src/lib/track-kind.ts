// What a published track carries, as an offer labels it for the SFU and
// the SFU labels it for viewers. It mirrors Kind in internal/sfu: change
// the two together.

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

export type TrackKind = typeof AUDIO_KIND | TileKind | typeof SCREEN_AUDIO_KIND | TranslationKind

export function translationKind(lang: string): TranslationKind {
  return `${TRANSLATION_KIND_PREFIX}${lang}`
}

/** The language of a translated voice; null for every other kind. */
export function translationLang(kind: TrackKind): string | null {
  return kind.startsWith(TRANSLATION_KIND_PREFIX) ? kind.slice(TRANSLATION_KIND_PREFIX.length) : null
}

export function isTileKind(kind: TrackKind | undefined): kind is TileKind {
  return TILE_KINDS.some((tile) => tile === kind)
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
