import type { TranslationLevel } from '../translate/types.ts'
import { Recent } from './recent.ts'

export interface Candidate {
  id: string
  lang: string
  translates: TranslationLevel
}

const RANK: Record<TranslationLevel, number> = { none: 0, plain: 1, prompted: 2 }
const REMEMBERED_SENTENCES = 256

function sentenceKey(speaker: string, segId: string): string {
  return `${speaker}\n${segId}`
}

export function assignTranslators(candidates: Iterable<Candidate>): Map<string, string> {
  const members = [...candidates]
  const able = members.filter((member) => member.translates !== 'none')
  const load = new Map(able.map((member) => [member.id, 0]))
  const assigned = new Map<string, string>()

  for (const target of [...new Set(members.map((member) => member.lang))].sort()) {
    const best = Math.max(0, ...able.map((member) => RANK[member.translates]))
    const chosen = able
      .filter((member) => RANK[member.translates] === best)
      .sort(
        (a, b) =>
          (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) ||
          Number(b.lang === target) - Number(a.lang === target) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )[0]
    if (!chosen) continue

    assigned.set(target, chosen.id)
    load.set(chosen.id, (load.get(chosen.id) ?? 0) + 1)
  }
  return assigned
}

/**
 * Election is who a room holds as the translator into each language, as
 * one member works it out from what every member announced. No server
 * runs it: each member holds it again whenever an announcement changes,
 * and members who know the same announcements hold the same translators.
 *
 * They do not know them at the same moment. A member acts on its own
 * announcement before the room has it, the server orders the messages
 * of one member only, and a translation takes time, so a translator may
 * be replaced while its line is still on its way. A line is therefore
 * judged against everyone who was the translator while its sentence was
 * being translated: from when the sentence was first heard until now.
 */
export class Election {
  private assigned: ReadonlyMap<string, string> = new Map()
  private elections = 0
  private readonly replaced = new Map<string, Map<string, number>>()
  private readonly heard = new Recent<number>(REMEMBERED_SENTENCES)

  /** Holds the election again, over the members as they are announced now. */
  hold(candidates: Iterable<Candidate>): void {
    const members = [...candidates]
    const next = assignTranslators(members)
    this.elections += 1

    for (const [lang, member] of this.assigned) {
      if (next.get(lang) === member) continue
      const past = this.replaced.get(lang) ?? new Map<string, number>()
      past.set(member, this.elections)
      this.replaced.set(lang, past)
    }
    this.assigned = next

    const langs = new Set(members.map((member) => member.lang))
    const ids = new Set(members.map((member) => member.id))
    for (const [lang, past] of this.replaced) {
      for (const member of past.keys()) if (!ids.has(member) || next.get(lang) === member) past.delete(member)
      if (past.size === 0 || !langs.has(lang)) this.replaced.delete(lang)
    }
  }

  /** A sentence is heard for the first time: whoever translates from now on may translate it. */
  hear(speaker: string, segId: string): void {
    const sentence = sentenceKey(speaker, segId)
    if (this.heard.get(sentence) === undefined) this.heard.set(sentence, this.elections)
  }

  /**
   * Whether member is the translator into lang, or was at some time since
   * the sentence was first heard. A sentence that was never heard here
   * is one only the translator of this moment may translate.
   */
  translated(member: string, lang: string, speaker: string, segId: string): boolean {
    if (this.assigned.get(lang) === member) return true

    const replaced = this.replaced.get(lang)?.get(member)
    const heard = this.heard.get(sentenceKey(speaker, segId))
    return replaced !== undefined && heard !== undefined && replaced > heard
  }

  /** The translator into each language that has one. */
  get translators(): ReadonlyMap<string, string> {
    return this.assigned
  }

  translatorFor(lang: string): string | null {
    return this.assigned.get(lang) ?? null
  }
}
