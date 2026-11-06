import { Moon, ScanLine, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/Hint'
import { THEME_LABELS, TOGGLE_THEMES } from '@/lib/themes'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const current = resolvedTheme ?? TOGGLE_THEMES[0]
  // A theme picked in the settings that the toggle does not cycle (Cyberchat
  // 2077) counts as off the list, which lands the click on the first one.
  const next = TOGGLE_THEMES[(TOGGLE_THEMES.indexOf(current as (typeof TOGGLE_THEMES)[number]) + 1) % TOGGLE_THEMES.length]
  // The icon shows the current theme; a click moves to the next one.
  const label = `Theme: ${THEME_LABELS[current as keyof typeof THEME_LABELS] ?? current} (switch to ${THEME_LABELS[next]})`

  return (
    <Hint label={label} side="bottom">
      <Button variant="ghost" size="icon" className="size-8" aria-label={label} onClick={() => setTheme(next)}>
        {current === 'light' ? <Sun /> : current === 'dark' ? <Moon /> : <ScanLine />}
      </Button>
    </Hint>
  )
}
