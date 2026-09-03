'use client'

// Single notification, in full.
//
// Reached by clicking any notification (bell or list). The server applies the
// same scope predicate here as everywhere else, so an id outside the viewer's
// access returns 404 — indistinguishable from one that doesn't exist.
//
// Opening a notification also marks it read, which is what a reader expects
// and keeps the bell badge honest.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import ReportLoader from '@/components/shared/ReportLoader'
import {
  sourceOf, parseMeta, orderedMeta, formatMetaValue, exactTime, relativeTime,
  META_LABELS, type PortalNotification, type Scope,
} from './notificationMeta'

interface ActorDetails {
  name?: string
  username?: string
  loginId?: number
  first_name?: string
  last_name?: string
  login_username?: string
  login_type?: number
  is_active?: number
  is_client_admin?: number
  client_name?: string
  client_email?: string
  is_staff?: number
}

const LOGIN_TYPES: Record<number, string> = { 0: 'Password', 1: 'Single sign-on', 2: 'Email OTP' }

export default function NotificationDetailPage({ id, basePath }: { id: string; basePath: string }) {
  const [item,   setItem]   = useState<PortalNotification | null>(null)
  const [actor,  setActor]  = useState<ActorDetails>({})
  const [scope,  setScope]  = useState<Scope>('self')
  const [loading, setLoading] = useState(true)
  const [error,  setError]  = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res  = await fetch(`/api/notifications/feed/${encodeURIComponent(id)}`, { credentials: 'include' })
      const data = await res.json()
      if (!data.success) {
        setError(res.status === 404
          ? 'This notification does not exist, or it is outside your access.'
          : (data.error || 'Could not load this notification'))
        return
      }
      setItem(data.notification)
      setActor(data.actor || {})
      setScope((data.scope as Scope) ?? 'self')

      // Reading it counts as reading it.
      if (!Number(data.notification?.is_read)) {
        fetch('/api/notifications/feed/read', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: Number(id) }),
        }).catch(() => {})
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const backLink = (
    <Link to={basePath}
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-white/50 hover:text-[#FC934C] transition-colors no-underline">
      ← All notifications
    </Link>
  )

  if (loading) {
    return (
      <div className="fade-in">
        {backLink}
        <div className="mt-4 bg-white dark:bg-[#14213a] rounded-2xl border border-gray-100 dark:border-white/10 shadow-card">
          <ReportLoader size={150} label="Loading" className="py-16" />
        </div>
      </div>
    )
  }

  if (error || !item) {
    return (
      <div className="fade-in">
        {backLink}
        <div className="mt-4 bg-white dark:bg-[#14213a] rounded-2xl border border-gray-100 dark:border-white/10 shadow-card p-12 text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl grid place-items-center bg-amber-50 text-amber-500">
            <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
          </div>
          <h2 className="text-base font-bold text-[#14254A] dark:text-white mb-1">Notification unavailable</h2>
          <p className="text-sm text-gray-400 dark:text-white/40 max-w-md mx-auto">{error}</p>
        </div>
      </div>
    )
  }

  const t    = sourceOf(item.event_type)
  const meta = parseMeta(item.metadata)
  const rows = orderedMeta(meta)
  const actorName = [actor.first_name, actor.last_name].filter(Boolean).join(' ').trim()
    || actor.name || item.actor_name || item.actor_username || '—'

  return (
    <div className="fade-in">
      {backLink}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mt-3 bg-white dark:bg-[#14213a] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 overflow-hidden">
        <div className="h-1" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />
        <div className="p-5 sm:p-6 flex items-start gap-4">
          <span className={`w-12 h-12 rounded-2xl grid place-items-center flex-shrink-0 ${t.bg} ${t.fg}`}>
            <span className="scale-150">{t.icon}</span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md ${t.chip}`}>
                {t.label}
              </span>
              <span className="text-[11px] text-gray-400 dark:text-white/35">
                from <b className="text-gray-500 dark:text-white/55">{t.page}</b>
              </span>
            </div>
            <h1 className="text-lg font-bold text-[#14254A] dark:text-white leading-snug break-words">{item.title}</h1>
            <p className="text-sm text-gray-500 dark:text-white/50 mt-1 break-words">{item.message}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">

        {/* ── Who ─────────────────────────────────────────────────────── */}
        <Panel title="User details" icon={<IconUser />}>
          <Row label="Name" value={actorName} />
          <Row label="Sign-in address" value={actor.login_username || item.actor_username || '—'} mono />
          {actor.login_type !== undefined && (
            <Row label="Sign-in method" value={LOGIN_TYPES[Number(actor.login_type)] ?? '—'} />
          )}
          <Row label="Client (company)" value={item.client_name || actor.client_name || '—'} />
          {actor.client_email && <Row label="Company email" value={actor.client_email} mono />}
          <Row label="Role" value={
            <span className="flex items-center gap-1.5 flex-wrap">
              {Number(actor.is_staff) === 1 && <Tag tone="violet">IP House staff</Tag>}
              {Number(actor.is_client_admin) === 1 && <Tag tone="orange">Client Admin</Tag>}
              {Number(actor.is_staff) !== 1 && Number(actor.is_client_admin) !== 1 && (
                <span className="text-gray-600 dark:text-white/60">Client user</span>
              )}
            </span>
          } />
          {actor.is_active !== undefined && (
            <Row label="Account status" value={
              <Tag tone={Number(actor.is_active) === 1 ? 'emerald' : 'gray'}>
                {Number(actor.is_active) === 1 ? 'Active' : 'Inactive'}
              </Tag>
            } />
          )}
          {meta.impersonatedBy && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-xl bg-violet-50 dark:bg-violet-500/10 border border-violet-100 dark:border-violet-500/20 text-[11px] text-violet-800 dark:text-violet-200">
              <svg className="w-3.5 h-3.5 flex-shrink-0 mt-px" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
              </svg>
              <span>
                Performed by IP House staff while viewing the portal as this client
                {meta.impersonatorName ? <> — <b>{meta.impersonatorName}</b></> : null}.
              </span>
            </div>
          )}
        </Panel>

        {/* ── When ────────────────────────────────────────────────────── */}
        <Panel title="Timing" icon={<IconClock />}>
          <Row label="Notification time" value={exactTime(item.created_at)} />
          <Row label="Relative" value={relativeTime(item.created_at)} />
          <Row label="Status" value={
            Number(item.is_read) === 1
              ? <Tag tone="gray">Read{item.read_at ? ` · ${exactTime(item.read_at)}` : ''}</Tag>
              : <Tag tone="orange">Unread</Tag>
          } />
          <Row label="Reference" value={`#${item.id}`} mono />
          <p className="text-[11px] text-gray-400 dark:text-white/35 mt-3">
            Times are shown in your local timezone.
          </p>
        </Panel>

        {/* ── What ────────────────────────────────────────────────────── */}
        <div className="lg:col-span-2">
          <Panel title="Action taken" icon={<IconBolt />}>
            {rows.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-white/40 py-2">
                No additional detail was recorded for this action.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                {rows.map(([k, v]) => (
                  <Row key={k}
                    label={META_LABELS[k] ?? k}
                    value={formatMetaValue(k, v)}
                    mono={k === 'fileName'} />
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>

      {/* Staff can pivot from this one event to everything that person did.
          The link carries the actor's login id, which is what the Tracking
          Report filters user_activity_log.user_id on, so it lands on the logs
          tab already scoped to them rather than on the whole feed. */}
      {scope === 'all' && item.actor_login_id ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Link to={`/admin/tracking?tab=logs&userId=${encodeURIComponent(String(item.actor_login_id))}`
            + `&userLabel=${encodeURIComponent(item.actor_name || item.actor_username || '')}`}
            className="px-4 py-2.5 rounded-xl text-sm font-bold text-white no-underline transition-all hover:opacity-90"
            style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
            View in Tracking Report
          </Link>
        </div>
      ) : null}
    </div>
  )
}

/* ── Primitives ─────────────────────────────────────────────────────────── */

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-white dark:bg-[#14213a] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-5 h-full">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-8 h-8 rounded-lg grid place-items-center bg-[#14254A]/5 dark:bg-white/10 text-[#14254A] dark:text-white/70 flex-shrink-0">
          {icon}
        </span>
        <h2 className="text-sm font-bold text-[#14254A] dark:text-white">{title}</h2>
      </div>
      {children}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-gray-50 dark:border-white/5 last:border-0">
      <span className="text-[11px] font-semibold text-gray-400 dark:text-white/40 uppercase tracking-wide flex-shrink-0 pt-0.5">
        {label}
      </span>
      <span className={`text-xs text-right break-words min-w-0 ${
        mono ? 'font-mono text-gray-600 dark:text-white/60' : 'text-gray-700 dark:text-white/75 font-medium'}`}>
        {value}
      </span>
    </div>
  )
}

const TAG_TONES: Record<string, string> = {
  orange:  'bg-orange-50 text-[#c2691f] dark:bg-orange-500/15 dark:text-[#FC934C]',
  violet:  'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  gray:    'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-white/60',
}

function Tag({ tone, children }: { tone: keyof typeof TAG_TONES; children: ReactNode }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md whitespace-nowrap ${TAG_TONES[tone]}`}>
      {children}
    </span>
  )
}

const sv = { width: 15, height: 15, fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', strokeWidth: 2 } as const
const IconUser  = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
const IconClock = () => <svg {...sv}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 7v5l3 2" /></svg>
const IconBolt  = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></svg>
