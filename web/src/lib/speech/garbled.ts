import { normalized } from './invented.ts'

export type Garbled = 'empty' | 'token-limit' | 'repetition'

const MIN_BUDGET = 16
const TOKENS_PER_CHARACTER = 4
const LONGEST_REPEATED_PHRASE = 4
const LEAST_REPEATED_WORDS = 4
const LEAST_REPEATS = 3
const PUNCTUATION_RUN = /(\p{P})\1{4,}/u

export function answerBudget(text: string): number {
  return Math.max(MIN_BUDGET, TOKENS_PER_CHARACTER * [...text].length)
}

function repeatsFrom(words: readonly string[], start: number, length: number): number {
  let repeats = 1
  while (start + (repeats + 1) * length <= words.length && words.slice(start + repeats * length, start + (repeats + 1) * length).every((word, i) => word === words[start + i])) repeats++
  return repeats
}

function loops(words: readonly string[]): boolean {
  for (let length = 1; length <= LONGEST_REPEATED_PHRASE; length++) {
    for (let start = 0; start + length <= words.length; start++) {
      const repeats = repeatsFrom(words, start, length)
      if (repeats >= LEAST_REPEATS && repeats * length >= LEAST_REPEATED_WORDS) return true
    }
  }
  return false
}

export function garbled(answer: string, generated: number, budget: number): Garbled | null {
  const words = normalized(answer)
  if (!words) return 'empty'
  if (generated >= budget) return 'token-limit'
  if (PUNCTUATION_RUN.test(answer) || loops(words.split(' '))) return 'repetition'
  return null
}
