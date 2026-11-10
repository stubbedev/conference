// How long the bridge keeps at its connection to the speech service. An
// attempt that is turned away, times out or drops before it has lasted
// counts against the next ones, and after a few in a row the bridge
// gives up and says so. A connection that lasted is a service that
// works: its end starts the count anew.

export const MAX_ATTEMPTS = 3

/** How long a connection has to stay open to count as one that worked. */
export const SETTLED_MS = 30_000

/** How long one attempt gets to open, and before that to be given its token. */
export const CONNECT_TIMEOUT_MS = 10_000

export const RECONNECT_DELAY_MS = 2_000

/** How an attempt ended: before it opened, or after it had been open for lastedMs. */
export type Ended = { how: 'refused' } | { how: 'dropped'; lastedMs: number }

export interface Verdict {
  /** The attempts in a row that did not last, this one included. */
  failures: number
  next: 'retry' | 'give-up'
  /** What to tell the member. */
  detail: string
}

export function afterEnd(failures: number, ended: Ended): Verdict {
  if (ended.how === 'dropped' && ended.lastedMs >= SETTLED_MS) {
    return { failures: 0, next: 'retry', detail: 'The speech connection dropped; reconnecting.' }
  }

  const count = failures + 1
  const refused = ended.how === 'refused'
  if (count >= MAX_ATTEMPTS) {
    const detail = refused ? 'The speech service cannot be reached or refused the connection.' : 'The speech connection keeps dropping as soon as it opens.'
    return { failures: count, next: 'give-up', detail }
  }

  const what = refused ? 'The speech service did not answer' : 'The speech connection dropped right after it opened'
  return { failures: count, next: 'retry', detail: `${what} (try ${count} of ${MAX_ATTEMPTS}).` }
}
