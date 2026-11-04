import { Moon, ScanLine, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/Hint'
import { THEME_LABELS, THEMES } from '@/lib/themes'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const current = resolvedTheme ?? THEMES[0]
  const next = THEMES[(THEMES.indexOf(current as (typeof THEMES)[number]) + 1) % THEMES.length]
  // The icon shows the current theme; a click moves to the next one.
  const label = `Theme: ${THEME_LABELS[current] ?? current} (switch to ${THEME_LABELS[next]})`

  return (
    <Hint label={label} side="bottom">
      <Button variant="ghost" size="icon" className="size-8" aria-label={label} onClick={() => setTheme(next)}>
        {current === 'light' ? <Sun /> : current === 'dark' ? <Moon /> : <ScanLine />}
      </Button>
    </Hint>
  )
}
