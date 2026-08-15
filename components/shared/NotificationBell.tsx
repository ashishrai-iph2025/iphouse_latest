'use client'

// Notification bell — shown to every signed-in user, in both the admin shell
// and the client shell.
//
// The SERVER decides what each viewer sees (handlers.NotificationFeed):
//   Admin / Super Admin → every event, every client
//   Client Admin        → every event on their own company
//   Client user         → only the events they themselves caused
//
// This component renders whatever it is given and shows the scope label the
// server returns — it never filters by role itself, so the UI can't drift out
// of step with the real rule. Read state is per login, so one person clearing
// their bell never hides an event from anyone else.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

const POLL_MS = 60_000

interface AdminNotification {
  id: number
  event_type: string
  title: string
  message: string
  actor_name: string
  actor_username: string
  client_user_id: number
  client_name: string
  link: string
  metadata: string | null
  created_at: string
  is_read: number
}

/** Scope the server applied — drives the header label and which columns matter. */
type Scope = 'all' | 'company' | 'self'

/* Source presentation. Every notification names its own source inline — one
   chronological list, no tabs. A tabbed feed makes the reader choose a category
   before they can see anything, which is backwards for a bell: the point is to
   glance once and know what happened. */
const TYPE_META: Record<string, { icon: ReactNode; bg: string; fg: string; label: string; chip: string }> = {
  url_upload: {
    label: 'URL Upload',
    chip: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
    bg: 'bg-blue-50 dark:bg-blue-500/10', fg: 'text-blue-600 dark:text-blue-300',
    icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1m-4-8-4-4m0 0L8 8m4-4v12" /></svg>,
  },
  approval_action: {
    label: 'Approval Review',
    chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    bg: 'bg-emerald-50 dark:bg-emerald-500/10', fg: 'text-emerald-600 dark:text-emerald-300',
    icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /></svg>,
  },
  download_request: {
    label: 'Download Request',
    chip: 'bg-orange-50 text-[#c2691f] dark:bg-orange-500/15 dark:text-[#FC934C]',
    bg: 'bg-orange-50 dark:bg-orange-500/10', fg: 'text-[#FC934C]',
    icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1m-4-4-4 4m0 0-4-4m4 4V4" /></svg>,
  },
  data_sharing: {
    label: 'Data Sharing',
    chip: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
    bg: 'bg-violet-50 dark:bg-violet-500/10', fg: 'text-violet-600 dark:text-violet-300',
    icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5M7 3h8l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /></svg>,
  },
  download_ready: {
    label: 'Download Ready',
    chip: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
    bg: 'bg-teal-50 dark:bg-teal-500/10', fg: 'text-teal-600 dark:text-teal-300',
    icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>,
  },
}
const FALLBACK_META = {
  label: 'Activity',
  chip: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-white/60',
  bg: 'bg-gray-100 dark:bg-white/10', fg: 'text-gray-500 dark:text-white/60',
  icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 8h.01M12 11v5" /></svg>,
}

function parseMeta(raw: string | null): Record<string, any> {
  if (!raw) return {}
  try { return JSON.parse(raw) ?? {} } catch { return {} }
}

/** MySQL hands back UTC as "YYYY-MM-DD HH:MM:SS" with no zone marker. */
function toDate(v: string): Date | null {
  const s = String(v ?? '')
  if (!s) return null
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime()) ? null : d
}

function relative(v: string): string {
  const d = toDate(v)
  if (!d) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

const exactStamp = (v: string) =>
  toDate(v)?.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) ?? ''

export default function NotificationBell({ variant = 'admin', tone }: {
  /** Which shell it sits in — only affects styling, never what is shown. */
  variant?: 'admin' | 'client'
  /** Force icon colour when the client navbar is painted a custom colour. */
  tone?: 'light' | 'dark'
}) {
  // The notification pages live under a different prefix per shell; the pages
  // themselves are the same components.
  const basePath = variant === 'admin' ? '/admin/notifications' : '/notifications'
  const navigate = useNavigate()
  const [open,    setOpen]    = useState(false)
  const [items,   setItems]   = useState<AdminNotification[]>([])
  const [unread,  setUnread]  = useState(0)
  const [loading, setLoading] = useState(true)
  const [scope,   setScope]   = useState<Scope>('self')
  const [scopeLabel, setScopeLabel] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // One chronological list — no server-side filtering. Each row names its
      // own source, so there is nothing to narrow down first.
      const res  = await fetch('/api/notifications/feed?limit=30', { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        setItems(data.items || [])
        setUnread(Number(data.unreadCount ?? 0))
        setScope((data.scope as Scope) ?? 'self')
        setScopeLabel(String(data.scopeLabel ?? ''))
      }
    } catch { /* leave the last good state on screen */ }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Keep the badge and an open panel live.
  useEffect(() => {
    const t = setInterval(() => { load() }, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function markRead(id: number) {
    setItems(prev => prev.map(n => n.id === id ? { ...n, is_read: 1 } : n))
    setUnread(u => Math.max(0, u - 1))
    try {
      await fetch('/api/notifications/feed/read', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    } catch { /* the next poll re-syncs */ }
  }

  async function markAllRead() {
    setItems(prev => prev.map(n => ({ ...n, is_read: 1 })))
    setUnread(0)
    try {
      await fetch('/api/notifications/feed/read', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
    } catch { /* the next poll re-syncs */ }
    load()
  }

  // Opening a notification goes to its own page, where the full record —
  // user details, timing and the action taken — is laid out. The detail page
  // marks it read itself, so this only closes the panel.
  function openItem(n: AdminNotification) {
    // Marked here as well as on the detail page so the badge drops immediately
    // instead of waiting for the next poll. The detail page skips its own write
    // when the record already reads as read, so this is not a double update.
    if (!Number(n.is_read)) markRead(n.id)
    setOpen(false)
    navigate(`${basePath}/${n.id}`)
  }

  const badge = unread > 99 ? '99+' : String(unread)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        title="Notifications"
        className={`relative flex items-center justify-center w-9 h-9 rounded-xl transition-colors ${
          tone === 'light'
            ? 'text-white hover:bg-white/10'
            : 'text-gray-500 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-[#14254A] dark:hover:text-white'
        }`}
      >
        <svg width="19" height="19" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <>
            <span className={`absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-[#FC934C] text-white text-[9px] font-bold grid place-items-center ring-2 ${
              variant === 'client' ? 'ring-white dark:ring-[#14254A]' : 'ring-white dark:ring-[#14213a]'}`}>
              {badge}
            </span>
            {/* Quiet pulse so a new item is noticed without animating forever */}
            <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-[#FC934C]/40 animate-ping pointer-events-none" />
          </>
        )}
      </button>

      {/* The panel floats over both the white navbar and the #eef2f7 page body,
          so it carries its own navy header, a tinted surface and a hard edge —
          a plain white card blends into whichever of the two it overlaps. */}
      {open && (
        <div className="absolute right-0 top-11 z-50 w-[min(94vw,400px)] rounded-2xl overflow-hidden
                        bg-[#e8edf5] dark:bg-[#14213a]
                        border border-[#14254A]/20 dark:border-white/10
                        shadow-[0_24px_64px_-16px_rgba(20,37,74,0.5)]">
          {/* Header */}
          <div className="px-4 py-3 flex items-center justify-between gap-2 border-b border-black/10 dark:border-white/10"
            style={{ background: 'linear-gradient(135deg,#14254A 0%,#1E3766 100%)' }}>
            <div>
              <h3 className="text-sm font-bold text-white">Notifications</h3>
              <p className="text-[11px] text-white/60">
                {unread > 0 ? `${unread} unread` : 'You are all caught up'}
                {scopeLabel ? <> · <span className="font-semibold text-white/80">{scopeLabel}</span></> : null}
              </p>
            </div>
            {unread > 0 && (
              <button onClick={markAllRead}
                className="text-[11px] font-bold text-[#FFC82B] hover:underline whitespace-nowrap">
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-[380px] overflow-y-auto bg-[#f6f8fc] dark:bg-transparent">
            {loading && items.length === 0 ? (
              <div className="py-12 grid place-items-center">
                <span className="w-6 h-6 border-2 border-gray-200 border-t-[#14254A] rounded-full animate-spin" />
              </div>
            ) : items.length === 0 ? (
              <div className="py-12 text-center px-6">
                <div className="w-11 h-11 mx-auto mb-3 rounded-2xl grid place-items-center bg-[#14254A]/[0.07] dark:bg-white/5 text-[#14254A]/30 dark:text-white/25">
                  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-gray-600 dark:text-white/70">Nothing here yet</p>
                <p className="text-[11px] text-gray-400 dark:text-white/40 mt-1">
                  {scope === 'self'
                    ? 'Your uploads, approvals, download requests and shared files will appear here.'
                    : 'Uploads, approvals, download requests and shared files will appear here.'}
                </p>
              </div>
            ) : (
              items.map(n => {
                const meta   = parseMeta(n.metadata)
                const t      = TYPE_META[n.event_type] ?? FALLBACK_META
                const isRead = !!Number(n.is_read)
                return (
                  <button key={n.id} onClick={() => openItem(n)}
                    className={`w-full text-left flex gap-3 px-4 py-3 border-b border-[#14254A]/10 dark:border-white/5 last:border-0 transition-colors hover:bg-white dark:hover:bg-white/5 ${
                      isRead ? '' : 'bg-[#FC934C]/[0.07]'}`}>
                    <span className={`w-8 h-8 rounded-xl grid place-items-center flex-shrink-0 ${t.bg} ${t.fg}`}>
                      {t.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      {/* Source line — every row states where it came from, so
                          the list stays one stream and nothing is hidden behind
                          a tab the reader has to think to open. */}
                      <span className="flex items-center gap-1.5 mb-1">
                        <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md whitespace-nowrap ${t.chip}`}>
                          {t.label}
                        </span>
                        {!isRead && <span className="w-1.5 h-1.5 rounded-full bg-[#FC934C] flex-shrink-0" />}
                        <span className="ml-auto text-[10px] text-gray-400 dark:text-white/35 whitespace-nowrap flex-shrink-0"
                          title={exactStamp(n.created_at)}>
                          {relative(n.created_at)}
                        </span>
                      </span>
                      <span className={`block text-xs break-words ${isRead
                        ? 'font-semibold text-gray-600 dark:text-white/70'
                        : 'font-bold text-[#14254A] dark:text-white'}`}>
                        {n.title}
                      </span>
                      <span className="block text-[11px] text-gray-500 dark:text-white/50 mt-0.5 break-words">
                        {n.message}
                      </span>
                      {/* Own-activity feeds already know the client and the
                          actor — repeating them on every row is pure noise. */}
                      {scope !== 'self' && (
                        <span className="block text-[10px] text-gray-400 dark:text-white/35 mt-1 truncate">
                          {scope === 'all' ? (n.client_name || 'Unknown client') : null}
                          {scope === 'all' && n.actor_name ? ' · ' : null}
                          {n.actor_name}
                          {meta.impersonatedBy ? <> · via IP House</> : null}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })
            )}
          </div>

          {/* Always offer the full list — it is the way to reach anything
              older than the 30 most recent shown here. */}
          <div className="px-4 py-2.5 border-t border-[#14254A]/15 dark:border-white/10 bg-[#e2e8f2] dark:bg-white/[0.03] flex items-center justify-between gap-2">
            <p className="text-[10px] text-[#14254A]/50 dark:text-white/35">
              {items.length > 0 ? `Showing the ${items.length} most recent` : 'Nothing recent'}
            </p>
            <Link to={basePath} onClick={() => setOpen(false)}
              className="text-[11px] font-bold text-[#FC934C] hover:underline whitespace-nowrap no-underline">
              View all notifications →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
