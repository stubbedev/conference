import type { TranslationLevel } from '../translate/types.ts'

export interface Candidate {
  id: string
  lang: string
  translates: TranslationLevel
}

const RANK: Record<TranslationLevel, number> = { none: 0, plain: 1, prompted: 2 }

function better(a: Candidate, b: Candidate, target: string): boolean {
  if (RANK[a.translates] !== RANK[b.translates]) return RANK[a.translates] > RANK[b.translates]
  if ((a.lang === target) !== (b.lang === target)) return a.lang === target
  return a.id < b.id
}

export function translatorFor(target: string, candidates: Iterable<Candidate>): string | null {
  let chosen: Candidate | null = null
  for (const candidate of candidates) {
    if (candidate.translates === 'none') continue
    if (chosen === null || better(candidate, chosen, target)) chosen = candidate
  }
  return chosen?.id ?? null
}
