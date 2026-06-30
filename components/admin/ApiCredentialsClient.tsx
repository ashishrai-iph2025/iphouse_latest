'use client'
import AdminPageHeader from './AdminPageHeader'

import { useState } from 'react'
import { useRouter } from '@/lib/router'
import { Link } from 'react-router-dom'
import AdminModal from './AdminModal'
import PaginationBar, { PER_PAGE } from './PaginationBar'

interface Cred {
  userId: number
  name: string
  email: string
  api_user_name: string | null
  api_password: string | null
}

export default function ApiCredentialsClient({ credentials }: { credentials: Cred[] }) {
  const router = useRouter()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [revealId, setRevealId] = useState<number | null>(null)
  const [revealedPw, setRevealedPw] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  function handleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  function si(col: string): JSX.Element {
    if (sortCol !== col) return <span className="ml-1 opacity-40 text-[10px]">↕</span>
    return <span className="ml-1 text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }
  function sortRows(arr: Cred[]): Cred[] {
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
  const filtered = credentials.filter(c =>
    !q || c.name.toLowerCase().includes(q) ||
    c.email.toLowerCase().includes(q) ||
    (c.api_user_name ?? '').toLowerCase().includes(q)
  )

  // Add modal
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ userId: '', apiUserName: '', apiPassword: '' })

  // Edit modal
  const [editCred, setEditCred] = useState<Cred | null>(null)
  const [editForm, setEditForm] = useState({ apiUserName: '', apiPassword: '' })

  // Delete confirm
  const [deleteCred, setDeleteCred] = useState<Cred | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  // The list endpoint only returns a masked password; fetch the real value
  // on demand when the admin clicks the reveal (eye) button.
  async function toggleReveal(userId: number) {
    if (revealId === userId) { setRevealId(null); return }
    if (revealedPw[userId] === undefined) {
      try {
        const res = await fetch(`/api/admin/api-credentials/reveal?userId=${userId}`, { credentials: 'include' })
        const data = await res.json()
        if (data.success) {
          setRevealedPw(prev => ({ ...prev, [userId]: data.api_password || '' }))
        } else {
          showToast(data.error || 'Failed to reveal', 'error'); return
        }
      } catch {
        showToast('Failed to reveal', 'error'); return
      }
    }
    setRevealId(userId)
  }

  const pageRows = sortRows(filtered).slice((page - 1) * PER_PAGE, page * PER_PAGE)

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!addForm.userId) return
    setBusy(true)
    const res = await fetch('/api/admin/api-credentials', {
        credentials: 'include',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: Number(addForm.userId), apiUserName: addForm.apiUserName, apiPassword: addForm.apiPassword }),
    })
    const data = await res.json()
    if (data.success) {
      showToast('API credentials added successfully')
      setAddOpen(false)
      setAddForm({ userId: '', apiUserName: '', apiPassword: '' })
      router.refresh()
    } else {
      showToast(data.error || 'Failed', 'error')
    }
    setBusy(false)
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editCred) return
    setBusy(true)
    const res = await fetch('/api/admin/api-credentials', {
        credentials: 'include',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: editCred.userId, apiUserName: editForm.apiUserName, apiPassword: editForm.apiPassword }),
    })
    const data = await res.json()
    if (data.success) {
      showToast('API credentials updated successfully')
      setEditCred(null)
      router.refresh()
    } else {
      showToast(data.error || 'Failed', 'error')
    }
    setBusy(false)
  }

  async function handleDelete() {
    if (!deleteCred) return
    setBusy(true)
    const res = await fetch('/api/admin/api-credentials', {
        credentials: 'include',
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: deleteCred.userId }),
    })
    const data = await res.json()
    if (data.success) {
      showToast('API credentials removed successfully')
      setDeleteCred(null)
      router.refresh()
    } else {
      showToast(data.error || 'Failed', 'error')
    }
    setBusy(false)
  }

  return (
    <div className="fade-in">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <AdminPageHeader
        breadcrumb={[{ label: 'API Credentials' }]}
        backHref="/admin/configuration"
        title="Manage API Credentials"
        description="Manage IP House API username/password per client"
        actions={
          <button onClick={() => { setAddForm({ userId: '', apiUserName: '', apiPassword: '' }); setAddOpen(true) }}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white hover:opacity-90 transition-all"
            style={{ background: '#14254A' }}>
            + Add API Credentials
          </button>
        }
      />

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-[#14254A]">{filtered.length} record{filtered.length !== 1 ? 's' : ''}</span>
          <input
            autoComplete="off"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search by name, email, API username…"
            className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-60 focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">#</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('name')}>User<>{si('name')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('email')}>Email<>{si('email')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('api_user_name')}>API Username<>{si('api_user_name')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">API Password</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-10 text-gray-400 text-sm">No users found.</td></tr>
              ) : pageRows.map((c, i) => (
                <tr key={c.userId} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-3 text-xs text-gray-400">{(page - 1) * PER_PAGE + i + 1}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                        style={{ background: 'linear-gradient(135deg,#FFC82B,#FC934C)' }}>
                        {c.name.charAt(0)}
                      </div>
                      <span className="font-medium text-gray-800 text-sm">{c.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{c.email}</td>
                  <td className="px-4 py-3">
                    {c.api_user_name
                      ? <code className="text-xs bg-gray-50 border border-gray-200 px-2 py-1 rounded-lg text-gray-700">{c.api_user_name}</code>
                      : <span className="text-xs text-gray-400">Not set</span>}
                  </td>
                  <td className="px-4 py-3">
                    {c.api_password ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-gray-600">
                          {revealId === c.userId ? (revealedPw[c.userId] || '—') : '••••••••'}
                        </span>
                        <button onClick={() => toggleReveal(c.userId)}
                          className="text-gray-400 hover:text-gray-700 transition-colors text-sm"
                          title={revealId === c.userId ? 'Hide' : 'Show'}>
                          {revealId === c.userId ? '🙈' : '👁'}
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">Not set</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => { setEditCred(c); setEditForm({ apiUserName: c.api_user_name || '', apiPassword: '' }) }}
                        className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                        Edit
                      </button>
                      {(c.api_user_name || c.api_password) && (
                        <button onClick={() => setDeleteCred(c)}
                          className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-red-600 hover:bg-red-50 transition-colors">
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
        <PaginationBar page={page} total={filtered.length} onChange={setPage} />
      </div>

      {/* Add Modal */}
      {addOpen && (
        <AdminModal onClose={() => setAddOpen(false)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden max-h-[calc(100vh-48px)] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 text-white" style={{ background: '#14254A' }}>
              <h3 className="font-bold text-sm">Add API Credentials</h3>
              <button onClick={() => setAddOpen(false)} className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>
            <form onSubmit={handleAdd} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Select User <span className="text-red-500">*</span></label>
                <select value={addForm.userId} onChange={e => setAddForm(f => ({ ...f, userId: e.target.value }))} required
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white">
                  <option value="">— Choose a user —</option>
                  {credentials.map(c => (
                    <option key={c.userId} value={c.userId}>{c.name} ({c.email})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">API Username <span className="text-red-500">*</span></label>
                <input autoComplete="off" value={addForm.apiUserName} onChange={e => setAddForm(f => ({ ...f, apiUserName: e.target.value }))} required
                  placeholder="Enter API username"
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">API Password <span className="text-red-500">*</span></label>
                <input autoComplete="off" value={addForm.apiPassword} onChange={e => setAddForm(f => ({ ...f, apiPassword: e.target.value }))} required
                  placeholder="Enter API password"
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                <p className="text-xs text-gray-400 mt-1">Encrypted at rest. Never shown in lists — reveal on demand only.</p>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setAddOpen(false)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={busy}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: '#14254A' }}>
                  {busy ? 'Saving…' : 'Add Credentials'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* Edit Modal */}
      {editCred && (
        <AdminModal onClose={() => setEditCred(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden max-h-[calc(100vh-48px)] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 text-white" style={{ background: '#14254A' }}>
              <h3 className="font-bold text-sm">Edit API Credentials — {editCred.name}</h3>
              <button onClick={() => setEditCred(null)} className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>
            <form onSubmit={handleEdit} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">API Username <span className="text-red-500">*</span></label>
                <input autoComplete="off" value={editForm.apiUserName} onChange={e => setEditForm(f => ({ ...f, apiUserName: e.target.value }))} required
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">API Password</label>
                <input autoComplete="off" value={editForm.apiPassword} onChange={e => setEditForm(f => ({ ...f, apiPassword: e.target.value }))}
                  placeholder="Leave blank to keep current password"
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                <p className="text-xs text-gray-400 mt-1">Only enter a value to change the stored password.</p>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setEditCred(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={busy}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: '#14254A' }}>
                  {busy ? 'Saving…' : 'Update Credentials'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* Delete Confirm Modal */}
      {deleteCred && (
        <AdminModal onClose={() => setDeleteCred(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-bold text-sm text-gray-800">Remove API Credentials</h3>
              <button onClick={() => setDeleteCred(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600">
                Are you sure you want to remove API credentials for <strong className="text-gray-800">{deleteCred.name}</strong>?
              </p>
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setDeleteCred(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleDelete} disabled={busy}
                  className="px-5 py-2 rounded-xl text-sm font-medium border border-gray-300 text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {busy ? '…' : 'Remove'}
                </button>
              </div>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
