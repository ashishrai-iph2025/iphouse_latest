'use client'

// /account-access — the Client Admin view.
//
// Visible only to a login holding the Client Admin grant for the company it is
// currently signed in as (plus IP House staff, who reach it while acting on a
// client's behalf). It lists everyone with access to THAT company and lets the
// Client Admin switch a user's access on or off.
//
// Everything else about a user — creating logins, credentials, sign-in method,
// and the Client Admin grant itself — stays with IP House Admin/Super Admin.
// The server enforces all of that independently; this page only reflects it.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Breadcrumb from '@/components/ui/Breadcrumb'
import PageLoader from '@/components/ui/PageLoader'
import Portal from '@/components/ui/Portal'
import { useSession } from '@/lib/auth-client'

const NAVY = '#14254A'
const ORANGE = '#FC934C'

interface CompanyUser {
  loginId: number
  first_name: string
  last_name: string
  login_username: string
  login_type: number
  is_active: number
  is_client_admin: number
  is_staff: number
  isSelf: boolean
  created_at: string | null
  updated_at: string | null
}

interface ActivityEvent {
  id: number
  action: string
  page_url: string | null
  ip_address: string
  metadata: string | null
  created_at: string
  actor_login_id: number
  actor_name: string
  actor_username: string
}

const LOGIN_TYPES: Record<number, string> = { 0: 'Password', 1: 'Single sign-on', 2: 'Email OTP' }

// Date windows offered by the activity modal. The server accepts exactly these.
const RANGES = [
  { days: 1,  label: '24 hours' },
  { days: 7,  label: '7 days'   },
  { days: 15, label: '15 days'  },
  { days: 30, label: '30 days'  },
] as const

// Audit-trail presentation. Keys match the action strings written by the Go
// server — the Client Admin ones from handlers/clientadmin.go, the rest from
// auth, impersonation and credential handlers, all of which land in the same
// table for every login attached to this company.
const ACTION_LABEL: Record<string, string> = {
  login:                      'Signed in',
  password_reset:             'Password reset',
  impersonate_start:          'Impersonation started',
  impersonate_exit:           'Impersonation ended',
  credential_reveal:          'Credential revealed',
  client_admin_view:          'Viewed access list',
  client_admin_user_enabled:  'Access granted',
  client_admin_user_disabled: 'Access revoked',
  client_admin_denied:        'Action refused',
  client_admin_list_view:     'Viewed access list',
  client_admin_granted:       'Made an administrator',
  client_admin_revoked:       'Administrator removed',
  client_admin_grant_denied:  'Action refused',
}
const ACTION_TONE: Record<string, string> = {
  login:                      'bg-blue-50 text-blue-700 ring-1 ring-blue-100',
  password_reset:             'bg-violet-50 text-violet-700 ring-1 ring-violet-100',
  impersonate_start:          'bg-violet-50 text-violet-700 ring-1 ring-violet-100',
  impersonate_exit:           'bg-violet-50 text-violet-700 ring-1 ring-violet-100',
  credential_reveal:          'bg-amber-50 text-amber-700 ring-1 ring-amber-100',
  client_admin_view:          'bg-gray-100 text-gray-600',
  client_admin_user_enabled:  'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100',
  client_admin_user_disabled: 'bg-amber-50 text-amber-700 ring-1 ring-amber-100',
  client_admin_denied:        'bg-red-50 text-red-700 ring-1 ring-red-100',
  client_admin_list_view:     'bg-gray-100 text-gray-600',
  client_admin_granted:       'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100',
  client_admin_revoked:       'bg-amber-50 text-amber-700 ring-1 ring-amber-100',
  client_admin_grant_denied:  'bg-red-50 text-red-700 ring-1 ring-red-100',
}
const ACTION_DOT: Record<string, string> = {
  login:                      'bg-blue-500',
  password_reset:             'bg-violet-500',
  impersonate_start:          'bg-violet-500',
  impersonate_exit:           'bg-violet-400',
  credential_reveal:          'bg-amber-500',
  client_admin_view:          'bg-gray-300',
  client_admin_user_enabled:  'bg-emerald-500',
  client_admin_user_disabled: 'bg-amber-500',
  client_admin_denied:        'bg-red-500',
  client_admin_list_view:     'bg-gray-300',
  client_admin_granted:       'bg-emerald-500',
  client_admin_revoked:       'bg-amber-500',
  client_admin_grant_denied:  'bg-red-500',
}

// Any action the server starts writing before this map learns about it still
// reads as words rather than a raw constant.
const actionLabel = (a: string) =>
  ACTION_LABEL[a] ?? a.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

const fullName = (u: CompanyUser) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.login_username || '—'

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?'

function parseMeta(raw: string | null): Record<string, any> {
  if (!raw) return {}
  try { return JSON.parse(raw) ?? {} } catch { return {} }
}

/** One-line plain-English summary of an audit row. */
function describe(ev: ActivityEvent): string {
  const m = parseMeta(ev.metadata)
  switch (ev.action) {
    case 'client_admin_user_enabled':
    case 'client_admin_user_disabled':
      return `${m.targetUser ?? 'a user'} · ${m.from ?? '?'} → ${m.to ?? '?'}`
    case 'client_admin_granted':
    case 'client_admin_revoked':
      return String(m.targetUser ?? m.target ?? '')
    case 'client_admin_denied':
    case 'client_admin_grant_denied':
      return String(m.reason ?? 'refused')
    case 'client_admin_view':
    case 'client_admin_list_view':
      return m.userCount !== undefined ? `${m.userCount} user${Number(m.userCount) === 1 ? '' : 's'} listed` : ''
    case 'login':
      return m.method ? `via ${LOGIN_METHOD_LABEL[String(m.method)] ?? m.method}` : ''
    case 'password_reset':
      return m.method === 'reset_token' ? 'using a reset link' : String(m.method ?? '')
    case 'impersonate_start':
    case 'impersonate_exit':
      return String(m.targetEmail ?? m.target ?? m.targetUser ?? '')
    case 'credential_reveal':
      return String(m.target ?? '')
    default:
      return ''
  }
}

const LOGIN_METHOD_LABEL: Record<string, string> = {
  password: 'password',
  otp:      'email OTP',
  select:   'account switch',
}

/** Parse a UTC datetime coming back from MySQL ("YYYY-MM-DD HH:MM:SS"). */
function toDate(v: string | null): Date | null {
  if (!v) return null
  const s = String(v)
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime()) ? null : d
}

const fmtDate = (v: string | null) =>
  toDate(v)?.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) ?? '—'

const fmtStamp = (v: string) =>
  toDate(v)?.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }) ?? String(v)

/** "3 hours ago" style, for the activity timeline. */
function relative(v: string): string {
  const d = toDate(v)
  if (!d) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return fmtDate(v)
}

type StatusFilter = 'all' | 'active' | 'inactive'

export default function AccountAccessPage() {
  const { data: session } = useSession()
  const user = session?.user as any

  const [users,   setUsers]   = useState<CompanyUser[]>([])
  const [client,  setClient]  = useState('')
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [busy,    setBusy]    = useState<number | null>(null)
  const [search,  setSearch]  = useState('')
  const [status,  setStatus]  = useState<StatusFilter>('all')
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  // Activity trail — opened as a modal so the account-wide feed (every login
  // attached to this company, not just this session) gets a full screen of room
  // without pushing the access list down the page.
  const [events,     setEvents]     = useState<ActivityEvent[]>([])
  const [showLog,    setShowLog]    = useState(false)
  const [logDays,    setLogDays]    = useState<number>(7)
  const [logLoading, setLogLoading] = useState(false)
  const [logSearch,  setLogSearch]  = useState('')
  // Revoking access is the destructive direction, so it is confirmed rather
  // than applied on a single stray click.
  const [confirm, setConfirm] = useState<CompanyUser | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  async function load() {
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/client-admin/users', { credentials: 'include' })
      const data = await res.json()
      if (!data.success) {
        setError(res.status === 403
          ? 'You do not have Client Admin access for this account.'
          : (data.error || 'Failed to load users'))
        return
      }
      setUsers(data.users || [])
      setClient(data.clientName || '')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Audit trail for this company — every login attached to it, not just the
  // session's own. Fetched when the modal opens and whenever the window
  // changes; the list page itself never waits on it.
  async function loadActivity(days = logDays) {
    setLogLoading(true)
    try {
      const res  = await fetch(`/api/client-admin/activity?days=${days}&limit=500`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) setEvents(data.events || [])
    } catch { /* the trail is supplementary — never block the page on it */ }
    finally { setLogLoading(false) }
  }

  useEffect(() => { load() }, [])

  // Load on open and on every window change.
  useEffect(() => { if (showLog) loadActivity(logDays) }, [showLog, logDays])

  // Close the modal on Escape, and stop the page scrolling behind it.
  useEffect(() => {
    if (!showLog) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowLog(false) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [showLog])

  // Same for the revoke confirmation.
  useEffect(() => {
    if (!confirm) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConfirm(null) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [confirm])

  async function apply(u: CompanyUser, next: boolean) {
    setBusy(u.loginId)
    try {
      const res = await fetch('/api/client-admin/users', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: u.loginId, isActive: next }),
      })
      const data = await res.json()
      if (data.success) {
        setUsers(prev => prev.map(x => x.loginId === u.loginId ? { ...x, is_active: next ? 1 : 0 } : x))
        showToast(`${fullName(u)} ${next ? 'can now sign in' : 'can no longer sign in'}`)
      } else {
        showToast(data.error || 'Update failed', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    // Refresh the trail either way — a refused attempt is recorded too — but
    // only while it is on screen.
    if (showLog) loadActivity()
    setBusy(null)
  }

  function requestToggle(u: CompanyUser) {
    if (Number(u.is_active) === 1) setConfirm(u)   // revoking → confirm
    else apply(u, true)                            // granting → immediate
  }

  const stats = useMemo(() => {
    const active = users.filter(u => Number(u.is_active) === 1).length
    return {
      total: users.length,
      active,
      inactive: users.length - active,
      admins: users.filter(u => Number(u.is_client_admin) === 1).length,
    }
  }, [users])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter(u => {
      if (status === 'active'   && Number(u.is_active) !== 1) return false
      if (status === 'inactive' && Number(u.is_active) === 1) return false
      if (!q) return true
      return fullName(u).toLowerCase().includes(q)
        || String(u.login_username ?? '').toLowerCase().includes(q)
    })
  }, [users, search, status])

  // Free-text narrowing over the window the server returned — matches the
  // person, the action in the words shown on screen, and the IP.
  const visibleEvents = useMemo(() => {
    const q = logSearch.trim().toLowerCase()
    if (!q) return events
    return events.filter(ev =>
      (ev.actor_name ?? '').toLowerCase().includes(q)
      || (ev.actor_username ?? '').toLowerCase().includes(q)
      || actionLabel(ev.action).toLowerCase().includes(q)
      || (ev.ip_address ?? '').toLowerCase().includes(q)
      || describe(ev).toLowerCase().includes(q))
  }, [events, logSearch])

  // dcp_user_login.created_at is null for logins predating the column, and a
  // column of nothing but em-dashes reads as a broken table. Show it only once
  // at least one row can fill it.
  const showAdded = useMemo(() => users.some(u => !!u.created_at), [users])

  const companyLabel = client || user?.clientName || 'your account'

  return (
    <div className="fade-in">
      {toast && (
        <div className={`fixed top-5 right-5 z-50 max-w-sm px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl flex items-center gap-2 ${
          toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          <span className="text-base leading-none">{toast.type === 'success' ? '✓' : '✕'}</span>
          {toast.msg}
        </div>
      )}

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-5">
        <div>
          <Breadcrumb items={[{ label: 'Administration' }, { label: 'Account Access' }]} />
          <div className="flex items-center gap-3 mt-2">
            <div className="w-10 h-10 rounded-xl grid place-items-center text-white flex-shrink-0"
              style={{ background: `linear-gradient(135deg, ${NAVY}, #1e3a6e)` }}>
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 0 0-5.36-1.86M17 20H7m10 0v-2c0-.66-.13-1.3-.36-1.86m0 0A5 5 0 0 0 7.36 16.14M7 20H2v-2a3 3 0 0 1 5.36-1.86" />
                <circle cx="12" cy="7" r="3" /><circle cx="19" cy="9" r="2" /><circle cx="5" cy="9" r="2" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-[#14254A] leading-tight">Account Access</h1>
              <p className="text-brand-muted text-sm truncate">
                People who can sign in to <b className="text-[#14254A]">{companyLabel}</b>
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button onClick={() => setShowLog(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold text-white transition-opacity hover:opacity-90 whitespace-nowrap"
            style={{ background: NAVY }}>
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
              <circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 7v5l3 2" />
            </svg>
            Activity log
          </button>
          <button onClick={() => { load(); if (showLog) loadActivity() }} disabled={loading}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border-2 transition-colors disabled:opacity-50 whitespace-nowrap"
            style={{ borderColor: NAVY, color: NAVY }}>
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card">
          <PageLoader />
        </div>
      ) : error ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-12 text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl grid place-items-center bg-red-50 text-red-500">
            <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
          </div>
          <h2 className="text-base font-bold text-[#14254A] mb-1">Unable to show access list</h2>
          <p className="text-sm text-gray-400 max-w-md mx-auto">{error}</p>
        </div>
      ) : (
        <>
          {/* ── Summary ─────────────────────────────────────────────────────
              One divided strip rather than four separate cards: the numbers are
              small and related, and four boxes across a wide screen left more
              empty space than content. */}
          {/* gap-px over a grey ground draws the dividers — `divide-x` on a grid
              puts a stray border at the start of each wrapped row. */}
          <div className="rounded-2xl shadow-card border border-gray-100 mb-4 overflow-hidden
            grid grid-cols-2 lg:grid-cols-4 gap-px bg-gray-100">
            <Stat label="Total users"    value={stats.total}    tone="navy"
              icon={<IconUsers />} foot="with access to this account" />
            <Stat label="Active"         value={stats.active}   tone="emerald"
              icon={<IconCheck />} foot="can sign in today" />
            <Stat label="Inactive"       value={stats.inactive} tone="amber"
              icon={<IconPause />} foot="sign-in blocked" />
            <Stat label="Administrators" value={stats.admins}   tone="orange"
              icon={<IconShield />} foot="can manage this list" />
          </div>

          {/* ── Access list ───────────────────────────────────────────────── */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
            <div className="h-1" style={{ background: `linear-gradient(90deg, ${NAVY}, ${ORANGE})` }} />

            {/* Toolbar */}
            <div className="flex items-center justify-between px-5 py-4 gap-3 flex-wrap border-b border-gray-100">
              <div>
                <h2 className="font-bold text-[#14254A] text-sm">Users</h2>
                <p className="text-xs text-brand-muted mt-0.5">
                  {filtered.length === users.length
                    ? `${users.length} user${users.length === 1 ? '' : 's'}`
                    : `${filtered.length} of ${users.length} shown`}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Status segmented control */}
                <div className="flex p-1 gap-1 rounded-xl bg-gray-100">
                  {([
                    { key: 'all',      label: 'All' },
                    { key: 'active',   label: 'Active' },
                    { key: 'inactive', label: 'Inactive' },
                  ] as const).map(s => (
                    <button key={s.key} onClick={() => setStatus(s.key)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        status === s.key ? 'bg-white shadow-sm text-[#14254A]' : 'text-gray-500 hover:text-gray-700'
                      }`}>
                      {s.label}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <svg className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                  </svg>
                  <input type="text" placeholder="Search users…"
                    value={search} onChange={e => setSearch(e.target.value)}
                    className="border border-gray-200 rounded-xl pl-8 pr-3 py-2 text-xs w-56 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A]"
                  />
                </div>
              </div>
            </div>

            {filtered.length === 0 ? (
              <div className="py-16 text-center">
                <div className="w-12 h-12 mx-auto mb-3 rounded-2xl grid place-items-center bg-gray-50 text-gray-300">
                  <IconUsers />
                </div>
                <p className="text-sm font-semibold text-gray-600">No users match these filters</p>
                <p className="text-xs text-gray-400 mt-1">Try clearing the search or switching to “All”.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[560px]">
                  <thead>
                    <tr className="bg-gray-50/80">
                      <th className="px-5 py-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-left">User</th>
                      <th className="px-5 py-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-left hidden md:table-cell w-44">
                        Sign-in method
                      </th>
                      {showAdded && (
                        <th className="px-5 py-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-left hidden lg:table-cell w-36">
                          Added
                        </th>
                      )}
                      <th className="px-5 py-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-right w-40">Access</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(u => {
                      const on = Number(u.is_active) === 1
                      // Staff logins and the caller's own row are read-only: a
                      // client must not disable IP House staff, and disabling
                      // yourself would lock you out with no way back.
                      const locked = Number(u.is_staff) === 1 || u.isSelf
                      return (
                        <tr key={u.loginId}
                          className={`border-b border-gray-50 last:border-0 transition-colors hover:bg-[#14254A]/[0.02] ${
                            on ? '' : 'bg-gray-50/40'}`}>
                          {/* Name and sign-in address share one cell: as separate
                              columns they sat a third of the table apart, which
                              is what made the list read as mostly empty space. */}
                          <td className="px-5 py-2.5">
                            <div className="flex items-center gap-3">
                              <div className={`w-9 h-9 rounded-xl grid place-items-center font-bold text-xs flex-shrink-0 text-white ${
                                on ? '' : 'opacity-40'}`}
                                style={{ background: `linear-gradient(135deg, ${NAVY}, #2d4f8a)` }}>
                                {initials(fullName(u))}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <p className={`text-sm font-semibold truncate ${on ? 'text-gray-800' : 'text-gray-400'}`}>
                                    {fullName(u)}
                                  </p>
                                  {u.isSelf && <Tag tone="blue">You</Tag>}
                                  {Number(u.is_client_admin) === 1 && <Tag tone="orange">Administrator</Tag>}
                                  {Number(u.is_staff) === 1 && <Tag tone="violet">IP House</Tag>}
                                </div>
                                <p className="text-[11px] text-gray-400 font-mono truncate mt-0.5">
                                  {u.login_username || '—'}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-2.5 hidden md:table-cell">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-gray-100 text-gray-600 whitespace-nowrap">
                              {LOGIN_TYPES[Number(u.login_type)] ?? '—'}
                            </span>
                          </td>
                          {showAdded && (
                            <td className="px-5 py-2.5 text-xs text-gray-500 hidden lg:table-cell whitespace-nowrap">
                              {fmtDate(u.created_at)}
                            </td>
                          )}
                          {/* Locked rows keep the switch — greyed and disabled —
                              so the column stays one shape down the page instead
                              of alternating between a control and a label. */}
                          <td className="px-5 py-2.5">
                            <div className="flex items-center justify-end gap-2.5">
                              <span className={`text-xs font-semibold whitespace-nowrap ${
                                busy === u.loginId ? 'text-gray-400'
                                  : locked ? 'text-gray-400'
                                  : on ? 'text-emerald-600' : 'text-gray-400'}`}>
                                {busy === u.loginId ? 'Saving…' : on ? 'Active' : 'Inactive'}
                              </span>
                              <button onClick={() => requestToggle(u)}
                                disabled={locked || busy === u.loginId}
                                role="switch" aria-checked={on}
                                aria-label={locked
                                  ? `Access for ${fullName(u)} cannot be changed here`
                                  : `${on ? 'Revoke' : 'Grant'} access for ${fullName(u)}`}
                                title={locked
                                  ? (u.isSelf ? 'You cannot change your own access' : 'Managed by IP House')
                                  : on ? 'Revoke access' : 'Grant access'}
                                className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors flex-shrink-0 ${
                                  locked ? 'cursor-not-allowed' : ''} ${
                                  busy === u.loginId ? 'opacity-50' : ''} ${
                                  on ? (locked ? 'bg-emerald-500/35' : 'bg-emerald-500')
                                     : (locked ? 'bg-gray-200' : 'bg-gray-300')}`}>
                                <span className={`inline-block w-[18px] h-[18px] rounded-full shadow transform transition-transform ${
                                  locked ? 'bg-white/80' : 'bg-white'} ${
                                  on ? 'translate-x-[24px]' : 'translate-x-[3px]'}`} />
                              </button>
                              <span className="w-3 flex-shrink-0 text-gray-300" aria-hidden>
                                {locked && (
                                  <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                                    <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                                  </svg>
                                )}
                              </span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/60 text-[11px] text-gray-500">
              Need a user added, or a name, sign-in method or password changed? Contact the{' '}
              <b className="text-[#FC934C]">IP House team</b> — only they can make those changes.
            </div>
          </div>

        </>
      )}

      {/* ── Activity log ────────────────────────────────────────────────────
          Account-wide, not per-session: every action recorded against any login
          attached to this company — sign-ins, password resets, impersonation,
          credential reveals and the access changes made on this page, including
          refused attempts. A modal rather than an inline panel because the feed
          is long and would otherwise bury the access list. */}
      {showLog && (
        <Portal>
        <div className="fixed inset-0 z-[99999] flex items-start sm:items-center justify-center p-4 backdrop-blur-sm"
          style={{ background: 'rgba(20,37,74,0.62)' }}
          role="dialog" aria-modal="true" aria-label="Activity log"
          onClick={() => setShowLog(false)}>
          <div onClick={e => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl flex flex-col overflow-hidden my-auto"
            style={{ maxHeight: 'calc(100dvh - 3rem)' }}>

            {/* Header */}
            <div className="px-5 py-4 flex items-center gap-3 flex-shrink-0"
              style={{ background: `linear-gradient(135deg, ${NAVY}, #1e3a6e)` }}>
              <div className="w-10 h-10 rounded-xl grid place-items-center text-white flex-shrink-0"
                style={{ background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.18)' }}>
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 7v5l3 2" />
                </svg>
              </div>
              <div className="min-w-0">
                <h2 className="font-bold text-white text-base leading-tight">Activity Log</h2>
                <p className="text-white/70 text-xs truncate">
                  All recorded activity for <b className="text-white">{companyLabel}</b>
                </p>
              </div>
              <button onClick={() => setShowLog(false)} aria-label="Close"
                className="ml-auto text-white/60 hover:text-white text-xl leading-none flex-shrink-0">×</button>
            </div>

            {/* Controls */}
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap flex-shrink-0">
              <div className="flex p-1 gap-1 rounded-xl bg-gray-100">
                {RANGES.map(r => (
                  <button key={r.days} onClick={() => setLogDays(r.days)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      logDays === r.days ? 'bg-white shadow-sm text-[#14254A]' : 'text-gray-500 hover:text-gray-700'}`}>
                    {r.label}
                  </button>
                ))}
              </div>
              <div className="relative ml-auto">
                <svg className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                </svg>
                <input type="text" placeholder="Filter by user, action or IP…"
                  value={logSearch} onChange={e => setLogSearch(e.target.value)}
                  className="border border-gray-200 rounded-xl pl-8 pr-3 py-2 text-xs w-60 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A]"
                />
              </div>
            </div>

            {/* Feed */}
            <div className="overflow-y-auto flex-1 min-h-[200px]">
              {logLoading ? (
                <p className="text-sm text-gray-400 text-center py-16">Loading activity…</p>
              ) : visibleEvents.length === 0 ? (
                <div className="py-16 text-center">
                  <p className="text-sm font-semibold text-gray-600">
                    {events.length === 0 ? 'Nothing recorded in this period' : 'No entries match this filter'}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {events.length === 0 ? 'Try a longer date range.' : 'Try clearing the search.'}
                  </p>
                </div>
              ) : (
                <ol className="px-5 py-4">
                  {visibleEvents.map((ev, i) => {
                    const meta = parseMeta(ev.metadata)
                    const detail = describe(ev)
                    return (
                      <li key={ev.id} className="relative flex gap-3 pb-4 last:pb-0">
                        {/* Timeline rail */}
                        {i < visibleEvents.length - 1 && (
                          <span className="absolute left-[5px] top-4 bottom-0 w-px bg-gray-100" aria-hidden />
                        )}
                        <span className={`relative mt-1.5 w-[11px] h-[11px] rounded-full flex-shrink-0 ring-4 ring-white ${
                          ACTION_DOT[ev.action] ?? 'bg-gray-300'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${
                              ACTION_TONE[ev.action] ?? 'bg-gray-100 text-gray-600'}`}>
                              {actionLabel(ev.action)}
                            </span>
                            <span className="text-xs font-semibold text-gray-700 truncate">
                              {ev.actor_name || ev.actor_username || '—'}
                            </span>
                            {meta.actorIsStaff && <Tag tone="violet">IP House</Tag>}
                          </div>
                          {detail && <p className="text-xs text-gray-500 mt-0.5 break-words">{detail}</p>}
                          <p className="text-[11px] text-gray-400 mt-0.5">
                            {relative(ev.created_at)} · {fmtStamp(ev.created_at)}
                            {ev.ip_address ? <> · <span className="font-mono">{ev.ip_address}</span></> : null}
                          </p>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/60 text-[11px] text-gray-500 flex items-center justify-between gap-3 flex-wrap flex-shrink-0">
              <span>
                Recorded automatically and cannot be edited or deleted from this page. IP House staff see the
                same events in the platform-wide tracking report.
              </span>
              <span className="whitespace-nowrap font-semibold text-gray-400">
                {visibleEvents.length === events.length
                  ? `${events.length} entr${events.length === 1 ? 'y' : 'ies'}`
                  : `${visibleEvents.length} of ${events.length}`}
              </span>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Revoke confirmation ─────────────────────────────────────────── */}
      {confirm && (
        <Portal>
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 backdrop-blur-sm"
          style={{ background: 'rgba(20,37,74,0.55)' }}
          role="dialog" aria-modal="true"
          onClick={() => setConfirm(null)}>
          <div onClick={e => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            style={{ border: '1px solid rgba(20,37,74,0.12)' }}>
            <div className="p-6">
              <div className="w-11 h-11 rounded-xl grid place-items-center bg-amber-50 text-amber-600 mb-4">
                <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
              </div>
              <h3 className="text-base font-bold text-[#14254A] mb-1.5">
                Revoke access for {fullName(confirm)}?
              </h3>
              <p className="text-sm text-gray-500 leading-relaxed">
                They will no longer be able to sign in to <b className="text-gray-700">{companyLabel}</b>.
                Their account is kept and you can restore access at any time.
              </p>
              <p className="text-[11px] text-gray-400 mt-3">
                This action is recorded in the activity log against your name.
              </p>
            </div>
            <div className="flex gap-2 px-6 py-4 bg-gray-50 border-t border-gray-100">
              <button onClick={() => setConfirm(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 bg-white text-gray-600 text-sm font-semibold hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button onClick={() => { const u = confirm; setConfirm(null); apply(u, false) }}
                className="flex-1 py-2.5 rounded-xl text-white text-sm font-bold bg-amber-600 hover:bg-amber-700 transition-colors">
                Revoke access
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}
    </div>
  )
}

/* ── Primitives ─────────────────────────────────────────────────────────── */

const STAT_TONES: Record<string, { bg: string; fg: string; value: string }> = {
  navy:    { bg: 'bg-[#14254A]/5',  fg: 'text-[#14254A]',    value: 'text-[#14254A]' },
  emerald: { bg: 'bg-emerald-50',   fg: 'text-emerald-600',  value: 'text-emerald-600' },
  amber:   { bg: 'bg-amber-50',     fg: 'text-amber-600',    value: 'text-amber-600' },
  orange:  { bg: 'bg-orange-50',    fg: 'text-[#FC934C]',    value: 'text-[#FC934C]' },
}

function Stat({ label, value, foot, icon, tone }: {
  label: string; value: number; foot: string; icon: ReactNode; tone: keyof typeof STAT_TONES
}) {
  const t = STAT_TONES[tone]
  return (
    <div className="flex items-center gap-3 px-5 py-3.5 min-w-0 bg-white">
      <span className={`w-9 h-9 rounded-xl grid place-items-center flex-shrink-0 ${t.bg} ${t.fg}`}>{icon}</span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className={`text-xl font-extrabold leading-none ${t.value}`}>{value.toLocaleString()}</span>
          <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400 truncate">{label}</span>
        </div>
        <p className="text-[11px] text-gray-400 mt-1 truncate">{foot}</p>
      </div>
    </div>
  )
}

const TAG_TONES: Record<string, string> = {
  blue:   'bg-blue-50 text-blue-600',
  orange: 'bg-orange-50 text-[#c2691f]',
  violet: 'bg-violet-50 text-violet-700',
}

function Tag({ tone, children }: { tone: keyof typeof TAG_TONES; children: ReactNode }) {
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full whitespace-nowrap ${TAG_TONES[tone]}`}>
      {children}
    </span>
  )
}

const sv = { width: 15, height: 15, fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', strokeWidth: 2 } as const
const IconUsers  = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 0 0-5.36-1.86M17 20H7m10 0v-2c0-.66-.13-1.3-.36-1.86m0 0A5 5 0 0 0 7.36 16.14M7 20H2v-2a3 3 0 0 1 5.36-1.86" /><circle cx="12" cy="7" r="3" /></svg>
const IconCheck  = () => <svg {...sv}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="m8.5 12 2.5 2.5 4.5-5" /></svg>
const IconPause  = () => <svg {...sv}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M10 9v6M14 9v6" /></svg>
const IconShield = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path strokeLinecap="round" strokeLinejoin="round" d="m9 12 2 2 4-4" /></svg>
