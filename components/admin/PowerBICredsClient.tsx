'use client'
import AdminPageHeader from './AdminPageHeader'

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import PaginationBar, { PER_PAGE } from './PaginationBar'
import AdminModal from './AdminModal'

interface Cred {
  id: number
  clientId: string
  clientSecret: string
  tenantId: string
  workspaceId: string
  is_active: number
}

interface Props {
  initialCreds: Cred[]
}

const BLANK_FORM = { clientId: '', clientSecret: '', tenantId: '', workspaceId: '' }

export default function PowerBICredsClient({ initialCreds }: Props) {
  const [creds, setCreds] = useState<Cred[]>(initialCreds)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const [revealedData, setRevealedData] = useState<Record<number, Cred>>({})
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
  const filtered = creds.filter(c =>
    !q || c.clientId.toLowerCase().includes(q) ||
    c.tenantId.toLowerCase().includes(q) ||
    c.workspaceId.toLowerCase().includes(q)
  )

  // Add/Edit modal
  const [modal, setModal] = useState<'add' | 'edit' | null>(null)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState(BLANK_FORM)
  const [saving, setSaving] = useState(false)

  // Delete modal
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  const pageRows = sortRows(filtered).slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function refresh() {
    try {
      const res = await fetch('/api/admin/powerbi-creds', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setCreds(data.creds)
    } catch { /* */ }
  }

  // Load fresh data on mount (page passes empty initialCreds before its own fetch resolves)
  useEffect(() => { refresh() }, [])

  async function toggleReveal(id: number) {
    if (revealed.has(id)) {
      setRevealed(prev => { const n = new Set(prev); n.delete(id); return n })
      return
    }
    if (!revealedData[id]) {
      try {
        const res = await fetch(`/api/admin/powerbi-creds/reveal?id=${id}`, { credentials: 'include' })
        const data = await res.json()
        if (data.success) {
          setRevealedData(prev => ({ ...prev, [id]: data as Cred }))
        } else {
          showToast(data.error || 'Failed to reveal', 'error'); return
        }
      } catch {
        showToast('Network error', 'error'); return
      }
    }
    setRevealed(prev => { const n = new Set(prev); n.add(id); return n })
  }

  function openAdd() {
    setEditId(null)
    setForm(BLANK_FORM)
    setModal('add')
  }

  function openEdit(c: Cred) {
    setEditId(c.id)
    setForm({ clientId: c.clientId, clientSecret: '', tenantId: c.tenantId, workspaceId: c.workspaceId })
    setModal('edit')
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.clientId || !form.tenantId || !form.workspaceId) return
    if (modal === 'add' && !form.clientSecret) return
    setSaving(true)
    try {
      const res = await fetch('/api/admin/powerbi-creds', {
        method: modal === 'add' ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(modal === 'add' ? form : { id: editId, ...form }),
      })
      const data = await res.json()
      if (data.success) {
        showToast(modal === 'add' ? 'Credentials added' : 'Credentials updated')
        setModal(null)
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
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await fetch('/api/admin/powerbi-creds', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: deleteId }),
      })
      const data = await res.json()
      if (data.success) {
        showToast('Credentials deleted')
        setDeleteId(null)
        await refresh()
      } else {
        showToast(data.error || 'Delete failed', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setDeleting(false)
  }

  function mask(val: string) {
    if (!val) return '—'
    if (val.length <= 8) return '••••••••'
    return val.slice(0, 4) + '••••••••' + val.slice(-4)
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
        breadcrumb={[{ label: 'PowerBI API Credentials' }]}
        backHref="/admin/configuration"
        title="PowerBI API Credentials"
        description="Azure AD app credentials for PowerBI embedded reports"
        actions={
          <button onClick={openAdd}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
            style={{ background: '#14254A' }}>
            + Add Credentials
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
            placeholder="Search by Client ID, Tenant ID…"
            className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-56 focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">#</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('clientId')}>Client ID<>{si('clientId')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Client Secret</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('tenantId')}>Tenant ID<>{si('tenantId')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('workspaceId')}>Workspace ID<>{si('workspaceId')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none" onClick={() => handleSort('is_active')}>Status<>{si('is_active')}</></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-10 text-gray-400 text-sm">No credentials found.</td></tr>
              ) : pageRows.map((c, idx) => {
                const show = revealed.has(c.id)
                const real = revealedData[c.id]
                const rowNum = (page - 1) * PER_PAGE + idx + 1
                return (
                  <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">{rowNum}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">
                      {show && real ? real.clientId || '—' : mask(c.clientId)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                      {show && real ? real.clientSecret || '—' : '••••••••••••••••'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">
                      {show && real ? real.tenantId || '—' : mask(c.tenantId)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">
                      {show && real ? real.workspaceId || '—' : mask(c.workspaceId)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.is_active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                        {c.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => toggleReveal(c.id)}
                          title={show ? 'Hide' : 'Show'}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors">
                          {show ? 'Hide' : 'Show'}
                        </button>
                        <button onClick={() => openEdit(c)}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                          Edit
                        </button>
                        <button onClick={() => setDeleteId(c.id)}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-300 text-red-600 hover:bg-red-50 transition-colors">
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <PaginationBar page={page} total={filtered.length} onChange={p => { setPage(p); setRevealed(new Set()) }} />
      </div>

      {/* Add / Edit Modal */}
      {modal && (
        <AdminModal onClose={() => !saving && setModal(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[calc(100vh-48px)]">

            <div className="flex items-center justify-between px-5 py-4 text-white flex-shrink-0"
              style={{ background: '#14254A' }}>
              <div>
                <h3 className="font-bold text-sm">{modal === 'add' ? 'Add' : 'Edit'} PowerBI Credentials</h3>
                <p className="text-white/60 text-xs mt-0.5">AES-256-CBC encrypted storage</p>
              </div>
              <button onClick={() => !saving && setModal(null)}
                className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>

            <form onSubmit={handleSave} className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Client ID *</label>
                  <input autoComplete="off" value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
                    required placeholder="Azure AD Application (client) ID"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    Client Secret {modal === 'edit' ? '(leave blank to keep existing)' : '*'}
                  </label>
                  <input autoComplete="off" value={form.clientSecret} onChange={e => setForm(f => ({ ...f, clientSecret: e.target.value }))}
                    required={modal === 'add'} placeholder="Azure AD Client Secret"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Tenant ID *</label>
                  <input autoComplete="off" value={form.tenantId} onChange={e => setForm(f => ({ ...f, tenantId: e.target.value }))}
                    required placeholder="Azure AD Directory (tenant) ID"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Workspace ID *</label>
                  <input autoComplete="off" value={form.workspaceId} onChange={e => setForm(f => ({ ...f, workspaceId: e.target.value }))}
                    required placeholder="PowerBI Workspace (group) ID"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-100 flex-shrink-0">
                <button type="button" onClick={() => !saving && setModal(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-all"
                  style={{ background: '#14254A' }}>
                  {saving ? 'Saving…' : 'Save Credentials'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* Delete Confirm Modal */}
      {deleteId && (
        <AdminModal onClose={() => !deleting && setDeleteId(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-bold text-sm text-gray-800">Delete Credentials</h3>
              <button onClick={() => setDeleteId(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600 mb-4">This will permanently delete these PowerBI credentials. This action cannot be undone.</p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setDeleteId(null)} disabled={deleting}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleDelete} disabled={deleting}
                  className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-300 text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
