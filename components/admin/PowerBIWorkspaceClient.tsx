'use client'
import React, { useState, useMemo, useCallback } from 'react'
import { useTheme } from '@/lib/ThemeContext'

/* ─── brand palette (IP House) ─────────────────────────────────────────────── */
const NAVY   = '#14254A'
const ORANGE = '#FC934C'
const YELLOW = '#FFC82B'
const GREEN  = '#2b7c38'
const ROSE   = '#b3091a'
const TEAL   = '#114a54'
const VIOLET = '#60325f'
const SLATE  = '#7C899C'
const BLUE   = '#0a4b9c'

/* ─── types (matches /api/admin/powerbi-workspace) ─────────────────────────── */
interface Report {
  id: string; name: string; reportType: string; webUrl: string; embedUrl: string; datasetId: string
}
interface RefreshAttempt { attemptId: number; type: string; startTime: string; endTime: string; status: string; error: any }
interface RefreshEntry {
  requestId: string; status: string; refreshType: string; startTime: string; endTime: string; error: any; attempts: RefreshAttempt[]
}
interface RefreshSchedule { days: string[]; times: string[]; enabled: boolean; localTimeZoneId: string; notifyOption: string }
interface DirectQuerySchedule { frequency: number; days: string[]; times: string[]; localTimeZoneId: string }
interface Dataset {
  id: string; name: string; configuredBy: string; isRefreshable: boolean
  isOnPremGatewayRequired: boolean; targetStorageMode: string; createdDate: string; contentProviderType: string
  refreshes: RefreshEntry[]; refreshSchedule: RefreshSchedule | null; directQueryRefreshSchedule: DirectQuerySchedule | null
}
interface WorkspaceData { workspaceId: string; workspaceName: string; workspaceType: string; reports: Report[]; datasets: Dataset[] }

/* ─── theme colors ─────────────────────────────────────────────────────────── */
type Colors = { card: string; bg: string; bord: string; t1: string; t2: string; t3: string }
function mkColors(isDark: boolean): Colors {
  return isDark
    ? { card: '#1a2d4e', bg: '#0f1f3d', bord: '#2a3f66', t1: '#e2e8f5', t2: '#8ba3c9', t3: '#4d6a94' }
    : { card: '#ffffff',  bg: '#f6f8fb',  bord: '#e8ebf0', t1: '#1f2a40', t2: '#5b6678', t3: '#9aa3b2' }
}

/* ─── helpers ──────────────────────────────────────────────────────────────── */
const fmt = (s?: string | null) => {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return s }
}
const dur = (a?: string | null, b?: string | null) => {
  if (!a || !b) return '—'
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (isNaN(ms) || ms < 0) return '—'
  const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000)
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}
const abbr = (s: string, n = 28) => (s && s.length > n ? s.slice(0, n) + '…' : s)

function nextScheduledTime(schedule: RefreshSchedule | null): string | null {
  if (!schedule || !schedule.enabled || !schedule.times?.length || !schedule.days?.length) return null
  const tz = schedule.localTimeZoneId || 'UTC'
  try {
    const now = new Date()
    for (let offset = 0; offset < 7; offset++) {
      const probe = new Date(now.getTime() + offset * 86400000)
      const dayName = probe.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz })
      if (!schedule.days.includes(dayName)) continue
      const parts = probe.toLocaleDateString('en-CA', { timeZone: tz }).split('-')
      for (const t of schedule.times) {
        const [hh, mm] = t.split(':').map(Number)
        const candidate = new Date(`${parts[0]}-${parts[1]}-${parts[2]}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`)
        if (candidate > now) return candidate.toISOString()
      }
    }
    return null
  } catch { return null }
}

/* ─── inline SVG icon set ──────────────────────────────────────────────────── */
type IcoName =
  | 'chart' | 'refresh' | 'settings' | 'alert' | 'spinner' | 'check' | 'x' | 'clock'
  | 'search' | 'external' | 'calendar' | 'database' | 'report' | 'chevDown' | 'chevRight'
  | 'info' | 'copy' | 'tick' | 'pause' | 'circle'

function Ico({ name, size = 13, className, style }: { name: IcoName; size?: number; className?: string; style?: React.CSSProperties }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, className, style }
  switch (name) {
    case 'chart':    return <svg {...p}><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="7"/><rect x="12" y="6" width="3" height="11"/><rect x="17" y="13" width="3" height="4"/></svg>
    case 'refresh':  return <svg {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
    case 'settings': return <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    case 'alert':    return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    case 'spinner':  return <svg {...p}><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>
    case 'check':    return <svg {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
    case 'x':        return <svg {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    case 'clock':    return <svg {...p}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    case 'search':   return <svg {...p}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    case 'external': return <svg {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    case 'calendar': return <svg {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
    case 'database': return <svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
    case 'report':   return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>
    case 'chevDown': return <svg {...p}><polyline points="6 9 12 15 18 9"/></svg>
    case 'chevRight':return <svg {...p}><polyline points="9 18 15 12 9 6"/></svg>
    case 'info':     return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
    case 'copy':     return <svg {...p}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    case 'tick':     return <svg {...p}><polyline points="20 6 9 17 4 12"/></svg>
    case 'pause':    return <svg {...p}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
    case 'circle':   return <svg {...p}><circle cx="12" cy="12" r="10"/></svg>
  }
}

/* ─── sub-components ───────────────────────────────────────────────────────── */
function StatusPill({ status }: { status: string }) {
  const s = (status ?? '').toLowerCase()
  const map: Record<string, [string, string, IcoName]> = {
    completed:  ['rgba(43,124,56,0.12)',  GREEN, 'check'],
    failed:     ['rgba(179,9,26,0.10)',   ROSE,  'x'],
    inprogress: ['rgba(10,75,156,0.12)',  BLUE,  'spinner'],
    unknown:    ['rgba(255,200,43,0.18)', '#b45309', 'alert'],
    cancelled:  ['rgba(255,200,43,0.15)', '#b45309', 'x'],
    disabled:   ['rgba(124,137,156,0.15)', SLATE, 'pause'],
  }
  const [bg, fg, icon] = map[s] ?? ['rgba(124,137,156,0.12)', SLATE, 'circle']
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 5, background: bg, border: `1px solid ${fg}30`, fontSize: 10, fontWeight: 700, color: fg, whiteSpace: 'nowrap' }}>
      <Ico name={icon} size={10} className={s === 'inprogress' ? 'animate-spin' : ''} />
      {status || 'Unknown'}
    </span>
  )
}

function CopyBtn({ text, t3 }: { text: string; t3: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      title="Copy ID"
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? GREEN : t3, display: 'inline-flex', padding: '2px 3px', verticalAlign: 'middle' }}>
      <Ico name={copied ? 'tick' : 'copy'} size={11} />
    </button>
  )
}

function InfoGrid({ items, C }: { items: { label: string; value: string; color?: string }[]; C: Colors }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 8 }}>
      {items.map((f, i) => (
        <div key={i} style={{ background: C.card, border: `1px solid ${C.bord}`, borderRadius: 8, padding: '12px 14px', boxShadow: '0 1px 4px rgba(13,36,75,0.05)' }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>{f.label}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: f.color ?? C.t1 }}>{f.value || '—'}</div>
        </div>
      ))}
    </div>
  )
}

/* ─── main ─────────────────────────────────────────────────────────────────── */
export default function PowerBIWorkspaceClient() {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const C = mkColors(isDark)

  const [data, setData]       = useState<WorkspaceData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  const [searchQ, setSearchQ]           = useState('')
  const [typeFilter, setTypeFilter]     = useState<'all' | 'Report' | 'SemanticModel'>('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [expandedDs, setExpandedDs]     = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab]       = useState<Record<string, 'history' | 'schedule'>>({})
  const [page, setPage]                 = useState(1)
  const PAGE_SIZE = 25

  const cardStyle: React.CSSProperties = {
    background: C.card,
    border: `1px solid ${C.bord}`,
    borderRadius: 12,
    boxShadow: isDark
      ? '0 1px 2px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.15)'
      : '0 1px 2px rgba(13,36,75,0.04), 0 4px 12px rgba(13,36,75,0.05)',
  }

  const load = useCallback(async () => {
    setLoading(true); setError(null); setData(null); setExpandedDs(new Set()); setPage(1)
    try {
      const res  = await fetch('/api/admin/powerbi-workspace', { credentials: 'include' })
      const json = await res.json()
      if (!res.ok || json.success === false) { setError(json.error ?? 'Failed to fetch workspace data'); setLoading(false); return }
      setData(json)
    } catch { setError('Network error — could not reach the server.') }
    setLoading(false)
  }, [])

  const toggleDs = (id: string) => setExpandedDs(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  const setTab   = (id: string, tab: 'history' | 'schedule') => setActiveTab(prev => ({ ...prev, [id]: tab }))

  interface FlatItem { itemType: 'Report' | 'SemanticModel'; report?: Report; dataset?: Dataset; name: string; id: string }
  const allItems: FlatItem[] = useMemo(() => {
    const out: FlatItem[] = []
    if (data) {
      for (const r of data.reports)  out.push({ itemType: 'Report',        report: r,  name: r.name, id: r.id })
      for (const d of data.datasets) out.push({ itemType: 'SemanticModel', dataset: d, name: d.name, id: d.id })
    }
    return out
  }, [data])

  const filtered = useMemo(() => {
    return allItems.filter(i => {
      if (searchQ && !i.name.toLowerCase().includes(searchQ.toLowerCase()) && !i.id.toLowerCase().includes(searchQ.toLowerCase())) return false
      if (typeFilter !== 'all' && i.itemType !== typeFilter) return false
      if (statusFilter !== 'all' && i.itemType === 'SemanticModel') {
        const st = i.dataset?.refreshes?.[0]?.status?.toLowerCase() ?? ''
        if (statusFilter !== st) return false
      }
      return true
    })
  }, [allItems, searchQ, typeFilter, statusFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages)
  const paged      = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const kpis = useMemo(() => {
    const reports = data?.reports.length ?? 0
    const models  = data?.datasets.length ?? 0
    const failed    = data?.datasets.filter(d => d.refreshes?.[0]?.status?.toLowerCase() === 'failed').length ?? 0
    const scheduled = data?.datasets.filter(d => d.refreshSchedule?.enabled).length ?? 0
    return { reports, models, failed, scheduled, total: reports + models }
  }, [data])

  const hasData = allItems.length > 0
  const COLS = '30px 1.8fr 140px 190px 170px 160px 52px'
  const thStyle: React.CSSProperties = { fontSize: 9, fontWeight: 700, color: '#fff', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0 10px', lineHeight: 1.4 }

  return (
    <div style={{ padding: 'clamp(12px,2vw,24px)', minHeight: '100vh', background: C.bg }}>

      {/* ── BACK LINK ── */}
      <a href="/admin/configuration"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 14, fontSize: 13, fontWeight: 600, color: C.t2, textDecoration: 'none' }}>
        <Ico name="chevRight" size={14} style={{ transform: 'rotate(180deg)' }} />
        Back to Configuration
      </a>

      {/* ── HEADER CARD ── */}
      <div style={{ ...cardStyle, padding: '20px 24px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14, fontSize: 11, color: C.t3 }}>
          <Ico name="chart" size={12} />
          <span>›</span>
          <span style={{ fontWeight: 700, color: C.t2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Power BI Workspace</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: isDark ? '#e2e8f5' : NAVY, letterSpacing: '-0.01em' }}>Power BI Workspace Monitor</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: C.t2 }}>Reports &amp; semantic models · Refresh history · Schedules</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <button onClick={load} disabled={loading}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 20px', borderRadius: 8, background: `linear-gradient(135deg,${YELLOW},${ORANGE})`, border: 'none', color: '#fff', fontSize: 12, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', boxShadow: '0 3px 10px rgba(252,147,76,0.35)', whiteSpace: 'nowrap', opacity: loading ? 0.7 : 1 }}>
              <Ico name={loading ? 'spinner' : 'refresh'} size={13} className={loading ? 'animate-spin' : ''} />
              {loading ? 'Loading…' : data ? 'Reload Workspace' : 'Load Workspace'}
            </button>
          </div>
        </div>
      </div>

      {/* ── ERROR ── */}
      {error && (
        <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', background: `${ROSE}08`, border: `1px solid ${ROSE}25`, marginBottom: 14 }}>
          <Ico name="alert" size={14} style={{ color: ROSE, flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: ROSE, flex: 1 }}>{error}</span>
        </div>
      )}

      {/* ── KPI STRIP ── */}
      {hasData && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10, marginBottom: 14 }}>
          {([
            { label: 'Total Items',      value: kpis.total,     color: isDark ? '#93c5fd' : NAVY,   icon: 'chart' as IcoName    },
            { label: 'Reports',          value: kpis.reports,   color: ORANGE, icon: 'report' as IcoName   },
            { label: 'Semantic Models',  value: kpis.models,    color: TEAL,   icon: 'database' as IcoName },
            { label: 'Failed Refreshes', value: kpis.failed,    color: ROSE,   icon: 'x' as IcoName        },
            { label: 'Scheduled',        value: kpis.scheduled, color: GREEN,  icon: 'calendar' as IcoName },
          ]).map((k, i) => (
            <div key={i} style={{ ...cardStyle, borderTop: `3px solid ${k.color}`, padding: '16px 18px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
                <div style={{ width: 28, height: 28, borderRadius: 7, background: `${k.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: k.color }}>
                  <Ico name={k.icon} size={13} />
                </div>
                <span style={{ fontSize: 10, color: C.t3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k.label}</span>
              </div>
              <div style={{ fontSize: 30, fontWeight: 800, color: k.color, lineHeight: 1 }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── WORKSPACE SUMMARY ── */}
      {data && hasData && (
        <div style={{ ...cardStyle, padding: '12px 18px', marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Workspace</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: isDark ? '#e2e8f5' : NAVY, marginTop: 2 }}>{data.workspaceName}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Workspace ID</div>
            <div style={{ fontSize: 11, fontFamily: 'monospace', color: C.t2, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>{data.workspaceId}<CopyBtn text={data.workspaceId} t3={C.t3} /></div>
          </div>
          {data.workspaceType && (
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Type</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.t1, marginTop: 2 }}>{data.workspaceType}</div>
            </div>
          )}
        </div>
      )}

      {/* ── FILTER BAR ── */}
      {hasData && (
        <div style={{ ...cardStyle, padding: '12px 16px', marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160, color: C.t3 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', display: 'flex' }}><Ico name="search" size={12} /></span>
            <input value={searchQ} onChange={e => { setSearchQ(e.target.value); setPage(1) }} placeholder="Search by name or ID…"
              style={{ width: '100%', padding: '8px 10px 8px 30px', borderRadius: 8, border: `1px solid ${C.bord}`, background: isDark ? '#0f1f3d' : '#fff', color: C.t1, fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['all', 'Report', 'SemanticModel'] as const).map(v => (
              <button key={v} onClick={() => { setTypeFilter(v); setPage(1) }}
                style={{ padding: '6px 12px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: typeFilter === v ? `${ORANGE}14` : 'transparent', border: `1px solid ${typeFilter === v ? ORANGE + '60' : C.bord}`, color: typeFilter === v ? ORANGE : C.t2 }}>
                {v === 'all' ? 'All Types' : v === 'Report' ? 'Reports' : 'Semantic Models'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['all', 'completed', 'failed', 'inprogress'].map(v => (
              <button key={v} onClick={() => { setStatusFilter(v); setPage(1) }}
                style={{ padding: '6px 12px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: statusFilter === v ? `${ROSE}12` : 'transparent', border: `1px solid ${statusFilter === v ? ROSE + '50' : C.bord}`, color: statusFilter === v ? ROSE : C.t2 }}>
                {v === 'all' ? 'All Status' : v === 'completed' ? 'Completed' : v === 'failed' ? 'Failed' : 'In Progress'}
              </button>
            ))}
          </div>
          {(searchQ || typeFilter !== 'all' || statusFilter !== 'all') && (
            <button onClick={() => { setSearchQ(''); setTypeFilter('all'); setStatusFilter('all'); setPage(1) }}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 11px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: 'transparent', border: `1px solid ${C.bord}`, color: C.t3 }}>
              <Ico name="x" size={10} /> Clear
            </button>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: C.t3, whiteSpace: 'nowrap' }}>
            {filtered.length} of {allItems.length} items{filtered.length > PAGE_SIZE && ` · Page ${safePage}/${totalPages}`}
          </span>
        </div>
      )}

      {/* ── TABLE ── */}
      {hasData && (
        <div style={{ ...cardStyle, overflow: 'hidden' }}>
          <div style={{ background: NAVY, borderRadius: '12px 12px 0 0', display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', padding: '11px 0', boxShadow: '0 2px 8px rgba(13,36,75,0.18)' }}>
            <div style={thStyle} />
            <div style={thStyle}>Name / ID</div>
            <div style={thStyle}>Type</div>
            <div style={thStyle}>Last Refreshed</div>
            <div style={thStyle}>Next Refresh</div>
            <div style={thStyle}>Status</div>
            <div style={thStyle} />
          </div>

          {filtered.length === 0 && (
            <div style={{ padding: '32px', textAlign: 'center', color: C.t3, fontSize: 12 }}>No items match the current filters.</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px' }}>
            {paged.map((entry, idx) => {
              const isDs = entry.itemType === 'SemanticModel'
              const ds = entry.dataset
              const rpt = entry.report
              const expanded = isDs && expandedDs.has(entry.id)
              const tab = activeTab[entry.id] ?? 'history'
              const isReport = entry.itemType === 'Report'
              const accent = isReport ? ORANGE : NAVY
              const lastRef = ds?.refreshes?.[0]
              const nextRef = ds ? nextScheduledTime(ds.refreshSchedule) : null
              const failReason = lastRef?.error ? (typeof lastRef.error === 'object' ? JSON.stringify(lastRef.error) : String(lastRef.error)) : ''

              return (
                <div key={entry.id + idx} style={{ background: C.card, border: `1px solid ${C.bord}`, borderLeft: `3px solid ${accent}`, borderRadius: 8, overflow: 'hidden', boxShadow: expanded ? '0 4px 16px rgba(13,36,75,0.10)' : '0 1px 3px rgba(13,36,75,0.04)', transition: 'box-shadow 0.15s' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', padding: '10px 0', background: expanded ? (isDark ? 'rgba(252,147,76,0.08)' : `${ORANGE}06`) : 'transparent' }}>
                    {/* chevron */}
                    <div style={{ display: 'flex', justifyContent: 'center', color: expanded ? ORANGE : C.t3 }}>
                      {isDs && (
                        <button onClick={() => toggleDs(entry.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', display: 'flex', padding: 4, borderRadius: 4 }}>
                          <Ico name={expanded ? 'chevDown' : 'chevRight'} size={13} />
                        </button>
                      )}
                    </div>
                    {/* name + id */}
                    <div style={{ padding: '0 10px', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: isReport ? VIOLET : TEAL, flexShrink: 0, display: 'flex' }}><Ico name={isReport ? 'report' : 'database'} size={13} /></span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: C.t1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.name}>{entry.name}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 3 }}>
                        <span style={{ fontSize: 10, color: C.t3, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }} title={entry.id}>{entry.id}</span>
                        <CopyBtn text={entry.id} t3={C.t3} />
                      </div>
                      {isReport && rpt?.datasetId && (
                        <div style={{ fontSize: 9, color: C.t3, marginTop: 1 }}>Dataset: <span style={{ fontFamily: 'monospace' }}>{abbr(rpt.datasetId, 22)}</span></div>
                      )}
                    </div>
                    {/* type */}
                    <div style={{ padding: '0 10px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 6, background: `${accent}18`, fontSize: 10, fontWeight: 700, color: accent, whiteSpace: 'nowrap' }}>
                        {isReport ? 'Report' : 'Semantic Model'}
                      </span>
                    </div>
                    {/* last refresh */}
                    <div style={{ padding: '0 10px' }}>
                      {lastRef ? (
                        <>
                          <div style={{ fontSize: 11, color: C.t1, whiteSpace: 'nowrap' }}>{fmt(lastRef.startTime)}</div>
                          <div style={{ fontSize: 9, color: C.t3, marginTop: 2 }}>Duration: {dur(lastRef.startTime, lastRef.endTime)}</div>
                        </>
                      ) : <span style={{ fontSize: 11, color: C.t3 }}>—</span>}
                    </div>
                    {/* next refresh */}
                    <div style={{ padding: '0 10px' }}>
                      {nextRef
                        ? <span style={{ fontSize: 11, color: TEAL, whiteSpace: 'nowrap' }}>{fmt(nextRef)}</span>
                        : ds?.refreshSchedule && !ds.refreshSchedule.enabled
                          ? <span style={{ fontSize: 10, color: C.t3 }}>Disabled</span>
                          : <span style={{ fontSize: 10, color: C.t3 }}>N/A</span>}
                    </div>
                    {/* status */}
                    <div style={{ padding: '0 10px' }}>
                      {lastRef ? <StatusPill status={lastRef.status} /> : <span style={{ fontSize: 10, color: C.t3 }}>—</span>}
                      {failReason && (
                        <div style={{ fontSize: 9, color: ROSE, marginTop: 3, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={failReason}>{failReason}</div>
                      )}
                    </div>
                    {/* action */}
                    <div style={{ padding: '0 10px', display: 'flex', justifyContent: 'center' }}>
                      {isReport && rpt?.webUrl && (
                        <a href={rpt.webUrl} target="_blank" rel="noreferrer" title="Open report"
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, background: `${ORANGE}18`, border: `1px solid ${ORANGE}40`, color: ORANGE, textDecoration: 'none' }}>
                          <Ico name="external" size={12} />
                        </a>
                      )}
                      {isDs && (
                        <button onClick={() => toggleDs(entry.id)} title="View details"
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, background: `${TEAL}14`, border: `1px solid ${TEAL}35`, color: TEAL, cursor: 'pointer' }}>
                          <Ico name="info" size={12} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* expanded panel */}
                  {expanded && ds && (
                    <div style={{ background: isDark ? 'rgba(0,0,0,0.15)' : 'rgba(13,36,75,0.02)', borderTop: `1px solid ${C.bord}`, padding: '16px 20px 16px 52px' }}>
                      <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: `1px solid ${C.bord}`, paddingBottom: 12, flexWrap: 'wrap' }}>
                        {(['history', 'schedule'] as const).map(t => (
                          <button key={t} onClick={() => setTab(entry.id, t)}
                            style={{ padding: '6px 14px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', background: tab === t ? ORANGE : 'transparent', border: `1px solid ${tab === t ? ORANGE : C.bord}`, color: tab === t ? '#fff' : C.t2 }}>
                            {t === 'history' ? 'Refresh History' : 'Schedule'}
                          </button>
                        ))}
                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: C.t3 }}>
                          <span style={{ color: TEAL, display: 'flex' }}><Ico name="database" size={11} /></span>
                          <span>Dataset ID:</span>
                          <span style={{ fontFamily: 'monospace', color: TEAL }}>{ds.id}</span>
                          <CopyBtn text={ds.id} t3={C.t3} />
                        </div>
                      </div>

                      {tab === 'history' && (
                        ds.refreshes.length === 0
                          ? <p style={{ color: C.t3, fontSize: 12 }}>No refresh history available.</p>
                          : (
                            <div style={{ overflowX: 'auto' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                                <thead>
                                  <tr style={{ background: isDark ? 'rgba(255,255,255,0.04)' : `${C.bord}40` }}>
                                    {['#', 'Status', 'Refresh Type', 'Start Time', 'End Time', 'Duration', 'Error / Reason'].map(h => (
                                      <th key={h} style={{ padding: '7px 12px', textAlign: 'left', fontSize: 9, fontWeight: 800, color: C.t3, letterSpacing: '0.07em', textTransform: 'uppercase', borderBottom: `1px solid ${C.bord}`, whiteSpace: 'nowrap' }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {ds.refreshes.slice(0, 20).map((h, i) => {
                                    const reason = h.error ? (typeof h.error === 'object' ? JSON.stringify(h.error) : String(h.error)) : ''
                                    return (
                                      <tr key={h.requestId || i} style={{ borderBottom: `1px solid ${C.bord}55`, background: i % 2 === 0 ? 'transparent' : (isDark ? 'rgba(255,255,255,0.03)' : `${C.bord}20`) }}>
                                        <td style={{ padding: '8px 12px', color: C.t3, fontWeight: 600 }}>{i + 1}</td>
                                        <td style={{ padding: '8px 12px' }}><StatusPill status={h.status} /></td>
                                        <td style={{ padding: '8px 12px', color: C.t2 }}>{h.refreshType || '—'}</td>
                                        <td style={{ padding: '8px 12px', color: C.t1, whiteSpace: 'nowrap' }}>{fmt(h.startTime)}</td>
                                        <td style={{ padding: '8px 12px', color: C.t1, whiteSpace: 'nowrap' }}>{fmt(h.endTime)}</td>
                                        <td style={{ padding: '8px 12px', color: TEAL, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{dur(h.startTime, h.endTime)}</td>
                                        <td style={{ padding: '8px 12px', color: ROSE, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={reason}>{reason || <span style={{ color: C.t3 }}>—</span>}</td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )
                      )}

                      {tab === 'schedule' && (
                        !ds.refreshSchedule
                          ? <p style={{ color: C.t3, fontSize: 12 }}>No refresh schedule configured on this dataset.</p>
                          : (
                            <InfoGrid C={C} items={[
                              { label: 'Status',        value: ds.refreshSchedule.enabled ? 'Enabled' : 'Disabled', color: ds.refreshSchedule.enabled ? GREEN : ROSE },
                              { label: 'Days',          value: ds.refreshSchedule.days?.join(', ') || '—' },
                              { label: 'Times',         value: ds.refreshSchedule.times?.join(', ') || '—' },
                              { label: 'Timezone',      value: ds.refreshSchedule.localTimeZoneId || '—' },
                              { label: 'Notifications', value: ds.refreshSchedule.notifyOption || '—' },
                              { label: 'Next Run',      value: fmt(nextRef), color: TEAL },
                            ]} />
                          )
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '14px 8px 10px', flexWrap: 'wrap', borderTop: `1px solid ${C.bord}` }}>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
                style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, border: `1px solid ${C.bord}`, background: safePage === 1 ? 'transparent' : C.card, color: safePage === 1 ? C.t3 : isDark ? '#e2e8f5' : NAVY, cursor: safePage === 1 ? 'default' : 'pointer' }}>‹ Prev</button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter(n => n === 1 || n === totalPages || Math.abs(n - safePage) <= 2)
                .reduce<(number | '…')[]>((acc, n, i, arr) => { if (i > 0 && (n as number) - (arr[i - 1] as number) > 1) acc.push('…'); acc.push(n); return acc }, [])
                .map((n, i) => n === '…'
                  ? <span key={'e' + i} style={{ padding: '0 4px', color: C.t3, fontSize: 12 }}>…</span>
                  : <button key={n} onClick={() => setPage(n as number)}
                      style={{ minWidth: 32, padding: '5px 8px', borderRadius: 5, fontSize: 11, fontWeight: 700, border: `1px solid ${safePage === n ? ORANGE : C.bord}`, background: safePage === n ? ORANGE : C.card, color: safePage === n ? '#fff' : C.t2, cursor: 'pointer' }}>{n}</button>)}
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
                style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, border: `1px solid ${C.bord}`, background: safePage === totalPages ? 'transparent' : C.card, color: safePage === totalPages ? C.t3 : isDark ? '#e2e8f5' : NAVY, cursor: safePage === totalPages ? 'default' : 'pointer' }}>Next ›</button>
              <span style={{ marginLeft: 8, fontSize: 11, color: C.t3 }}>{(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
            </div>
          )}
        </div>
      )}

      {/* ── LOADING ── */}
      {loading && (
        <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '64px 32px', gap: 14 }}>
          <span style={{ color: ORANGE, display: 'flex' }}><Ico name="spinner" size={32} className="animate-spin" /></span>
          <div style={{ fontSize: 14, fontWeight: 700, color: isDark ? '#e2e8f5' : NAVY }}>Fetching workspace data…</div>
          <div style={{ fontSize: 12, color: C.t2 }}>Retrieving reports, datasets and refresh history.</div>
        </div>
      )}

      {/* ── EMPTY ── */}
      {!loading && !data && !error && (
        <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '80px 32px', gap: 14, textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: `${ORANGE}10`, border: `1px solid ${ORANGE}25`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: ORANGE }}>
            <Ico name="chart" size={28} />
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: isDark ? '#e2e8f5' : NAVY }}>Click "Load Workspace" to fetch Power BI data</div>
          <div style={{ fontSize: 13, color: C.t2, maxWidth: 420, lineHeight: 1.8 }}>
            Reports, semantic models, refresh schedules and history will appear here.
          </div>
        </div>
      )}
    </div>
  )
}
