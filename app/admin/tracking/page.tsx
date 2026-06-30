'use client'

import { useState, useEffect, useCallback, createContext, useContext } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import DatePicker from '@/components/ui/DatePicker'
import { useTheme } from '@/lib/ThemeContext'

/* ── Brand palette (static) ────────────────────────────────────────────── */
const NAVY    = '#0D244B'
const ORANGE  = '#FC934C'
const YELLOW  = '#FFC82B'
const NAVY_50 = '#7C899C'
const TEAL    = '#114a54'
const LILAC   = '#60325f'
const BROWN   = '#4c2e05'
const SEA     = '#9fc2cc'
const GREEN   = '#2b7c38'
const RED     = '#80020d'

const PALETTE = [ORANGE, NAVY, YELLOW, NAVY_50, TEAL, LILAC, BROWN, SEA, GREEN, RED]

const PER_PAGE = 20

const ACTION_COLORS: Record<string, string> = {
  view:    NAVY,
  approve: GREEN,
  reject:  RED,
  update:  ORANGE,
  login:   TEAL,
  logout:  NAVY_50,
}

interface ActivityLog {
  id: number; user_id: number; username: string; full_name: string; email: string; page_url: string
  action: string; ip_address: string; user_agent: string; created_at: string
}
interface Analytics {
  actionCounts:    { action: string; count: number }[]
  dailyTrend:      { date: string; count: number }[]
  topPages:        { page_url: string; count: number }[]
  topUsers:        { username: string; count: number; last_seen: string }[]
  dashboardAccess: { title: string; userId: number; username: string; count: number }[]
  hourlyDist:      { hour: number; count: number }[]
}

/* ── Theme context ─────────────────────────────────────────────────────── */
interface TC {
  isDark: boolean
  card: string; bg: string; bord: string
  t1: string; t2: string; t3: string
  track: string; rowEven: string; rowOdd: string; inputBg: string
}
const ThemeCtx = createContext<TC>({
  isDark: false,
  card: '#fff', bg: '#F4F5F7', bord: '#C6CDD7',
  t1: NAVY, t2: NAVY_50, t3: '#C6CDD7',
  track: '#E9ECEF', rowEven: '#fff', rowOdd: '#F7F8F9', inputBg: '#fff',
})
const useTC = () => useContext(ThemeCtx)

function mkTC(isDark: boolean): TC {
  return isDark ? {
    isDark: true,
    card: '#1a2d4e', bg: '#0f1f3d', bord: '#2a3f66',
    t1: '#e2e8f5', t2: '#8ba3c9', t3: '#3d5a84',
    track: '#2a3f66', rowEven: '#1a2d4e', rowOdd: '#162038', inputBg: '#0f1f3d',
  } : {
    isDark: false,
    card: '#fff', bg: '#F4F5F7', bord: '#C6CDD7',
    t1: NAVY, t2: NAVY_50, t3: '#C6CDD7',
    track: '#E9ECEF', rowEven: '#fff', rowOdd: '#F7F8F9', inputBg: '#fff',
  }
}

/* ── Main page ─────────────────────────────────────────────────────────── */
export default function TrackingPage() {
  const { theme } = useTheme()
  const tc = mkTC(theme === 'dark')
  const [tab, setTab] = useState<'analytics' | 'logs'>('analytics')

  return (
    <ThemeCtx.Provider value={tc}>
      <div className="p-6 fade-in">
        <AdminPageHeader
          backHref="/admin/configuration"
          breadcrumb={[{ label: 'Application Tracking' }]}
          title="Application Tracking"
          description="Real-time activity log and AI-powered usage analytics"
        />

        {/* Tab switcher */}
        <div className="flex gap-0 mb-6 rounded-xl overflow-hidden w-fit"
          style={{ border: `1px solid ${tc.bord}` }}>
          {[{ key: 'analytics', label: '📊 Analytics Report' }, { key: 'logs', label: '📋 Activity Logs' }].map(t => (
            <button key={t.key} onClick={() => setTab(t.key as any)}
              style={tab === t.key
                ? { background: NAVY, color: '#fff', fontFamily: 'DM Sans, sans-serif' }
                : { background: tc.card, color: tc.t2, fontFamily: 'DM Sans, sans-serif' }}
              className="px-5 py-2.5 text-xs font-semibold transition-all">
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'analytics' && <AnalyticsTab />}
        {tab === 'logs'      && <LogsTab />}
      </div>
    </ThemeCtx.Provider>
  )
}

/* ── Pure-CSS chart helpers ────────────────────────────────────────────── */

function BarChartCSS({ data, labelKey, valueKey, color = NAVY, height = 180 }: {
  data: Record<string, any>[]; labelKey: string; valueKey: string; color?: string; height?: number
}) {
  const { t2 } = useTC()
  if (!data.length) return <EmptyChart />
  const max = Math.max(...data.map(d => d[valueKey]), 1)
  return (
    <div className="flex items-end gap-1 w-full overflow-x-auto" style={{ height }}>
      {data.map((d, i) => {
        const pct = Math.round((d[valueKey] / max) * 100)
        return (
          <div key={i} className="flex flex-col items-center flex-1 min-w-0 group relative" style={{ height }}>
            <div className="absolute -top-7 left-1/2 -translate-x-1/2 text-white text-[10px] px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap z-10 pointer-events-none"
              style={{ background: NAVY }}>
              {d[valueKey]}
            </div>
            <div className="w-full flex-1 flex items-end">
              <div className="w-full rounded-t-sm transition-all" style={{ height: `${pct}%`, background: color, minHeight: 2 }} />
            </div>
            <span className="text-[9px] mt-1 truncate w-full text-center" style={{ color: t2 }}
              title={String(d[labelKey])}>
              {String(d[labelKey]).length > 6 ? String(d[labelKey]).slice(0, 6) + '…' : d[labelKey]}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function HBarChartCSS({ data, labelKey, valueKey, colors }: {
  data: Record<string, any>[]; labelKey: string; valueKey: string; colors?: string[]
}) {
  const { t2, track } = useTC()
  if (!data.length) return <EmptyChart />
  const max = Math.max(...data.map(d => d[valueKey]), 1)
  return (
    <div className="space-y-2">
      {data.map((d, i) => {
        const pct = Math.round((d[valueKey] / max) * 100)
        const bg  = colors ? colors[i % colors.length] : PALETTE[i % PALETTE.length]
        return (
          <div key={i} className="flex items-center gap-2">
            <span className="text-[10px] w-28 truncate flex-shrink-0 text-right" style={{ color: t2 }}
              title={String(d[labelKey])}>
              {String(d[labelKey]).length > 18 ? String(d[labelKey]).slice(0,18)+'…' : d[labelKey]}
            </span>
            <div className="flex-1 h-5 rounded-full overflow-hidden" style={{ background: track }}>
              <div className="h-full rounded-full flex items-center pl-2 transition-all"
                style={{ width: `${Math.max(pct, 2)}%`, background: bg }}>
                <span className="text-[9px] text-white font-bold">{d[valueKey]}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DonutCSS({ data, nameKey, valueKey }: {
  data: Record<string, any>[]; nameKey: string; valueKey: string
}) {
  const { t2, t3 } = useTC()
  if (!data.length) return <EmptyChart />
  const total = data.reduce((s, d) => s + d[valueKey], 0)
  let offset = 0
  const r = 60, cx = 80, cy = 80, strokeW = 28
  const circ = 2 * Math.PI * r

  return (
    <div className="flex items-center gap-4">
      <svg width={160} height={160} viewBox="0 0 160 160">
        {data.map((d, i) => {
          const pct  = d[valueKey] / total
          const dash = pct * circ
          const gap  = circ - dash
          const rot  = offset * 360 - 90
          offset += pct
          return (
            <circle key={i} cx={cx} cy={cy} r={r}
              fill="none" stroke={ACTION_COLORS[d[nameKey]] || PALETTE[i % PALETTE.length]}
              strokeWidth={strokeW} strokeDasharray={`${dash} ${gap}`}
              transform={`rotate(${rot} ${cx} ${cy})`} />
          )
        })}
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fontSize={14} fontWeight="bold" fill={ORANGE}>{total}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" dominantBaseline="middle" fontSize={9} fill={t2}>events</text>
      </svg>
      <div className="flex flex-col gap-1.5">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs" style={{ color: t2 }}>
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ background: ACTION_COLORS[d[nameKey]] || PALETTE[i % PALETTE.length] }} />
            <span className="capitalize">{d[nameKey]}</span>
            <span className="ml-1" style={{ color: t3 }}>({d[valueKey]})</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function LineChartCSS({ data, dateKey, valueKey }: {
  data: Record<string, any>[]; dateKey: string; valueKey: string
}) {
  const { track, t2 } = useTC()
  if (!data.length) return <EmptyChart />
  const W = 560, H = 160, PX = 30, PY = 10
  const max = Math.max(...data.map(d => d[valueKey]), 1)
  const toX = (i: number) => PX + (i / (data.length - 1 || 1)) * (W - PX * 2)
  const toY = (v: number) => PY + (1 - v / max) * (H - PY * 2)
  const pts  = data.map((d, i) => `${toX(i)},${toY(d[valueKey])}`).join(' ')
  const area = `${toX(0)},${H - PY} ${pts} ${toX(data.length - 1)},${H - PY}`

  const step = Math.max(1, Math.floor(data.length / 6))

  return (
    <div className="overflow-x-auto">
      <svg width="100%" viewBox={`0 0 ${W} ${H + 20}`} preserveAspectRatio="xMidYMid meet">
        {[0,25,50,75,100].map(p => {
          const y = PY + (1 - p/100) * (H - PY*2)
          return <line key={p} x1={PX} y1={y} x2={W-PX} y2={y} stroke={track} strokeWidth={1} />
        })}
        <polygon points={area} fill={`${ORANGE}18`} />
        <polyline points={pts} fill="none" stroke={ORANGE} strokeWidth={2} strokeLinejoin="round" />
        {data.map((d, i) => (
          <circle key={i} cx={toX(i)} cy={toY(d[valueKey])} r={3} fill={ORANGE} />
        ))}
        {data.map((d, i) => i % step === 0 && (
          <text key={i} x={toX(i)} y={H + 15} textAnchor="middle" fontSize={9} fill={t2}>
            {String(d[dateKey]).slice(0, 10).slice(5)}
          </text>
        ))}
      </svg>
    </div>
  )
}

function EmptyChart({ label = 'No data recorded yet' }: { label?: string }) {
  const { t3 } = useTC()
  return <div className="flex items-center justify-center h-36 text-xs" style={{ color: t3 }}>{label}</div>
}

/* ── Shared card shell ─────────────────────────────────────────────────── */
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const { card, bord } = useTC()
  return (
    <div className={`rounded-2xl p-5 ${className}`}
      style={{ background: card, border: `1px solid ${bord}` }}>
      {children}
    </div>
  )
}

function ChartTitle({ children }: { children: React.ReactNode }) {
  const { t1 } = useTC()
  return <p className="font-bold text-sm mb-0.5" style={{ color: t1, fontFamily: 'DM Sans, sans-serif' }}>{children}</p>
}
function ChartSub({ children }: { children: React.ReactNode }) {
  const { t2 } = useTC()
  return <p className="text-xs mb-4" style={{ color: t2, fontFamily: 'Inter, sans-serif' }}>{children}</p>
}

/* ── Analytics Tab ─────────────────────────────────────────────────────── */
function AnalyticsTab() {
  const { isDark, card, bg, bord, t1, t2, t3, track } = useTC()
  const [data,    setData]    = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/admin/tracking/analytics', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        setData(d.success ? d : {
          actionCounts: [], dailyTrend: [], topPages: [],
          topUsers: [], dashboardAccess: [], hourlyDist: [],
        })
      })
      .catch(() => setData({
        actionCounts: [], dailyTrend: [], topPages: [],
        topUsers: [], dashboardAccess: [], hourlyDist: [],
      }))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <span className="w-8 h-8 border-4 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: `${bord} ${bord} ${bord} ${NAVY}` }} />
    </div>
  )
  if (!data) return null

  const totalActions = data.actionCounts.reduce((s, a) => s + a.count, 0)
  const uniqueUsers  = data.topUsers.length
  const topPage      = data.topPages[0]
  const peakHour     = data.hourlyDist.reduce((a, b) => b.count > a.count ? b : a, { hour: 0, count: 0 })

  const dashMap: Record<string, number> = {}
  data.dashboardAccess.forEach(d => { dashMap[d.title] = (dashMap[d.title] || 0) + d.count })
  const dashChartData = Object.entries(dashMap).map(([name, value]) => ({ name, value })).sort((a,b) => b.value - a.value)

  const hourlyFull = Array.from({ length: 24 }, (_, h) => {
    const found = data.hourlyDist.find(d => d.hour === h)
    return { hour: `${String(h).padStart(2,'0')}`, count: found?.count ?? 0 }
  })

  const KPI_CARDS = [
    { label: 'Total Events', value: totalActions.toLocaleString(), icon: '📊' },
    { label: 'Active Users', value: String(uniqueUsers),           icon: '👥' },
    { label: 'Top Page',     value: topPage?.page_url?.split('/').pop() || '—', icon: '📄', small: true },
    { label: 'Peak Hour',    value: `${String(peakHour.hour).padStart(2,'0')}:00`, icon: '⏰' },
  ]

  return (
    <div className="space-y-6">
      {/* KPI boxes */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {KPI_CARDS.map(k => (
          <div key={k.label} className="rounded-2xl p-4 flex items-center gap-3"
            style={{ background: isDark ? '#162038' : '#F4F5F7', border: `1.5px solid ${bord}` }}>
            <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
              style={{ background: isDark ? 'rgba(255,255,255,0.06)' : `${NAVY}12` }}>{k.icon}</div>
            <div className="min-w-0">
              <p className={`font-bold truncate ${k.small ? 'text-sm' : 'text-[26px] leading-tight'}`}
                style={{ color: ORANGE, fontFamily: 'Inter, sans-serif' }}>{k.value}</p>
              <p className="text-[11px] font-medium" style={{ color: t2, fontFamily: 'Inter, sans-serif' }}>{k.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Row 1: Line chart + Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card className="lg:col-span-2">
          <ChartTitle>Daily Activity — Last 30 Days</ChartTitle>
          <ChartSub>Total events recorded per day</ChartSub>
          <LineChartCSS data={data.dailyTrend} dateKey="date" valueKey="count" />
        </Card>
        <Card>
          <ChartTitle>Action Breakdown</ChartTitle>
          <ChartSub>Events by action type</ChartSub>
          <DonutCSS data={data.actionCounts} nameKey="action" valueKey="count" />
        </Card>
      </div>

      {/* Row 2: Hourly bar + Top pages */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card>
          <ChartTitle>Hourly Activity Distribution</ChartTitle>
          <ChartSub>When are users most active?</ChartSub>
          <BarChartCSS data={hourlyFull} labelKey="hour" valueKey="count" color={isDark ? '#5b8db8' : NAVY} height={160} />
        </Card>
        <Card>
          <ChartTitle>Top 10 Most Visited Pages</ChartTitle>
          <ChartSub>Busiest routes across all users</ChartSub>
          <HBarChartCSS data={data.topPages} labelKey="page_url" valueKey="count" />
        </Card>
      </div>

      {/* Row 3: PowerBI access + Top users */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card>
          <ChartTitle>PowerBI Dashboard Access</ChartTitle>
          <ChartSub>Which reports are users viewing most?</ChartSub>
          {dashChartData.length === 0
            ? <EmptyChart label="No dashboard access recorded yet — promote BI reports to users" />
            : <BarChartCSS data={dashChartData} labelKey="name" valueKey="value" color={ORANGE} height={160} />
          }
        </Card>
        <Card>
          <ChartTitle>Most Active Users</ChartTitle>
          <ChartSub>Top 10 users by total events</ChartSub>
          {data.topUsers.length === 0 ? <EmptyChart /> : (
            <div className="space-y-2.5 max-h-[220px] overflow-y-auto">
              {data.topUsers.map((u, i) => {
                const pct = Math.round((u.count / data.topUsers[0].count) * 100)
                return (
                  <div key={u.username} className="flex items-center gap-2">
                    <span className="text-xs font-bold w-4 flex-shrink-0" style={{ color: t3 }}>{i+1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium truncate" style={{ color: t1 }}>{u.username}</span>
                        <span className="text-xs ml-2 flex-shrink-0" style={{ color: t2 }}>{u.count}</span>
                      </div>
                      <div className="h-1.5 rounded-full" style={{ background: track }}>
                        <div className="h-1.5 rounded-full transition-all" style={{ width: `${pct}%`, background: PALETTE[i % PALETTE.length] }} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      {/* AI insight panel */}
      <div className="rounded-2xl p-6" style={{ background: NAVY }}>
        <div className="flex items-start gap-3">
          <span className="text-2xl">🤖</span>
          <div className="flex-1">
            <p className="font-bold text-sm mb-2" style={{ color: ORANGE, fontFamily: 'DM Sans, sans-serif' }}>AI-Generated Insight Summary</p>
            <div className="text-xs space-y-1.5" style={{ color: 'rgba(255,255,255,0.80)' }}>
              {totalActions === 0 ? (
                <p>No activity data recorded yet. Insights will appear once users start interacting with the portal.</p>
              ) : (
                <>
                  <p>• <strong>{totalActions.toLocaleString()} total events</strong> recorded across <strong>{uniqueUsers}</strong> unique users.</p>
                  {data.actionCounts[0] && <p>• Most frequent action: <strong className="capitalize">{data.actionCounts[0].action}</strong> ({data.actionCounts[0].count} times) — {data.actionCounts[0].action === 'view' ? 'users are predominantly browsing content.' : `high ${data.actionCounts[0].action} activity detected.`}</p>}
                  {peakHour.count > 0 && <p>• Peak usage at <strong>{String(peakHour.hour).padStart(2,'0')}:00</strong> ({peakHour.count} events) — schedule maintenance outside this window.</p>}
                  {topPage && <p>• Most visited: <strong>{topPage.page_url}</strong> ({topPage.count} visits).</p>}
                  {dashChartData.length === 0 && <p>• <strong>No PowerBI dashboard views recorded.</strong> Consider promoting BI reports to improve adoption.</p>}
                  {dashChartData.length > 0 && <>
                    <p>• Most accessed dashboard: <strong>{dashChartData[0].name}</strong> ({dashChartData[0].value} views).</p>
                    {dashChartData.length > 1 && <p>• Least accessed: <strong>{dashChartData[dashChartData.length-1].name}</strong> — review relevance or improve discoverability.</p>}
                  </>}
                </>
              )}
            </div>
            <p className="mt-4 text-[9px] italic" style={{ color: NAVY_50, fontFamily: 'DM Sans, sans-serif' }}>Confidential &amp; Proprietary</p>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Logs Tab ──────────────────────────────────────────────────────────── */
function LogsTab() {
  const { isDark, card, bord, t1, t2, t3, track, rowEven, rowOdd, inputBg } = useTC()
  const [logs,         setLogs]         = useState<ActivityLog[]>([])
  const [total,        setTotal]        = useState(0)
  const [page,         setPage]         = useState(1)
  const [loading,      setLoading]      = useState(true)
  const [search,       setSearch]       = useState('')
  const [filterAction, setFilterAction] = useState('')
  const [dateFrom,     setDateFrom]     = useState('')
  const [dateTo,       setDateTo]       = useState('')
  const [userId,       setUserId]       = useState('')

  const ALL_ACTIONS = ['view','approve','reject','update','login','logout']
  const totalPages  = Math.max(1, Math.ceil(total / PER_PAGE))

  const load = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        limit: String(PER_PAGE), offset: String((p-1)*PER_PAGE),
        ...(filterAction && { action: filterAction }),
        ...(search       && { search }),
        ...(dateFrom     && { from: dateFrom }),
        ...(dateTo       && { to: dateTo }),
        ...(userId       && { userId }),
      })
      const res  = await fetch(`/api/admin/tracking?${params}`)
      const data = await res.json()
      if (data.success) { setLogs(data.logs); setTotal(data.total) }
    } catch {}
    setLoading(false)
  }, [filterAction, search, dateFrom, dateTo, userId])

  useEffect(() => { setPage(1); load(1) }, [filterAction, search, dateFrom, dateTo, userId])
  useEffect(() => { load(page) }, [page])

  const hasFilters = search || filterAction || dateFrom || dateTo || userId

  return (
    <>
      {/* Filter bar */}
      <div className="rounded-xl p-4 mb-4" style={{ background: card, border: `1px solid ${bord}` }}>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 items-stretch">
          <div className="lg:col-span-2">
            <input autoComplete="off" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search name, email or IP…"
              className="w-full text-xs rounded-lg px-3 focus:outline-none"
              style={{ border: `1px solid ${bord}`, color: t1, background: inputBg, fontFamily: 'Inter, sans-serif', height: 38, boxSizing: 'border-box' }} />
          </div>
          <select value={filterAction} onChange={e => setFilterAction(e.target.value)}
            className="w-full text-xs rounded-lg px-3 focus:outline-none"
            style={{ border: `1px solid ${bord}`, color: t1, height: 38, boxSizing: 'border-box', background: inputBg }}>
            <option value="">All Actions</option>
            {ALL_ACTIONS.map(a => <option key={a} value={a} className="capitalize">{a}</option>)}
          </select>
          <DatePicker value={dateFrom} onChange={setDateFrom} placeholder="From date" accentColor={NAVY} />
          <DatePicker value={dateTo} onChange={setDateTo} placeholder="To date" min={dateFrom} accentColor={NAVY} />
        </div>
        {hasFilters && (
          <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: `1px solid ${track}` }}>
            <span className="text-xs" style={{ color: t2 }}>{total} result{total !== 1 ? 's' : ''}</span>
            <button onClick={() => { setSearch(''); setFilterAction(''); setDateFrom(''); setDateTo(''); setUserId('') }}
              className="text-xs px-3 py-1 rounded-lg transition-colors hover:opacity-80"
              style={{ color: t2, border: `1px solid ${bord}` }}>Clear filters</button>
          </div>
        )}
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ background: card, border: `1px solid ${bord}` }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: NAVY }}>
                {['#','User','Page URL','Action','IP Address','User Agent','Time'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap"
                    style={{ color: 'rgba(255,255,255,0.75)', fontFamily: 'DM Sans, sans-serif' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="text-center py-12">
                  <span className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin inline-block"
                    style={{ borderColor: `${bord} ${bord} ${bord} ${NAVY}` }} />
                </td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12 text-sm" style={{ color: t2 }}>No activity logs found.</td></tr>
              ) : logs.map((l, idx) => (
                <tr key={l.id} className="transition-colors"
                  style={{ background: idx % 2 === 0 ? rowEven : rowOdd, borderBottom: `1px solid ${track}` }}>
                  <td className="px-4 py-3 text-xs font-mono" style={{ color: t2 }}>{(page-1)*PER_PAGE+idx+1}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0"
                        style={{ background: `linear-gradient(135deg,${ORANGE},${YELLOW})` }}>
                        {(l.full_name || l.username || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate" style={{ color: t1 }} title={l.full_name || l.username}>{l.full_name || l.username}</div>
                        <div className="text-[10px] truncate" style={{ color: t2 }} title={l.email}>{l.email || `UID: ${l.user_id}`}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono max-w-[180px] truncate" style={{ color: t2 }}>{l.page_url}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize"
                      style={{ background: `${ACTION_COLORS[l.action]??NAVY_50}18`, color: ACTION_COLORS[l.action]??NAVY_50 }}>
                      {l.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono whitespace-nowrap" style={{ color: t2 }}>{l.ip_address}</td>
                  <td className="px-4 py-3 text-xs max-w-[160px] truncate" style={{ color: t2 }} title={l.user_agent}>{l.user_agent}</td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: t2 }}>{l.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 text-xs"
          style={{ borderTop: `1px solid ${track}`, color: t2 }}>
          <span>Showing {total===0?0:(page-1)*PER_PAGE+1}–{Math.min(page*PER_PAGE,total)} of {total}</span>
          <div className="flex items-center gap-1">
            {[
              { label: '«', action: () => setPage(1),          disabled: page===1 },
              { label: '‹', action: () => setPage(p => p-1),   disabled: page===1 },
              { label: '›', action: () => setPage(p => p+1),   disabled: page===totalPages },
              { label: '»', action: () => setPage(totalPages), disabled: page===totalPages },
            ].map(btn => (
              <button key={btn.label} onClick={btn.action} disabled={btn.disabled}
                className="px-2 py-1 rounded transition-colors hover:opacity-80 disabled:opacity-30"
                style={{ border: `1px solid ${bord}`, color: t1, background: 'transparent' }}>
                {btn.label}
              </button>
            ))}
            <span className="px-3 py-1 font-medium" style={{ color: t1 }}>{page} / {totalPages}</span>
          </div>
        </div>
      </div>
    </>
  )
}
