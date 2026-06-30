'use client'

import { useState, useEffect } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'

interface Stats {
  loginStats:     { today: number; week: number; month: number; uniqueToday: number }
  passwordStats:  { totalChanges: number; uniqueUsers: number; today: number; thisWeek: number }
  passwordHistory: { username: string; full_name: string; change_count: number; last_changed: string }[]
  topDashboards:  { dashboard_id: string; dashboard_name: string; access_count: number; unique_users: number; last_accessed: string }[]
  topUsers:       { username: string; full_name: string; client: string; total_actions: number; logins: number; last_seen: string }[]
  recentActivity: { username: string; full_name: string; action: string; page_url: string; ip_address: string; created_at: string; metadata: string }[]
  actionBreakdown:{ action: string; count: number }[]
  dailyLogins:    { date: string; logins: number; unique_users: number }[]
  loginsByHour:   { hour: number; count: number }[]
}

const ACTION_COLOR: Record<string, string> = {
  login:              '#16A34A',
  password_changed:   '#F59E0B',
  dashboard_accessed: '#0078D4',
  logout:             '#6b7280',
  view:               '#14254A',
  search_performed:   '#7C3AED',
  ip_tracking:        '#0891B2',
  download_requested: '#EC4899',
}

const ACTION_ICON: Record<string, string> = {
  login:              '🔑',
  password_changed:   '🔐',
  dashboard_accessed: '📊',
  logout:             '👋',
  view:               '👁',
  search_performed:   '🔍',
  ip_tracking:        '📍',
  download_requested: '⬇️',
}

function StatCard({ label, value, icon, color, sub }: { label: string; value: number | string; icon: string; color: string; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4 flex items-center gap-3">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
        style={{ background: `${color}12` }}>{icon}</div>
      <div>
        <p className="text-2xl font-bold" style={{ color }}>{value}</p>
        <p className="text-xs text-gray-400 font-medium">{label}</p>
        {sub && <p className="text-[10px] text-gray-300">{sub}</p>}
      </div>
    </div>
  )
}

function MiniBarChart({ data, labelKey, valueKey, color = '#0078D4' }: {
  data: Record<string, any>[]; labelKey: string; valueKey: string; color?: string
}) {
  if (!data.length) return <p className="text-xs text-gray-400 text-center py-4">No data yet</p>
  const max = Math.max(...data.map(d => Number(d[valueKey])), 1)
  return (
    <div className="flex items-end gap-0.5 w-full" style={{ height: 80 }}>
      {data.map((d, i) => {
        const pct = Math.round((Number(d[valueKey]) / max) * 100)
        const label = String(d[labelKey]).slice(5, 10)
        return (
          <div key={i} className="flex flex-col items-center flex-1 min-w-0 group relative" style={{ height: 80 }}>
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-[9px] px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap z-10 pointer-events-none">
              {d[valueKey]}
            </div>
            <div className="w-full flex-1 flex items-end">
              <div className="w-full rounded-t-sm" style={{ height: `${pct}%`, background: color, minHeight: 2 }} />
            </div>
            <span className="text-[8px] text-gray-400 mt-0.5 truncate w-full text-center">{label}</span>
          </div>
        )
      })}
    </div>
  )
}

function HourChart({ data }: { data: { hour: number; count: number }[] }) {
  const full = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    count: data.find(d => d.hour === h)?.count ?? 0,
  }))
  const max = Math.max(...full.map(d => d.count), 1)
  return (
    <div className="flex items-end gap-0.5 w-full" style={{ height: 60 }}>
      {full.map(d => {
        const pct = Math.round((d.count / max) * 100)
        const label = `${String(d.hour).padStart(2, '0')}:00`
        return (
          <div key={d.hour} className="flex flex-col items-center flex-1 group relative" style={{ height: 60 }}>
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-[9px] px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap z-10 pointer-events-none">
              {label}: {d.count}
            </div>
            <div className="w-full flex-1 flex items-end">
              <div className="w-full rounded-t-sm" style={{ height: `${pct}%`, background: '#14254A', minHeight: pct ? 2 : 0 }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function ActivityPage() {
  const [data,    setData]    = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab,     setTab]     = useState<'overview' | 'dashboards' | 'passwords' | 'users' | 'feed'>('overview')

  useEffect(() => {
    fetch('/api/admin/activity-stats', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.success) setData(d) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const Skeleton = ({ h = 40 }: { h?: number }) => (
    <div className="animate-pulse bg-gray-100 rounded-xl" style={{ height: h }} />
  )

  return (
    <div className="p-6 fade-in">
      <AdminPageHeader
        breadcrumb={[{ label: 'Activity' }]}
        title="Activity & Usage Analytics"
        description="Logins, password changes, PowerBI access and full user activity tracking"
      />

      {/* Tab bar */}
      <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit mb-6 flex-wrap">
        {[
          { key: 'overview',   label: '📊 Overview'        },
          { key: 'dashboards', label: '📈 Dashboard Access' },
          { key: 'passwords',  label: '🔐 Password Changes' },
          { key: 'users',      label: '👥 Top Users'        },
          { key: 'feed',       label: '📋 Activity Feed'    },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key as any)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${tab === t.key ? 'bg-white shadow text-[#14254A]' : 'text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab === 'overview' && (
        <div className="space-y-5">
          {/* KPI row 1 — logins */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {loading ? Array(4).fill(0).map((_, i) => <Skeleton key={i} h={80} />) : <>
              <StatCard label="Logins Today"        value={data?.loginStats.today       ?? 0} icon="🔑" color="#16A34A" />
              <StatCard label="Logins This Week"    value={data?.loginStats.week        ?? 0} icon="📅" color="#0078D4" />
              <StatCard label="Logins This Month"   value={data?.loginStats.month       ?? 0} icon="📆" color="#7C3AED" />
              <StatCard label="Active Users Today"  value={data?.loginStats.uniqueToday ?? 0} icon="👥" color="#14254A" />
            </>}
          </div>

          {/* KPI row 2 — password changes */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {loading ? Array(4).fill(0).map((_, i) => <Skeleton key={i} h={80} />) : <>
              <StatCard label="Total Password Changes"  value={data?.passwordStats.totalChanges ?? 0} icon="🔐" color="#F59E0B" />
              <StatCard label="Users Changed Password"  value={data?.passwordStats.uniqueUsers  ?? 0} icon="👤" color="#EC4899" />
              <StatCard label="Password Changes Today"  value={data?.passwordStats.today        ?? 0} icon="📅" color="#EF4444" />
              <StatCard label="Changes This Week"       value={data?.passwordStats.thisWeek     ?? 0} icon="📆" color="#0891B2" />
            </>}
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

            {/* Daily login trend */}
            <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-card p-5">
              <p className="font-semibold text-[#14254A] text-sm mb-1">Daily Login Activity — Last 30 Days</p>
              <p className="text-xs text-gray-400 mb-3">Login events per day</p>
              {loading ? <Skeleton h={80} /> : <MiniBarChart data={data?.dailyLogins ?? []} labelKey="date" valueKey="logins" color="#16A34A" />}
            </div>

            {/* Action breakdown */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-5">
              <p className="font-semibold text-[#14254A] text-sm mb-1">Event Breakdown</p>
              <p className="text-xs text-gray-400 mb-3">Last 30 days by type</p>
              {loading ? <Skeleton h={80} /> : (
                <div className="space-y-2">
                  {(data?.actionBreakdown ?? []).map(a => (
                    <div key={a.action} className="flex items-center gap-2">
                      <span className="text-sm">{ACTION_ICON[a.action] ?? '•'}</span>
                      <div className="flex-1">
                        <div className="flex justify-between text-xs mb-0.5">
                          <span className="text-gray-600 capitalize">{a.action.replace(/_/g, ' ')}</span>
                          <span className="font-semibold" style={{ color: ACTION_COLOR[a.action] ?? '#14254A' }}>{a.count}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full rounded-full" style={{
                            width: `${Math.round((a.count / Math.max(...(data?.actionBreakdown ?? []).map(x => x.count), 1)) * 100)}%`,
                            background: ACTION_COLOR[a.action] ?? '#14254A',
                          }} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {!loading && !data?.actionBreakdown?.length && <p className="text-xs text-gray-400 text-center py-3">No events yet</p>}
                </div>
              )}
            </div>
          </div>

          {/* Login by hour */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-5">
            <p className="font-semibold text-[#14254A] text-sm mb-1">Login Frequency by Hour</p>
            <p className="text-xs text-gray-400 mb-3">When users most commonly log in (24 h)</p>
            {loading ? <Skeleton h={60} /> : <HourChart data={data?.loginsByHour ?? []} />}
          </div>
        </div>
      )}

      {/* ── DASHBOARD ACCESS ── */}
      {tab === 'dashboards' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50">
            <p className="font-semibold text-[#14254A] text-sm">PowerBI Dashboard Access</p>
            <p className="text-xs text-gray-400">Which reports are accessed most, and by how many users</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: '#14254A' }}>
                  {['#', 'Dashboard Name', 'Report ID', 'Total Accesses', 'Unique Users', 'Last Accessed'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="text-center py-10 text-gray-400 text-sm">Loading…</td></tr>
                ) : !data?.topDashboards?.length ? (
                  <tr><td colSpan={6} className="text-center py-10 text-gray-400 text-sm">No dashboard access recorded yet.</td></tr>
                ) : data.topDashboards.map((d, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">{i + 1}</td>
                    <td className="px-4 py-3 font-medium text-gray-800 text-xs">{d.dashboard_name}</td>
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">{d.dashboard_id.slice(0, 12)}…</td>
                    <td className="px-4 py-3">
                      <span className="font-bold text-[#0078D4]">{d.access_count}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{d.unique_users}</td>
                    <td className="px-4 py-3 text-xs text-gray-400">{d.last_accessed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── PASSWORD CHANGES ── */}
      {tab === 'passwords' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50">
            <p className="font-semibold text-[#14254A] text-sm">Password Change History</p>
            <p className="text-xs text-gray-400">Users ranked by number of password changes</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: '#14254A' }}>
                  {['#', 'User', 'Username', 'Times Changed', 'Last Changed'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className="text-center py-10 text-gray-400 text-sm">Loading…</td></tr>
                ) : !data?.passwordHistory?.length ? (
                  <tr><td colSpan={5} className="text-center py-10 text-gray-400 text-sm">No password changes recorded yet.</td></tr>
                ) : data.passwordHistory.map((p, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">{i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                          style={{ background: '#F59E0B' }}>
                          {(p.full_name?.trim() || p.username || '?').charAt(0).toUpperCase()}
                        </div>
                        <p className="text-xs font-medium text-gray-800">{p.full_name?.trim() || '—'}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">{p.username}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold"
                        style={{ background: '#FEF3C7', color: '#D97706' }}>
                        {p.change_count}×
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">{p.last_changed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── TOP USERS ── */}
      {tab === 'users' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50">
            <p className="font-semibold text-[#14254A] text-sm">Most Active Users</p>
            <p className="text-xs text-gray-400">Ranked by total tracked events</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: '#14254A' }}>
                  {['#', 'User', 'Client', 'Total Events', 'Logins', 'Last Seen'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="text-center py-10 text-gray-400 text-sm">Loading…</td></tr>
                ) : !data?.topUsers?.length ? (
                  <tr><td colSpan={6} className="text-center py-10 text-gray-400 text-sm">No activity recorded yet.</td></tr>
                ) : data.topUsers.map((u, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">{i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                          style={{ background: '#14254A' }}>
                          {(u.full_name?.trim() || u.username || '?').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-gray-800">{u.full_name?.trim() || '—'}</p>
                          <p className="text-[10px] text-gray-400 font-mono">{u.username}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{u.client || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="font-bold text-[#14254A]">{u.total_actions}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{u.logins}</td>
                    <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{u.last_seen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── ACTIVITY FEED ── */}
      {tab === 'feed' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50">
            <p className="font-semibold text-[#14254A] text-sm">Live Activity Feed</p>
            <p className="text-xs text-gray-400">Last 30 tracked events across all users</p>
          </div>
          <div className="divide-y divide-gray-50">
            {loading ? (
              <p className="text-center py-10 text-gray-400 text-sm">Loading…</p>
            ) : !data?.recentActivity?.length ? (
              <p className="text-center py-10 text-gray-400 text-sm">No activity recorded yet.</p>
            ) : data.recentActivity.map((a, i) => {
              const color = ACTION_COLOR[a.action] ?? '#14254A'
              const icon  = ACTION_ICON[a.action]  ?? '•'
              let meta: Record<string, any> = {}
              try { meta = a.metadata ? JSON.parse(a.metadata) : {} } catch {}
              return (
                <div key={i} className="flex items-start gap-3 px-5 py-3 hover:bg-gray-50/50">
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center text-base flex-shrink-0"
                    style={{ background: `${color}12` }}>
                    {icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-gray-800">{a.full_name?.trim() || a.username}</span>
                      <span className="text-[10px] font-mono text-gray-400">{a.username}</span>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold capitalize"
                        style={{ background: `${color}12`, color }}>
                        {a.action.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-400 truncate mt-0.5">
                      {meta.dashboardName ? `Dashboard: ${meta.dashboardName}` : a.page_url}
                      {a.ip_address ? ` · ${a.ip_address}` : ''}
                    </p>
                  </div>
                  <span className="text-[10px] text-gray-400 whitespace-nowrap flex-shrink-0">{a.created_at}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
