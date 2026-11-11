// The sentences a listener leaves to the room's translator. A sentence
// is waited for a bounded time and from one member: when the time is up,
// or that member is no longer the translator, the listener translates it
// itself. Time is passed in, so whoever keeps the clock asks when the
// next wait is over and comes back then.

import type { CaptionLine } from '../translate/types.ts'

/** A sentence the listener translates itself after all, with what was said before it. */
export interface Taken {
  caption: CaptionLine
  earlier: readonly string[]
}

interface Sentence extends Taken {
  from: string
  due: number | null
  taken: boolean
  arrived: boolean
}

function sentenceKey(caption: Pick<CaptionLine, 'speaker' | 'segId'>): string {
  return `${caption.speaker}\n${caption.segId}`
}

export class Awaited {
  private readonly sentences = new Map<string, Sentence>()
  private readonly waitMs: number

  constructor(waitMs: number) {
    this.waitMs = waitMs
  }

  get size(): number {
    return this.sentences.size
  }

  /** When the next wait is over; null while nothing is waited for. */
  get nextDue(): number | null {
    const dues = [...this.sentences.values()].flatMap((sentence) => (sentence.due === null ? [] : [sentence.due]))
    return dues.length === 0 ? null : Math.min(...dues)
  }

  /**
   * A caption whose translation is from's to send. The listener waits,
   * unless it took the sentence over when an earlier state of it went
   * untranslated: then this state is the listener's as well.
   */
  heard(caption: CaptionLine, earlier: readonly string[], from: string, now: number): 'wait' | 'take' {
    this.supersede(caption)

    const key = sentenceKey(caption)
    const known = this.sentences.get(key)
    if (known?.taken) {
      if (caption.final) this.sentences.delete(key)
      else this.sentences.set(key, { ...known, caption, earlier, from })
      return 'take'
    }

    const arrived = known?.arrived ?? false
    const due = known?.due ?? (arrived && !caption.final ? null : now + this.waitMs)
    this.sentences.set(key, { caption, earlier, from, due, taken: false, arrived })
    return 'wait'
  }

  /**
   * A translation of the sentence arrived. A final one settles it. One of
   * an unfinished state ends the wait for that state only: once the
   * finished caption is heard, nothing but its translation does.
   */
  translated(line: Pick<CaptionLine, 'speaker' | 'segId' | 'final'>): void {
    const key = sentenceKey(line)
    const sentence = this.sentences.get(key)
    if (!sentence) return
    if (line.final) {
      this.sentences.delete(key)
      return
    }
    sentence.arrived = true
    if (!sentence.caption.final) sentence.due = null
  }

  /** The sentences whose wait is over at now: the listener's from here on. */
  overdue(now: number): Taken[] {
    const taken: Taken[] = []
    for (const [key, sentence] of this.sentences) {
      if (sentence.due === null || sentence.due > now) continue
      sentence.due = null
      sentence.taken = true
      if (sentence.caption.final) this.sentences.delete(key)
      taken.push({ caption: sentence.caption, earlier: sentence.earlier })
    }
    return taken
  }

  /**
   * The room's translator into the listener's language is translator
   * now. What was left to anyone else will not come, so those sentences
   * are forgotten, and the ones still waited for are handed back to be
   * translated at once.
   */
  reassigned(translator: string | null): Taken[] {
    const taken: Taken[] = []
    for (const [key, sentence] of this.sentences) {
      if (sentence.from === translator) continue
      this.sentences.delete(key)
      if (sentence.due !== null) taken.push({ caption: sentence.caption, earlier: sentence.earlier })
    }
    return taken
  }

  /** Forgets the sentences of a speaker who will not be heard from again. */
  forget(speaker: string): void {
    for (const [key, sentence] of this.sentences) if (sentence.caption.speaker === speaker) this.sentences.delete(key)
  }

  clear(): void {
    this.sentences.clear()
  }

  // A speaker says one sentence at a time, so a caption of a new one
  // means every earlier one is finished: a state of it that is still
  // unfinished here will never be followed by its final caption.
  private supersede(caption: CaptionLine): void {
    for (const [key, sentence] of this.sentences) {
      const earlier = sentence.caption.speaker === caption.speaker && sentence.caption.segId !== caption.segId
      if (earlier && !sentence.caption.final) this.sentences.delete(key)
    }
  }
}
