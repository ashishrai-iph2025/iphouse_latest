'use client'

import { createContext, useContext, useEffect, useState } from 'react'

export type AccentColor  = 'orange' | 'blue' | 'green' | 'purple' | 'pink' | 'yellow' | 'red' | 'teal'
export type LayoutWidth  = 'fluid' | 'boxed'
export type NavbarStyle  = 'default' | 'dark' | 'navy' | 'slate' | 'blue' | 'violet' | 'emerald' | 'rose'
export type SidebarColor = 'navy' | 'dark' | 'slate' | 'blue' | 'violet' | 'emerald' | 'rose' | 'gray'
export type CardStyle    = 'bordered' | 'borderless' | 'shadow'
export type NavLayout    = 'default' | 'mini' | 'horizontal' | 'horizontal-single' | 'detached' | 'two-column' | 'without-header' | 'overlay' | 'menu-aside' | 'menu-stacked' | 'modern' | 'transparent' | 'rtl'
export type SidebarSize  = 'default' | 'compact' | 'hover'

export const NAVBAR_HEX: Record<NavbarStyle, string> = {
  default:  '#ffffff',
  dark:     '#1f2937',
  navy:     '#14254A',
  slate:    '#334155',
  blue:     '#0078D4',
  violet:   '#7C3AED',
  emerald:  '#059669',
  rose:     '#e11d48',
}

export const SIDEBAR_HEX: Record<SidebarColor, string> = {
  navy:    '#14254A',
  dark:    '#1f2937',
  slate:   '#334155',
  blue:    '#0078D4',
  violet:  '#7C3AED',
  emerald: '#059669',
  rose:    '#e11d48',
  gray:    '#4b5563',
}

interface CustomizerState {
  accentColor:  AccentColor
  layoutWidth:  LayoutWidth
  navbarStyle:  NavbarStyle
  sidebarColor: SidebarColor
  cardStyle:    CardStyle
  navLayout:    NavLayout
  sidebarSize:  SidebarSize
}

interface CustomizerCtx extends CustomizerState {
  setAccentColor:  (v: AccentColor)  => void
  setLayoutWidth:  (v: LayoutWidth)  => void
  setNavbarStyle:  (v: NavbarStyle)  => void
  setSidebarColor: (v: SidebarColor) => void
  setCardStyle:    (v: CardStyle)    => void
  setNavLayout:    (v: NavLayout)    => void
  setSidebarSize:  (v: SidebarSize)  => void
}

const ACCENT_MAP: Record<AccentColor, { primary: string; ring: string }> = {
  orange: { primary: '#FC934C', ring: 'rgba(252,147,76,0.25)' },
  blue:   { primary: '#0078D4', ring: 'rgba(0,120,212,0.25)' },
  green:  { primary: '#16A34A', ring: 'rgba(22,163,74,0.25)' },
  purple: { primary: '#7C3AED', ring: 'rgba(124,58,237,0.25)' },
  pink:   { primary: '#DB2777', ring: 'rgba(219,39,119,0.25)' },
  yellow: { primary: '#D97706', ring: 'rgba(217,119,6,0.25)' },
  red:    { primary: '#DC2626', ring: 'rgba(220,38,38,0.25)' },
  teal:   { primary: '#0891B2', ring: 'rgba(8,145,178,0.25)' },
}

const DEFAULTS: CustomizerState = {
  accentColor:  'orange',
  layoutWidth:  'fluid',
  navbarStyle:  'default',
  sidebarColor: 'navy',
  cardStyle:    'bordered',
  navLayout:    'horizontal',
  sidebarSize:  'default',
}

const CustomizerContext = createContext<CustomizerCtx>({
  ...DEFAULTS,
  setAccentColor:  () => {},
  setLayoutWidth:  () => {},
  setNavbarStyle:  () => {},
  setSidebarColor: () => {},
  setCardStyle:    () => {},
  setNavLayout:    () => {},
  setSidebarSize:  () => {},
})

function applyAccent(color: AccentColor) {
  const { primary, ring } = ACCENT_MAP[color]
  document.documentElement.style.setProperty('--accent',      primary)
  document.documentElement.style.setProperty('--accent-ring', ring)
}
function applyLayout(width: LayoutWidth)     { document.documentElement.setAttribute('data-layout',     width) }
function applyNavbar(style: NavbarStyle)     {
  document.documentElement.setAttribute('data-navbar', style)
  document.documentElement.style.setProperty('--navbar-bg', NAVBAR_HEX[style])
}
function applySidebarColor(c: SidebarColor) {
  document.documentElement.style.setProperty('--sidebar-bg', SIDEBAR_HEX[c])
}
function applyCard(style: CardStyle)         { document.documentElement.setAttribute('data-card',        style) }
function applyNavLayout(layout: NavLayout)   { document.documentElement.setAttribute('data-nav-layout',  layout) }
function applySidebarSize(size: SidebarSize) { document.documentElement.setAttribute('data-sidebar',     size) }

export function ThemeCustomizerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<CustomizerState>(DEFAULTS)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('ip_customizer')
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<CustomizerState>
        if ((parsed as any).navLayout === 'default') parsed.navLayout = 'horizontal'
        const merged = { ...DEFAULTS, ...parsed }
        setState(merged)
        applyAccent(merged.accentColor)
        applyLayout(merged.layoutWidth)
        applyNavbar(merged.navbarStyle)
        applySidebarColor(merged.sidebarColor)
        applyCard(merged.cardStyle)
        applyNavLayout(merged.navLayout)
        applySidebarSize(merged.sidebarSize)
        return
      }
    } catch {}
    applyAccent(DEFAULTS.accentColor)
    applyLayout(DEFAULTS.layoutWidth)
    applyNavbar(DEFAULTS.navbarStyle)
    applySidebarColor(DEFAULTS.sidebarColor)
    applyCard(DEFAULTS.cardStyle)
    applyNavLayout(DEFAULTS.navLayout)
    applySidebarSize(DEFAULTS.sidebarSize)
  }, [])

  function save(next: CustomizerState) { setState(next); localStorage.setItem('ip_customizer', JSON.stringify(next)) }

  function setAccentColor(v: AccentColor)   { save({ ...state, accentColor: v  }); applyAccent(v) }
  function setLayoutWidth(v: LayoutWidth)   { save({ ...state, layoutWidth: v  }); applyLayout(v) }
  function setNavbarStyle(v: NavbarStyle)   { save({ ...state, navbarStyle: v  }); applyNavbar(v) }
  function setSidebarColor(v: SidebarColor) { save({ ...state, sidebarColor: v }); applySidebarColor(v) }
  function setCardStyle(v: CardStyle)       { save({ ...state, cardStyle: v    }); applyCard(v) }
  function setNavLayout(v: NavLayout)       { save({ ...state, navLayout: v    }); applyNavLayout(v) }
  function setSidebarSize(v: SidebarSize)   { save({ ...state, sidebarSize: v  }); applySidebarSize(v) }

  return (
    <CustomizerContext.Provider value={{ ...state, setAccentColor, setLayoutWidth, setNavbarStyle, setSidebarColor, setCardStyle, setNavLayout, setSidebarSize }}>
      {children}
    </CustomizerContext.Provider>
  )
}

export const useCustomizer = () => useContext(CustomizerContext)
export { ACCENT_MAP }
