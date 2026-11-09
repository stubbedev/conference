export interface LanguagePair {
  source: string
  target: string
}

export class WarmUps {
  private readonly claimed = new Set<string>()

  claim(sources: Iterable<string>, target: string): LanguagePair[] {
    const pairs: LanguagePair[] = []
    for (const source of sources) {
      const key = `${source}-${target}`
      if (source === target || this.claimed.has(key)) continue
      this.claimed.add(key)
      pairs.push({ source, target })
    }
    return pairs
  }
}
