'use client'

/*
── A small popover, not an offcanvas panel ─────────────────────────────────

This used to be a floating gear pinned to the viewport edge that slid a
full-height panel in from the right. It now sits inline as one more icon in
the header's own icon row (see ClientNavbar.tsx / HeaderControls.tsx /
AdminHeaderControls.tsx) and opens a small popover — a "small notification
window", not a sidebar of its own. Three controls: colour mode, sidebar
on/off, header on/off — see lib/ThemeCustomizerContext.tsx and
lib/ThemeContext.tsx for the state behind them.

The popover is portalled to document.body and positioned `fixed` from the
trigger's own getBoundingClientRect (CountryPicker.tsx uses the same
pattern), not an in-flow `absolute` box inside a `relative` wrapper. A page
can have its own `sticky`/z-indexed elements (e.g. app/admin/configuration's
category-tabs row) that sit in a completely different part of the DOM than
this header; z-index only ranks siblings within the same stacking context,
so a merely-higher z-index here did not reliably beat page content mounted
elsewhere. Escaping to the body sidesteps the comparison entirely.

All three now apply identically whichever shell this is mounted in — admin
has a real horizontal layout of its own to switch to (AdminShell.tsx), the
same way the client portal does, so there is no longer a reduced view for
one context. `context` still exists: it picks what "Reset to default" resets
TO (see defaultsFor in ThemeCustomizerContext.tsx) — admin's own shipped
default keeps its sidebar on, client's keeps it off — not what is shown.
*/

import { useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTheme } from '@/lib/ThemeContext'
import { useCustomizer, defaultsFor } from '@/lib/ThemeCustomizerContext'

/** Worst-case panel width used only for clamping the portal's fixed position —
    the CSS itself still shrinks to `90vw` below this on a narrow phone. */
const PANEL_W = 300

/** Two segments in one pill — used for the light/dark choice. */
function SegmentedChoice<T extends string>({ options, value, onChange }: {
  options: { key: T; label: string }[]; value: T; onChange: (v: T) => void
}) {
  return (
    <div className="flex gap-2">
      {options.map(o => (
        <button key={o.key} onClick={() => onChange(o.key)}
          className={`flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition-all ${
            value === o.key
              ? 'border-[#FC934C] bg-[#FC934C]/[0.08] text-[#FC934C]'
              : 'border-gray-200 dark:border-white/10 text-gray-500 dark:text-white/50 hover:border-gray-300 dark:hover:border-white/20'
          }`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A toggle switch — used for Enable Sidebar and Show Header. */
function ToggleRow({ label, hint, checked, onChange, disabled }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
}) {
  return (
    <button onClick={() => !disabled && onChange(!checked)} disabled={disabled}
      className={`w-full flex items-center justify-between gap-3 text-left ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
      <span>
        <span className="block text-xs font-semibold text-gray-700 dark:text-white/80">{label}</span>
        <span className="block text-[10px] text-gray-400 dark:text-white/40 mt-0.5">{hint}</span>
      </span>
      <span className={`relative flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-[#FC934C]' : 'bg-gray-200 dark:bg-white/15'}`}
        style={{ width: '40px', height: '22px' }}>
        <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : ''}`} />
      </span>
    </button>
  )
}

export default function ThemeCustomizer({ context = 'client', tone = 'dark', align = 'down' }: {
  /** Which shell this is mounted in — picks what "Reset to default" resets
      to (see defaultsFor), since admin's and client's shipped defaults
      differ. Every control here shows and works the same either way. */
  context?: 'admin' | 'client'
  /** Icon colour to match whatever bar this sits in — same convention as
      NotificationBell/FullscreenToggle/CountryPicker next to it. */
  tone?: 'light' | 'dark'
  /** 'up' when mounted low on the page (the sidebar's own footer cluster,
      shown once the header is turned off) so the popover opens above the
      trigger instead of running off the bottom of the viewport. */
  align?: 'down' | 'up'
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const { theme, toggle } = useTheme()
  const { sidebarEnabled, headerVisible, setSidebarEnabled, setHeaderVisible } = useCustomizer()
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setRect(btnRef.current?.getBoundingClientRect() ?? null)
    function handle(e: MouseEvent) {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handle)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', handle)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function resetAll() {
    if (theme === 'dark') toggle()
    const d = defaultsFor(context)
    setSidebarEnabled(d.sidebarEnabled)
    setHeaderVisible(d.headerVisible)
  }

  return (
    <>
      <button ref={btnRef} onClick={() => setOpen(o => !o)}
        aria-expanded={open} title="Theme Customizer"
        className={`flex items-center justify-center w-9 h-9 rounded-xl transition-colors ${
          tone === 'light'
            ? 'text-white hover:bg-white/10'
            : 'text-gray-500 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-[#14254A] dark:hover:text-white'
        }`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          className={`transition-transform duration-500 ${open ? 'rotate-180' : ''}`}>
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>

      {open && rect && createPortal(
        <div ref={panelRef} role="dialog" aria-label="Theme Customizer"
          className="fixed z-[9999] w-[min(90vw,300px)] rounded-2xl overflow-hidden
            bg-white dark:bg-[#1a2d55] border border-gray-100 dark:border-white/10
            shadow-[0_24px_64px_-16px_rgba(20,37,74,0.5)]"
          style={align === 'up'
            /* 'up' also means "mounted low in a narrow column" (the sidebar
               footer) — right-anchoring there can push most of the panel off
               the left edge of that ~240px rail, so it left-anchors instead. */
            ? { bottom: Math.max(8, window.innerHeight - rect.top + 4), left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_W - 8)) }
            : { top: Math.min(rect.bottom + 4, window.innerHeight - 60), left: Math.max(8, Math.min(rect.right - PANEL_W, window.innerWidth - PANEL_W - 8)) }}>

          <div className="flex items-center justify-between px-4 py-3"
            style={{ background: 'linear-gradient(135deg,#14254A 0%,#FC934C 100%)' }}>
            <h2 className="text-white font-bold text-sm">Theme Customizer</h2>
            <button onClick={() => setOpen(false)} className="w-6 h-6 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white transition-colors text-xs">
              ×
            </button>
          </div>

          <div className="px-4 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400 dark:text-white/40 mb-2">Colour mode</h3>
              <SegmentedChoice
                options={[{ key: 'light', label: '☀️ Light' }, { key: 'dark', label: '🌙 Dark' }]}
                value={theme} onChange={v => { if (v !== theme) toggle() }} />
            </div>

            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400 dark:text-white/40 mb-2">Sidebar</h3>
              <ToggleRow label="Enable sidebar" hint="Show a left-hand navigation panel instead of the top tab bar."
                checked={sidebarEnabled} onChange={setSidebarEnabled} />
            </div>

            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400 dark:text-white/40 mb-2">Header</h3>
              <ToggleRow label="Show header" hint={sidebarEnabled
                ? 'Hide the top bar when the sidebar is enabled.'
                : 'The header carries the navigation tabs, so it stays on until the sidebar is enabled.'}
                checked={!sidebarEnabled || headerVisible} disabled={!sidebarEnabled}
                onChange={setHeaderVisible} />
            </div>
          </div>

          <div className="px-4 py-3 border-t border-gray-100 dark:border-white/10">
            <button onClick={resetAll}
              className="w-full py-2 rounded-xl border border-gray-200 dark:border-white/10 text-xs font-semibold text-gray-500 dark:text-white/50 hover:text-gray-700 dark:hover:text-white/70 hover:border-gray-300 dark:hover:border-white/20 transition-colors">
              Reset to default
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
