'use client'

import { useState, useEffect } from 'react'
import { useTheme } from '@/lib/ThemeContext'
import {
  useCustomizer, ACCENT_MAP, NAVBAR_HEX, SIDEBAR_HEX,
  type AccentColor, type LayoutWidth, type NavbarStyle, type SidebarColor, type CardStyle,
  type NavLayout, type SidebarSize,
} from '@/lib/ThemeCustomizerContext'

// Set to true to show the floating Theme Customizer gear button in the UI.
// Hidden by default (config-only) — the panel and all logic remain intact.
const SHOW_THEME_CUSTOMIZER_BUTTON = false

const ACCENT_COLORS: { key: AccentColor; hex: string; label: string }[] = [
  { key: 'orange', hex: '#FC934C', label: 'Orange' },
  { key: 'blue',   hex: '#0078D4', label: 'Blue'   },
  { key: 'green',  hex: '#16A34A', label: 'Green'  },
  { key: 'purple', hex: '#7C3AED', label: 'Purple' },
  { key: 'pink',   hex: '#DB2777', label: 'Pink'   },
  { key: 'yellow', hex: '#D97706', label: 'Yellow' },
  { key: 'red',    hex: '#DC2626', label: 'Red'    },
  { key: 'teal',   hex: '#0891B2', label: 'Teal'   },
]

const NAVBAR_COLORS: { key: NavbarStyle; label: string }[] = [
  { key: 'default', label: 'White'   },
  { key: 'dark',    label: 'Dark'    },
  { key: 'navy',    label: 'Navy'    },
  { key: 'slate',   label: 'Slate'   },
  { key: 'blue',    label: 'Blue'    },
  { key: 'violet',  label: 'Violet'  },
  { key: 'emerald', label: 'Emerald' },
  { key: 'rose',    label: 'Rose'    },
]

const SIDEBAR_COLORS: { key: SidebarColor; label: string }[] = [
  { key: 'navy',    label: 'Navy'    },
  { key: 'dark',    label: 'Dark'    },
  { key: 'slate',   label: 'Slate'   },
  { key: 'blue',    label: 'Blue'    },
  { key: 'violet',  label: 'Violet'  },
  { key: 'emerald', label: 'Emerald' },
  { key: 'rose',    label: 'Rose'    },
  { key: 'gray',    label: 'Gray'    },
]

const LAYOUTS: { key: LayoutWidth; label: string; icon: string }[] = [
  { key: 'fluid', label: 'Fluid',  icon: '⬛' },
  { key: 'boxed', label: 'Boxed',  icon: '▪️' },
]

const CARD_STYLES: { key: CardStyle; label: string }[] = [
  { key: 'bordered',   label: 'Bordered'   },
  { key: 'borderless', label: 'Borderless' },
  { key: 'shadow',     label: 'Only Shadow' },
]

/* ── Layout thumbnail SVGs ── */
function LayoutThumb({ type }: { type: NavLayout }) {
  const navy = '#14254A'; const orange = '#FC934C'; const gray = '#e5e7eb'; const white = '#fff'; const mid = '#94a3b8'

  const thumbs: Record<NavLayout, JSX.Element> = {
    'default': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="2" y="10" width="12" height="32" rx="1" fill={navy}/>
        <rect x="16" y="10" width="42" height="6" rx="1" fill={gray}/>
        <rect x="16" y="18" width="20" height="12" rx="1" fill={gray}/>
        <rect x="38" y="18" width="20" height="12" rx="1" fill={gray}/>
        <rect x="16" y="32" width="42" height="8" rx="1" fill={gray}/>
      </svg>
    ),
    'mini': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="2" y="10" width="6" height="32" rx="1" fill={navy}/>
        <rect x="10" y="10" width="48" height="6" rx="1" fill={gray}/>
        <rect x="10" y="18" width="22" height="12" rx="1" fill={gray}/>
        <rect x="34" y="18" width="24" height="12" rx="1" fill={gray}/>
        <rect x="10" y="32" width="48" height="8" rx="1" fill={gray}/>
      </svg>
    ),
    'horizontal': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="2" y="9" width="56" height="6" rx="1" fill={orange} opacity="0.7"/>
        <rect x="2" y="17" width="56" height="6" rx="1" fill={gray}/>
        <rect x="2" y="25" width="27" height="10" rx="1" fill={gray}/>
        <rect x="31" y="25" width="27" height="10" rx="1" fill={gray}/>
        <rect x="2" y="37" width="56" height="5" rx="1" fill={gray}/>
      </svg>
    ),
    'horizontal-single': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="14" rx="2" fill={navy}/>
        <rect x="4" y="3" width="20" height="4" rx="1" fill={white} opacity="0.3"/>
        <rect x="26" y="3" width="10" height="4" rx="1" fill={white} opacity="0.2"/>
        <rect x="38" y="3" width="10" height="4" rx="1" fill={white} opacity="0.2"/>
        <rect x="4" y="9" width="52" height="3" rx="1" fill={orange} opacity="0.6"/>
        <rect x="2" y="16" width="56" height="6" rx="1" fill={gray}/>
        <rect x="2" y="24" width="27" height="10" rx="1" fill={gray}/>
        <rect x="31" y="24" width="27" height="10" rx="1" fill={gray}/>
        <rect x="2" y="36" width="56" height="6" rx="1" fill={gray}/>
      </svg>
    ),
    'detached': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill="#f3f6fb"/>
        <rect x="2" y="2" width="56" height="7" rx="2" fill={white}/>
        <rect x="2" y="11" width="13" height="31" rx="2" fill={white}/>
        <rect x="17" y="11" width="41" height="9" rx="1" fill={white}/>
        <rect x="17" y="22" width="19" height="11" rx="1" fill={white}/>
        <rect x="38" y="22" width="20" height="11" rx="1" fill={white}/>
        <rect x="17" y="35" width="41" height="8" rx="1" fill={white}/>
        <rect x="4" y="14" width="9" height="3" rx="1" fill={gray}/>
        <rect x="4" y="19" width="9" height="3" rx="1" fill={gray}/>
        <rect x="4" y="24" width="9" height="3" rx="1" fill={gray}/>
      </svg>
    ),
    'two-column': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="2" y="10" width="7" height="32" rx="1" fill={navy}/>
        <rect x="11" y="10" width="13" height="32" rx="1" fill="#e2e8f0"/>
        <rect x="26" y="10" width="32" height="6" rx="1" fill={gray}/>
        <rect x="26" y="18" width="14" height="12" rx="1" fill={gray}/>
        <rect x="42" y="18" width="16" height="12" rx="1" fill={gray}/>
        <rect x="26" y="32" width="32" height="8" rx="1" fill={gray}/>
      </svg>
    ),
    'without-header': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect x="2" y="2" width="12" height="40" rx="1" fill={navy}/>
        <rect x="16" y="2" width="42" height="6" rx="1" fill={gray}/>
        <rect x="16" y="10" width="20" height="12" rx="1" fill={gray}/>
        <rect x="38" y="10" width="20" height="12" rx="1" fill={gray}/>
        <rect x="16" y="24" width="42" height="18" rx="1" fill={gray}/>
      </svg>
    ),
    'overlay': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="2" y="10" width="26" height="32" rx="1" fill={navy} opacity="0.9"/>
        <rect x="2" y="10" width="56" height="6" rx="1" fill={gray} opacity="0.5"/>
        <rect x="30" y="18" width="28" height="12" rx="1" fill={gray}/>
        <rect x="30" y="32" width="28" height="8" rx="1" fill={gray}/>
        <rect x="4" y="15" width="20" height="3" rx="1" fill={white} opacity="0.5"/>
        <rect x="4" y="20" width="20" height="3" rx="1" fill={white} opacity="0.3"/>
        <rect x="4" y="25" width="20" height="3" rx="1" fill={white} opacity="0.3"/>
      </svg>
    ),
    'menu-aside': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="46" y="10" width="12" height="32" rx="1" fill={navy}/>
        <rect x="2" y="10" width="42" height="6" rx="1" fill={gray}/>
        <rect x="2" y="18" width="20" height="12" rx="1" fill={gray}/>
        <rect x="24" y="18" width="20" height="12" rx="1" fill={gray}/>
        <rect x="2" y="32" width="42" height="8" rx="1" fill={gray}/>
      </svg>
    ),
    'menu-stacked': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="2" y="9" width="56" height="6" rx="1" fill="#e2e8f0"/>
        <rect x="2" y="17" width="56" height="5" rx="1" fill={gray}/>
        <rect x="2" y="24" width="27" height="11" rx="1" fill={gray}/>
        <rect x="31" y="24" width="27" height="11" rx="1" fill={gray}/>
        <rect x="2" y="37" width="56" height="5" rx="1" fill={gray}/>
      </svg>
    ),
    'modern': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill="#f3f6fb"/>
        <rect x="2" y="2" width="12" height="40" rx="3" fill={navy}/>
        <rect x="16" y="2" width="42" height="7" rx="2" fill={white}/>
        <rect x="16" y="11" width="20" height="13" rx="2" fill={white}/>
        <rect x="38" y="11" width="20" height="13" rx="2" fill={white}/>
        <rect x="16" y="26" width="42" height="14" rx="2" fill={white}/>
        <rect x="4" y="6" width="8" height="8" rx="2" fill={orange}/>
        <rect x="5" y="16" width="6" height="2" rx="1" fill={white} opacity="0.5"/>
        <rect x="5" y="20" width="6" height="2" rx="1" fill={white} opacity="0.3"/>
        <rect x="5" y="24" width="6" height="2" rx="1" fill={white} opacity="0.3"/>
      </svg>
    ),
    'transparent': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="tg" x1="0" y1="0" x2="60" y2="44" gradientUnits="userSpaceOnUse">
            <stop stopColor={navy}/>
            <stop offset="1" stopColor="#1e3a6e"/>
          </linearGradient>
        </defs>
        <rect width="60" height="44" rx="3" fill="url(#tg)"/>
        <rect width="60" height="8" rx="2" fill={white} opacity="0.08"/>
        <rect x="2" y="10" width="12" height="32" rx="1" fill={white} opacity="0.08"/>
        <rect x="16" y="10" width="42" height="6" rx="1" fill={white} opacity="0.12"/>
        <rect x="16" y="18" width="20" height="12" rx="1" fill={white} opacity="0.1"/>
        <rect x="38" y="18" width="20" height="12" rx="1" fill={white} opacity="0.1"/>
        <rect x="16" y="32" width="42" height="8" rx="1" fill={white} opacity="0.1"/>
      </svg>
    ),
    'rtl': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="46" y="10" width="12" height="32" rx="1" fill={navy}/>
        <rect x="2" y="10" width="42" height="6" rx="1" fill={gray}/>
        <rect x="2" y="18" width="19" height="12" rx="1" fill={gray}/>
        <rect x="23" y="18" width="19" height="12" rx="1" fill={gray}/>
        <rect x="2" y="32" width="42" height="8" rx="1" fill={gray}/>
        <text x="48" y="28" fontSize="7" fill={white} opacity="0.7" textAnchor="middle">RTL</text>
      </svg>
    ),
  }

  return <div className="w-full h-full">{thumbs[type]}</div>
}

/* ── Sidebar size thumbnail SVGs ── */
function SidebarThumb({ type }: { type: SidebarSize }) {
  const navy = '#14254A'; const gray = '#e5e7eb'; const white = '#fff'

  const thumbs: Record<SidebarSize, JSX.Element> = {
    'default': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="2" y="10" width="14" height="32" rx="1" fill={navy}/>
        <rect x="18" y="10" width="40" height="6" rx="1" fill={gray}/>
        <rect x="18" y="18" width="18" height="12" rx="1" fill={gray}/>
        <rect x="38" y="18" width="20" height="12" rx="1" fill={gray}/>
        <rect x="18" y="32" width="40" height="8" rx="1" fill={gray}/>
        <rect x="4" y="13" width="10" height="2" rx="1" fill={white} opacity="0.4"/>
        <rect x="4" y="17" width="10" height="2" rx="1" fill={white} opacity="0.25"/>
        <rect x="4" y="21" width="10" height="2" rx="1" fill={white} opacity="0.25"/>
      </svg>
    ),
    'compact': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="2" y="10" width="8" height="32" rx="1" fill={navy}/>
        <rect x="12" y="10" width="46" height="6" rx="1" fill={gray}/>
        <rect x="12" y="18" width="21" height="12" rx="1" fill={gray}/>
        <rect x="35" y="18" width="23" height="12" rx="1" fill={gray}/>
        <rect x="12" y="32" width="46" height="8" rx="1" fill={gray}/>
        <rect x="3" y="13" width="6" height="2" rx="1" fill={white} opacity="0.4"/>
        <rect x="3" y="17" width="6" height="2" rx="1" fill={white} opacity="0.25"/>
        <rect x="3" y="21" width="6" height="2" rx="1" fill={white} opacity="0.25"/>
      </svg>
    ),
    'hover': (
      <svg viewBox="0 0 60 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="44" rx="3" fill={white}/>
        <rect width="60" height="8" rx="2" fill={navy}/>
        <rect x="2" y="10" width="5" height="32" rx="1" fill={navy}/>
        <rect x="3" y="13" width="3" height="2" rx="0.5" fill={white} opacity="0.5"/>
        <rect x="3" y="17" width="3" height="2" rx="0.5" fill={white} opacity="0.3"/>
        <rect x="3" y="21" width="3" height="2" rx="0.5" fill={white} opacity="0.3"/>
        {/* hover-expanded overlay */}
        <rect x="2" y="10" width="16" height="22" rx="2" fill={navy} opacity="0.95"/>
        <rect x="4" y="13" width="12" height="2" rx="1" fill={white} opacity="0.5"/>
        <rect x="4" y="17" width="12" height="2" rx="1" fill={white} opacity="0.3"/>
        <rect x="4" y="21" width="12" height="2" rx="1" fill={white} opacity="0.3"/>
        <rect x="4" y="25" width="12" height="2" rx="1" fill={white} opacity="0.3"/>
        <rect x="9" y="34" width="49" height="6" rx="1" fill={gray}/>
        <rect x="9" y="18" width="49" height="14" rx="1" fill={gray}/>
        <rect x="9" y="10" width="49" height="6" rx="1" fill={gray}/>
      </svg>
    ),
  }

  return <div className="w-full h-full">{thumbs[type]}</div>
}

const NAV_LAYOUTS: { key: NavLayout; label: string }[] = [
  { key: 'horizontal',        label: 'Horizontal'        },
  { key: 'horizontal-single', label: 'H. Single'         },
  { key: 'menu-stacked',      label: 'Stacked'           },
  { key: 'transparent',       label: 'Transparent'       },
  { key: 'default',           label: 'Sidebar'           },
  { key: 'mini',              label: 'Mini'              },
  { key: 'modern',            label: 'Modern'            },
  { key: 'detached',          label: 'Detached'          },
  { key: 'two-column',        label: 'Two Column'        },
  { key: 'without-header',    label: 'No Header'         },
  { key: 'overlay',           label: 'Overlay'           },
  { key: 'menu-aside',        label: 'Right Side'        },
  { key: 'rtl',               label: 'RTL'               },
]

const SIDEBAR_SIZES: { key: SidebarSize; label: string }[] = [
  { key: 'default', label: 'Default'    },
  { key: 'compact', label: 'Compact'    },
  { key: 'hover',   label: 'Hover View' },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-100 dark:border-white/10 pb-5 mb-5">
      <h3 className="text-sm font-bold text-gray-800 dark:text-white mb-3 flex items-center justify-between">
        {title}
        <span className="text-gray-300 text-base leading-none">—</span>
      </h3>
      {children}
    </div>
  )
}

function ColorSwatch({ hex, active, onClick, label }: { hex: string; active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} title={label}
      className="w-10 h-10 rounded-xl transition-all flex items-center justify-center"
      style={{
        background: hex,
        outline: active ? `3px solid ${hex}` : '3px solid transparent',
        outlineOffset: '2px',
        boxShadow: active ? `0 2px 8px ${hex}55` : 'none',
      }}>
      {active && <span className="text-white text-sm font-bold drop-shadow">✓</span>}
    </button>
  )
}

function ThumbCard<T extends string>({ item, active, onClick, ThumbComponent }: {
  item: { key: T; label: string }
  active: boolean
  onClick: () => void
  ThumbComponent: React.ComponentType<{ type: T }>
}) {
  return (
    <button onClick={onClick}
      className={`flex flex-col items-center gap-1.5 group focus:outline-none`}>
      <div className={`w-full aspect-[60/44] rounded-lg overflow-hidden border-2 transition-all ${
        active
          ? 'border-[#FC934C] shadow-md shadow-orange-200/60 scale-[1.03]'
          : 'border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/20'
      }`}>
        <ThumbComponent type={item.key} />
      </div>
      <span className={`text-[9px] font-semibold leading-tight text-center transition-colors ${
        active ? 'text-[#FC934C]' : 'text-gray-500 dark:text-gray-400 group-hover:text-gray-700 dark:group-hover:text-gray-300'
      }`}>
        {item.label}
      </span>
    </button>
  )
}

interface ThemePreset {
  key: string
  label: string
  accent: AccentColor
  navbar: NavbarStyle
  sidebar: SidebarColor
  gradient: string   // CSS gradient for the preview swatch
}

const THEME_PRESETS: ThemePreset[] = [
  { key: 'default',  label: 'IP House',  accent: 'orange',  navbar: 'navy',    sidebar: 'navy',    gradient: 'linear-gradient(135deg,#14254A,#FC934C)' },
  { key: 'ocean',    label: 'Ocean',     accent: 'blue',    navbar: 'blue',    sidebar: 'blue',    gradient: 'linear-gradient(135deg,#0078D4,#38bdf8)' },
  { key: 'forest',   label: 'Forest',    accent: 'green',   navbar: 'emerald', sidebar: 'emerald', gradient: 'linear-gradient(135deg,#059669,#16A34A)' },
  { key: 'royal',    label: 'Royal',     accent: 'purple',  navbar: 'violet',  sidebar: 'violet',  gradient: 'linear-gradient(135deg,#7C3AED,#a855f7)' },
  { key: 'rose',     label: 'Rose',      accent: 'pink',    navbar: 'rose',    sidebar: 'rose',    gradient: 'linear-gradient(135deg,#e11d48,#DB2777)' },
  { key: 'midnight', label: 'Midnight',  accent: 'teal',    navbar: 'dark',    sidebar: 'dark',    gradient: 'linear-gradient(135deg,#1f2937,#0891B2)' },
  { key: 'slate',    label: 'Slate',     accent: 'blue',    navbar: 'slate',   sidebar: 'slate',   gradient: 'linear-gradient(135deg,#334155,#0078D4)' },
  { key: 'crimson',  label: 'Crimson',   accent: 'red',     navbar: 'dark',    sidebar: 'gray',    gradient: 'linear-gradient(135deg,#DC2626,#1f2937)' },
]

export default function ThemeCustomizer() {
  const [open, setOpen] = useState(false)
  const { theme, toggle } = useTheme()
  const {
    accentColor, layoutWidth, navbarStyle, sidebarColor, cardStyle, navLayout, sidebarSize,
    setAccentColor, setLayoutWidth, setNavbarStyle, setSidebarColor, setCardStyle, setNavLayout, setSidebarSize,
  } = useCustomizer()

  function applyPreset(p: ThemePreset) {
    setAccentColor(p.accent)
    setNavbarStyle(p.navbar)
    setSidebarColor(p.sidebar)
  }

  const activePreset = THEME_PRESETS.find(
    p => p.accent === accentColor && p.navbar === navbarStyle && p.sidebar === sidebarColor
  )

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      const panel = document.getElementById('theme-customizer-panel')
      const btn   = document.getElementById('theme-customizer-btn')
      if (panel && !panel.contains(e.target as Node) && btn && !btn.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  return (
    <>
      {/* Floating gear button — hidden from the UI (config-only).
          The panel & all logic remain; set SHOW_THEME_CUSTOMIZER_BUTTON to true to re-enable. */}
      {SHOW_THEME_CUSTOMIZER_BUTTON && (
        <button id="theme-customizer-btn" onClick={() => setOpen(o => !o)}
          title="Theme Customizer"
          className="fixed right-0 top-1/2 -translate-y-1/2 z-[60] flex items-center justify-center w-10 h-10 rounded-l-xl shadow-lg transition-all hover:w-12"
          style={{ background: 'linear-gradient(135deg,#14254A,#FC934C)' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform duration-500 ${open ? 'rotate-180' : ''}`}>
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      )}

      {/* Overlay */}
      {open && (
        <div className="fixed inset-0 bg-black/20 z-[59]" onClick={() => setOpen(false)} />
      )}

      {/* Panel */}
      <div id="theme-customizer-panel"
        className={`fixed top-0 right-0 h-full w-[300px] bg-white dark:bg-[#1a2d55] shadow-2xl z-[60] flex flex-col transition-transform duration-300 ease-in-out ${open ? 'translate-x-0' : 'translate-x-full'}`}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ background: 'linear-gradient(135deg,#14254A 0%,#FC934C 100%)' }}>
          <div>
            <h2 className="text-white font-bold text-base">Theme Customizer</h2>
            <p className="text-white/60 text-xs mt-0.5">Choose your themes &amp; layouts etc.</p>
          </div>
          <button onClick={() => setOpen(false)} className="w-7 h-7 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white transition-colors">
            ×
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">

          {/* ── Preset Themes ── */}
          <Section title="Select Theme">
            <div className="grid grid-cols-4 gap-2">
              {THEME_PRESETS.map(p => {
                const isActive = activePreset?.key === p.key
                return (
                  <button key={p.key} onClick={() => applyPreset(p)}
                    title={p.label}
                    className={`flex flex-col items-center gap-1.5 group focus:outline-none`}>
                    <div
                      className={`w-full h-10 rounded-xl transition-all border-2 ${
                        isActive
                          ? 'border-white scale-[1.06] shadow-lg'
                          : 'border-transparent hover:scale-105'
                      }`}
                      style={{ background: p.gradient, boxShadow: isActive ? `0 4px 14px rgba(0,0,0,0.25)` : undefined }}>
                      {isActive && (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="text-white text-sm font-bold drop-shadow">✓</span>
                        </div>
                      )}
                    </div>
                    <span className={`text-[9px] font-semibold text-center leading-tight transition-colors ${
                      isActive ? 'text-[#FC934C]' : 'text-gray-500 group-hover:text-gray-700'
                    }`}>
                      {p.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </Section>

          {/* Select Layouts */}
          <Section title="Select Layouts">
            <div className="grid grid-cols-3 gap-2">
              {NAV_LAYOUTS.map(l => (
                <ThumbCard key={l.key} item={l} active={navLayout === l.key}
                  onClick={() => setNavLayout(l.key)}
                  ThumbComponent={LayoutThumb as React.ComponentType<{ type: NavLayout }>} />
              ))}
            </div>
          </Section>

          {/* Sidebar Size */}
          <Section title="Sidebar Size">
            <div className="grid grid-cols-3 gap-2">
              {SIDEBAR_SIZES.map(s => (
                <ThumbCard key={s.key} item={s} active={sidebarSize === s.key}
                  onClick={() => setSidebarSize(s.key)}
                  ThumbComponent={SidebarThumb as React.ComponentType<{ type: SidebarSize }>} />
              ))}
            </div>
          </Section>

          {/* Layout Width */}
          <Section title="Layout Width">
            <div className="flex gap-3">
              {LAYOUTS.map(l => (
                <button key={l.key} onClick={() => setLayoutWidth(l.key)}
                  className={`flex-1 py-2.5 rounded-xl border-2 text-xs font-semibold transition-all ${
                    layoutWidth === l.key
                      ? 'border-[#FC934C] bg-orange-50 text-[#FC934C]'
                      : 'border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400 hover:border-gray-300'
                  }`}>
                  {layoutWidth === l.key && <span className="mr-1">✓</span>}
                  {l.label} Layout
                </button>
              ))}
            </div>
          </Section>

          {/* Card Style */}
          <Section title="Card Layout">
            <div className="flex flex-col gap-2">
              {CARD_STYLES.map(c => (
                <button key={c.key} onClick={() => setCardStyle(c.key)}
                  className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border-2 text-sm font-medium transition-all text-left ${
                    cardStyle === c.key
                      ? 'border-[#FC934C] bg-orange-50 text-[#FC934C]'
                      : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:border-gray-300'
                  }`}>
                  <span className="w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0"
                    style={{ borderColor: cardStyle === c.key ? '#FC934C' : '#d1d5db' }}>
                    {cardStyle === c.key && <span className="w-2 h-2 rounded-full bg-[#FC934C] block" />}
                  </span>
                  {c.label}
                </button>
              ))}
            </div>
          </Section>

          {/* Top Bar Color */}
          <Section title="Top Bar Color">
            <div className="flex flex-wrap gap-2">
              {NAVBAR_COLORS.map(n => (
                <ColorSwatch key={n.key} hex={NAVBAR_HEX[n.key]} label={n.label}
                  active={navbarStyle === n.key}
                  onClick={() => setNavbarStyle(n.key)} />
              ))}
            </div>
          </Section>

          {/* Sidebar Color */}
          <Section title="Sidebar Color">
            <div className="flex flex-wrap gap-2">
              {SIDEBAR_COLORS.map(s => (
                <ColorSwatch key={s.key} hex={SIDEBAR_HEX[s.key]} label={s.label}
                  active={sidebarColor === s.key}
                  onClick={() => setSidebarColor(s.key)} />
              ))}
            </div>
          </Section>

          {/* Color Mode */}
          <Section title="Color Mode">
            <div className="flex gap-3">
              <button onClick={() => theme === 'dark' && toggle()}
                className={`flex-1 flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all ${
                  theme === 'light'
                    ? 'border-[#FC934C] bg-orange-50 text-[#FC934C]'
                    : 'border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400'
                }`}>
                ☀️ Light Mode
              </button>
              <button onClick={() => theme === 'light' && toggle()}
                className={`flex-1 flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all ${
                  theme === 'dark'
                    ? 'border-[#FC934C] bg-orange-50 text-[#FC934C]'
                    : 'border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400'
                }`}>
                🌙 Dark Mode
              </button>
            </div>
          </Section>

          {/* Theme / Accent Colors */}
          <Section title="Theme Colors">
            <div className="flex flex-wrap gap-2">
              {ACCENT_COLORS.map(a => (
                <ColorSwatch key={a.key} hex={a.hex} label={a.label}
                  active={accentColor === a.key}
                  onClick={() => setAccentColor(a.key)} />
              ))}
            </div>
          </Section>

        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 dark:border-white/10 flex-shrink-0">
          <button
            onClick={() => {
              setAccentColor('orange')
              setLayoutWidth('fluid')
              setNavbarStyle('default')
              setSidebarColor('navy')
              setCardStyle('bordered')
              setNavLayout('horizontal')
              setSidebarSize('default')
              if (theme === 'dark') toggle()
            }}
            className="w-full py-2.5 rounded-xl border border-gray-200 dark:border-white/10 text-sm font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-700 hover:border-gray-300 transition-colors">
            Reset to Default
          </button>
          <p className="text-center text-[10px] text-gray-400 mt-3">Settings auto-save to your browser</p>
        </div>
      </div>
    </>
  )
}
