// The request/response wrapper every speech worker speaks: a message per
// call, a reply with the same id, and an error reply instead of a thrown
// exception the caller cannot see.

export interface WorkerReply {
  id?: number
  type: 'done' | 'error'
  message?: string
  [key: string]: unknown
}

interface Pending {
  resolve: (reply: WorkerReply) => void
  reject: (error: Error) => void
}

/** Calls into one worker and hands back what it replies. */
export class WorkerRpc {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private next = 0
  private closed = false

  constructor(worker: Worker) {
    this.worker = worker
    worker.onmessage = (event: MessageEvent<WorkerReply>) => this.settle(event.data)
    worker.onerror = (event) => this.failAll(new Error(event.message || 'the speech worker failed'))
  }

  call<T extends WorkerReply>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the speech worker is closed'))

    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (reply: WorkerReply) => void, reject })
      this.worker.postMessage({ ...message, id }, transfer)
    })
  }

  close(): void {
    this.closed = true
    this.failAll(new Error('the speech worker is closed'))
    this.worker.terminate()
  }

  private settle(reply: WorkerReply): void {
    if (reply.id === undefined) return
    const pending = this.pending.get(reply.id)
    if (!pending) return
    this.pending.delete(reply.id)

    if (reply.type === 'error') pending.reject(new Error(reply.message ?? 'the speech worker failed'))
    else pending.resolve(reply)
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
