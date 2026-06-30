'use client'
import AdminPageHeader from './AdminPageHeader'

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import PaginationBar, { PER_PAGE } from './PaginationBar'
import AdminModal from './AdminModal'

interface ModuleRow {
  Id: number
  ModuleName: string
  pageName: string
  status: number
  created: string
  updated: string
}

function fmtDate(s?: string) {
  if (!s) return '—'
  try { return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) } catch { return s }
}

export default function ModulePermissionsClient({ initialModules }: { initialModules: ModuleRow[] }) {
  const [modules, setModules] = useState<ModuleRow[]>(initialModules)
  const [showDeleted, setShowDeleted] = useState(false)
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ moduleName: '', pageName: '' })

  const [editRow, setEditRow] = useState<ModuleRow | null>(null)
  const [editForm, setEditForm] = useState({ moduleName: '', pageName: '' })

  const [confirm, setConfirm] = useState<{ row: ModuleRow; action: 'delete' | 'restore' } | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const displayed = modules.filter(m => showDeleted ? true : m.status === 0)
  const pageRows = displayed.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function toggleShowDeleted() { setShowDeleted(v => !v); setPage(1) }

  useEffect(() => { reload(false) }, [])

  async function reload(includeDeleted: boolean) {
    const res = await fetch(`/api/admin/module-permissions?showDeleted=${includeDeleted ? 1 : 0}`, { credentials: 'include' })
    const data = await res.json()
    if (data.success) setModules(data.modules)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    const res = await fetch('/api/admin/module-permissions', {
        credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addForm),
    })
    const data = await res.json()
    if (data.success) {
      showToast('Module added successfully')
      setAddOpen(false)
      setAddForm({ moduleName: '', pageName: '' })
      await reload(showDeleted)
    } else {
      showToast(data.error || 'Failed to add module', 'error')
    }
    setBusy(false)
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editRow) return
    setBusy(true)
    const res = await fetch('/api/admin/module-permissions', {
        credentials: 'include',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editRow.Id, ...editForm }),
    })
    const data = await res.json()
    if (data.success) {
      showToast('Module updated successfully')
      setEditRow(null)
      await reload(showDeleted)
    } else {
      showToast(data.error || 'Failed to update module', 'error')
    }
    setBusy(false)
  }

  async function handleConfirm() {
    if (!confirm) return
    setBusy(true)
    let res: Response
    if (confirm.action === 'delete') {
      res = await fetch('/api/admin/module-permissions', {
        credentials: 'include',
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: confirm.row.Id }),
      })
    } else {
      res = await fetch('/api/admin/module-permissions', {
        credentials: 'include',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: confirm.row.Id, restore: true }),
      })
    }
    const data = await res.json()
    if (data.success) {
      showToast(confirm.action === 'delete' ? 'Module deleted' : 'Module restored')
      setConfirm(null)
      await reload(showDeleted)
    } else {
      showToast(data.error || 'Action failed', 'error')
    }
    setBusy(false)
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
        breadcrumb={[{ label: 'Modules Access' }]}
        backHref="/admin/configuration"
        title="Modules Access"
        description="Manage application modules and page permissions"
        actions={
          <>
            <button onClick={toggleShowDeleted}
              className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all ${showDeleted ? 'bg-gray-100 border-gray-300 text-gray-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {showDeleted ? 'Hide Deleted' : 'Show Deleted'}
            </button>
            <button onClick={() => { setAddForm({ moduleName: '', pageName: '' }); setAddOpen(true) }}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-white hover:opacity-90 transition-all"
              style={{ background: '#14254A' }}>
              + Add Module
            </button>
          </>
        }
      />

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                {['ID', 'Module Name', 'Page Name', 'Status', 'Created', 'Updated', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-10 text-gray-400 text-sm">No modules found.</td></tr>
              ) : pageRows.map(m => (
                <tr key={m.Id} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">{m.Id}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{m.ModuleName}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{m.pageName || '—'}</td>
                  <td className="px-4 py-3">
                    {m.status === 0
                      ? <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />Active</span>
                      : <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500"><span className="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0" />Deleted</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(m.created)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(m.updated)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {m.status === 0 ? (
                        <>
                          <button onClick={() => { setEditRow(m); setEditForm({ moduleName: m.ModuleName, pageName: m.pageName || '' }) }}
                            className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                            Edit
                          </button>
                          <button onClick={() => setConfirm({ row: m, action: 'delete' })}
                            className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-red-600 hover:bg-red-50 transition-colors">
                            Delete
                          </button>
                        </>
                      ) : (
                        <button onClick={() => setConfirm({ row: m, action: 'restore' })}
                          className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                          Restore
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <PaginationBar page={page} total={displayed.length} onChange={setPage} />
      </div>

      {/* Add Modal */}
      {addOpen && (
        <AdminModal onClose={() => setAddOpen(false)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 text-white" style={{ background: '#14254A' }}>
              <h3 className="font-bold text-sm">Add Module</h3>
              <button onClick={() => setAddOpen(false)} className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>
            <form onSubmit={handleAdd} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Module Name <span className="text-red-500">*</span></label>
                <input autoComplete="off" value={addForm.moduleName} onChange={e => setAddForm(f => ({ ...f, moduleName: e.target.value }))} required
                  maxLength={255} placeholder="Enter module name"
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Page Name</label>
                <input autoComplete="off" value={addForm.pageName} onChange={e => setAddForm(f => ({ ...f, pageName: e.target.value }))}
                  maxLength={255} placeholder="Enter page name"
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setAddOpen(false)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={busy}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: '#14254A' }}>
                  {busy ? 'Adding…' : 'Add Module'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* Edit Modal */}
      {editRow && (
        <AdminModal onClose={() => setEditRow(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 text-white" style={{ background: '#14254A' }}>
              <h3 className="font-bold text-sm">Edit Module — {editRow.ModuleName}</h3>
              <button onClick={() => setEditRow(null)} className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>
            <form onSubmit={handleEdit} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Module Name <span className="text-red-500">*</span></label>
                <input autoComplete="off" value={editForm.moduleName} onChange={e => setEditForm(f => ({ ...f, moduleName: e.target.value }))} required
                  maxLength={255}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Page Name</label>
                <input autoComplete="off" value={editForm.pageName} onChange={e => setEditForm(f => ({ ...f, pageName: e.target.value }))}
                  maxLength={255}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setEditRow(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={busy}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: '#14254A' }}>
                  {busy ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* Delete / Restore Confirm Modal */}
      {confirm && (
        <AdminModal onClose={() => setConfirm(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-bold text-sm text-gray-800">
                {confirm.action === 'delete' ? 'Delete Module' : 'Restore Module'}
              </h3>
              <button onClick={() => setConfirm(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-700">
                Are you sure you want to {confirm.action} <strong>{confirm.row.ModuleName}</strong>?
              </p>
              {confirm.action === 'delete' && (
                <p className="text-xs text-gray-400 mt-1">This is a soft delete and can be restored later from "Show Deleted".</p>
              )}
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setConfirm(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleConfirm} disabled={busy}
                  className={`px-5 py-2 rounded-xl text-sm font-medium border disabled:opacity-50 transition-colors ${confirm.action === 'delete' ? 'border-gray-300 text-red-600 hover:bg-red-50' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                  {busy ? '…' : confirm.action === 'delete' ? 'Delete' : 'Restore'}
                </button>
              </div>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
