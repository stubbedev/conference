import { Moon, ScanLine, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/Hint'
import { useTheme } from '@/lib/theme'
import { nextToggleTheme, THEME_LABELS } from '@/lib/themes'

export function ThemeToggle() {
  const { theme: current, setTheme } = useTheme()
  const next = nextToggleTheme(current)
  // The icon shows the current theme; a click moves to the next one.
  const label = `Theme: ${THEME_LABELS[current]} (switch to ${THEME_LABELS[next]})`

  return (
    <Hint label={label} side="bottom">
      <Button variant="ghost" size="icon" className="size-8" onClick={() => setTheme(next)}>
        {current === 'light' ? <Sun /> : current === 'dark' ? <Moon /> : <ScanLine />}
      </Button>
    </Hint>
  )
}
