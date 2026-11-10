// The app's themes. The ids are what browsers store, so they stay put.
// Every theme is in the picker in the settings; the toggle in the header
// only switches between the two a call is usually wanted in, so that the
// third is a choice rather than something a click cycles past.
export const THEMES = ['dark', 'light', 'hud'] as const

export type Theme = (typeof THEMES)[number]

export const THEME_LABELS: Record<Theme, string> = { dark: 'Dark', light: 'Light', hud: 'Cyberchat 2077' }

/** The themes the header's toggle switches between, in order. */
export const TOGGLE_THEMES = ['dark', 'light'] as const satisfies readonly Theme[]

export function nextToggleTheme(current: Theme): Theme {
  return TOGGLE_THEMES[(TOGGLE_THEMES.findIndex((theme) => theme === current) + 1) % TOGGLE_THEMES.length]
}

export type ThemeChoice = Theme | 'system'

export const DEFAULT_THEME: ThemeChoice = 'dark'

export function parseThemeChoice(stored: unknown): ThemeChoice {
  if (stored === 'system') return stored
  return THEMES.find((theme) => theme === stored) ?? DEFAULT_THEME
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  if (choice !== 'system') return choice
  return systemDark ? 'dark' : 'light'
}

export function colorScheme(theme: Theme): 'dark' | 'light' {
  return theme === 'light' ? 'light' : 'dark'
}
