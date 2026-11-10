export class GpuWatch {
  private readonly onStall: () => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private budgetMs = 0
  private lastActivity = 0
  private longestQuiet = 0

  constructor(onStall: () => void) {
    this.onStall = onStall
  }

  started(budgetMs: number): void {
    this.stop()
    this.budgetMs = budgetMs
    this.longestQuiet = 0
    this.lastActivity = performance.now()
    this.arm()
  }

  active(): void {
    if (this.timer === null) return
    this.noteQuiet()
    this.arm()
  }

  settled(): number | null {
    if (this.timer === null) return null
    this.noteQuiet()
    this.stop()
    return this.longestQuiet
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private noteQuiet(): void {
    const now = performance.now()
    this.longestQuiet = Math.max(this.longestQuiet, now - this.lastActivity)
    this.lastActivity = now
  }

  private arm(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.onStall()
    }, this.budgetMs)
  }
}
