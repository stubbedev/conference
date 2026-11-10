import type { TranslationLevel } from '../translate/types.ts'

export interface Candidate {
  id: string
  lang: string
  translates: TranslationLevel
}

const RANK: Record<TranslationLevel, number> = { none: 0, plain: 1, prompted: 2 }

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
 */
export class Election {
  private assigned: ReadonlyMap<string, string> = new Map()

  /** Holds the election again, over the members as they are announced now. */
  hold(candidates: Iterable<Candidate>): void {
    this.assigned = assignTranslators(candidates)
  }

  /** The translator into each language that has one. */
  get translators(): ReadonlyMap<string, string> {
    return this.assigned
  }

  translatorFor(lang: string): string | null {
    return this.assigned.get(lang) ?? null
  }
}
