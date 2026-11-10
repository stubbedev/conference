import { createContext, useContext } from 'react'

import { colorScheme, parseThemeChoice, resolveTheme, THEMES, type Theme, type ThemeChoice } from '@/lib/themes'

export const STORAGE_KEY = 'theme'
export const DARK_QUERY = '(prefers-color-scheme: dark)'
const NO_TRANSITIONS = '*,*::before,*::after{transition:none!important}'

export interface ThemeState {
  theme: Theme
  setTheme: (choice: ThemeChoice) => void
}

export const ThemeContext = createContext<ThemeState | null>(null)

export function storedChoice(): ThemeChoice {
  try {
    return parseThemeChoice(localStorage.getItem(STORAGE_KEY))
  } catch {
    return parseThemeChoice(null)
  }
}

export function store(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    console.warn('the theme cannot be remembered: this browser refuses local storage')
  }
}

export function systemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches
}

export function apply(theme: Theme): void {
  const root = document.documentElement
  if (root.classList.contains(theme) && root.style.colorScheme === colorScheme(theme)) return

  const pause = document.createElement('style')
  pause.textContent = NO_TRANSITIONS
  document.head.appendChild(pause)

  root.classList.remove(...THEMES)
  root.classList.add(theme)
  root.style.colorScheme = colorScheme(theme)

  void window.getComputedStyle(document.body).opacity
  setTimeout(() => pause.remove(), 1)
}

export function applyStoredTheme(): void {
  apply(resolveTheme(storedChoice(), systemDark()))
}

export function useTheme(): ThemeState {
  const state = useContext(ThemeContext)
  if (!state) throw new Error('useTheme needs a ThemeProvider above it')
  return state
}
