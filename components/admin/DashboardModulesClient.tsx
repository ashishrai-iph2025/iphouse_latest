'use client'

import { useState, useEffect, useMemo } from 'react'
import AdminPageHeader from './AdminPageHeader'
import AdminModal from './AdminModal'
import PaginationBar, { PER_PAGE } from './PaginationBar'
import SearchableSelect from '@/components/ui/SearchableSelect'
import {
  DASHBOARD_CATEGORIES, NO_CATEGORY, categoryLabel, chipFor,
} from '@/lib/dashboardCategories'

export interface DashModule {
  moduleId:   number
  moduleName: string
  moduleIcon: string | null
  /** VOD, Sports, War Room — or '' for a module nobody has filed yet.
   *  Added by migration 006. What /admin/registrations narrows by when it
   *  grants a login a subset of this catalogue, so it is not decoration here:
   *  an uncategorised module can only be granted on its own. */
  category:   string
  deleted:    number
}

const API = '/api/admin/dashboard-modules'

/* The filter's stand-in for "no category at all".
   It cannot be '' — SearchableSelect spends the empty string on its clear row,
   which is "no filter", and the two are opposite questions: one asks for every
   module, the other for the modules nobody has filed. */
const UNFILED = '__unfiled__'

export default function DashboardModulesClient({ initialModules }: { initialModules: DashModule[] }) {
  const [modules, setModules]   = useState<DashModule[]>(initialModules)
  const [page, setPage]         = useState(1)
  const [search, setSearch]     = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)
  const [busy, setBusy]         = useState(false)
  const [toast, setToast]       = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  // Add / Edit modal
  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId]       = useState<number | null>(null)
  const [form, setForm]           = useState({ moduleName: '', moduleIcon: '', category: NO_CATEGORY as string })

  // Delete confirm
  const [deleteMod, setDeleteMod] = useState<DashModule | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function refresh() {
    try {
      const res = await fetch(`${API}?showDeleted=1`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) setModules(data.modules ?? [])
    } catch { /* */ }
  }

  // Fetch fresh data on mount — the page passes initialModules before its own
  // fetch resolves, and useState only reads that prop once, so refresh here.
  useEffect(() => { refresh() }, [])

  const q = search.toLowerCase()
  const filtered = modules.filter(m => {
    if (!showDeleted && Number(m.deleted) !== 0) return false
    if (catFilter) {
      const cat = (m.category ?? '').trim()
      if (catFilter === UNFILED ? cat !== '' : cat !== catFilter) return false
    }
    /* The category is searchable too. Typing "sports" is the fastest way to
       reach that group, and a reader who has just met the column will try it
       before finding the dropdown beside it. */
    return !q
      || m.moduleName.toLowerCase().includes(q)
      || (m.moduleIcon ?? '').toLowerCase().includes(q)
      || (m.category ?? '').toLowerCase().includes(q)
  })
  const pageRows = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  /* Counts beside each category, from the same rows the table is drawn from
     (minus the category filter itself, or every option but the chosen one
     would read 0). A category with nothing in it is worth seeing: it is
     usually a module that was never filed rather than a category nobody
     wants. */
  const catCounts = useMemo(() => {
    const base = modules.filter(m => showDeleted || Number(m.deleted) === 0)
    const counts: Record<string, number> = { [UNFILED]: 0 }
    for (const c of DASHBOARD_CATEGORIES) counts[c] = 0
    for (const m of base) {
      const key = (m.category ?? '').trim() || UNFILED
      if (key in counts) counts[key] += 1
    }
    return counts
  }, [modules, showDeleted])

  function openAdd() {
    setEditId(null)
    setForm({ moduleName: '', moduleIcon: '', category: NO_CATEGORY })
    setModalOpen(true)
  }

  function openEdit(m: DashModule) {
    setEditId(m.moduleId)
    setForm({
      moduleName: m.moduleName,
      moduleIcon: m.moduleIcon ?? '',
      category:   (m.category ?? '').trim(),
    })
    setModalOpen(true)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.moduleName.trim()) return
    setBusy(true)
    try {
      const res = await fetch(API, {
        method:      editId ? 'PUT' : 'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify(editId
          ? { moduleId: editId, moduleName: form.moduleName.trim(), moduleIcon: form.moduleIcon.trim(), category: form.category }
          : { moduleName: form.moduleName.trim(), moduleIcon: form.moduleIcon.trim(), category: form.category }),
      })
      const data = await res.json()
      if (data.success) {
        showToast(editId ? 'Module updated' : 'Module created')
        setModalOpen(false)
        await refresh()
      } else {
        showToast(data.error || 'Save failed', 'error')
      }
    } catch { showToast('Network error', 'error') }
    setBusy(false)
  }

  async function handleDelete() {
    if (!deleteMod) return
    setBusy(true)
    try {
      const res = await fetch(API, {
        method:      'DELETE',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ moduleId: deleteMod.moduleId }),
      })
      const data = await res.json()
      if (data.success) {
        showToast('Module deactivated')
        setDeleteMod(null)
        await refresh()
      } else {
        showToast(data.error || 'Delete failed', 'error')
      }
    } catch { showToast('Network error', 'error') }
    setBusy(false)
  }

  async function handleRestore(m: DashModule) {
    setBusy(true)
    try {
      const res = await fetch(API, {
        method:      'PUT',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ moduleId: m.moduleId, restore: true }),
      })
      const data = await res.json()
      if (data.success) { showToast('Module activated'); await refresh() }
      else showToast(data.error || 'Restore failed', 'error')
    } catch { showToast('Network error', 'error') }
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
        breadcrumb={[{ label: 'Configuration', href: '/admin/configuration' }, { label: 'PowerBI Dashboard Modules' }]}
        backHref="/admin/configuration"
        title="PowerBI Dashboard Modules"
        description="Manage dashboard modules (Open Web, Social Media, Telegram, etc.)"
        actions={
          <button onClick={openAdd}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white hover:opacity-90 transition-all"
            style={{ background: '#14254A' }}>
            + Add Module
          </button>
        }
      />

      {/* Table card */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-100 flex-wrap">
          <span className="text-sm font-semibold text-[#14254A]">{filtered.length} module{filtered.length !== 1 ? 's' : ''}</span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
              <input type="checkbox" checked={showDeleted} onChange={e => { setShowDeleted(e.target.checked); setPage(1) }} />
              Show inactive
            </label>
            {/* The house dropdown rather than a native <select>, whose option
                list the operating system draws in its own colours. Compact, to
                sit level with the search box beside it. */}
            <div className="w-44">
              <SearchableSelect compact
                options={[
                  ...DASHBOARD_CATEGORIES.map(c => ({ key: c, label: c, count: catCounts[c] })),
                  { key: UNFILED, label: 'Uncategorised', count: catCounts[UNFILED] },
                ]}
                value={catFilter}
                onChange={v => { setCatFilter(v); setPage(1) }}
                placeholder="All categories" emptyLabel="– All categories –" />
            </div>
            <input
              autoComplete="off"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              placeholder="Search modules…"
              className="h-8 border border-gray-200 rounded-[0.625rem] px-3 text-xs w-56 transition-colors focus:outline-none focus:border-[#FC934C] focus:ring-2 focus:ring-[#FC934C]/20"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">ID</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Module Name</th>
                {/* Next to the name, not out past the icon: the pair is one
                    fact — WHICH report this module is — and the category is the
                    half that tells two similarly named rows apart. */}
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Category</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Icon</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-10 text-gray-400 text-sm">No modules found.</td></tr>
              ) : pageRows.map(m => (
                <tr key={m.moduleId} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-3 text-xs text-gray-400 font-mono">{m.moduleId}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                        style={{ background: 'linear-gradient(135deg,#FFC82B,#FC934C)' }}>
                        {m.moduleName.charAt(0).toUpperCase()}
                      </div>
                      <span className="font-medium text-gray-800 text-sm">{m.moduleName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {/* Uncategorised is SAID, not left blank. A blank cell in a
                        new column reads as a rendering fault; "Uncategorised"
                        reads as the real, fixable state it is — and it matters,
                        because an uncategorised module can only ever be granted
                        on its own name. */}
                    <span className={`inline-flex items-center text-[11px] font-semibold px-2 py-1 rounded-lg whitespace-nowrap ${chipFor(m.category)}`}>
                      {categoryLabel(m.category)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {m.moduleIcon
                      ? <code className="text-xs bg-gray-50 border border-gray-200 px-2 py-1 rounded-lg text-gray-700">{m.moduleIcon}</code>
                      : <span className="text-xs text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {Number(m.deleted) === 0
                      ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-lg">● Active</span>
                      : <span className="inline-flex items-center gap-1 text-xs font-semibold text-gray-500 bg-gray-100 px-2 py-1 rounded-lg">● Not Active</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {Number(m.deleted) === 0 ? (
                        <>
                          <button onClick={() => openEdit(m)}
                            className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                            Edit
                          </button>
                          <button onClick={() => setDeleteMod(m)}
                            className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-gray-300 text-red-600 hover:bg-red-50 transition-colors">
                            Deactivate
                          </button>
                        </>
                      ) : (
                        <button onClick={() => handleRestore(m)} disabled={busy}
                          className="text-xs px-2.5 py-1.5 rounded-lg font-medium border border-emerald-300 text-emerald-700 hover:bg-emerald-50 transition-colors disabled:opacity-50">
                          Activate
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

      {/* Add / Edit Modal */}
      {modalOpen && (
        <AdminModal onClose={() => setModalOpen(false)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden max-h-[calc(100vh-48px)] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 text-white" style={{ background: '#14254A' }}>
              <h3 className="font-bold text-sm">{editId ? 'Edit Module' : 'Add Module'}</h3>
              <button onClick={() => setModalOpen(false)} className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>
            <form onSubmit={handleSave} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Module Name <span className="text-red-500">*</span></label>
                <input autoComplete="off" value={form.moduleName} onChange={e => setForm(f => ({ ...f, moduleName: e.target.value }))} required
                  placeholder="e.g. Telegram"
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Category</label>
                <SearchableSelect
                  options={DASHBOARD_CATEGORIES.map(c => ({ key: c, label: c }))}
                  value={form.category}
                  onChange={v => setForm(f => ({ ...f, category: v }))}
                  placeholder="Uncategorised" emptyLabel="— Uncategorised —" />
                <p className="text-xs text-gray-400 mt-1">
                  Files this module under a report group. /admin/registrations grants report
                  access a category at a time, so an uncategorised module can only be granted
                  on its own.
                </p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Module Icon</label>
                <input autoComplete="off" value={form.moduleIcon} onChange={e => setForm(f => ({ ...f, moduleIcon: e.target.value }))}
                  placeholder="e.g. telegram.png"
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
                <p className="text-xs text-gray-400 mt-1">Icon filename stored against the module (optional).</p>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={busy}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: '#14254A' }}>
                  {busy ? 'Saving…' : editId ? 'Update Module' : 'Add Module'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* Delete Confirm Modal */}
      {deleteMod && (
        <AdminModal onClose={() => setDeleteMod(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-bold text-sm text-gray-800">Deactivate Module</h3>
              <button onClick={() => setDeleteMod(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600">
                Are you sure you want to deactivate <strong className="text-gray-800">{deleteMod.moduleName}</strong>? It will be marked as not active and can be reactivated later.
              </p>
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setDeleteMod(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleDelete} disabled={busy}
                  className="px-5 py-2 rounded-xl text-sm font-medium border border-gray-300 text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {busy ? '…' : 'Deactivate'}
                </button>
              </div>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
