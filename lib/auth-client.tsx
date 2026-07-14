'use client'

/**
 * Drop-in replacement for next-auth/react that talks to the Go JWT API.
 * Exports: SessionProvider, useSession, signIn, signOut
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react'

// ── Session shape (mirrors what next-auth session.user had) ──────────────────

export interface AppUser {
  loginId:        number
  userId:         number
  role:           number | null
  loginType:      number
  loginUsername:  string
  loginFirstName: string
  loginLastName:  string
  clientName:     string
  name:           string
  email:          string
  apiToken?:      string
  apiAccess?:     boolean
}

export interface AppSession {
  user: AppUser
}

type Status = 'loading' | 'authenticated' | 'unauthenticated'

interface SessionCtx {
  data:   AppSession | null
  status: Status
  update: () => Promise<void>
}

// ── Context ───────────────────────────────────────────────────────────────────

const Ctx = createContext<SessionCtx>({
  data:   null,
  status: 'loading',
  update: async () => {},
})

// ── AuthProvider (replaces SessionProvider) ───────────────────────────────────

export function SessionProvider({ children }: { children: ReactNode }) {
  const [data,   setData]   = useState<AppSession | null>(null)
  const [status, setStatus] = useState<Status>('loading')

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'include' })
      if (res.ok) {
        const json = await res.json()
        if (json.success && json.user) {
          const u = json.user
          const session: AppSession = {
            user: {
              loginId:        u.loginId,
              userId:         u.userId,
              role:           u.role ?? null,
              loginType:      u.loginType ?? 0,
              loginUsername:  u.loginUsername ?? '',
              loginFirstName: u.loginFirstName ?? '',
              loginLastName:  u.loginLastName  ?? '',
              clientName:     u.clientName ?? '',
              name:  [u.loginFirstName, u.loginLastName].filter(Boolean).join(' ') || u.loginUsername || '',
              email: u.loginUsername ?? '',
              apiToken: u.apiToken,
              apiAccess: u.apiAccess ?? false,
            },
          }
          setData(session)
          setStatus('authenticated')
          // Keep middleware-readable role cookie in sync
          document.cookie = `userRole=${u.role ?? ''}; path=/; max-age=1800; SameSite=Lax`
          return
        }
      }
    } catch { /* network error */ }
    setData(null)
    setStatus('unauthenticated')
  }, [])

  useEffect(() => { fetchSession() }, [fetchSession])

  return (
    <Ctx.Provider value={{ data, status, update: fetchSession }}>
      {children}
    </Ctx.Provider>
  )
}

// ── useSession ────────────────────────────────────────────────────────────────

export function useSession() {
  return useContext(Ctx)
}

// ── signIn ────────────────────────────────────────────────────────────────────

interface SignInOptions {
  redirect?:  boolean
  username?:  string
  password?:  string
  loginId?:   string
  tempToken?: string
  callbackUrl?: string
}

interface SignInResult {
  ok:    boolean
  error: string | null
  url:   string | null
}

export async function signIn(
  _provider: string,
  options: SignInOptions = {}
): Promise<SignInResult> {
  try {
    const body: Record<string, unknown> = {}
    if (options.username)  body.username  = options.username
    if (options.password)  body.password  = options.password
    if (options.loginId)   body.loginId   = Number(options.loginId)
    if (options.tempToken) body.tempToken = options.tempToken

    const res = await fetch('/api/auth/login', {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'include',
      body:        JSON.stringify(body),
    })

    const json = await res.json()

    if (!res.ok || !json.success) {
      return { ok: false, error: json.error ?? 'Login failed', url: null }
    }

    // Persist role for middleware
    const role = json.user?.role
    document.cookie = `userRole=${role ?? ''}; path=/; max-age=1800; SameSite=Lax`

    return { ok: true, error: null, url: options.callbackUrl ?? '/' }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error', url: null }
  }
}

// ── signOut ───────────────────────────────────────────────────────────────────

export async function signOut(options?: { callbackUrl?: string; redirect?: boolean }) {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
  } catch { /* ignore */ }
  // Clear cookies
  document.cookie = 'token=; path=/; max-age=0'
  document.cookie = 'userRole=; path=/; max-age=0'
  // Drop cached nav permissions so the next login starts clean
  try {
    const { clearModuleAccessCache } = await import('@/lib/moduleAccess')
    clearModuleAccessCache()
  } catch { /* ignore */ }
  const url = options?.callbackUrl ?? '/login'
  if (options?.redirect !== false) window.location.href = url
}

// ── getSession (server-side shim — always null; pages use useSession) ─────────

export async function getSession(): Promise<AppSession | null> {
  return null
}

