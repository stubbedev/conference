import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'

import { apply, DARK_QUERY, store, storedChoice, STORAGE_KEY, systemDark, ThemeContext } from '@/lib/theme'
import { parseThemeChoice, resolveTheme, type ThemeChoice } from '@/lib/themes'

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState(storedChoice)
  const [dark, setDark] = useState(systemDark)
  const theme = resolveTheme(choice, dark)

  useLayoutEffect(() => apply(theme), [theme])

  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY)
    const follow = () => setDark(query.matches)
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setChoice(parseThemeChoice(event.newValue))
    }
    query.addEventListener('change', follow)
    window.addEventListener('storage', sync)
    return () => {
      query.removeEventListener('change', follow)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const setTheme = useCallback((next: ThemeChoice) => {
    store(next)
    setChoice(next)
  }, [])

  const state = useMemo(() => ({ theme, setTheme }), [theme, setTheme])
  return <ThemeContext.Provider value={state}>{children}</ThemeContext.Provider>
}

