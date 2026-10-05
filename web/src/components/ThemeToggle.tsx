import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Button } from '@/components/ui/button'
import { Hint } from '@/components/Hint'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  return (
    <Hint label="Toggle theme" side="bottom">
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label="Toggle theme"
        onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      >
        {mounted && resolvedTheme === 'dark' ? <Sun /> : <Moon />}
      </Button>
    </Hint>
  )
}
