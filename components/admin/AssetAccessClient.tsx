'use client'
import AdminPageHeader from './AdminPageHeader'

import { useState, useMemo, useEffect } from 'react'
import { Link } from 'react-router-dom'
import PaginationBar, { PER_PAGE } from './PaginationBar'
import AdminModal from './AdminModal'

interface UserAssetRow {
  userId: number
  loginId: number
  clientName: string
  apiUserName: string
  name: string
  username: string
  is_active: number
  total_assets: number
  assigned_count: number
  assigned_preview: { id: string; name: string }[]
}

interface Asset { id: string; name: string }

export default function AssetAccessClient({ initialUsers }: { initialUsers: UserAssetRow[] }) {
  const [users, setUsers] = useState<UserAssetRow[]>(initialUsers)
  const [page, setPage] = useState(1)
  const [tableSearch, setTableSearch] = useState('')
  const [sortCol, setSortCol] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [busyRow, setBusyRow] = useState<number | null>(null)  // loginId

  function handleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  function si(col: string): JSX.Element {
    if (sortCol !== col) return <span className="ml-1 opacity-40 text-[10px]">↕</span>
    return <span className="ml-1 text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }
  function sortRows(arr: UserAssetRow[]): UserAssetRow[] {
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

  const tq = tableSearch.toLowerCase()
  const filteredUsers = users.filter(u =>
    !tq || (u.clientName || '').toLowerCase().includes(tq) ||
    u.username.toLowerCase().includes(tq) ||
    (u.apiUserName || '').toLowerCase().includes(tq)
  )

  // Assign modal
  const [modal, setModal] = useState<{ user: UserAssetRow; assets: Asset[]; assignedIds: Set<string> } | null>(null)
  const [loadingModal, setLoadingModal] = useState(false)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)

  // Delete confirm
  const [deleteRow, setDeleteRow] = useState<UserAssetRow | null>(null)

  const pageRows = sortRows(filteredUsers).slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  useEffect(() => { refreshUsers() }, [])

  async function refreshUsers() {
    const res = await fetch('/api/admin/asset-access', { credentials: 'include' })
    const data = await res.json()
    if (data.success) setUsers(data.items)
  }

  // ── Fetch assets from API ──
  async function fetchAssets(user: UserAssetRow) {
    if (!confirm(`Fetch assets from API for "${user.clientName || user.name}"?`)) return
    setBusyRow(user.loginId)
    const res = await fetch('/api/admin/asset-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action: 'login_client', clientUserId: user.userId }),
    })
    const data = await res.json()
    if (data.success) {
      showToast(`Fetched ${data.assets_count} assets for ${user.clientName || user.name}`)
      await refreshUsers()
    } else {
      showToast(data.message || 'Fetch failed', 'error')
    }
    setBusyRow(null)
  }

  // ── Open assign modal ──
  async function openAssign(user: UserAssetRow) {
    setLoadingModal(true)
    setModal({ user, assets: [], assignedIds: new Set() })
    setSearch('')
    const res = await fetch('/api/admin/asset-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_assets', clientUserId: user.userId, loginId: user.loginId }),
      credentials: 'include',
    })
    const data = await res.json()
    setLoadingModal(false)
    if (!data.success) { showToast(data.message || 'Failed to load assets', 'error'); setModal(null); return }
    setModal({ user, assets: data.data.assets, assignedIds: new Set(data.data.assignedIds ?? []) })
  }

  // ── Save assigned assets ──
  async function saveAssign() {
    if (!modal) return
    setSaving(true)
    const selected = modal.assets.filter(a => modal.assignedIds.has(a.id))
    const res = await fetch('/api/admin/asset-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        action: 'assign_assets',
        clientUserId: modal.user.userId,
        loginId: modal.user.loginId,
        assets: selected,
      }),
    })
    const data = await res.json()
    if (data.success) {
      showToast(`Saved ${data.count} assigned assets`)
      setModal(null)
      await refreshUsers()
    } else {
      showToast(data.message || 'Save failed', 'error')
    }
    setSaving(false)
  }

  // ── Delete access ──
  async function confirmDelete() {
    if (!deleteRow) return
    setBusyRow(deleteRow.loginId)
    const res = await fetch('/api/admin/asset-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action: 'delete_access', loginId: deleteRow.loginId }),
    })
    const data = await res.json()
    if (data.success) {
      showToast(`Access removed for ${deleteRow.clientName || deleteRow.name}`)
      setDeleteRow(null)
      await refreshUsers()
    } else {
      showToast(data.message || 'Delete failed', 'error')
    }
    setBusyRow(null)
  }

  function toggleAsset(id: string) {
    if (!modal) return
    setModal(m => {
      if (!m) return m
      const next = new Set(m.assignedIds)
      if (next.has(id)) next.delete(id); else next.add(id)
      return { ...m, assignedIds: next }
    })
  }

  const filteredAssets = useMemo(() => {
    if (!modal) return []
    const q = search.toLowerCase()
    return q ? modal.assets.filter(a => a.name.toLowerCase().includes(q) || a.id.includes(q)) : modal.assets
  }, [modal, search])

  const allFiltered = filteredAssets.every(a => modal?.assignedIds.has(a.id))
  function toggleAllFiltered() {
    if (!modal) return
    setModal(m => {
      if (!m) return m
      const next = new Set(m.assignedIds)
      if (allFiltered) filteredAssets.forEach(a => next.delete(a.id))
      else filteredAssets.forEach(a => next.add(a.id))
      return { ...m, assignedIds: next }
    })
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
        breadcrumb={[{ label: 'User Asset Manager' }]}
        backHref="/admin/configuration"
        title="User Asset Manager"
        description="Fetch and assign IP House assets per client login"
      />

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-[#14254A]">{filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}</span>
          <input
            autoComplete="off"
            value={tableSearch}
            onChange={e => { setTableSearch(e.target.value); setPage(1) }}
            placeholder="Search by client, email, API username…"
            className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-60 focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">#</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('clientName')}>Client Name<>{si('clientName')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('username')}>User Email<>{si('username')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('apiUserName')}>API Username<>{si('apiUserName')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('total_assets')}>Total<>{si('total_assets')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('assigned_count')}>Assigned<>{si('assigned_count')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Assigned List</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-10 text-gray-400 text-sm">No users found.</td></tr>
              ) : pageRows.map((u, i) => (
                <tr key={u.loginId} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-3 text-xs text-gray-400">{(page - 1) * PER_PAGE + i + 1}</td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-gray-800">{u.clientName || '—'}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{u.username}</td>
                  <td className="px-4 py-3">
                    {u.apiUserName
                      ? <code className="text-xs bg-gray-50 border border-gray-200 px-2 py-1 rounded-lg text-emerald-700">{u.apiUserName}</code>
                      : <span className="text-xs text-gray-400">No API key</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium text-gray-700">{u.total_assets}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium text-gray-700">{u.assigned_count}</span>
                  </td>
                  <td className="px-4 py-3 max-w-[180px]">
                    {u.assigned_preview.length > 0 ? (
                      <div className="space-y-0.5">
                        {u.assigned_preview.map(a => (
                          <div key={a.id} className="text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded px-2 py-0.5 truncate">
                            ✓ {a.name || a.id}
                          </div>
                        ))}
                        {u.assigned_count > 3 && (
                          <div className="text-xs text-gray-400">+{u.assigned_count - 3} more</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">None assigned</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button onClick={() => fetchAssets(u)} disabled={busyRow === u.loginId}
                        className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50">
                        {busyRow === u.loginId ? '…' : 'Fetch'}
                      </button>
                      {u.total_assets > 0 && (
                        <button onClick={() => openAssign(u)} disabled={busyRow === u.loginId}
                          className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50">
                          Assign
                        </button>
                      )}
                      {u.assigned_count > 0 && (
                        <button onClick={() => setDeleteRow(u)} disabled={busyRow === u.loginId}
                          className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50">
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <PaginationBar page={page} total={filteredUsers.length} onChange={setPage} />
      </div>

      {/* ── Assign Modal ── */}
      {modal && (
        <AdminModal onClose={() => !saving && setModal(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[calc(100vh-48px)]">

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 text-white flex-shrink-0" style={{ background: '#14254A' }}>
              <div>
                <h3 className="font-bold text-sm">{modal.user.clientName || modal.user.name} — Assign Assets</h3>
                <p className="text-white/60 text-xs mt-0.5">{modal.assets.length} assets available</p>
              </div>
              <button onClick={() => !saving && setModal(null)} className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>

            {loadingModal ? (
              <div className="flex-1 flex items-center justify-center py-16 text-gray-400 text-sm">
                Loading assets…
              </div>
            ) : (
              <>
                {/* Search + controls */}
                <div className="px-5 py-3 border-b border-gray-100 flex-shrink-0 space-y-2">
                  <input autoComplete="off" value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search assets…"
                    className="w-full border border-gray-200 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300" />
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{modal.assignedIds.size} of {modal.assets.length} selected</span>
                    <div className="flex gap-3">
                      <button type="button" onClick={toggleAllFiltered}
                        className="text-blue-600 hover:underline font-medium">
                        {allFiltered && filteredAssets.length > 0 ? 'Deselect All' : 'Select All'}
                        {search ? ' (filtered)' : ''}
                      </button>
                    </div>
                  </div>
                  {/* Progress bar */}
                  <div className="w-full bg-gray-100 rounded-full h-1.5">
                    <div className="bg-blue-500 h-1.5 rounded-full transition-all"
                      style={{ width: modal.assets.length ? `${(modal.assignedIds.size / modal.assets.length) * 100}%` : '0%' }} />
                  </div>
                </div>

                {/* Asset list */}
                <div className="flex-1 overflow-y-auto px-5 py-3">
                  {filteredAssets.length === 0 ? (
                    <div className="text-center py-8 text-gray-400 text-sm">No matching assets.</div>
                  ) : (
                    <div className="space-y-1">
                      {filteredAssets.map(a => {
                        const checked = modal.assignedIds.has(a.id)
                        return (
                          <label key={a.id}
                            className={`flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer transition-colors ${checked ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50 border border-gray-100 hover:bg-gray-100'}`}>
                            <div className="flex items-center gap-3">
                              <input type="checkbox" checked={checked} onChange={() => toggleAsset(a.id)}
                                className="w-4 h-4 rounded accent-blue-600" />
                              <span className={`text-sm font-medium ${checked ? 'text-blue-700' : 'text-gray-700'}`}>{a.name}</span>
                            </div>
                            <span className="text-xs text-gray-400 font-mono">ID: {a.id}</span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100 flex-shrink-0">
                  <span className="text-xs text-gray-400">{modal.assignedIds.size} asset{modal.assignedIds.size !== 1 ? 's' : ''} selected</span>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => !saving && setModal(null)}
                      className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                      Cancel
                    </button>
                    <button onClick={saveAssign} disabled={saving || modal.assignedIds.size === 0}
                      className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50" style={{ background: '#14254A' }}>
                      {saving ? 'Saving…' : 'Save Assigned Assets'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </AdminModal>
      )}

      {/* ── Delete Confirm Modal ── */}
      {deleteRow && (
        <AdminModal onClose={() => setDeleteRow(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-bold text-sm text-gray-800">Remove Asset Access</h3>
              <button onClick={() => setDeleteRow(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600">
                Are you sure you want to remove all assigned assets for <strong className="text-gray-800">{deleteRow.clientName || deleteRow.name}</strong>?
              </p>
              <p className="text-xs text-gray-400 mt-1">This will permanently remove all assigned assets for this user.</p>
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setDeleteRow(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={confirmDelete} disabled={busyRow === deleteRow.loginId}
                  className="px-5 py-2 rounded-xl text-sm font-medium border border-gray-300 text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {busyRow === deleteRow.loginId ? '…' : 'Remove Access'}
                </button>
              </div>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
