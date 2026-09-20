import { useCallback, useState } from 'react'

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

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next
        try {
          localStorage.setItem(key, JSON.stringify(resolved))
        } catch {
          return resolved
        }
        return resolved
      })
    },
    [key],
  )

  return [value, update]
}
