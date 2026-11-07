export class Recent<V> {
  private readonly entries = new Map<string, V>()
  private readonly capacity: number

  constructor(capacity: number) {
    if (!(capacity > 0)) throw new RangeError(`a recent-results cache needs room for at least one entry, got ${capacity}`)
    this.capacity = capacity
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size <= this.capacity) return
    const oldest = this.entries.keys().next().value
    if (oldest !== undefined) this.entries.delete(oldest)
  }
}
