'use client'

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useRouter } from '@/lib/router'
import PaginationBar, { PER_PAGE } from './PaginationBar'

interface Client {
  userId: number
  name: string
  email: string
  deleted: number
  createdOn?: string
  link?: string
}

interface Props {
  clients: Client[]
  totalClients: number
  totalDashboards: number
  totalModules: number
}

function fmtDate(s?: string) {
  if (!s) return '—'
  try { return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return s }
}

export default function ClientsPageClient({ clients, totalClients, totalDashboards, totalModules }: Props) {
  const router = useRouter()
  const [tab, setTab] = useState<'active' | 'inactive'>('active')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState<number | null>(null)
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
  function sortRows(arr: Client[]): Client[] {
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

  const active   = clients.filter(c => c.deleted === 0)
  const inactive = clients.filter(c => c.deleted === 1)
  const q = search.toLowerCase()
  const filtered = (tab === 'active' ? active : inactive).filter(c =>
    !q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || String(c.userId).includes(q)
  )
  const pageRows = sortRows(filtered).slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function changeTab(t: 'active' | 'inactive') { setTab(t); setPage(1) }
  function changeSearch(v: string) { setSearch(v); setPage(1) }

  async function toggleStatus(userId: number, activate: boolean) {
    setBusy(userId)
    const res = await fetch('/api/admin/clients', {
        credentials: 'include',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, deleted: activate ? 0 : 1 }),
    })
    const data = await res.json()
    if (data.success) { showToast(activate ? 'Client activated' : 'Client deactivated'); router.refresh() }
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

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs text-gray-400 mb-4">
        <Link to="/admin/home" className="hover:text-gray-600">Home</Link>
        <span>›</span>
        <span className="text-gray-700 font-medium">Client Management</span>
      </div>

      <div className="flex flex-col md:flex-row gap-5">

        {/* ── LEFT COLUMN ── */}
        <div className="w-full md:w-52 flex-shrink-0 space-y-3">

          {/* Stat: Total Clients */}
          <div className="rounded-2xl p-4 bg-white border border-gray-100 shadow-sm">
            <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mb-1">Total Clients</p>
            <Link to="/admin/clients/add">
              <p className="text-3xl font-bold text-[#14254A] hover:opacity-70 transition-opacity">{totalClients}</p>
            </Link>
            <p className="text-xs text-gray-400 mt-1">Active accounts</p>
          </div>

          {/* Stat: Published Dashboards */}
          <div className="rounded-2xl p-4 bg-white border border-gray-100 shadow-sm">
            <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mb-1">Published Dashboards</p>
            <Link to="/admin/dashboards">
              <p className="text-3xl font-bold text-[#14254A] hover:opacity-70 transition-opacity">{totalDashboards}</p>
            </Link>
            <p className="text-xs text-gray-400 mt-1">With embed links</p>
          </div>

          {/* Stat: Dashboard Modules */}
          <div className="rounded-2xl p-4 bg-white border border-gray-100 shadow-sm">
            <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mb-1">Dashboard Modules</p>
            <p className="text-3xl font-bold text-[#14254A]">{totalModules}</p>
            <p className="text-xs text-gray-400 mt-1">Active modules</p>
          </div>

          {/* Add New Client */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
            <Link to="/admin/clients/add"
              className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 no-underline"
              style={{ background: '#14254A' }}>
              + Add New Client
            </Link>
          </div>
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div className="flex-1 min-w-0 bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">

          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
            <h2 className="font-bold text-[#14254A] text-base">Client Management</h2>
            <input
              autoComplete="off"
              value={search} onChange={e => changeSearch(e.target.value)}
              placeholder="Search by name, email, ID…"
              className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-full sm:w-56 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>

          {/* Tabs */}
          <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-gray-100 bg-gray-50/50">
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
              Active Clients
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
              Inactive Clients
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                tab === 'inactive' ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
              }`}>
                {inactive.length}
              </span>
            </button>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr style={{ background: '#14254A' }}>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('userId')}>User ID<>{si('userId')}</></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('name')}>Name<>{si('name')}</></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('email')}>Email<>{si('email')}</></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('createdOn')}>Created On<>{si('createdOn')}</></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Link</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('deleted')}>Status<>{si('deleted')}</></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-10 text-gray-400 text-sm">No records found.</td></tr>
                ) : pageRows.map(c => (
                  <tr key={c.userId} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">#{c.userId}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ background: 'linear-gradient(135deg,#FFC82B,#FC934C)' }}>
                          {c.name.charAt(0)}
                        </div>
                        <span className="font-medium text-gray-800 text-sm">{c.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{c.email}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(c.createdOn)}</td>
                    <td className="px-4 py-3">
                      {c.link
                        ? <a href={c.link} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-gray-600 border border-gray-200 px-2 py-0.5 rounded hover:bg-gray-50 transition-colors">View</a>
                        : <span className="text-xs text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.deleted === 0 ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                        {c.deleted === 0 ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {c.deleted === 0 ? (
                          <>
                            <Link to={`/admin/clients/${c.userId}/edit`}
                              className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors no-underline">
                              Edit
                            </Link>
                            <Link to={`/admin/clients/${c.userId}/dashboard`}
                              className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-blue-200 text-blue-600 hover:bg-blue-50 transition-colors no-underline">
                              Dashboard
                            </Link>
                            <button onClick={() => toggleStatus(c.userId, false)} disabled={busy === c.userId}
                              className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50">
                              {busy === c.userId ? '…' : 'Deactivate'}
                            </button>
                          </>
                        ) : (
                          <button onClick={() => toggleStatus(c.userId, true)} disabled={busy === c.userId}
                            className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50">
                            {busy === c.userId ? '…' : 'Activate'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar page={page} total={filtered.length} onChange={setPage} />
        </div>
      </div>
    </div>
  )
}
