import type { WorkerReply } from './worker.ts'

export interface Port {
  close(): void
}

export class Workers<P, C extends Port> {
  private readonly open: (purpose: P) => C
  private readonly ports = new Map<P, C>()
  private readonly loads = new Map<P, Promise<WorkerReply>>()

  constructor(open: (purpose: P) => C) {
    this.open = open
  }

  port(purpose: P): C {
    const known = this.ports.get(purpose)
    if (known) return known

    const port = this.open(purpose)
    this.ports.set(purpose, port)
    return port
  }

  load(purpose: P, init: (port: C) => Promise<WorkerReply>): Promise<WorkerReply> {
    const known = this.loads.get(purpose)
    if (known) return known

    const port = this.port(purpose)
    const pending: Promise<WorkerReply> = init(port).catch((err: unknown) => {
      if (this.ports.get(purpose) === port) this.close(purpose)
      throw err
    })
    this.loads.set(purpose, pending)
    return pending
  }

  close(purpose: P): void {
    this.loads.delete(purpose)

    const port = this.ports.get(purpose)
    if (!port) return

    this.ports.delete(purpose)
    port.close()
  }

  closeAll(): void {
    for (const purpose of [...this.ports.keys()]) this.close(purpose)
  }
}
