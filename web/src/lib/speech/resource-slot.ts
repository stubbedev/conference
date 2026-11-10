export class ResourceSlot<T extends { close(): void }> {
  private held: T | null = null
  private opening: Promise<T | null> | null = null
  private closed = false

  get current(): T | null {
    return this.held
  }

  fill(open: () => Promise<T>): Promise<T | null> {
    if (this.closed) return Promise.resolve(null)
    if (this.held) return Promise.resolve(this.held)
    this.opening ??= Promise.resolve()
      .then(open)
      .then((resource) => this.keep(resource))
      .finally(() => {
        this.opening = null
      })
    return this.opening
  }

  close(): void {
    this.closed = true
    this.held?.close()
    this.held = null
  }

  private keep(resource: T): T | null {
    if (this.closed) {
      resource.close()
      return null
    }
    this.held = resource
    return resource
  }
}
