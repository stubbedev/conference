// The message loop every speech worker runs: one request at a time, a
// reply with the request's id, and an error reply instead of an exception
// the page cannot see. Handlers answer with the body of their reply and,
// when they hand over audio, the buffers the worker no longer needs.
//
// Requests are queued rather than run at once: a worker holds one session
// on a GPU or a single WebAssembly thread, and the page asks it for work
// from several places at the same time (an interim caption while a
// sentence is still being spoken, two listeners' languages).

import { errorMessage } from '../errors'
import { Serial } from './serial'

/** err with whatever caused it, which is where a wrapped failure says why. */
function reason(err: unknown): string {
  const cause = err instanceof Error && err.cause ? err.cause : null
  return cause ? `${errorMessage(err)}: ${reason(cause)}` : errorMessage(err)
}

/** One request as it arrives, with the id the page waits for. */
export interface Request {
  id?: number
  type: string
  [key: string]: unknown
}

/** A reply's body, and what it hands over when it is sent. */
export type Answer = [body: Record<string, unknown>, transfer?: Transferable[]]

export type Handler = (request: Request) => Promise<Answer | void> | Answer | void

/**
 * The worker's own scope. This file is also compiled for a window, through
 * the page's engines, and only a worker's postMessage takes a transfer
 * list.
 */
interface Scope {
  onmessage: ((event: MessageEvent<Request>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

const scope = self as unknown as Scope

/** Runs handler for every message the worker receives, one at a time. */
export function serve(handler: Handler): void {
  const queue = new Serial()

  scope.onmessage = (event: MessageEvent<Request>) => {
    const request = event.data
    void queue.run(async () => {
      try {
        const [body, transfer] = (await handler(request)) ?? [{}]
        if (request.id !== undefined) scope.postMessage({ ...body, id: request.id, type: 'done' }, transfer ?? [])
      } catch (err) {
        scope.postMessage({ id: request.id, type: 'error', message: reason(err) })
      }
    })
  }
}

export function notify(event: string, body: Record<string, unknown>, transfer: Transferable[] = []): void {
  scope.postMessage({ ...body, event }, transfer)
}
