'use client'

// Top-nav "access a client" search (admin / super admin). The nav shows a
// compact trigger; clicking it opens a command-palette-style modal that
// live-searches login accounts (by username, person name, or client company)
// and lets the admin enter that client's portal (impersonation).

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface LoginRow {
  loginId: number
  userId: number
  login_username: string
  first_name: string | null
  last_name: string | null
  designation: string | null
  login_type: number
  client_name: string | null
  client_email: string | null
}

const LOGIN_TYPE_LABEL: Record<number, string> = { 0: 'Email OTP', 1: 'Authenticator', 2: 'Password' }

function personName(r: LoginRow): string {
  const n = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
  return n || r.login_username
}

export default function ClientAccessSearch() {
  const [open,    setOpen]    = useState(false)
  const [q,       setQ]       = useState('')
  const [results, setResults] = useState<LoginRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busy,    setBusy]    = useState<number | null>(null)
  const [error,   setError]   = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const close = useCallback(() => { setOpen(false); setQ(''); setResults([]); setError('') }, [])

  // Debounced live search.
  useEffect(() => {
    if (!open) return
    const query = q.trim()
    if (!query) { setResults([]); setLoading(false); return }
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/user-search?q=${encodeURIComponent(query)}`, { credentials: 'include' })
        const d = await res.json()
        if (d.success) setResults(d.users || [])
      } catch { /* ignore */ }
      setLoading(false)
    }, 250)
    return () => clearTimeout(t)
  }, [q, open])

  // Focus the field + Esc to close.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey) }
  }, [open, close])

  async function access(row: LoginRow) {
    setBusy(row.loginId); setError('')
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: row.loginId }),
      })
      const d = await res.json()
      if (d.success) { window.location.href = '/dashboard'; return }
      setError(d.error || 'Could not access this client'); setBusy(null)
    } catch { setError('Network error'); setBusy(null) }
  }

  return (
    <>
      {/* Nav trigger — styled like a search box */}
      <button onClick={() => setOpen(true)}
        className="hidden md:flex items-center gap-2 h-[34px] pl-2.5 pr-2 rounded-lg border text-sm bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 text-gray-400 hover:border-[#FC934C]/50 transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3" strokeLinecap="round"/></svg>
        <span className="w-40 lg:w-48 text-left">Search client to access…</span>
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-start justify-center p-4 sm:pt-20 bg-black/40 backdrop-blur-sm" onMouseDown={close}>
          <div className="w-full max-w-3xl bg-white dark:bg-[#16233f] rounded-2xl shadow-2xl border border-gray-100 dark:border-white/10 overflow-hidden fade-in flex flex-col max-h-[80vh]"
            onMouseDown={e => e.stopPropagation()}>

            {/* Search header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-white/10 flex-shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9aa3b2" strokeWidth="2" className="flex-shrink-0"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3" strokeLinecap="round"/></svg>
              <input ref={inputRef} type="text" value={q} onChange={e => { setQ(e.target.value); setError('') }}
                placeholder="Search by username, person, or client company…"
                className="flex-1 bg-transparent text-[15px] text-[#14254A] dark:text-white placeholder:text-gray-400 focus:outline-none" />
              <button onClick={close} className="text-gray-400 hover:text-gray-600 dark:hover:text-white text-lg leading-none px-1">×</button>
            </div>

            {error && <div className="px-4 py-2 text-xs text-red-600 bg-red-50 dark:bg-red-500/10 flex-shrink-0">{error}</div>}

            {/* Column header — same grid template as the rows so columns align */}
            {q.trim() && results.length > 0 && (
              <div className="grid items-center gap-3 px-4 py-2 border-b border-gray-100 dark:border-white/10 text-[10px] uppercase tracking-widest text-gray-400 font-semibold flex-shrink-0"
                style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1.4fr) minmax(0,1.1fr) 96px' }}>
                <span>Person</span>
                <span className="hidden sm:block">Username</span>
                <span className="hidden sm:block">Client / Company</span>
                <span className="text-right">Action</span>
              </div>
            )}

            {/* Results — clickable rows */}
            <div className="overflow-y-auto flex-1">
              {!q.trim() ? (
                <div className="px-4 py-12 text-center text-sm text-gray-400">
                  Start typing to find a client login. Access opens their portal exactly as they see it.
                </div>
              ) : loading ? (
                <div className="flex justify-center py-12"><span className="w-6 h-6 border-2 border-gray-200 border-t-[#14254A] rounded-full animate-spin" /></div>
              ) : results.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-gray-400">No login matches “{q.trim()}”.</div>
              ) : (
                results.map(row => (
                  <button key={row.loginId} onClick={() => access(row)} disabled={busy !== null}
                    className="w-full grid items-center gap-3 px-4 py-2.5 text-left border-b border-gray-50 dark:border-white/5 hover:bg-orange-50/60 dark:hover:bg-white/5 transition-colors disabled:opacity-50 group"
                    style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1.4fr) minmax(0,1.1fr) 96px' }}>
                    {/* Person */}
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                        style={{ background: 'linear-gradient(135deg,#0078D4,#004E8C)' }}>
                        {personName(row).charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[#14254A] dark:text-white truncate">{personName(row)}</p>
                        <p className="text-[11px] text-gray-400 truncate">
                          {row.designation || 'Client user'} · {LOGIN_TYPE_LABEL[row.login_type] ?? 'Login'}
                        </p>
                      </div>
                    </div>
                    {/* Username */}
                    <div className="min-w-0 hidden sm:block">
                      <code className="text-[11px] bg-gray-100 dark:bg-white/10 px-1.5 py-0.5 rounded font-mono text-gray-600 dark:text-gray-300 truncate block" title={row.login_username}>{row.login_username}</code>
                    </div>
                    {/* Client / Company */}
                    <div className="min-w-0 hidden sm:block text-sm text-gray-600 dark:text-gray-300 truncate" title={row.client_name || ''}>{row.client_name || '—'}</div>
                    {/* Action */}
                    <div className="justify-self-end">
                      <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold text-white transition-all group-hover:opacity-90 whitespace-nowrap"
                        style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                        {busy === row.loginId ? 'Opening…' : 'Access →'}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>

            {results.length > 0 && (
              <div className="px-4 py-2 border-t border-gray-100 dark:border-white/10 text-[11px] text-gray-400 flex-shrink-0">
                {results.length} result{results.length !== 1 ? 's' : ''} · You&apos;ll enter the selected client&apos;s portal — press Esc to cancel.
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
