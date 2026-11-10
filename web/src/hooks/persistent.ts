import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

import { readStored, writeStored } from '../lib/storage.ts'

interface PersistentOptions<T> {
  /**
   * Turns whatever storage holds into a valid value: an older build or a
   * hand edit may have left anything there, and it is undefined when
   * nothing is stored or readable, so this is also where the default
   * comes from.
   */
  parse: (stored: unknown) => T
}

// State kept in localStorage under key. Nothing read from storage is
// trusted, so there is no initial value to pass, only the parser.
export function usePersistentState<T>(key: string, { parse }: PersistentOptions<T>): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(() => parse(readStored(key)))

  // Updaters stay pure so React can bail out when one returns the
  // previous value; persistence happens after the render that changed
  // the value, which also writes the parsed shape back on first load.
  useEffect(() => writeStored(key, value), [key, value])

  return [value, setValue]
}
