'use client'

// Shared nav/module permissions for the client shell. Fetched ONCE per page
// load (ClientNavbar and SideNav previously each fetched /api/user/nav) and
// cached in sessionStorage per login, so a page refresh paints the correct
// nav immediately instead of flashing every module and then collapsing to
// the granted ones once the API answers.
//
// allowedModuleNames === null means "not known yet" (first-ever load with no
// cache, fetch still in flight). Consumers must FAIL CLOSED on null — render
// only the always-allowed items (Dashboard) — never the full nav.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useSession } from '@/lib/auth-client'

interface ModuleAccess {
  allowedModuleNames: string[] | null
  accountCount: number
  // Live Markscan token availability from /api/user/nav. null = not known yet;
  // consumers should fall back to the session's apiAccess claim. Unlike the
  // claim (frozen at select-login), this heals once a transient Markscan
  // failure at login resolves itself.
  apiAccess: boolean | null
}

const Ctx = createContext<ModuleAccess>({ allowedModuleNames: null, accountCount: 1, apiAccess: null })

const CACHE_PREFIX = 'nav-modules:'
const cacheKey = (loginId: number) => `${CACHE_PREFIX}${loginId}`

/** Remove every cached nav-permission entry (called on sign-out). */
export function clearModuleAccessCache() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(CACHE_PREFIX)) sessionStorage.removeItem(k)
    }
  } catch { /* storage unavailable */ }
}

export function ModuleAccessProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession()
  const loginId = session?.user?.loginId

  const [state, setState] = useState<ModuleAccess>({ allowedModuleNames: null, accountCount: 1, apiAccess: null })

  useEffect(() => {
    if (loginId === undefined) return

    // Hydrate from the per-login cache first: refreshes paint correctly on
    // the very first frame. Keyed by loginId so one user's permissions can
    // never leak into another login in the same tab.
    try {
      const raw = sessionStorage.getItem(cacheKey(loginId))
      if (raw) {
        const cached = JSON.parse(raw)
        if (Array.isArray(cached?.allowedModuleNames)) {
          setState({
            allowedModuleNames: cached.allowedModuleNames,
            accountCount: Number(cached.accountCount) || 1,
            apiAccess: typeof cached.apiAccess === 'boolean' ? cached.apiAccess : null,
          })
        }
      }
    } catch { /* bad cache — fall through to the fetch */ }

    // Always refresh from the API so permission changes still propagate.
    fetch('/api/user/nav', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!d?.success) return
        const next: ModuleAccess = {
          allowedModuleNames: (d.allowedModules ?? []).map((m: { moduleName: string }) => m.moduleName),
          accountCount: d.accountCount ?? 1,
          apiAccess: typeof d.apiAccess === 'boolean' ? d.apiAccess : null,
        }
        setState(next)
        try { sessionStorage.setItem(cacheKey(loginId), JSON.stringify(next)) } catch { /* quota */ }
      })
      .catch(() => {})
  }, [loginId])

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>
}

export function useModuleAccess() {
  return useContext(Ctx)
}
