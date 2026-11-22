import { normalized } from './invented.ts'

export const ECHO_LATENCY_MS = 1_500
const ECHO_SHARE = 0.6
const ECHO_WORDS = 3
const REMEMBERED = 16

export interface Span {
  from: number
  until: number
}

interface Played extends Span {
  words: readonly string[]
}

function wordsOf(text: string): string[] {
  const words = normalized(text)
  return words ? words.split(' ') : []
}

function inOrder(said: readonly string[], played: readonly string[]): number {
  let previous = new Array<number>(played.length + 1).fill(0)
  for (const word of said) {
    const row = new Array<number>(played.length + 1).fill(0)
    for (let at = 0; at < played.length; at++) {
      row[at + 1] = word === played[at] ? previous[at] + 1 : Math.max(previous[at + 1], row[at])
    }
    previous = row
  }
  return previous[played.length]
}

function overlaps(said: Span, played: Span): boolean {
  return said.from <= played.until + ECHO_LATENCY_MS && said.until >= played.from
}

export class Echoes {
  private readonly played = new Map<string, Played>()

  play(key: string, text: string, span: Span): void {
    const before = this.played.get(key)
    this.played.delete(key)
    this.played.set(key, {
      words: wordsOf(text),
      from: Math.min(span.from, before?.from ?? span.from),
      until: Math.max(span.until, before?.until ?? span.until),
    })
    if (this.played.size <= REMEMBERED) return
    const oldest = this.played.keys().next().value
    if (oldest !== undefined) this.played.delete(oldest)
  }

  echoes(text: string, said: Span): boolean {
    const words = wordsOf(text)
    if (words.length === 0) return false
    const heard = [...this.played.values()]
      .filter((played) => overlaps(said, played))
      .sort((a, b) => a.from - b.from)
      .flatMap((played) => played.words)
    if (heard.length === 0) return false
    const common = inOrder(words, heard)
    return common >= ECHO_SHARE * words.length && common >= Math.min(ECHO_WORDS, heard.length)
  }
}
