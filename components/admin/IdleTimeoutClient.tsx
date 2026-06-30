'use client'
import AdminPageHeader from './AdminPageHeader'

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import PaginationBar, { PER_PAGE } from './PaginationBar'
import AdminModal from './AdminModal'

interface UserRow {
  userId: number
  name: string
  email: string
  settingId: number | null
  idle_minutes: number
  is_active: number
}

interface Props {
  initialRows: UserRow[]
}

export default function IdleTimeoutClient({ initialRows }: Props) {
  const [rows, setRows] = useState<UserRow[]>(initialRows)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  function handleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  function si(col: string): JSX.Element {
    if (sortCol !== col) return <span className="ml-1 opacity-40 text-[10px]">↕</span>
    return <span className="ml-1 text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }
  function sortRows(arr: UserRow[]): UserRow[] {
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

  // Edit modal
  const [editRow, setEditRow] = useState<UserRow | null>(null)
  const [minutes, setMinutes] = useState('30')
  const [isActive, setIsActive] = useState(true)
  const [saving, setSaving] = useState(false)

  // Delete confirm
  const [deleteRow, setDeleteRow] = useState<UserRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const q = search.toLowerCase()
  const filtered = rows.filter(r =>
    !q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)
  )
  const pageRows = sortRows(filtered).slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  function openEdit(row: UserRow) {
    setEditRow(row)
    setMinutes(String(row.idle_minutes))
    setIsActive(row.is_active === 1)
  }

  async function refresh() {
    try {
      const res = await fetch('/api/admin/idle-timeout', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setRows(data.settings)
    } catch { /* */ }
  }

  // Load fresh data on mount (page passes empty initialRows before its own fetch resolves)
  useEffect(() => { refresh() }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!editRow) return
    const mins = Number(minutes)
    if (!mins || mins < 1 || mins > 480) {
      showToast('Enter a value between 1 and 480 minutes', 'error')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/admin/idle-timeout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: editRow.userId, idleMinutes: mins, isActive: isActive ? 1 : 0 }),
      })
      const data = await res.json()
      if (data.success) {
        showToast('Idle timeout saved')
        setEditRow(null)
        await refresh()
      } else {
        showToast(data.error || 'Save failed', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setSaving(false)
  }

  async function handleDelete() {
    if (!deleteRow?.settingId) return
    setDeleting(true)
    try {
      const res = await fetch('/api/admin/idle-timeout', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ settingId: deleteRow.settingId }),
      })
      const data = await res.json()
      if (data.success) {
        showToast('Reset to default (30 min)')
        setDeleteRow(null)
        await refresh()
      } else {
        showToast(data.error || 'Delete failed', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setDeleting(false)
  }

  function fmtTimeout(m: number) {
    if (m < 60) return `${m} min`
    const h = Math.floor(m / 60)
    const rem = m % 60
    return rem === 0 ? `${h} hr` : `${h} hr ${rem} min`
  }

  return (
    <div className="p-6 fade-in">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Breadcrumb */}
      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration', href: '/admin/configuration' }, { label: 'Session Timeout' }]}
        backHref="/admin/configuration"
        title="Client Session Timeout"
        description="Set idle timeout per client. Auto-logout is enabled per user. Default is 30 minutes."
        actions={
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-700 text-xs font-medium">
            ⏱️ Default: 30 min
          </div>
        }
      />

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-[#14254A]">{filtered.length} user{filtered.length !== 1 ? 's' : ''}</span>
          <input
            autoComplete="off"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search by name or email…"
            className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-60 focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">#</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('name')}>Name<>{si('name')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('email')}>Email<>{si('email')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('idle_minutes')}>Idle Timeout<>{si('idle_minutes')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('is_active')}>Auto-Logout<>{si('is_active')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-10 text-gray-400 text-sm">No users found.</td></tr>
              ) : pageRows.map((r, idx) => (
                <tr key={r.userId} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-3 text-xs text-gray-400 font-mono">{(page - 1) * PER_PAGE + idx + 1}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                        style={{ background: 'linear-gradient(135deg,#6366F1,#4F46E5)' }}>
                        {(r.name || '?').charAt(0).toUpperCase()}
                      </div>
                      <span className="font-medium text-gray-800">{r.name || '—'}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{r.email || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border ${!r.settingId ? 'bg-gray-50 border-gray-200 text-gray-500' : 'bg-indigo-50 border-indigo-200 text-indigo-700'}`}>
                      ⏱️ {fmtTimeout(r.idle_minutes)}
                      {!r.settingId && <span className="text-gray-400 font-normal">(default)</span>}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {r.settingId ? (
                      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${r.is_active ? 'text-emerald-600' : 'text-gray-400'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${r.is_active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                        {r.is_active ? 'Enabled' : 'Disabled'}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => openEdit(r)}
                        className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                        {r.settingId ? 'Edit' : 'Configure'}
                      </button>
                      {r.settingId && (
                        <button onClick={() => setDeleteRow(r)}
                          className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-red-600 hover:bg-red-50 transition-colors">
                          Reset
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

      {/* Edit / Configure Modal */}
      {editRow && (
        <AdminModal onClose={() => !saving && setEditRow(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 text-white" style={{ background: '#14254A' }}>
              <div>
                <h3 className="font-bold text-sm">{editRow.settingId ? 'Edit' : 'Configure'} Idle Timeout</h3>
                <p className="text-white/60 text-xs mt-0.5">{editRow.name}</p>
              </div>
              <button onClick={() => !saving && setEditRow(null)} className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>
            <form onSubmit={handleSave} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                  Idle Timeout (minutes) <span className="text-red-500">*</span>
                </label>
                <input
                  autoComplete="off"
                  type="number"
                  min={1}
                  max={480}
                  value={minutes}
                  onChange={e => setMinutes(e.target.value)}
                  required
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                <p className="text-xs text-gray-400 mt-1">1–480 minutes. User will be auto-logged out after this idle period.</p>
              </div>

              {/* Quick picks */}
              <div className="grid grid-cols-4 gap-2">
                {[15, 30, 60, 120].map(v => (
                  <button key={v} type="button" onClick={() => setMinutes(String(v))}
                    className={`py-1.5 rounded-lg text-xs font-medium border transition-colors ${Number(minutes) === v ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                    {v < 60 ? `${v}m` : `${v / 60}h`}
                  </button>
                ))}
              </div>

              {/* Enable/disable toggle */}
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <div
                  onClick={() => setIsActive(v => !v)}
                  className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${isActive ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${isActive ? 'translate-x-5' : ''}`} />
                </div>
                <span className="text-sm font-medium text-gray-700">Enable auto-logout</span>
              </label>

              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => !saving && setEditRow(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: '#14254A' }}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* Reset (delete) confirm */}
      {deleteRow && (
        <AdminModal onClose={() => !deleting && setDeleteRow(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-bold text-sm text-gray-800">Reset to Default</h3>
              <button onClick={() => setDeleteRow(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600">
                Reset idle timeout for <strong>{deleteRow.name}</strong> back to the default 30 minutes?
              </p>
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setDeleteRow(null)} disabled={deleting}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleDelete} disabled={deleting}
                  className="px-4 py-2 rounded-xl border border-gray-300 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {deleting ? 'Resetting…' : 'Reset'}
                </button>
              </div>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
