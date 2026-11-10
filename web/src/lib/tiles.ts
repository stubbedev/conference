import type { Layer } from './quality.ts'
import { SCREEN_KIND, type TileKind } from './track-kind.ts'

export const LOCAL_SOURCE = 'local'

export interface Tile {
  key: string
  sourceId: string
  kind: TileKind
  stream: MediaStream | null
}

export function tileLabel(tile: Tile, displayName: string, members: readonly { id: string; name: string }[]): string {
  if (tile.sourceId === LOCAL_SOURCE) {
    return tile.kind === SCREEN_KIND ? 'Your screen' : `${displayName} (you)`
  }
  const name = members.find((member) => member.id === tile.sourceId)?.name ?? 'Guest'
  return tile.kind === SCREEN_KIND ? `${name}'s screen` : name
}

/** The translated voices that exist, by member id and then language. */
export type Voices<Stream> = Readonly<Record<string, Readonly<Record<string, Stream>>>>

/** voices with a member's translated voice in lang, in place of the one it had. */
export function withVoice<Stream>(voices: Voices<Stream>, member: string, lang: string, stream: Stream): Voices<Stream> {
  return { ...voices, [member]: { ...voices[member], [lang]: stream } }
}

/**
 * withLocalVoices adds the voices the listener's own engines make, one
 * per member, to those published to the room. Such a voice speaks the
 * listener's language, whichever that is by now, so it is filed under
 * lang when it is looked up and not when it was made.
 */
export function withLocalVoices<Stream>(
  voices: Voices<Stream>,
  local: Readonly<Record<string, Stream>>,
  lang: string,
): Voices<Stream> {
  return Object.entries(local).reduce((all, [member, stream]) => withVoice(all, member, lang, stream), voices)
}

/** What live translation gives one listener to hear. */
export interface Translations<Stream> {
  /** Whether live translation is on in the call. */
  on: boolean
  /** The listener's language. */
  lang: string
  /** Whether the listener wants other languages spoken in theirs. */
  voice: boolean
  /** The language each other member speaks, by member id. */
  spoken: Readonly<Record<string, string>>
  voices: Voices<Stream>
}

/** The stream a tile is heard through, and whether that is its own. */
export type Heard<Stream> = { through: 'own'; stream: Stream | null } | { through: 'translation'; stream: Stream }

/**
 * heardThrough is what a tile is heard through: the one rule behind what
 * plays, what every speaking signal measures and what a recording holds.
 * A translated voice replaces a member's own only when the listener
 * wants translations spoken, the member speaks another language and that
 * voice exists. Everyone else, and every share, is heard through their
 * own stream, so no preference leaves a member silent.
 */
export function heardThrough<Stream>(
  tile: { sourceId: string; kind: TileKind; stream: Stream | null },
  translations: Translations<Stream>,
): Heard<Stream> {
  const own: Heard<Stream> = { through: 'own', stream: tile.stream }
  if (!translations.on || !translations.voice || tile.kind === SCREEN_KIND) return own

  const spoken: string | undefined = translations.spoken[tile.sourceId]
  const voices: Readonly<Record<string, Stream>> | undefined = translations.voices[tile.sourceId]
  const voice: Stream | undefined = voices?.[translations.lang]
  if (!spoken || spoken === translations.lang || voice === undefined) return own

  return { through: 'translation', stream: voice }
}

export function layoutLayer(tile: Pick<Tile, 'key' | 'kind'>, pinnedKey: string | null, tileCount: number): Layer {
  if (pinnedKey) return tile.key === pinnedKey ? 'h' : 'l'
  if (tile.kind === SCREEN_KIND) return 'h'
  if (tileCount <= 2) return 'h'
  if (tileCount <= 6) return 'm'
  return 'l'
}
