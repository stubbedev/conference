import type { Layer } from './quality.ts'
import { SCREEN_KIND, type TileKind } from './track-kind.ts'
import type { LangAnnouncement } from './translate/types.ts'

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
 * withoutVoice is voices once the track behind stream is gone. Only that
 * very stream is taken out: a translator that starts over may publish
 * its new voice before the old one is seen to leave, and that one stays.
 */
export function withoutVoice<Stream>(voices: Voices<Stream>, member: string, lang: string, stream: Stream): Voices<Stream> {
  const ofMember: Readonly<Record<string, Stream>> | undefined = voices[member]
  if (ofMember?.[lang] !== stream) return voices

  const { [member]: _gone, ...others } = voices
  const { [lang]: _ended, ...kept } = ofMember
  return Object.keys(kept).length === 0 ? others : { ...others, [member]: kept }
}

/** What a member says of their own speech: its language, and what is made of it right now. */
/** What a tile needs of a member's announcement; ownVoice is absent until they announce one. */
export type Speaker = Pick<LangAnnouncement, 'lang' | 'captions' | 'voices'> & Partial<Pick<LangAnnouncement, 'ownVoice'>>

/** What live translation gives one listener to hear. */
export interface Translations<Stream> {
  /** Whether live translation is on in the call. */
  on: boolean
  /** The listener's language. */
  lang: string
  /** Whether the listener wants other languages spoken in theirs. */
  voice: boolean
  /** What each other member last announced, by member id. */
  announced: ReadonlyMap<string, Speaker>
  /** The translated voices that arrive from the room. */
  published: Voices<Stream>
  /**
   * The voices the listener's own engines make, by member id. Such a
   * voice speaks the listener's language, whichever that is by now.
   */
  local: Readonly<Record<string, Stream>>
}

/** The stream a tile is heard through, and whether that is its own. */
export type Heard<Stream> = { through: 'own'; stream: Stream | null } | { through: 'translation'; stream: Stream }

/**
 * heardThrough is what a tile is heard through: the one rule behind what
 * plays, what every speaking signal measures and what a recording holds.
 * A translated voice replaces a member's own only when the listener
 * wants translations spoken, the member speaks another language and a
 * voice in the listener's language is both there and alive. A voice from
 * the room is alive while its speaker announces that language as
 * voiced; a voice made here is alive while its speaker announces
 * captions for it to be made from. That a voice exists is not enough: a
 * translator that has fallen silent keeps its track, and a speaker whose
 * captions stopped leaves a voice with nothing to say. Everyone else,
 * and every share, is heard through their own stream, so no preference
 * and no translator that stopped leaves a member silent.
 */
export function heardThrough<Stream>(
  tile: { sourceId: string; kind: TileKind; stream: Stream | null },
  translations: Translations<Stream>,
): Heard<Stream> {
  const own: Heard<Stream> = { through: 'own', stream: tile.stream }
  if (!translations.on || !translations.voice || tile.kind === SCREEN_KIND) return own

  const speaker = translations.announced.get(tile.sourceId)
  if (!speaker || speaker.lang === translations.lang) return own

  const fromRoom: Readonly<Record<string, Stream>> | undefined = translations.published[tile.sourceId]
  const published = speaker.voices.includes(translations.lang) ? fromRoom?.[translations.lang] : undefined
  const madeHere: Stream | undefined = translations.local[tile.sourceId]
  const voice = published ?? (speaker.captions ? madeHere : undefined)
  if (voice === undefined) return own

  return { through: 'translation', stream: voice }
}

export function layoutLayer(tile: Pick<Tile, 'key' | 'kind'>, pinnedKey: string | null, tileCount: number): Layer {
  if (pinnedKey) return tile.key === pinnedKey ? 'h' : 'l'
  if (tile.kind === SCREEN_KIND) return 'h'
  if (tileCount <= 2) return 'h'
  if (tileCount <= 6) return 'm'
  return 'l'
}
