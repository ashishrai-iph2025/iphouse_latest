'use client'

/*
── Cut down to two switches ────────────────────────────────────────────────

This context has been through two richer designs — a curated set of nav
layouts/colours, then a full rebuild matching a 24-preset reference template
— and both were judged over-built for what this app actually needs: most of
what they offered either did nothing in AdminShell (which has always had its
own fixed layout) or duplicated the plain light/dark toggle ThemeContext.tsx
already provides. What is left is the two things that are genuinely a matter
of per-account preference and are read by real layout code (ClientShell.tsx,
SideNav.tsx): whether the sidebar is shown at all, and whether the top header
is shown alongside it. Colour scheme lives in ThemeContext.tsx, untouched.
*/

import { createContext, useContext, useEffect, useRef, useState } from 'react'

export interface CustomizerState {
  /** true = a left sidebar nav (SideNav.tsx); false = the horizontal top-nav
      (the tabs row in ClientNavbar.tsx). */
  sidebarEnabled: boolean
  /** Whether the top header (logo, notifications, profile menu) is shown.
      Only meaningful when sidebarEnabled — with the sidebar off, the nav
      tabs themselves live in that header, so ClientShell always shows it
      regardless of this flag once sidebarEnabled is false (see its own
      `showHeader`). */
  headerVisible: boolean
}

export const DEFAULTS: CustomizerState = {
  sidebarEnabled: false,
  headerVisible: true,
}

interface CustomizerCtx extends CustomizerState {
  setSidebarEnabled: (v: boolean) => void
  setHeaderVisible:  (v: boolean) => void
}

const CustomizerContext = createContext<CustomizerCtx>({
  ...DEFAULTS,
  setSidebarEnabled: () => {},
  setHeaderVisible:  () => {},
})

function sanitize(partial: Partial<CustomizerState> | null | undefined): CustomizerState {
  return {
    sidebarEnabled: typeof partial?.sidebarEnabled === 'boolean' ? partial.sidebarEnabled : DEFAULTS.sidebarEnabled,
    headerVisible:  typeof partial?.headerVisible  === 'boolean' ? partial.headerVisible  : DEFAULTS.headerVisible,
  }
}

export function ThemeCustomizerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<CustomizerState>(DEFAULTS)
  /* Set the moment the reader changes anything themselves. The server read
     below is already in flight from mount and is not guaranteed to land
     before a click that came seconds later — without this guard, a slow
     reply landing AFTER that click would overwrite the reader's own fresh
     choice with whatever the account's row held before they made it. */
  const userChanged = useRef(false)

  useEffect(() => {
    // Painted from localStorage first, synchronously, so the first frame is
    // already in the reader's chosen layout rather than flashing the default
    // for the network round trip below.
    let painted = DEFAULTS
    try {
      const saved = localStorage.getItem('ip_customizer')
      if (saved) painted = sanitize(JSON.parse(saved))
    } catch {}
    setState(painted)

    // Then the account's own row, authoritative the moment it answers.
    let live = true
    fetch('/api/user/theme-layout', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!live || userChanged.current || !d?.success || !d.found) return
        const server = sanitize(d.layout)
        setState(server)
        try { localStorage.setItem('ip_customizer', JSON.stringify(server)) } catch {}
      })
      .catch(() => {})
    return () => { live = false }
  }, [])

  function syncToAccount(next: CustomizerState) {
    fetch('/api/user/theme-layout', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => {})
  }

  function save(next: CustomizerState) {
    userChanged.current = true
    setState(next)
    try { localStorage.setItem('ip_customizer', JSON.stringify(next)) } catch {}
    syncToAccount(next)
  }

  function setSidebarEnabled(v: boolean) { save({ ...state, sidebarEnabled: v }) }
  function setHeaderVisible(v: boolean)  { save({ ...state, headerVisible: v }) }

  return (
    <CustomizerContext.Provider value={{ ...state, setSidebarEnabled, setHeaderVisible }}>
      {children}
    </CustomizerContext.Provider>
  )
}

export const useCustomizer = () => useContext(CustomizerContext)
