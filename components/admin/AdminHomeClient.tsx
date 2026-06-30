'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '@/lib/ThemeContext'

/* ─── Brand colours ────────────────────────────────────────────────────── */
const NAVY    = '#0D244B'
const ORANGE  = '#FC934C'
const YELLOW  = '#FFC82B'
const NAVY_50 = '#7C899C'
const NAVY_25 = '#C6CDD7'
const NAVY_10 = '#E9ECEF'
const NAVY_5  = '#F4F5F7'
const NAVY_3  = '#F7F8F9'
const RED     = '#80020d'
const GREEN   = '#2b7c38'
const TEAL    = '#114a54'
const LILAC   = '#60325f'
const BROWN   = '#4c2e05'
const SEA     = '#9fc2cc'

const PALETTE      = [ORANGE, NAVY, YELLOW, NAVY_50, TEAL, LILAC, BROWN, SEA, GREEN, RED]
const DONUT_PALETTE = [ORANGE, YELLOW, NAVY, GREEN, SEA, TEAL, LILAC, RED]

const BODY_FONT = { fontFamily: "'Inter', sans-serif" }

/* ─── Dark-mode context ────────────────────────────────────────────────── */
const DarkCtx = createContext(false)
const useDark = () => useContext(DarkCtx)

function dk(dark: boolean) {
  return {
    card:       dark ? '#1a2d4e' : '#fff',
    cardBorder: dark ? '#2a3f66' : NAVY_25,
    kpiBg:      dark ? '#162038' : NAVY_5,
    iconBg:     dark ? '#0f1f3d' : NAVY_10,
    text:       dark ? '#e2e8f5' : NAVY,
    sub:        dark ? '#8ba3c9' : NAVY_50,
    rowEven:    dark ? '#1a2d4e' : '#fff',
    rowOdd:     dark ? '#162038' : NAVY_3,
    rowBorder:  dark ? '#2a3f66' : NAVY_3,
    track:      dark ? '#2a3f66' : NAVY_10,
    divider:    dark ? '#2a3f66' : NAVY_25,
    skeleton:   dark ? '#2a3f66' : NAVY_10,
    quickBg:    dark ? '#162038' : NAVY_5,
  }
}

/* ─── Interfaces ───────────────────────────────────────────────────────── */
interface Counts {
  totalClients: number; clientAccounts: number; admins: number; superAdmins: number
  activeLogins: number; totalLogins: number; totalModules: number
  loginsThisWeek: number; loginsThisMonth: number
}
interface Analytics {
  counts: Counts
  weeklyLogins:         { date: string; count: number }[]
  monthlyLogins:        { month: string; count: number }[]
  topClients:           { loginId: number; name: string; username: string; total_logins: number; last_login: string; is_active: number }[]
  topLoginUsers:        { loginId: number; name: string; username: string; client: string; logins: number; last_login: string; login_type: number; is_active: number }[]
  moduleUsage:          { moduleName: string; users: number; active: number }[]
  recentLogins:         { loginId: number; client: string; username: string; loginTime: string }[]
  recentDashboardViews: { id: number; client: string; username: string; report: string; viewedAt: string }[]
  registrationTrend:    { month: string; count: number }[]
  dashboardAccess:      { title: string; count: number }[]
  loginTypeBreakdown:   { label: string; count: number }[]
  activeVsInactive:     { status: string; count: number }[]
  clientsWithMostUsers: { name: string; count: number }[]
}

/* ─── Chart helpers ─────────────────────────────────────────────────────── */
function ChartTitle({ children }: { children: React.ReactNode }) {
  const d = dk(useDark())
  return <p style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 700, color: d.text, fontSize: 15 }} className="mb-0.5">{children}</p>
}
function ChartSub({ children }: { children: React.ReactNode }) {
  const d = dk(useDark())
  return <p style={{ fontFamily: "'Inter', sans-serif", color: d.sub, fontSize: 11 }} className="mb-4">{children}</p>
}

function BarH({ items, colorFn }: { items: { label: string; value: number }[]; colorFn?: (i: number) => string }) {
  const isDark = useDark(); const d = dk(isDark)
  if (!items.length) return <EmptyState />
  const max = Math.max(...items.map(i => i.value), 1)
  return (
    <div className="space-y-2.5">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-3">
          <span style={{ ...BODY_FONT, color: d.sub, fontSize: 10, width: 112, flexShrink: 0, textAlign: 'right' }} className="truncate" title={item.label}>
            {item.label.length > 16 ? item.label.slice(0, 16) + '…' : item.label}
          </span>
          <div className="flex-1 rounded-sm overflow-hidden" style={{ height: 22, background: d.track }}>
            <div className="h-full flex items-center px-2 transition-all"
              style={{ width: `${Math.max((item.value / max) * 100, 3)}%`, background: colorFn ? colorFn(i) : PALETTE[i % PALETTE.length] }}>
              <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 9, color: '#fff', fontWeight: 700 }}>{item.value}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function BarV({ items, color = NAVY, height = 140 }: { items: { label: string; value: number }[]; color?: string; height?: number }) {
  const d = dk(useDark())
  if (!items.length) return <EmptyState />
  const max = Math.max(...items.map(i => i.value), 1)
  return (
    <div className="flex items-end gap-1 w-full" style={{ height }}>
      {items.map((item, i) => {
        const pct = Math.round((item.value / max) * 100)
        return (
          <div key={i} className="flex flex-col items-center flex-1 min-w-0 group" style={{ height }}>
            <div className="relative w-full flex-1 flex items-end">
              <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-white text-[9px] px-1 py-0.5 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap z-10 pointer-events-none"
                style={{ background: NAVY }}>
                {item.value}
              </div>
              <div className="w-full rounded-t-sm" style={{ height: `${pct}%`, background: color, minHeight: 2 }} />
            </div>
            <span style={{ ...BODY_FONT, color: d.sub, fontSize: 9 }} className="mt-1 truncate w-full text-center">{item.label}</span>
          </div>
        )
      })}
    </div>
  )
}

function DonutChart({ segments, centerLabel = 'total' }: { segments: { label: string; value: number; color: string }[]; centerLabel?: string }) {
  const d = dk(useDark())
  const total = segments.reduce((s, g) => s + g.value, 0)
  if (!total) return <EmptyState />
  const r = 52, cx = 70, cy = 70, sw = 22, circ = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="flex items-center gap-5 flex-wrap">
      <svg width={140} height={140} viewBox="0 0 140 140">
        {segments.map((seg, i) => {
          const pct = seg.value / total, dash = pct * circ, gap = circ - dash
          const rot = offset * 360 - 90; offset += pct
          return <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={seg.color} strokeWidth={sw}
            strokeDasharray={`${dash} ${gap}`} transform={`rotate(${rot} ${cx} ${cy})`} />
        })}
        <text x={cx} y={cy - 7} textAnchor="middle" fontSize={22} fontWeight="700" fill={ORANGE} fontFamily="'Inter', sans-serif">{total}</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize={9} fill={NAVY_50} fontFamily="'Inter', sans-serif">{centerLabel}</text>
      </svg>
      <div className="space-y-2">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: seg.color }} />
            <span style={{ ...BODY_FONT, color: d.text, fontSize: 11 }}>{seg.label}</span>
            <span style={{ ...BODY_FONT, color: seg.color, fontSize: 11, fontWeight: 700 }} className="ml-auto pl-3">{seg.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function LineChart({ items, color = ORANGE, height = 120 }: { items: { label: string; value: number }[]; color?: string; height?: number }) {
  const d = dk(useDark())
  if (!items.length) return <EmptyState />
  const W = 460, H = height, PX = 24, PY = 10
  const max = Math.max(...items.map(i => i.value), 1)
  const toX = (i: number) => PX + (i / (items.length - 1 || 1)) * (W - PX * 2)
  const toY = (v: number) => PY + (1 - v / max) * (H - PY * 2)
  const pts  = items.map((item, i) => `${toX(i)},${toY(item.value)}`).join(' ')
  const area = `${toX(0)},${H - PY} ${pts} ${toX(items.length - 1)},${H - PY}`
  const step = Math.max(1, Math.floor(items.length / 5))
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H + 20}`} preserveAspectRatio="xMidYMid meet">
      {[0, 50, 100].map(p => {
        const y = PY + (1 - p / 100) * (H - PY * 2)
        return <line key={p} x1={PX} y1={y} x2={W - PX} y2={y} stroke={d.track} strokeWidth={1} />
      })}
      <polygon points={area} fill={`${color}20`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      {items.map((item, i) => <circle key={i} cx={toX(i)} cy={toY(item.value)} r={3} fill={color} />)}
      {items.map((item, i) => i % step === 0 && (
        <text key={i} x={toX(i)} y={H + 16} textAnchor="middle" fontSize={8} fill={d.sub} fontFamily="'Inter', sans-serif">{item.label.slice(-5)}</text>
      ))}
    </svg>
  )
}

function EmptyState() {
  const d = dk(useDark())
  return <div className="flex items-center justify-center" style={{ height: 100, color: d.sub, fontFamily: "'Inter', sans-serif", fontSize: 12 }}>No data yet</div>
}

function Skeleton({ h }: { h: number }) {
  const d = dk(useDark())
  return <div className="rounded-sm animate-pulse" style={{ height: h, background: d.skeleton }} />
}

function KpiBox({ label, value, icon, loading }: { label: string; value?: number; icon: string; loading: boolean }) {
  const isDark = useDark(); const d = dk(isDark)
  return (
    <div className="flex items-center gap-4 p-5 rounded-xl" style={{ background: d.kpiBg, border: `1.5px solid ${d.cardBorder}` }}>
      <div className="w-11 h-11 rounded-lg flex items-center justify-center text-xl flex-shrink-0" style={{ background: d.iconBg }}>{icon}</div>
      <div>
        <p className="font-bold" style={{ color: ORANGE, fontSize: 26, fontFamily: "'Inter', sans-serif", lineHeight: 1 }}>
          {loading ? <span className="inline-block w-8 h-6 rounded animate-pulse" style={{ background: d.skeleton }} /> : (value ?? 0)}
        </p>
        <p style={{ color: d.sub, fontSize: 11, fontFamily: "'Inter', sans-serif", marginTop: 3 }}>{label}</p>
      </div>
    </div>
  )
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const d = dk(useDark())
  return (
    <div className={`rounded-xl overflow-hidden ${className}`} style={{ background: d.card, border: `1px solid ${d.cardBorder}` }}>
      {children}
    </div>
  )
}

/* ─── Main component ────────────────────────────────────────────────────── */
const LOGIN_TYPE_COLOR: Record<string, string> = { 'Email OTP': NAVY, 'Authenticator': TEAL, 'Password': ORANGE }

export default function AdminHomeClient({ name, today, role }: { name: string; today: string; role: number }) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const d = dk(isDark)

  const [data,    setData]    = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/admin/home-analytics', { credentials: 'include' })
      .then(r => r.json())
      .then(res => { if (res.success) setData(res) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const quickLinks = [
    { href: '/admin/clients',               label: 'Clients',           icon: '🏢' },
    { href: '/admin/users',                 label: 'Users',             icon: '👥' },
    { href: '/admin/configuration',         label: 'Configuration',     icon: '⚙️' },
    { href: '/admin/registration-requests', label: 'Reg. Requests',     icon: '📋' },
    { href: '/admin/tracking',              label: 'Activity Tracking', icon: '📡' },
    { href: '/admin/dashboards',            label: 'Dashboards',        icon: '📊' },
  ]

  const counts = data?.counts ?? {} as Counts

  const weeklyData  = (data?.weeklyLogins  ?? []).map(d2 => ({ label: String(d2.date).slice(0, 10).slice(5), value: d2.count }))
  const monthlyData = (data?.monthlyLogins ?? []).map(d2 => {
    const [yr, mo] = String(d2.month).slice(0, 7).split('-')
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(mo) - 1] ?? mo
    return { label: `${mon} '${yr.slice(2)}`, value: d2.count }
  })
  const moduleItems    = (data?.moduleUsage          ?? []).slice(0, 12).map(m => ({ label: m.moduleName, value: m.users }))
  const dashItems      = (data?.dashboardAccess       ?? []).map(d2 => ({ label: d2.title, value: d2.count }))
  const regItems       = (data?.registrationTrend     ?? []).map((d2: any) => ({ label: String(d2.date ?? d2.month ?? '').slice(5, 10), value: d2.count }))
  const mostUsersItems = (data?.clientsWithMostUsers  ?? []).map(d2 => ({ label: d2.name, value: d2.count }))

  const userDistSegments     = [{ label: 'Client Accounts', value: counts.clientAccounts ?? 0, color: ORANGE }, { label: 'Admins', value: counts.admins ?? 0, color: NAVY }, { label: 'Super Admins', value: counts.superAdmins ?? 0, color: YELLOW }]
  const loginTypeSegments    = (data?.loginTypeBreakdown ?? []).map(l => ({ label: l.label, value: l.count, color: LOGIN_TYPE_COLOR[l.label] ?? NAVY_50 }))
  const activeVsInactiveSegs = (data?.activeVsInactive   ?? []).map(l => ({ label: l.status, value: l.count, color: l.status === 'Active' ? GREEN : RED }))

  return (
    <DarkCtx.Provider value={isDark}>
      <div className="p-6 fade-in space-y-6" style={BODY_FONT}>

        {/* Hero */}
        <div className="rounded-xl p-6" style={{ background: NAVY }}>
          <div className="flex items-start justify-between">
            <div>
              <h1 style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 700, fontSize: 22, color: '#fff' }}>
                Welcome back, <span style={{ color: ORANGE }}>{name}</span>
              </h1>
              <p style={{ color: NAVY_50, fontSize: 12, marginTop: 4, fontFamily: "'Inter', sans-serif" }}>
                {today} · IP House Admin Portal
              </p>
            </div>
            {role === 2 && (
              <span className="text-xs font-bold px-3 py-1.5 rounded"
                style={{ background: `${YELLOW}25`, color: YELLOW, border: `1px solid ${YELLOW}50`, fontFamily: "'Inter', sans-serif" }}>
                ★ Super Admin
              </span>
            )}
          </div>
        </div>

        {/* KPI Row 1 */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiBox label="Total Clients"   value={counts.totalClients}   icon="🏢" loading={loading} />
          <KpiBox label="Client Accounts" value={counts.clientAccounts} icon="👤" loading={loading} />
          <KpiBox label="Admins"          value={counts.admins}         icon="🛡️" loading={loading} />
          <KpiBox label="Super Admins"    value={counts.superAdmins}    icon="👑" loading={loading} />
        </div>

        {/* KPI Row 2 */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiBox label="Total Login Users"     value={counts.totalLogins}     icon="🔐" loading={loading} />
          <KpiBox label="Active Login Accounts" value={counts.activeLogins}    icon="✅" loading={loading} />
          <KpiBox label="Logins This Week"      value={counts.loginsThisWeek}  icon="📅" loading={loading} />
          <KpiBox label="Logins This Month"     value={counts.loginsThisMonth} icon="📈" loading={loading} />
        </div>

        {/* Donuts */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {[
            { title: 'Client Distribution',       sub: 'Breakdown by role',        segs: userDistSegments,     center: 'clients'  },
            { title: 'Login Type Breakdown',       sub: 'Auth method distribution', segs: loginTypeSegments,    center: 'accounts' },
            { title: 'Active vs Inactive Logins',  sub: 'Login account status',     segs: activeVsInactiveSegs, center: 'accounts' },
          ].map(c => (
            <Card key={c.title} className="p-5">
              <ChartTitle>{c.title}</ChartTitle>
              <ChartSub>{c.sub}</ChartSub>
              {loading ? <Skeleton h={140} /> : <DonutChart segments={c.segs} centerLabel={c.center} />}
            </Card>
          ))}
        </div>

        {/* Line + Bar */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Card className="p-5">
            <ChartTitle>Weekly Login Activity</ChartTitle>
            <ChartSub>Logins in the last 14 days</ChartSub>
            {loading ? <Skeleton h={120} /> : <LineChart items={weeklyData} color={ORANGE} height={120} />}
          </Card>
          <Card className="p-5">
            <ChartTitle>Monthly Visitor Trend</ChartTitle>
            <ChartSub>Total logins per month (12 months)</ChartSub>
            {loading ? <Skeleton h={140} /> : <BarV items={monthlyData} color={NAVY} height={140} />}
          </Card>
        </div>

        {/* Registrations + Most users */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Card className="p-5">
            <ChartTitle>New Registrations</ChartTitle>
            <ChartSub>Approved registration requests — last 30 days</ChartSub>
            {loading ? <Skeleton h={140} /> : <BarV items={regItems} color={ORANGE} height={140} />}
          </Card>
          <Card className="p-5">
            <ChartTitle>Clients with Most Login Users</ChartTitle>
            <ChartSub>Top 10 by sub-account count</ChartSub>
            {loading ? <Skeleton h={200} /> : <BarH items={mostUsersItems} />}
          </Card>
        </div>

        {/* Module + Dashboard */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Card className="p-5">
            <ChartTitle>Module Access Distribution</ChartTitle>
            <ChartSub>Users with access per module</ChartSub>
            {loading ? <Skeleton h={200} /> : <BarH items={moduleItems} />}
          </Card>
          <Card className="p-5">
            <ChartTitle>PowerBI Dashboard Views</ChartTitle>
            <ChartSub>Most accessed reports</ChartSub>
            {loading ? <Skeleton h={200} /> : (dashItems.length === 0 ? <EmptyState /> : <BarH items={dashItems} />)}
          </Card>
        </div>

        {/* Recent dashboard views */}
        <Card>
          <div className="px-5 py-4" style={{ borderBottom: `1px solid ${d.divider}` }}>
            <p style={{ fontFamily: "'DM Sans', sans-serif", color: d.text, fontWeight: 600, fontSize: 14 }}>Recent Dashboard Views</p>
            <p style={{ fontFamily: "'Inter', sans-serif", color: d.sub, fontSize: 11 }}>Who opened which PowerBI report</p>
          </div>
          <div>
            {loading ? <Skeleton h={160} /> : (data?.recentDashboardViews ?? []).length === 0 ? <EmptyState /> : (data?.recentDashboardViews ?? []).map((v, i) => (
              <div key={v.id} className="flex items-center gap-3 px-5 py-3"
                style={{ borderBottom: `1px solid ${d.rowBorder}`, background: i % 2 === 0 ? d.rowEven : d.rowOdd }}>
                <div className="w-8 h-8 rounded flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ background: d.iconBg, color: d.text }}>
                  {(v.client || v.username || 'U').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate" style={{ color: d.text }}>{v.client}</p>
                  <p className="text-[10px] truncate" style={{ color: d.sub }}>{v.username || '—'}</p>
                </div>
                <div className="min-w-0 flex-1 text-right">
                  <p className="text-xs font-medium truncate" style={{ color: ORANGE }}>{v.report}</p>
                  <p className="text-[10px] truncate" style={{ color: d.sub }}>{v.viewedAt}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Top 20 tables */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

          {/* Top Users by Portal Usage */}
          <Card>
            <div className="px-5 py-4" style={{ borderBottom: `1px solid ${d.divider}` }}>
              <p style={{ fontFamily: "'DM Sans', sans-serif", color: d.text, fontWeight: 600, fontSize: 14 }}>Top 20 Users by Portal Usage</p>
              <p style={{ fontFamily: "'Inter', sans-serif", color: d.sub, fontSize: 11 }}>Ranked by total activity events</p>
            </div>
            <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 360 }}>
              <table className="w-full text-sm" style={BODY_FONT}>
                <thead>
                  <tr style={{ background: NAVY }}>
                    {['#', 'Name', 'Username', 'Total Activity', 'Last Active', 'Status', 'Usage'].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap"
                        style={{ color: 'rgba(255,255,255,0.85)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="text-center py-8">
                      <span className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin inline-block" style={{ borderColor: d.skeleton, borderTopColor: ORANGE }} />
                    </td></tr>
                  ) : (data?.topClients ?? []).length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-8 text-xs" style={{ color: d.sub }}>No activity data yet</td></tr>
                  ) : (data?.topClients ?? []).map((c, i) => {
                    const maxLogins = data!.topClients[0]?.total_logins || 1
                    const pct = Math.round((c.total_logins / maxLogins) * 100)
                    return (
                      <tr key={(c as any).loginId ?? i} style={{ background: i % 2 === 0 ? d.rowEven : d.rowOdd, borderBottom: `1px solid ${d.rowBorder}` }}>
                        <td className="px-4 py-3 text-xs font-mono" style={{ color: d.sub }}>{i + 1}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                              style={{ background: PALETTE[i % PALETTE.length] }}>
                              {(c.name || 'U').charAt(0).toUpperCase()}
                            </div>
                            <p className="text-xs font-medium" style={{ color: d.text }}>{c.name?.trim() || '—'}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: d.sub }}>{(c as any).username || '—'}</td>
                        <td className="px-4 py-3 text-xs font-bold" style={{ color: ORANGE }}>{c.total_logins}</td>
                        <td className="px-4 py-3 text-xs" style={{ color: d.sub }}>{c.last_login || '—'}</td>
                        <td className="px-4 py-3">
                          <span className="text-[10px] px-2 py-0.5 rounded font-semibold"
                            style={{ background: c.is_active ? `${GREEN}18` : `${RED}15`, color: c.is_active ? GREEN : RED }}>
                            {c.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-4 py-3 w-24">
                          <div className="h-1.5 rounded-sm" style={{ background: d.track }}>
                            <div className="h-1.5 rounded-sm" style={{ width: `${pct}%`, background: ORANGE }} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Top 20 Login Users */}
          <Card>
            <div className="px-5 py-4" style={{ borderBottom: `1px solid ${d.divider}` }}>
              <p style={{ fontFamily: "'DM Sans', sans-serif", color: d.text, fontWeight: 600, fontSize: 14 }}>Top 20 Login Users</p>
              <p style={{ fontFamily: "'Inter', sans-serif", color: d.sub, fontSize: 11 }}>Most active individual login accounts</p>
            </div>
            <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 360 }}>
              <table className="w-full text-sm" style={BODY_FONT}>
                <thead>
                  <tr style={{ background: NAVY }}>
                    {['#', 'Name', 'Username', 'Client', 'Login Type', 'Total Logins', 'Last Login', 'Status'].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap"
                        style={{ color: 'rgba(255,255,255,0.85)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={8} className="text-center py-8">
                      <span className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin inline-block" style={{ borderColor: d.skeleton, borderTopColor: ORANGE }} />
                    </td></tr>
                  ) : (data?.topLoginUsers ?? []).length === 0 ? (
                    <tr><td colSpan={8} className="text-center py-8 text-xs" style={{ color: d.sub }}>No login user data yet</td></tr>
                  ) : (data?.topLoginUsers ?? []).map((u, i) => {
                    const typeLabel = { 0: 'Email OTP', 1: 'Authenticator', 2: 'Password' }[u.login_type] ?? `Type ${u.login_type}`
                    const typeColor = LOGIN_TYPE_COLOR[typeLabel] ?? NAVY_50
                    const maxLogins = data!.topLoginUsers[0]?.logins || 1
                    const pct = Math.round((u.logins / maxLogins) * 100)
                    return (
                      <tr key={u.loginId} style={{ background: i % 2 === 0 ? d.rowEven : d.rowOdd, borderBottom: `1px solid ${d.rowBorder}` }}>
                        <td className="px-4 py-3 text-xs font-mono" style={{ color: d.sub }}>{i + 1}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                              style={{ background: PALETTE[i % PALETTE.length] }}>
                              {(u.name || u.username || 'U').charAt(0).toUpperCase()}
                            </div>
                            <span className="text-xs font-medium" style={{ color: d.text }}>{u.name || '—'}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs font-mono" style={{ color: d.sub }}>{u.username}</td>
                        <td className="px-4 py-3 text-xs" style={{ color: d.text }}>{u.client}</td>
                        <td className="px-4 py-3">
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded text-white" style={{ background: typeColor }}>{typeLabel}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold" style={{ color: ORANGE }}>{u.logins}</span>
                            <div className="flex-1 h-1 rounded-sm" style={{ background: d.track, minWidth: 40 }}>
                              <div className="h-1 rounded-sm" style={{ width: `${pct}%`, background: ORANGE }} />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: d.sub }}>{u.last_login || '—'}</td>
                        <td className="px-4 py-3">
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded"
                            style={{ background: u.is_active ? `${GREEN}18` : `${RED}15`, color: u.is_active ? GREEN : RED }}>
                            {u.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* Recent Logins + Quick Actions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Card>
            <div className="px-5 py-4" style={{ borderBottom: `1px solid ${d.divider}` }}>
              <p style={{ fontFamily: "'DM Sans', sans-serif", color: d.text, fontWeight: 600, fontSize: 14 }}>Recent Logins</p>
              <p style={{ fontFamily: "'Inter', sans-serif", color: d.sub, fontSize: 11 }}>Last 15 login sessions</p>
            </div>
            <div>
              {loading ? <Skeleton h={160} /> : (data?.recentLogins ?? []).length === 0 ? <EmptyState /> : (data?.recentLogins ?? []).map((a, i) => (
                <div key={a.loginId} className="flex items-center gap-3 px-5 py-3"
                  style={{ borderBottom: `1px solid ${d.rowBorder}`, background: i % 2 === 0 ? d.rowEven : d.rowOdd }}>
                  <div className="w-8 h-8 rounded flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{ background: d.iconBg, color: d.text }}>
                    {(a.client || a.username || 'U').charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate" style={{ color: d.text }}>{a.client}</p>
                    <p className="text-[10px] truncate" style={{ color: d.sub }}>{a.username} · {a.loginTime}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-5">
            <p style={{ fontFamily: "'DM Sans', sans-serif", color: d.text, fontWeight: 600, fontSize: 14 }} className="mb-4">Quick Actions</p>
            <div className="grid grid-cols-2 gap-3">
              {quickLinks.map(link => (
                <Link key={link.href} to={link.href}
                  className="flex items-center gap-2.5 p-3 rounded-lg transition-all hover:opacity-80"
                  style={{ background: d.quickBg, border: `1px solid ${d.cardBorder}` }}>
                  <div className="w-8 h-8 rounded flex items-center justify-center text-base flex-shrink-0" style={{ background: d.iconBg }}>{link.icon}</div>
                  <span className="text-xs font-semibold" style={{ color: d.text }}>{link.label}</span>
                </Link>
              ))}
            </div>
          </Card>
        </div>

        {/* AI Insight */}
        {!loading && data && (
          <div className="rounded-xl p-6" style={{ background: NAVY }}>
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 text-xl" style={{ background: `${ORANGE}25` }}>📊</div>
              <div>
                <p style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 700, fontSize: 14, color: ORANGE }} className="mb-2">AI-Generated Platform Insight</p>
                <div className="space-y-1.5" style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
                  <p>• Platform has <strong style={{ color: '#fff' }}>{counts.totalClients} clients</strong> — {counts.clientAccounts} client accounts, {counts.admins} admins, {counts.superAdmins} super admin{counts.superAdmins !== 1 ? 's' : ''}.</p>
                  <p>• Login accounts: <strong style={{ color: '#fff' }}>{counts.activeLogins} active</strong> out of {counts.totalLogins} total ({counts.totalLogins > 0 ? Math.round((counts.activeLogins / counts.totalLogins) * 100) : 0}% active rate).</p>
                  {counts.loginsThisWeek > 0 && <p>• <strong style={{ color: ORANGE }}>{counts.loginsThisWeek} logins this week</strong>, {counts.loginsThisMonth} this month.</p>}
                  {monthlyData.length > 1 && (() => {
                    const last = monthlyData[monthlyData.length - 1]?.value ?? 0
                    const prev = monthlyData[monthlyData.length - 2]?.value ?? 0
                    const diff = last - prev
                    return <p>• Monthly trend: <strong style={{ color: '#fff' }}>{last} logins</strong> this month ({diff >= 0 ? `+${diff}` : diff} vs prior month).</p>
                  })()}
                  {loginTypeSegments[0] && <p>• Most used auth: <strong style={{ color: '#fff' }}>{loginTypeSegments[0].label}</strong> ({loginTypeSegments[0].value} accounts).</p>}
                  {moduleItems[0] && <p>• Most accessed module: <strong style={{ color: '#fff' }}>{moduleItems[0].label}</strong> ({moduleItems[0].value} users).</p>}
                  {data.topClients[0] && <p>• Most active user: <strong style={{ color: ORANGE }}>{data.topClients[0].name?.trim() || data.topClients[0].username}</strong> — {data.topClients[0].total_logins} events.</p>}
                  {dashItems.length === 0 && <p>• <strong style={{ color: YELLOW }}>No PowerBI dashboard views recorded</strong> — promote BI reports to improve adoption.</p>}
                </div>
              </div>
            </div>
            <p className="mt-4 pt-3" style={{ borderTop: `1px solid rgba(255,255,255,0.1)`, fontFamily: "'DM Sans', sans-serif", fontStyle: 'italic', fontSize: 9, color: NAVY_50 }}>
              Confidential &amp; Proprietary
            </p>
          </div>
        )}
      </div>
    </DarkCtx.Provider>
  )
}
