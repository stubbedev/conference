import { Serial } from './speech/serial.ts'

export interface ToggleOutcome {
  on: boolean
  open: boolean
}

export class DeviceQueue<K extends string> {
  private readonly serial = new Serial()
  private readonly counts = new Map<K, number>()
  private readonly listeners = new Set<() => void>()
  private closed = false

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

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

  available(kind: K, hasTrack: boolean): boolean {
    return hasTrack || this.pending(kind)
  }

  toggle(kind: K, on: boolean, hasTrack: boolean): ToggleOutcome {
    if (this.available(kind, hasTrack)) return { on: !on, open: false }
    return { on: true, open: true }
  }

  close(teardown: () => void): Promise<void> {
    this.closed = true
    teardown()
    return this.serial.run(teardown)
  }

  private count(kinds: readonly K[], delta: 1 | -1): void {
    if (kinds.length === 0) return
    for (const kind of kinds) this.counts.set(kind, (this.counts.get(kind) ?? 0) + delta)
    for (const listener of this.listeners) listener()
  }
}
