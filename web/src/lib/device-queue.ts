import { Serial } from './speech/serial.ts'

export interface ToggleOutcome {
  on: boolean
  open: boolean
}

export class DeviceQueue<K extends string> {
  private readonly serial = new Serial()
  private readonly counts = new Map<K, number>()
  private closed = false

  run(kinds: readonly K[], task: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.count(kinds, 1)
    return this.serial
      .run(async () => {
        if (this.closed) return
        await task()
      })
      .finally(() => this.count(kinds, -1))
  }

  pending(kind: K): boolean {
    return (this.counts.get(kind) ?? 0) > 0
  }

  toggle(kind: K, on: boolean, hasTrack: boolean): ToggleOutcome {
    if (hasTrack || this.pending(kind)) return { on: !on, open: false }
    return { on: true, open: true }
  }

  close(teardown: () => void): Promise<void> {
    this.closed = true
    teardown()
    return this.serial.run(teardown)
  }

  private count(kinds: readonly K[], delta: 1 | -1): void {
    for (const kind of kinds) this.counts.set(kind, (this.counts.get(kind) ?? 0) + delta)
  }
}
