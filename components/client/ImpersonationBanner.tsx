'use client'

// Shown across the client portal when an Admin / Super Admin is viewing AS a
// client. Makes the impersonation obvious and provides a one-click exit back to
// the admin session.

import { useState } from 'react'
import { useSession } from '@/lib/auth-client'

export default function ImpersonationBanner() {
  const { data: session } = useSession()
  const user = session?.user as any
  const [exiting, setExiting] = useState(false)

  if (!user?.impersonating) return null

  async function exit() {
    setExiting(true)
    try {
      await fetch('/api/admin/impersonate/exit', { method: 'POST', credentials: 'include' })
    } catch { /* ignore — the redirect below still lands on a fresh admin page */ }

    /* End the CLIENT'S session in this tab, not just the cookie.
       The nav grants are cached in sessionStorage per login and sessionStorage
       survives a location change, so leaving them behind meant the next visit to
       a client portal could paint from a previous visit's cache before the API
       answered — including a cached "no API access" from a minute when the
       upstream was rate-limited, which then reads as a permissions error. */
    try {
      const { clearModuleAccessCache } = await import('@/lib/moduleAccess')
      clearModuleAccessCache()
    } catch { /* storage unavailable */ }

    // A full load, not a route change: it re-reads the restored admin cookie and
    // drops every provider that was holding the client's data.
    window.location.href = '/admin/home'
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, flexWrap: 'wrap',
      padding: '8px 16px', background: 'linear-gradient(90deg,#FFC82B,#FC934C)', color: '#3a2400',
      fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13, fontWeight: 600, zIndex: 60,
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" strokeLinecap="round" strokeLinejoin="round"/><circle cx="12" cy="12" r="3"/>
        </svg>
        You are viewing the portal as <b>{user.clientName || 'this client'}</b>
        {user.impersonatorName ? <> (as {user.impersonatorName})</> : null}. Actions here affect the client&apos;s account.
      </span>
      <button onClick={exit} disabled={exiting}
        style={{
          border: '1.5px solid rgba(58,36,0,0.35)', background: 'rgba(255,255,255,0.45)', color: '#3a2400',
          fontWeight: 700, fontSize: 12, padding: '5px 16px', borderRadius: 999, cursor: 'pointer',
        }}>
        {exiting ? 'Returning…' : '← Back to Admin Panel'}
      </button>
    </div>
  )
}
