'use client'

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useRouter } from '@/lib/router'
import PaginationBar, { PER_PAGE } from './PaginationBar'

interface Dashboard {
  userId: number
  name: string
  email: string
  moduleId: number
  moduleName: string
  link: string
  active: number
  default: number
}

interface Props {
  dashboards: Dashboard[]
  totalClients: number
  totalDashboards: number
  totalModules: number
}

export default function DashboardsPageClient({ dashboards, totalClients, totalDashboards, totalModules }: Props) {
  const router = useRouter()
  const [tab, setTab] = useState<'active' | 'inactive'>('active')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [sortCol, setSortCol] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  function handleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  function si(col: string): JSX.Element {
    if (sortCol !== col) return <span className="ml-1 opacity-40 text-[10px]">↕</span>
    return <span className="ml-1 text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }
  function sortRows(arr: Dashboard[]): Dashboard[] {
    if (!sortCol) return arr
    return [...arr].sort((a, b) => {
      const av = (a as any)[sortCol] ?? ''
      const bv = (b as any)[sortCol] ?? ''
      const cmp = (typeof av === 'number' && typeof bv === 'number')
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const active   = dashboards.filter(d => d.active === 1)
  const inactive = dashboards.filter(d => d.active === 0)
  const q = search.toLowerCase()
  const filtered = (tab === 'active' ? active : inactive).filter(d =>
    !q || d.name.toLowerCase().includes(q) || d.email.toLowerCase().includes(q) || d.moduleName.toLowerCase().includes(q)
  )
  const pageRows = sortRows(filtered).slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function changeTab(t: 'active' | 'inactive') { setTab(t); setPage(1) }
  function changeSearch(v: string) { setSearch(v); setPage(1) }

  async function toggleActive(userId: number, moduleId: number, activate: boolean) {
    const key = `${userId}_${moduleId}`
    setBusy(key)
    const res  = await fetch('/api/admin/dashboards', {
        credentials: 'include',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, moduleId, active: activate ? 1 : 0 }),
    })
    const data = await res.json()
    if (data.success) { showToast(activate ? 'Dashboard activated' : 'Dashboard deactivated'); router.refresh() }
    else showToast(data.error || 'Failed', 'error')
    setBusy(null)
  }

  return (
    <div className="p-5 fade-in">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Back button */}
      <div className="mb-3">
        <Link to="/admin/configuration" className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-[#14254A] transition-colors">
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to Configuration
        </Link>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs text-gray-400 mb-4">
        <Link to="/admin/home" className="hover:text-gray-600">Home</Link>
        <span>›</span>
        <span className="text-gray-700 font-medium">Dashboard Management</span>
      </div>

      <div className="flex gap-5">

        {/* ── LEFT COLUMN ── */}
        <div className="w-52 flex-shrink-0 space-y-3">

          <div className="rounded-2xl p-4 bg-white border border-gray-100 shadow-sm">
            <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mb-1">Total Clients</p>
            <Link to="/admin/clients">
              <p className="text-3xl font-bold text-[#14254A] hover:opacity-70 transition-opacity">{totalClients}</p>
            </Link>
            <p className="text-xs text-gray-400 mt-1">Active accounts</p>
          </div>

          <div className="rounded-2xl p-4 bg-white border border-gray-100 shadow-sm">
            <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mb-1">Published Dashboards</p>
            <p className="text-3xl font-bold text-[#14254A]">{totalDashboards}</p>
            <p className="text-xs text-gray-400 mt-1">With embed links</p>
          </div>

          <div className="rounded-2xl p-4 bg-white border border-gray-100 shadow-sm">
            <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mb-1">Dashboard Modules</p>
            <p className="text-3xl font-bold text-[#14254A]">{totalModules}</p>
            <p className="text-xs text-gray-400 mt-1">Active modules</p>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
            <Link to="/admin/dashboards/add"
              className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 no-underline"
              style={{ background: '#14254A' }}>
              + Add Dashboard
            </Link>
          </div>
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div className="flex-1 min-w-0 bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">

          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="font-bold text-[#14254A] text-base">Dashboard Management</h2>
            <input
              autoComplete="off"
              value={search} onChange={e => changeSearch(e.target.value)}
              placeholder="Search client, email, module…"
              className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-56 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-gray-50/50">
            <button
              onClick={() => changeTab('active')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-150 ${
                tab === 'active'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'bg-white text-gray-500 border border-gray-200 hover:border-emerald-300 hover:text-emerald-700'
              }`}
            >
              <span className={`flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold flex-shrink-0 ${
                tab === 'active' ? 'bg-white/20 text-white' : 'bg-emerald-100 text-emerald-700'
              }`}>✓</span>
              Active Dashboards
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                tab === 'active' ? 'bg-white/20 text-white' : 'bg-emerald-100 text-emerald-700'
              }`}>
                {active.length}
              </span>
            </button>

            <button
              onClick={() => changeTab('inactive')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-150 ${
                tab === 'inactive'
                  ? 'bg-gray-700 text-white shadow-sm'
                  : 'bg-white text-gray-500 border border-gray-200 hover:border-gray-400 hover:text-gray-700'
              }`}
            >
              <span className={`flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold flex-shrink-0 ${
                tab === 'inactive' ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
              }`}>✕</span>
              Inactive Dashboards
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                tab === 'inactive' ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
              }`}>
                {inactive.length}
              </span>
            </button>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: '#14254A' }}>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('name')}>Client Name<>{si('name')}</></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('email')}>Account (Email)<>{si('email')}</></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('moduleName')}>Module Name<>{si('moduleName')}</></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">PowerBI Dashboard Link</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('active')}>Is Active<>{si('active')}</></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('default')}>Is Default<>{si('default')}</></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-10 text-gray-400 text-sm">
                    No dashboards found.{' '}
                    <Link to="/admin/dashboards/add" className="text-blue-600 hover:underline">Create one →</Link>
                  </td></tr>
                ) : pageRows.map(d => {
                  const key = `${d.userId}_${d.moduleId}`
                  return (
                    <tr key={key} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-800 text-sm">{d.name}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{d.email}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-medium px-2 py-1 rounded-lg bg-gray-100 text-gray-700 border border-gray-200">
                          {d.moduleName}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <a href={d.link} target="_blank" rel="noopener noreferrer"
                          className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors no-underline inline-block">
                          View
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium text-gray-700`}>
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${d.active === 1 ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                          {d.active === 1 ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-gray-600">{d.default === 1 ? 'Yes' : 'No'}</span>
                      </td>
                      <td className="px-4 py-3">
                        {d.active === 1 ? (
                          <div className="flex items-center gap-1.5">
                            <Link to={`/admin/dashboards/edit?userId=${d.userId}&moduleId=${d.moduleId}`}
                              className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors no-underline">
                              Edit
                            </Link>
                            <button onClick={() => toggleActive(d.userId, d.moduleId, false)} disabled={busy === key}
                              className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50">
                              {busy === key ? '…' : 'Deactivate'}
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => toggleActive(d.userId, d.moduleId, true)} disabled={busy === key}
                            className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50">
                            {busy === key ? '…' : 'Activate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <PaginationBar page={page} total={filtered.length} onChange={setPage} />
        </div>
      </div>
    </div>
  )
}
