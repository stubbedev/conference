const WINDOW = 3
const BEHIND = 1

export class Pace {
  private readonly factors: number[] = []

  record(audioSeconds: number, tookSeconds: number): void {
    if (audioSeconds <= 0) return
    this.factors.push(tookSeconds / audioSeconds)
    if (this.factors.length > WINDOW) this.factors.shift()
  }

  get behind(): boolean {
    return this.factors.length === WINDOW && this.factors.every((factor) => factor > BEHIND)
  }

  reset(): void {
    this.factors.length = 0
  }
}

export const BACKGROUND_DUTY = 0.3

export function nextRunAt(finishedAt: number, tookMs: number, minGapMs: number, duty = BACKGROUND_DUTY): number {
  return finishedAt + Math.max(minGapMs, (tookMs * (1 - duty)) / duty)
}
