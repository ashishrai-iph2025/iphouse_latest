'use client'

/*
── Cut down to two switches ────────────────────────────────────────────────

This context has been through two richer designs — a curated set of nav
layouts/colours, then a full rebuild matching a 24-preset reference template
— and both were judged over-built for what this app actually needs. What is
left is the two things that are genuinely a matter of per-account preference
and are read by real layout code (ClientShell.tsx/SideNav.tsx, and now
AdminShell.tsx too): whether the sidebar is shown at all, and whether the top
header is shown alongside it. Colour scheme lives in ThemeContext.tsx,
untouched.

── One context, two starting points ────────────────────────────────────────

AdminShell and ClientShell each wrap their own tree in a Provider — same
component, different `context`. That only changes what a session with
NOTHING saved yet opens on: admin starts on its sidebar (the layout every
staff account has always had), client starts on the horizontal top-nav (same
reasoning). The moment a reader changes either switch, their own save always
wins over this regardless of which shell reads it back.

`context` also picks the localStorage key. The two shells' defaults now
genuinely differ, so sharing one cached value would flash the WRONG one on
whichever shell reads it first — a staff account viewing /admin (sidebar) and
then, in the same browser, opening a client portal (horizontal) would paint
one frame of the other's layout before its own account row arrives. Separate
keys mean each shell's instant-paint cache can only ever be its own.
*/

import { createContext, useContext, useEffect, useRef, useState } from 'react'

export interface CustomizerState {
  /** true = a left sidebar nav; false = the horizontal top-nav. */
  sidebarEnabled: boolean
  /** Whether the top header (logo, notifications, profile menu) is shown.
      Only meaningful when sidebarEnabled — with the sidebar off, the nav
      tabs themselves live in that header, so the shell always shows it
      regardless of this flag once sidebarEnabled is false (see each shell's
      own `showHeader`). */
  headerVisible: boolean
}

/** What a session with nothing saved yet opens on, per shell. */
const CONTEXT_DEFAULTS: Record<'admin' | 'client', CustomizerState> = {
  admin:  { sidebarEnabled: true,  headerVisible: true },
  client: { sidebarEnabled: false, headerVisible: true },
}
// Client's own shipped default, kept as the export every existing caller
// (AddUserDrawer-style resets, etc.) already uses.
export const DEFAULTS = CONTEXT_DEFAULTS.client

interface CustomizerCtx extends CustomizerState {
  setSidebarEnabled: (v: boolean) => void
  setHeaderVisible:  (v: boolean) => void
}

const CustomizerContext = createContext<CustomizerCtx>({
  ...DEFAULTS,
  setSidebarEnabled: () => {},
  setHeaderVisible:  () => {},
})

function sanitize(partial: Partial<CustomizerState> | null | undefined, defaults: CustomizerState): CustomizerState {
  return {
    sidebarEnabled: typeof partial?.sidebarEnabled === 'boolean' ? partial.sidebarEnabled : defaults.sidebarEnabled,
    headerVisible:  typeof partial?.headerVisible  === 'boolean' ? partial.headerVisible  : defaults.headerVisible,
  }
}

export function ThemeCustomizerProvider({ children, context = 'client' }: {
  children: React.ReactNode
  /** Which shell is mounting this — picks the starting defaults and the
      instant-paint cache key. See the file header for why. */
  context?: 'admin' | 'client'
}) {
  const defaults = CONTEXT_DEFAULTS[context]
  const cacheKey = `ip_customizer:${context}`

  const [state, setState] = useState<CustomizerState>(defaults)
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
    let painted = defaults
    try {
      const saved = localStorage.getItem(cacheKey)
      if (saved) painted = sanitize(JSON.parse(saved), defaults)
    } catch {}
    setState(painted)

    // Then the account's own row, authoritative the moment it answers.
    let live = true
    fetch('/api/user/theme-layout', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!live || userChanged.current || !d?.success || !d.found) return
        const server = sanitize(d.layout, defaults)
        setState(server)
        try { localStorage.setItem(cacheKey, JSON.stringify(server)) } catch {}
      })
      .catch(() => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context])

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
    try { localStorage.setItem(cacheKey, JSON.stringify(next)) } catch {}
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

/** The shipped defaults for one shell — used by ThemeCustomizer.tsx's own
    "Reset to default" so it resets to what THAT shell actually starts on,
    not always the client's. */
export function defaultsFor(context: 'admin' | 'client'): CustomizerState {
  return CONTEXT_DEFAULTS[context]
}
