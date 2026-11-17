import type { Cut } from './vad.ts'

export const MAX_HELD_CHARS = 160

const SENTENCE_END = /[.!?…。！？][\p{Pe}\p{Pf}"']*\s*$/u
const CLOSED = /[.…]+$/u
const CARRIES_ON = /^\p{Ll}/u

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text)
}

export interface Line {
  seq: number
  text: string
  final: boolean
}

function joined(held: string, text: string): string {
  if (!held || !text) return held || text
  return `${CARRIES_ON.test(text) ? held.replace(CLOSED, '') : held} ${text}`
}

export class Sentences {
  private held = ''
  private seq = 0

  get holding(): boolean {
    return this.held !== ''
  }

  partial(text: string): Line | null {
    const line = joined(this.held, text.trim())
    return line ? { seq: this.seq, text: line, final: false } : null
  }

  utterance(text: string, cut: Cut): Line | null {
    const line = joined(this.held, text.trim())
    if (!line) return null

    if ((cut === 'pause' || !endsSentence(line)) && line.length < MAX_HELD_CHARS) {
      this.held = line
      return { seq: this.seq, text: line, final: false }
    }

    return this.finish(line)
  }

  expire(): Line | null {
    return this.held ? this.finish(this.held) : null
  }

  private finish(text: string): Line {
    const line = { seq: this.seq, text, final: true }
    this.held = ''
    this.seq += 1
    return line
  }
}
