// The app's themes, in the order the theme toggle cycles through them.
// "hud" is shown as Cyberchat 2077. The ids are what browsers store, so
// they stay put.
export const THEMES = ['dark', 'light', 'hud'] as const

export const THEME_LABELS: Record<string, string> = { dark: 'Dark', light: 'Light', hud: 'Cyberchat 2077' }
