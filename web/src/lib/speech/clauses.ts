const MIN_CLAUSE = 24
const BREAK = /(?<=[,;:.!?…。！？])\s+/u

export function clauses(text: string): string[] {
  const pieces = text.trim().split(BREAK).filter(Boolean)
  const merged: string[] = []
  for (const piece of pieces) {
    const last = merged.at(-1)
    if (last !== undefined && last.length < MIN_CLAUSE) merged[merged.length - 1] = `${last} ${piece}`
    else merged.push(piece)
  }
  const tail = merged.at(-1)
  if (merged.length > 1 && tail !== undefined && tail.length < MIN_CLAUSE) {
    merged.pop()
    merged[merged.length - 1] = `${merged.at(-1)} ${tail}`
  }
  return merged
}
