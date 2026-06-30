'use client'
import AdminPageHeader from './AdminPageHeader'

import { useState } from 'react'
import { Link } from 'react-router-dom'
import PaginationBar, { PER_PAGE } from './PaginationBar'
import AdminModal from './AdminModal'

interface UserRow {
  userId: number
  loginId: number
  clientName: string
  name: string
  username: string
  is_active: number
}

interface ModuleRow {
  Id: number
  ModuleName: string
  status: number
}

interface Props {
  users: UserRow[]
  modules: ModuleRow[]
}

export default function UserModulePermissionsClient({ users, modules }: Props) {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)
  const [sortCol, setSortCol] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  // Modal state
  const [modalUser, setModalUser] = useState<UserRow | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [loadingPerms, setLoadingPerms] = useState(false)
  const [saving, setSaving] = useState(false)

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

  const q = search.toLowerCase()
  const filtered = users.filter(u =>
    !q || (u.name ?? '').toLowerCase().includes(q) ||
    (u.clientName ?? '').toLowerCase().includes(q) ||
    (u.username ?? '').toLowerCase().includes(q)
  )
  const pageRows = sortRows(filtered).slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const visibleModules = modules.filter(m => showDeleted ? true : m.status === 0)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function openModal(user: UserRow) {
    setModalUser(user)
    setChecked(new Set())
    setLoadingPerms(true)
    try {
      const res = await fetch(`/api/admin/user-module-permissions?loginId=${user.loginId}`)
      const data = await res.json()
      if (data.success) setChecked(new Set(data.allowed as number[]))
    } catch {
      showToast('Failed to load permissions', 'error')
    }
    setLoadingPerms(false)
  }

  function toggleModule(id: number) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function savePermissions(e: React.FormEvent) {
    e.preventDefault()
    if (!modalUser) return
    setSaving(true)
    const res = await fetch('/api/admin/user-module-permissions', {
        credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: modalUser.loginId, modules: Array.from(checked) }),
    })
    const data = await res.json()
    if (data.success) {
      showToast('Permissions updated successfully')
      setModalUser(null)
    } else {
      showToast(data.error || 'Failed to save permissions', 'error')
    }
    setSaving(false)
  }

  const allVisible = visibleModules.every(m => checked.has(m.Id))

  function toggleAll() {
    if (allVisible) {
      setChecked(prev => {
        const next = new Set(prev)
        visibleModules.forEach(m => next.delete(m.Id))
        return next
      })
    } else {
      setChecked(prev => {
        const next = new Set(prev)
        visibleModules.forEach(m => next.add(m.Id))
        return next
      })
    }
  }

  return (
    <div className="p-6 fade-in">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <AdminPageHeader
        breadcrumb={[{ label: 'User Module Permissions' }]}
        backHref="/admin/configuration"
        title="User Module Permissions"
        description="Grant or revoke module access per login account"
        actions={
          <button onClick={() => setShowDeleted(v => !v)}
            className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-all">
            {showDeleted ? 'Hide Deleted Modules' : 'Show Deleted Modules'}
          </button>
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
            placeholder="Search by name, client, username…"
            className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-60 focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('userId')}>User ID<>{si('userId')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('name')}>Name<>{si('name')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('clientName')}>Client<>{si('clientName')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('username')}>Username<>{si('username')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('is_active')}>Status<>{si('is_active')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-10 text-gray-400 text-sm">No users found.</td></tr>
              ) : pageRows.map(u => (
                <tr key={u.loginId} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">{u.userId}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                        style={{ background: 'linear-gradient(135deg,#0078D4,#004E8C)' }}>
                        {(u.name.trim() || u.username).charAt(0).toUpperCase()}
                      </div>
                      <span className="font-medium text-gray-800">{u.name.trim() || '—'}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{u.clientName || '—'}</td>
                  <td className="px-4 py-3 text-xs font-mono text-gray-500">{u.username}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${u.is_active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => openModal(u)}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                      Manage Permissions
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <PaginationBar page={page} total={filtered.length} onChange={setPage} />
      </div>

      {/* Permissions Modal */}
      {modalUser && (
        <AdminModal onClose={() => !saving && setModalUser(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[calc(100vh-48px)]">

            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 text-white flex-shrink-0"
              style={{ background: '#14254A' }}>
              <div>
                <h3 className="font-bold text-sm">Manage Permissions</h3>
                <p className="text-white/60 text-xs mt-0.5">{modalUser.name.trim() || modalUser.username}</p>
              </div>
              <button onClick={() => !saving && setModalUser(null)}
                className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>

            {/* Module list */}
            <form onSubmit={savePermissions} className="flex flex-col flex-1 min-h-0">
              <div className="px-5 py-3 border-b border-gray-100 flex-shrink-0">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500">Check modules to grant access. Unchecked = no access.</p>
                  {visibleModules.length > 0 && (
                    <button type="button" onClick={toggleAll}
                      className="text-xs text-blue-600 hover:underline font-medium">
                      {allVisible ? 'Deselect All' : 'Select All'}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-3">
                {loadingPerms ? (
                  <div className="text-center py-8 text-gray-400 text-sm">Loading permissions…</div>
                ) : visibleModules.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 text-sm">No modules available.</div>
                ) : (
                  <div className="space-y-1">
                    {visibleModules.map(m => (
                      <label key={m.Id}
                        className={`flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer transition-colors ${checked.has(m.Id) ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50 border border-gray-100 hover:bg-gray-100'}`}>
                        <div className="flex items-center gap-3">
                          <input type="checkbox" checked={checked.has(m.Id)}
                            onChange={() => toggleModule(m.Id)}
                            className="w-4 h-4 rounded accent-blue-600" />
                          <span className={`text-sm font-medium ${checked.has(m.Id) ? 'text-blue-700' : 'text-gray-700'}`}>
                            {m.ModuleName}
                          </span>
                        </div>
                        {m.status === 1 && (
                          <span className="text-xs text-red-400">Deleted</span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100 flex-shrink-0">
                <span className="text-xs text-gray-400">{checked.size} module{checked.size !== 1 ? 's' : ''} selected</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => !saving && setModalUser(null)}
                    className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                    Cancel
                  </button>
                  <button type="submit" disabled={saving || loadingPerms}
                    className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-all"
                    style={{ background: '#14254A' }}>
                    {saving ? 'Saving…' : 'Save Permissions'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
