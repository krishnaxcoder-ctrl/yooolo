export type Theme = 'light' | 'dark'

const KEY = 'yooolo.theme'

/** The chosen theme, or the system's when none has been chosen. */
export function currentTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // Storage blocked: follow the system.
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Applies a theme through `data-theme` on <html>, which the CSS tokens key off, and remembers it. */
export function applyTheme(theme: Theme, remember = true) {
  document.documentElement.dataset.theme = theme
  if (!remember) return
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Not remembered in private windows.
  }
}
