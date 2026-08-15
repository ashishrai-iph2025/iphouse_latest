'use client'

// Full notification list — "View all notifications" from the bell.
//
// Rendered inside whichever shell the viewer is in; `basePath` decides where a
// row links to (/notifications for clients, /admin/notifications for staff).
// What the list CONTAINS is decided entirely by the server, which scopes the
// feed to the viewer (all clients / own company / own actions).

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  sourceOf, parseMeta, relativeTime, exactTime, SOURCE_META,
  type PortalNotification, type Scope,
} from './notificationMeta'

const PER_PAGE = 20

export default function NotificationsListPage({ basePath }: { basePath: string }) {
  const [items,  setItems]  = useState<PortalNotification[]>([])
  const [total,  setTotal]  = useState(0)
  const [unread, setUnread] = useState(0)
  const [scope,  setScope]  = useState<Scope>('self')
  const [scopeLabel, setScopeLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [page,   setPage]   = useState(1)
  const [search, setSearch] = useState('')
  const [type,   setType]   = useState('')
  const [onlyUnread, setOnlyUnread] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        limit: String(PER_PAGE),
        offset: String((page - 1) * PER_PAGE),
      })
      if (search.trim()) params.set('search', search.trim())
      if (type) params.set('type', type)
      if (onlyUnread) params.set('unread', '1')
      const res  = await fetch(`/api/notifications/feed?${params}`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        setItems(data.items || [])
        setTotal(Number(data.total ?? 0))
        setUnread(Number(data.unreadCount ?? 0))
        setScope((data.scope as Scope) ?? 'self')
        setScopeLabel(String(data.scopeLabel ?? ''))
      }
    } catch { /* keep the last good state */ }
    setLoading(false)
  }, [page, search, type, onlyUnread])

  useEffect(() => { load() }, [load])
  // Any filter change restarts paging — page 3 of the old result set is
  // meaningless against the new one.
  useEffect(() => { setPage(1) }, [search, type, onlyUnread])

  async function markAllRead() {
    setItems(prev => prev.map(n => ({ ...n, is_read: 1 })))
    setUnread(0)
    try {
      await fetch('/api/notifications/feed/read', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
    } catch { /* the next load re-syncs */ }
    load()
  }

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))
  const from = total === 0 ? 0 : (page - 1) * PER_PAGE + 1
  const to   = Math.min(page * PER_PAGE, total)

  return (
    <div className="fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl grid place-items-center text-white flex-shrink-0"
            style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#14254A] dark:text-white leading-tight">Notifications</h1>
            <p className="text-brand-muted text-sm">
              {total.toLocaleString()} total
              {unread > 0 ? <> · <b className="text-[#FC934C]">{unread} unread</b></> : null}
              {scopeLabel ? <> · {scopeLabel}</> : null}
            </p>
          </div>
        </div>
        {unread > 0 && (
          <button onClick={markAllRead}
            className="self-start px-3.5 py-2 rounded-xl text-xs font-bold border-2 transition-colors whitespace-nowrap"
            style={{ borderColor: '#FC934C', color: '#c2691f' }}>
            Mark all read
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-[#14213a] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 overflow-hidden">
        <div className="h-1" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />

        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-4 border-b border-gray-100 dark:border-white/10">
          <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-white/50 cursor-pointer select-none">
            <input type="checkbox" checked={onlyUnread} onChange={e => setOnlyUnread(e.target.checked)}
              className="w-3.5 h-3.5 rounded accent-[#FC934C]" />
            Unread only
          </label>
          <div className="flex items-center gap-2 flex-wrap ml-auto">
            <select value={type} onChange={e => setType(e.target.value)}
              className="border border-gray-200 dark:border-white/10 dark:bg-white/5 dark:text-white rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#14254A]/20">
              <option value="">All sources</option>
              {Object.entries(SOURCE_META).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <input type="text" placeholder="Search notifications…"
              value={search} onChange={e => setSearch(e.target.value)}
              className="border border-gray-200 dark:border-white/10 dark:bg-white/5 dark:text-white rounded-xl px-3 py-2 text-xs w-56 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
          </div>
        </div>

        {/* List */}
        {loading && items.length === 0 ? (
          <div className="py-16 grid place-items-center">
            <span className="w-7 h-7 border-2 border-gray-200 border-t-[#14254A] rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center px-6">
            <div className="w-12 h-12 mx-auto mb-3 rounded-2xl grid place-items-center bg-gray-50 dark:bg-white/5 text-gray-300 dark:text-white/25">
              <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-gray-600 dark:text-white/70">No notifications found</p>
            <p className="text-[11px] text-gray-400 dark:text-white/40 mt-1">
              {search || type || onlyUnread
                ? 'Try clearing the filters above.'
                : 'Uploads, approvals, download requests and shared files will appear here.'}
            </p>
          </div>
        ) : (
          <div>
            {items.map(n => {
              const t      = sourceOf(n.event_type)
              const meta   = parseMeta(n.metadata)
              const isRead = !!Number(n.is_read)
              return (
                <Link key={n.id} to={`${basePath}/${n.id}`}
                  className={`flex gap-3 px-5 py-4 border-b border-gray-50 dark:border-white/5 last:border-0 transition-colors no-underline hover:bg-gray-50 dark:hover:bg-white/5 ${
                    isRead ? '' : 'bg-[#FC934C]/[0.04]'}`}>
                  <span className={`w-9 h-9 rounded-xl grid place-items-center flex-shrink-0 ${t.bg} ${t.fg}`}>
                    {t.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 mb-1 flex-wrap">
                      <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md ${t.chip}`}>
                        {t.label}
                      </span>
                      {!isRead && <span className="w-1.5 h-1.5 rounded-full bg-[#FC934C]" />}
                      <span className="ml-auto text-[11px] text-gray-400 dark:text-white/35 whitespace-nowrap"
                        title={exactTime(n.created_at)}>
                        {relativeTime(n.created_at)}
                      </span>
                    </span>
                    <span className={`block text-sm break-words ${isRead
                      ? 'font-semibold text-gray-700 dark:text-white/75'
                      : 'font-bold text-[#14254A] dark:text-white'}`}>
                      {n.title}
                    </span>
                    <span className="block text-xs text-gray-500 dark:text-white/50 mt-0.5 break-words">
                      {n.message}
                    </span>
                    {scope !== 'self' && (
                      <span className="block text-[11px] text-gray-400 dark:text-white/35 mt-1 truncate">
                        {scope === 'all' ? (n.client_name || 'Unknown client') : null}
                        {scope === 'all' && n.actor_name ? ' · ' : null}
                        {n.actor_name}
                        {meta.impersonatedBy ? ' · via IP House' : null}
                      </span>
                    )}
                  </span>
                  <span className="self-center text-gray-300 dark:text-white/25 flex-shrink-0 text-sm">›</span>
                </Link>
              )
            })}
          </div>
        )}

        {/* Pagination */}
        {total > PER_PAGE && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 dark:border-white/10 text-xs text-gray-500 dark:text-white/50">
            <span>Showing {from}–{to} of {total.toLocaleString()}</span>
            <div className="flex items-center gap-1">
              <PgBtn onClick={() => setPage(1)} disabled={page === 1}>«</PgBtn>
              <PgBtn onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>‹</PgBtn>
              <span className="px-2 font-semibold">{page} / {totalPages}</span>
              <PgBtn onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>›</PgBtn>
              <PgBtn onClick={() => setPage(totalPages)} disabled={page === totalPages}>»</PgBtn>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PgBtn({ children, onClick, disabled }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="px-2 py-1 rounded border border-gray-200 dark:border-white/10 disabled:opacity-30 hover:bg-gray-50 dark:hover:bg-white/10 transition-colors">
      {children}
    </button>
  )
}
