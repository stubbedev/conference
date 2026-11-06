import { useTheme } from 'next-themes'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { THEME_LABELS, THEMES } from '@/lib/themes'

// The themes by name, for the settings; the header's toggle cycles the two
// that are listed for it, which is a shorter list than this one.
export function ThemeSelect() {
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor="theme" className="text-xs text-muted-foreground">
        Theme
      </Label>
      <Select value={resolvedTheme ?? THEMES[0]} onValueChange={setTheme}>
        <SelectTrigger id="theme" className="w-full">
          <span className="min-w-0 flex-1 truncate text-left">
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>
          {THEMES.map((theme) => (
            <SelectItem key={theme} value={theme}>
              {THEME_LABELS[theme]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
