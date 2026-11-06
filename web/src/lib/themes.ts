// The app's themes. The ids are what browsers store, so they stay put.
// Every theme is in the picker in the settings; the toggle in the header
// only switches between the two a call is usually wanted in, so that the
// third is a choice rather than something a click cycles past.
export const THEMES = ['dark', 'light', 'hud'] as const

export type Theme = (typeof THEMES)[number]

export const THEME_LABELS: Record<Theme, string> = { dark: 'Dark', light: 'Light', hud: 'Cyberchat 2077' }

/** The themes the header's toggle switches between, in order. */
export const TOGGLE_THEMES = ['dark', 'light'] as const satisfies readonly Theme[]
