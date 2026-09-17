'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'

type Theme = 'light' | 'dark'
/** What the reader picked. 'system' is not a theme by itself — it means
    "whatever the OS says right now", which can change without a click. */
export type ColorMode = 'light' | 'dark' | 'system'

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

function resolve(mode: ColorMode): Theme {
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
}

const ThemeContext = createContext<{
  /** The RESOLVED theme — what is actually painted. Every existing consumer
      that just wants to know "is it dark right now" reads this and never
      has to think about 'system' at all. */
  theme: Theme
  /** What the reader picked, including 'system' — only the customizer panel
      needs this, to know which of the three options is lit. */
  mode: ColorMode
  setMode: (m: ColorMode) => void
  /** Unchanged from before 'system' existed: cycles light↔dark. A reader on
      'system' who uses the plain toggle button (rather than the customizer)
      is picking a concrete side explicitly, which is why this always lands
      on 'light' or 'dark', never back on 'system'. */
  toggle: () => void
}>({
  theme: 'light', mode: 'light', setMode: () => {}, toggle: () => {},
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>('light')
  const [theme, setTheme] = useState<Theme>('light')

  function paint(t: Theme) {
    setTheme(t)
    document.documentElement.classList.toggle('dark', t === 'dark')
  }

  function setMode(m: ColorMode) {
    setModeState(m)
    localStorage.setItem('theme', m)
    paint(resolve(m))
  }

  useEffect(() => {
    const saved = (localStorage.getItem('theme') as ColorMode | null) ?? 'light'
    setModeState(saved)
    paint(resolve(saved))
  }, [])

  /* Only while mode is 'system': the OS can change its own preference (a
     scheduled night mode, a manual switch) with nobody touching this page,
     and 'system' means the page follows it live, not just at the moment it
     was picked. Torn down the instant mode leaves 'system' so a light/dark
     pick that happens to match the OS right now does not quietly start
     tracking it again on the next OS change. */
  const modeRef = useRef(mode)
  modeRef.current = mode
  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => { if (modeRef.current === 'system') paint(mq.matches ? 'dark' : 'light') }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  function toggle() {
    setMode(theme === 'light' ? 'dark' : 'light')
  }

  return (
    <ThemeContext.Provider value={{ theme, mode, setMode, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
