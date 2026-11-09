export const GPU_STALL_MS = 300_000

export class GpuWatch {
  private readonly stallMs: number
  private readonly onStall: () => void
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(stallMs: number, onStall: () => void) {
    this.stallMs = stallMs
    this.onStall = onStall
  }

  started(): void {
    this.settled()
    this.timer = setTimeout(() => {
      this.timer = null
      this.onStall()
    }, this.stallMs)
  }

  active(): void {
    if (this.timer !== null) this.started()
  }

  settled(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
