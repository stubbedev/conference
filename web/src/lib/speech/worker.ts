// The request/response wrapper every speech worker speaks: a message per
// call, a reply with the same id, and an error reply instead of a thrown
// exception the caller cannot see.

export interface WorkerEvent {
  event: string
  [key: string]: unknown
}

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
  private readonly name: string
  private readonly pending = new Map<number, Pending>()
  private next = 0
  private closed = false
  private spoke = false
  private unstarted: Error | null = null
  private readonly onEvent: (event: WorkerEvent) => void

  constructor(worker: Worker, name: string, onEvent: (event: WorkerEvent) => void) {
    this.worker = worker
    this.name = name
    this.onEvent = onEvent
    worker.onmessage = (event: MessageEvent<WorkerReply | WorkerEvent>) => {
      this.spoke = true
      this.receive(event.data)
    }
    worker.onerror = (event) => this.crashed(event)
  }

  post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
    if (this.closed) return
    this.worker.postMessage(message, transfer)
  }

  call<T extends WorkerReply>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the speech worker is closed'))
    if (this.unstarted) return Promise.reject(this.unstarted)

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

  private receive(message: WorkerReply | WorkerEvent): void {
    if ('event' in message && typeof message.event === 'string') {
      this.onEvent(message as WorkerEvent)
      return
    }
    this.settle(message as WorkerReply)
  }

  private settle(reply: WorkerReply): void {
    if (reply.id === undefined) {
      if (reply.type === 'error') this.onEvent({ event: 'error', message: reply.message ?? 'the speech worker failed' })
      return
    }
    const pending = this.pending.get(reply.id)
    if (!pending) return
    this.pending.delete(reply.id)

    if (reply.type === 'error') pending.reject(new Error(reply.message ?? 'the speech worker failed'))
    else pending.resolve(reply)
  }

  private crashed(event: ErrorEvent): void {
    if (this.spoke) {
      this.failAll(new Error(event.message || 'the speech worker failed'))
      return
    }
    this.unstarted = new Error(`the ${this.name} worker could not start: ${event.message || 'its code could not be loaded'}`)
    this.failAll(this.unstarted)
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
