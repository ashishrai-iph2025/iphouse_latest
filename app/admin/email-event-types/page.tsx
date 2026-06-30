'use client'
import { useState, useEffect } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import AdminModal from '@/components/admin/AdminModal'

const NAVY    = '#0D244B'
const ORANGE  = '#FC934C'
const NAVY_25 = '#C6CDD7'
const NAVY_10 = '#E9ECEF'
const NAVY_5  = '#F4F5F7'
const NAVY_50 = '#7C899C'

interface EventType {
  id: number
  key: string
  label: string
  description: string
  has_notify_email: number
  variables: string
  sort_order: number
  is_active: number
  created_at: string
  updated_at: string
}

const BLANK: Omit<EventType, 'id' | 'created_at' | 'updated_at'> = {
  key: '', label: '', description: '', has_notify_email: 0,
  variables: '', sort_order: 0, is_active: 1,
}

export default function EmailEventTypesPage() {
  const [rows,         setRows]         = useState<EventType[]>([])
  const [loading,      setLoading]      = useState(true)
  const [modal,        setModal]        = useState<'add' | 'edit' | 'delete' | null>(null)
  const [form,         setForm]         = useState({ ...BLANK })
  const [editId,       setEditId]       = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<EventType | null>(null)
  const [saving,       setSaving]       = useState(false)
  const [saveMsg,      setSaveMsg]      = useState('')
  const [search,       setSearch]       = useState('')

  async function load() {
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/email-event-types', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setRows(data.eventTypes || [])
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  function openAdd() {
    setForm({ ...BLANK }); setEditId(null); setSaveMsg(''); setModal('add')
  }
  function openEdit(r: EventType) {
    setForm({ key: r.key, label: r.label, description: r.description,
      has_notify_email: r.has_notify_email, variables: r.variables,
      sort_order: r.sort_order, is_active: r.is_active })
    setEditId(r.id); setSaveMsg(''); setModal('edit')
  }
  function openDelete(r: EventType) {
    setDeleteTarget(r); setModal('delete')
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setSaveMsg('')
    try {
      const method = modal === 'edit' ? 'PUT' : 'POST'
      const body   = modal === 'edit' ? { id: editId, ...form } : form
      const res    = await fetch('/api/admin/email-event-types', {
        method, headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) { setModal(null); load() }
      else setSaveMsg(data.error || 'Failed to save')
    } finally { setSaving(false) }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setSaving(true)
    try {
      const res  = await fetch('/api/admin/email-event-types', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ id: deleteTarget.id }),
      })
      const data = await res.json()
      if (data.success) { setModal(null); load() }
      else setSaveMsg(data.error || 'Failed to delete')
    } finally { setSaving(false) }
  }

  // Parse comma-separated variables for display
  function parseVars(v: string) {
    return v ? v.split(',').map(s => s.trim()).filter(Boolean) : []
  }

  function addVar() {
    const v = prompt('Enter variable name (without braces), e.g. user_name')
    if (!v) return
    const tag = `{{${v.trim()}}}`
    setForm(f => ({ ...f, variables: f.variables ? f.variables + ',' + tag : tag }))
  }

  function removeVar(tag: string) {
    setForm(f => ({
      ...f,
      variables: f.variables.split(',').map(s => s.trim()).filter(s => s !== tag).join(','),
    }))
  }

  const filtered = rows.filter(r =>
    !search ||
    r.key.toLowerCase().includes(search.toLowerCase()) ||
    r.label.toLowerCase().includes(search.toLowerCase()) ||
    r.description.toLowerCase().includes(search.toLowerCase())
  )

  const inputStyle: React.CSSProperties = {
    width: '100%', border: `1px solid ${NAVY_25}`, borderRadius: 10,
    padding: '8px 12px', fontSize: 13, outline: 'none', boxSizing: 'border-box',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 11, fontWeight: 600, color: NAVY_50,
    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4,
  }

  return (
    <div className="p-6 fade-in">
      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration', href: '/admin/configuration' }, { label: 'Email Event Types' }]}
        backHref="/admin/configuration"
        title="Email Event Types"
        description="Define and manage event types available for email template configuration"
        actions={
          <button onClick={openAdd}
            className="px-4 py-2 text-sm font-semibold text-white rounded-xl hover:opacity-90 transition-opacity"
            style={{ background: NAVY }}>
            + Add Event Type
          </button>
        }
      />

      {/* Info banner */}
      <div className="rounded-xl p-4 mb-6 text-sm" style={{ background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af' }}>
        <strong>What are Event Types?</strong> Each event type defines a trigger (e.g. "Registration Approved") and the placeholder variables available for that email template. The Email Templates page reads these dynamically — add a new event type here and it immediately appears in the template editor dropdown.
      </div>

      {/* Search + table */}
      <div className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${NAVY_25}` }}>
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: `1px solid ${NAVY_10}` }}>
          <span className="text-sm font-semibold" style={{ color: NAVY }}>{filtered.length} event type{filtered.length !== 1 ? 's' : ''}</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by key, label or description…"
            className="text-xs rounded-xl px-3 py-1.5 focus:outline-none"
            style={{ border: `1px solid ${NAVY_25}`, width: 280 }} />
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="spinner" /></div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm" style={{ color: NAVY_50 }}>No event types found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: NAVY }}>
                  {['Sort', 'Event Key', 'Label', 'Description', 'Variables', 'Notify Email', 'Status', 'Actions'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap"
                      style={{ color: 'rgba(255,255,255,0.75)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, idx) => (
                  <tr key={r.id} style={{ background: idx % 2 === 0 ? '#fff' : NAVY_5, borderBottom: `1px solid ${NAVY_10}` }}>
                    <td className="px-4 py-3 text-xs font-mono" style={{ color: NAVY_50 }}>{r.sort_order}</td>
                    <td className="px-4 py-3">
                      <code className="text-xs px-2 py-0.5 rounded-lg" style={{ background: NAVY_10, color: NAVY }}>{r.key}</code>
                    </td>
                    <td className="px-4 py-3 text-sm font-medium" style={{ color: NAVY }}>{r.label}</td>
                    <td className="px-4 py-3 text-xs max-w-[200px] truncate" style={{ color: NAVY_50 }} title={r.description}>{r.description || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {parseVars(r.variables).slice(0, 3).map(v => (
                          <code key={v} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>{v}</code>
                        ))}
                        {parseVars(r.variables).length > 3 && (
                          <span className="text-[10px]" style={{ color: NAVY_50 }}>+{parseVars(r.variables).length - 3} more</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-lg ${r.has_notify_email ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-gray-50 text-gray-400 border border-gray-200'}`}>
                        {r.has_notify_email ? 'Yes' : 'No'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: NAVY_50 }}>
                        <span className={`w-1.5 h-1.5 rounded-full ${r.is_active ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                        {r.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEdit(r)}
                          className="px-2.5 py-1 text-xs rounded-lg border hover:opacity-80 transition-opacity"
                          style={{ borderColor: NAVY_25, color: NAVY }}>Edit</button>
                        <button onClick={() => openDelete(r)}
                          className="px-2.5 py-1 text-xs rounded-lg border hover:bg-red-50 transition-colors"
                          style={{ borderColor: NAVY_25, color: '#dc2626' }}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add / Edit Modal ─────────────────────────────────────────── */}
      {(modal === 'add' || modal === 'edit') && (
        <AdminModal onClose={() => setModal(null)}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 620,
            maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', boxShadow: '0 25px 50px rgba(0,0,0,0.25)' }}>

            <div style={{ background: NAVY, borderRadius: '16px 16px 0 0', padding: '16px 24px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#fff', fontWeight: 600, fontSize: 14 }}>
                {modal === 'add' ? 'Add Email Event Type' : 'Edit Email Event Type'}
              </span>
              <button onClick={() => setModal(null)}
                style={{ color: 'rgba(255,255,255,0.6)', fontSize: 22, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
            </div>

            <form onSubmit={handleSave} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {saveMsg && (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 10, padding: '8px 14px', fontSize: 13 }}>{saveMsg}</div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Event Key *</label>
                  <input autoComplete="off" required value={form.key}
                    onChange={e => setForm(f => ({ ...f, key: e.target.value.toLowerCase().replace(/\s+/g, '_') }))}
                    placeholder="e.g. registration_approved"
                    style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  <p style={{ fontSize: 10, color: NAVY_50, marginTop: 3 }}>Lowercase, underscores only. Must be unique.</p>
                </div>
                <div>
                  <label style={labelStyle}>Label *</label>
                  <input autoComplete="off" required value={form.label}
                    onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                    placeholder="e.g. Registration Approved"
                    style={inputStyle} />
                </div>
              </div>

              <div>
                <label style={labelStyle}>Description</label>
                <input autoComplete="off" value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Brief description of when this email is sent"
                  style={inputStyle} />
              </div>

              {/* Variables builder */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>Template Variables</label>
                  <button type="button" onClick={addVar}
                    style={{ fontSize: 11, fontWeight: 600, color: '#1d4ed8', background: '#eff6ff', border: '1px solid #bfdbfe',
                      borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>
                    + Add Variable
                  </button>
                </div>
                <div style={{ minHeight: 44, background: NAVY_5, border: `1px solid ${NAVY_25}`, borderRadius: 10,
                  padding: '8px 12px', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {parseVars(form.variables).length === 0 && (
                    <span style={{ fontSize: 12, color: NAVY_50 }}>No variables yet — click "+ Add Variable"</span>
                  )}
                  {parseVars(form.variables).map(v => (
                    <span key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#fff',
                      border: '1px solid #bfdbfe', borderRadius: 6, padding: '2px 8px', fontSize: 11, color: '#1d4ed8', fontFamily: 'monospace' }}>
                      {v}
                      <button type="button" onClick={() => removeVar(v)}
                        style={{ color: '#93c5fd', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1, fontSize: 13, padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Sort Order</label>
                  <input type="number" value={form.sort_order}
                    onChange={e => setForm(f => ({ ...f, sort_order: parseInt(e.target.value) || 0 }))}
                    style={inputStyle} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 20 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: NAVY }}>
                    <input type="checkbox" checked={form.is_active === 1}
                      onChange={e => setForm(f => ({ ...f, is_active: e.target.checked ? 1 : 0 }))} />
                    Active
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: NAVY }}>
                    <input type="checkbox" checked={form.has_notify_email === 1}
                      onChange={e => setForm(f => ({ ...f, has_notify_email: e.target.checked ? 1 : 0 }))} />
                    Has Recipient Email
                  </label>
                </div>
              </div>

              {form.has_notify_email === 1 && (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#92400e' }}>
                  When a template is created for this event type, the template form will show a <strong>Recipient Email</strong> field so admins can configure where the notification is sent.
                </div>
              )}

              <div style={{ borderTop: `1px solid ${NAVY_10}`, paddingTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" onClick={() => setModal(null)}
                  style={{ padding: '9px 20px', borderRadius: 10, border: `1px solid ${NAVY_25}`, fontSize: 13, fontWeight: 500, color: '#374151', background: '#fff', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button type="submit" disabled={saving}
                  style={{ padding: '9px 24px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600,
                    color: '#fff', background: NAVY, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                  {saving ? 'Saving…' : modal === 'add' ? 'Create Event Type' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* ── Delete Confirm ─────────────────────────────────────────── */}
      {modal === 'delete' && deleteTarget && (
        <AdminModal onClose={() => setModal(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-800">Delete Event Type</h2>
              <button onClick={() => setModal(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-600">
                Delete <strong>{deleteTarget.label}</strong> (<code className="text-xs bg-gray-100 px-1 rounded">{deleteTarget.key}</code>)?
              </p>
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
                Any existing email templates using this event key will remain but this key will no longer appear in the dropdown.
              </p>
              {saveMsg && <p className="mt-3 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{saveMsg}</p>}
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button onClick={() => setModal(null)}
                className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
              <button onClick={handleDelete} disabled={saving}
                className="px-5 py-2.5 rounded-xl text-sm font-medium text-white disabled:opacity-60 transition-colors"
                style={{ background: '#dc2626' }}>
                {saving ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
