import { useCallback, useEffect, useState } from 'react'

export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  migrate?: (stored: T) => T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    const fallback = typeof initial === 'function' ? (initial as () => T)() : initial
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return fallback
      const stored = JSON.parse(raw) as T
      return migrate ? migrate(stored) : stored
    } catch {
      return fallback
    }
  })

  // The updater is pure so React can bail out when it returns the
  // previous value; persistence happens after the render that changed
  // the value, which also writes a migrated shape back on first load.
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage full or blocked: the state still works for this session
    }
  }, [key, value])

  const update = useCallback((next: T | ((prev: T) => T)) => setValue(next), [])

  return [value, update]
}
