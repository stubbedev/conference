export interface Candidate {
  id: string
  lang: string
  translates: boolean
}

export function translatorFor(lang: string, candidates: Iterable<Candidate>): string | null {
  let chosen: string | null = null
  for (const candidate of candidates) {
    if (candidate.lang !== lang || !candidate.translates) continue
    if (chosen === null || candidate.id < chosen) chosen = candidate.id
  }
  return chosen
}
