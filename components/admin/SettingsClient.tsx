'use client'
import AdminPageHeader from './AdminPageHeader'

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import PaginationBar, { PER_PAGE } from './PaginationBar'
import AdminModal from './AdminModal'
interface EmailCred {
  id: number
  emailId: string
  emailPassword: string
  smtpHost: string
  smtpPort: number
  smtpSecure: string
  purpose: string
  is_active: number
}

interface Props {
  initialCreds: EmailCred[]
}

const BLANK = {
  emailId: '', emailPassword: '', smtpHost: '',
  smtpPort: '587', smtpSecure: 'tls', purpose: '',
}

export default function SettingsClient({ initialCreds }: Props) {
  const [creds,   setCreds]   = useState<EmailCred[]>(initialCreds)
  const [page,    setPage]    = useState(1)
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const [revealedPw, setRevealedPw] = useState<Record<number, string>>({})
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  // Add / Edit modal
  const [modal,   setModal]   = useState<'add' | 'edit' | null>(null)
  const [editId,  setEditId]  = useState<number | null>(null)
  const [form,    setForm]    = useState(BLANK)
  const [saving,  setSaving]  = useState(false)

  // Delete confirm
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  const pageRows = creds.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function refresh() {
    try {
      const res = await fetch('/api/admin/email-credentials', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setCreds(data.credentials)
    } catch { /* */ }
  }

  // Load fresh data on mount (page passes empty initialCreds before its own fetch resolves)
  useEffect(() => { refresh() }, [])

  // The list endpoint returns a masked password; fetch the real value on demand.
  async function toggleReveal(id: number) {
    if (revealed.has(id)) {
      setRevealed(prev => { const n = new Set(prev); n.delete(id); return n })
      return
    }
    if (revealedPw[id] === undefined) {
      try {
        const res = await fetch(`/api/admin/email-credentials/reveal?id=${id}`, { credentials: 'include' })
        const data = await res.json()
        if (data.success) {
          setRevealedPw(prev => ({ ...prev, [id]: data.emailPassword || '' }))
        } else {
          showToast(data.error || 'Failed to reveal', 'error'); return
        }
      } catch {
        showToast('Failed to reveal', 'error'); return
      }
    }
    setRevealed(prev => { const n = new Set(prev); n.add(id); return n })
  }

  function openAdd() {
    setEditId(null)
    setForm(BLANK)
    setModal('add')
  }

  function openEdit(c: EmailCred) {
    setEditId(c.id)
    setForm({
      emailId:       c.emailId,
      emailPassword: '',
      smtpHost:      c.smtpHost,
      smtpPort:      String(c.smtpPort),
      smtpSecure:    c.smtpSecure,
      purpose:       c.purpose,
    })
    setModal('edit')
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (modal === 'add' && !form.emailPassword) return
    setSaving(true)
    try {
      const res = await fetch('/api/admin/email-credentials', {
        method: modal === 'add' ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modal === 'add'
          ? { ...form, smtpPort: Number(form.smtpPort) }
          : { id: editId, ...form, smtpPort: Number(form.smtpPort) }),
      })
      const data = await res.json()
      if (data.success) {
        showToast(modal === 'add' ? 'Email credentials added' : 'Email credentials updated')
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
      const res = await fetch('/api/admin/email-credentials', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
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

  return (
    <div className="p-6 fade-in">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <AdminPageHeader
        breadcrumb={[{ label: 'Settings' }]}
        backHref="/admin/configuration"
        title="Master Email Credentials"
        description="Email IDs and passwords stored with AES-256-CBC encryption"
        actions={
          <button onClick={openAdd}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white hover:opacity-90 transition-all"
            style={{ background: '#14254A' }}>
            + Add Email Credentials
          </button>
        }
      />

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                {['#', 'Email ID', 'Password', 'SMTP Host', 'Port', 'Secure', 'Purpose', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-10 text-gray-400 text-sm">No email credentials found.</td></tr>
              ) : pageRows.map((c, idx) => {
                const show = revealed.has(c.id)
                const rowNum = (page - 1) * PER_PAGE + idx + 1
                return (
                  <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">{rowNum}</td>

                    {/* Email ID with eye toggle */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-gray-700">
                          {show ? (c.emailId || '—') : '************'}
                        </span>
                        <button onClick={() => toggleReveal(c.id)}
                          className="text-gray-400 hover:text-gray-700 transition-colors text-sm flex-shrink-0"
                          title={show ? 'Hide' : 'Show'}>
                          {show ? '🙈' : '👁'}
                        </button>
                      </div>
                    </td>

                    {/* Password with eye toggle */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-gray-500">
                          {show ? (revealedPw[c.id] || '—') : '************'}
                        </span>
                        <button onClick={() => toggleReveal(c.id)}
                          className="text-gray-400 hover:text-gray-700 transition-colors text-sm flex-shrink-0"
                          title={show ? 'Hide' : 'Show'}>
                          {show ? '🙈' : '👁'}
                        </button>
                      </div>
                    </td>

                    <td className="px-4 py-3 text-xs text-gray-700">{c.smtpHost || '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-700">{c.smtpPort}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-medium px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-700 uppercase">
                        {c.smtpSecure}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{c.purpose || '—'}</td>

                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
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
        <PaginationBar page={page} total={creds.length} onChange={p => { setPage(p); setRevealed(new Set()) }} />
      </div>

      {/* Add / Edit Modal */}
      {modal && (
        <AdminModal onClose={() => !saving && setModal(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[calc(100vh-48px)]">

            <div className="flex items-center justify-between px-5 py-4 text-white flex-shrink-0"
              style={{ background: '#14254A' }}>
              <div>
                <h3 className="font-bold text-sm">{modal === 'add' ? 'Add' : 'Edit'} Email Credentials</h3>
                <p className="text-white/60 text-xs mt-0.5">AES-256-CBC encrypted storage</p>
              </div>
              <button onClick={() => !saving && setModal(null)}
                className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>

            <form onSubmit={handleSave} className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Email ID *</label>
                  <input autoComplete="off" type="email" value={form.emailId}
                    onChange={e => setForm(f => ({ ...f, emailId: e.target.value }))}
                    required placeholder="noreply@example.com"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    Password {modal === 'edit' ? '(leave blank to keep existing)' : '*'}
                  </label>
                  <input autoComplete="off" type="text" value={form.emailPassword}
                    onChange={e => setForm(f => ({ ...f, emailPassword: e.target.value }))}
                    required={modal === 'add'} placeholder={modal === 'edit' ? 'Leave blank to keep existing' : 'Email password'}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">SMTP Host *</label>
                  <input autoComplete="off" type="text" value={form.smtpHost}
                    onChange={e => setForm(f => ({ ...f, smtpHost: e.target.value }))}
                    required placeholder="smtp.example.com"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">SMTP Port *</label>
                    <input autoComplete="off" type="number" value={form.smtpPort}
                      onChange={e => setForm(f => ({ ...f, smtpPort: e.target.value }))}
                      required placeholder="587"
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Secure</label>
                    <select value={form.smtpSecure}
                      onChange={e => setForm(f => ({ ...f, smtpSecure: e.target.value }))}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#14254A]/20">
                      <option value="tls">TLS</option>
                      <option value="ssl">SSL</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Purpose</label>
                  <input autoComplete="off" type="text" value={form.purpose}
                    onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))}
                    placeholder="e.g. Registration emails, Alerts"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                </div>

              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-100 flex-shrink-0">
                <button type="button" onClick={() => !saving && setModal(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: '#14254A' }}>
                  {saving ? 'Saving…' : 'Save Credentials'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* Delete Confirm */}
      {deleteId && (
        <AdminModal onClose={() => !deleting && setDeleteId(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-bold text-sm text-gray-800">Delete Email Credentials</h3>
              <button onClick={() => setDeleteId(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600 mb-4">This will permanently delete these email credentials. This cannot be undone.</p>
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
