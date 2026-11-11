// What the page and the E2EE worker say to each other: the options a
// transform is attached with, the messages the page posts, and the
// counters the worker reports back. Types and pure functions only, so
// both sides compile it against their own typings.

export type Purpose = 'send' | 'recv'

/** What the page hands the worker with every transform it attaches. */
export interface TransformOptions {
  purpose: Purpose
  /** Names the transform in the worker's counters; unique per page. */
  id: number
}

export function isTransformOptions(value: unknown): value is TransformOptions {
  if (typeof value !== 'object' || value === null) return false
  const { purpose, id } = value as { purpose?: unknown; id?: unknown }
  return (purpose === 'send' || purpose === 'recv') && typeof id === 'number'
}

/**
 * What the page posts to the worker: the room's media key, and the
 * transforms of a connection it has closed. A browser does not end a
 * transform's streams with its connection, so only the page can say that
 * a transform is over.
 */
export type WorkerMessage = { type: 'key'; keyBytes: Uint8Array<ArrayBuffer> } | { type: 'closed'; ids: number[] }

/** The frames of one transform the worker is piping. */
export interface TransformCounts extends TransformOptions {
  /** When the worker started piping it, in milliseconds since the epoch. */
  openedAt: number
  /** Frames the browser handed in. */
  read: number
  /** Frames handed back, encrypted or decrypted. */
  written: number
  dropped: number
}

// E2EEStats is what the worker posts every couple of seconds: frames
// processed and dropped per direction since it started, the last error
// text, and the counters of every transform it is piping right now.
export interface E2EEStats {
  type: 'e2ee-stats'
  send: number
  recv: number
  dropSend: number
  dropRecv: number
  lastError: string
  transforms: TransformCounts[]
}

export function isE2EEStats(data: unknown): data is E2EEStats {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'e2ee-stats'
}
