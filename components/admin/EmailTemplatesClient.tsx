'use client'
import { useState, useEffect } from 'react'
import AdminPageHeader from './AdminPageHeader'
import AdminModal from './AdminModal'

interface EmailTemplate {
  id: number
  name: string
  event_key: string
  subject: string
  body_html: string
  is_active: number
  notify_email: string
  created_at: string
  updated_at: string
}

interface EventTypeDef {
  id: number
  key: string
  label: string
  has_notify_email: number
  variables: string
  is_active: number
}

// Sample values shown in preview for each variable
const PREVIEW_VARS: Record<string, string> = {
  otp_code:         '847 293',
  user_name:        'Jane Smith',
  full_name:        'Jane Smith',
  first_name:       'Jane',
  last_name:        'Smith',
  expiry_minutes:   '10',
  email:            'jane.smith@example.com',
  password:         'TempP@ss9!',
  login_url:        '#',
  date:             new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
  designation:      'Content Manager',
  remarks:          'Referred by Hoichoi team',
  rejection_reason: 'Incomplete documentation provided.',
  reset_link:       '#',
  expiry_time:      '30 minutes',
  reference_id:     'INF-20240001',
  status:           'Submitted',
  name:             'Jane Smith',
  platform:         'YouTube',
  asset_name:       'Premier League 2024',
  url_count:        '3',
  urls_list:        '<ol style="margin:0;padding-left:20px;"><li>https://example.com/infringing-1</li><li>https://example.com/infringing-2</li><li>https://example.com/infringing-3</li></ol>',
  custom_var_1:     'Sample Value 1',
  custom_var_2:     'Sample Value 2',
}

function renderWithSampleVars(template: string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => PREVIEW_VARS[key] ?? `[${key}]`)
}

const BLANK = { name: '', event_key: '', subject: '', body_html: '', is_active: 1, notify_email: '' }

export default function EmailTemplatesClient() {
  const [templates,    setTemplates]    = useState<EmailTemplate[]>([])
  const [eventTypes,   setEventTypes]   = useState<EventTypeDef[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [modal,        setModal]        = useState<'add' | 'edit' | 'delete' | null>(null)
  const [form,         setForm]         = useState({ ...BLANK })
  const [editId,       setEditId]       = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<EmailTemplate | null>(null)
  const [saving,       setSaving]       = useState(false)
  const [saveMsg,      setSaveMsg]      = useState('')
  const [search,       setSearch]       = useState('')
  const [sortCol,      setSortCol]      = useState('')
  const [sortDir,      setSortDir]      = useState<'asc' | 'desc'>('asc')

  function handleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  function si(col: string) {
    if (sortCol !== col) return <span className="ml-1 opacity-40 text-[10px]">↕</span>
    return <span className="ml-1 text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }
  function sortRows(arr: EmailTemplate[]): EmailTemplate[] {
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

  const [previewTarget, setPreviewTarget] = useState<{ name: string; subject: string; body_html: string; event_key: string } | null>(null)
  const [previewTab,    setPreviewTab]    = useState<'rendered' | 'source'>('rendered')

  async function load() {
    setLoading(true); setError('')
    try {
      const [tRes, eRes] = await Promise.all([
        fetch('/api/admin/email-templates',   { credentials: 'include' }),
        fetch('/api/admin/email-event-types', { credentials: 'include' }),
      ])
      const [tData, eData] = await Promise.all([tRes.json(), eRes.json()])
      if (tData.success) setTemplates(tData.templates || [])
      else setError(tData.error || 'Failed to load templates')
      if (eData.success) setEventTypes((eData.eventTypes || []).filter((e: EventTypeDef) => e.is_active))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  function openAdd() {
    setForm({ ...BLANK }); setEditId(null); setSaveMsg(''); setModal('add')
  }
  function openEdit(t: EmailTemplate) {
    setForm({ name: t.name, event_key: t.event_key, subject: t.subject, body_html: t.body_html, is_active: t.is_active, notify_email: t.notify_email || '' })
    setEditId(t.id); setSaveMsg(''); setModal('edit')
  }
  function openDelete(t: EmailTemplate) {
    setDeleteTarget(t); setSaveMsg(''); setModal('delete')
  }
  function openPreview(t: { name: string; subject: string; body_html: string; event_key: string }) {
    setPreviewTarget(t); setPreviewTab('rendered')
  }
  function closeModal() { setModal(null); setSaveMsg('') }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setSaveMsg('')
    try {
      const method = modal === 'edit' ? 'PUT' : 'POST'
      const body   = modal === 'edit' ? { id: editId, ...form } : form
      const res    = await fetch('/api/admin/email-templates', {
        method, headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) { closeModal(); load() }
      else setSaveMsg(data.error || 'Failed to save')
    } finally { setSaving(false) }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setSaving(true)
    try {
      const res  = await fetch('/api/admin/email-templates', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ id: deleteTarget.id }),
      })
      const data = await res.json()
      if (data.success) { closeModal(); load() }
      else setSaveMsg(data.error || 'Failed to delete')
    } finally { setSaving(false) }
  }

  function appendVar(v: string) {
    setForm(f => ({ ...f, body_html: f.body_html + v }))
  }

  // Derive helpers from live event types
  const usedKeys      = templates.map(t => t.event_key)
  const availableKeys = eventTypes.filter(et => !usedKeys.includes(et.key) || (modal === 'edit' && form.event_key === et.key))

  const selectedEventType = eventTypes.find(et => et.key === form.event_key)
  const currentVars       = selectedEventType?.variables
    ? selectedEventType.variables.split(',').map(s => s.trim()).filter(Boolean)
    : []
  const showNotifyEmail   = selectedEventType?.has_notify_email === 1

  function buildPreviewDoc(html: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box;}body{margin:0;padding:24px;background:#f3f6fb;font-family:Poppins,'Segoe UI',sans-serif;}</style></head><body>${renderWithSampleVars(html)}</body></html>`
  }

  return (
    <div className="fade-in py-2 px-4 sm:px-6 lg:px-8">
      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration', href: '/admin/configuration' }, { label: 'Email Templates' }]}
        backHref="/admin/configuration"
        title="Email Templates"
        description="Manage templates for system-generated emails"
        actions={
          <button onClick={openAdd}
            className="px-4 py-2 text-sm font-semibold text-white rounded-xl hover:opacity-90 transition-opacity"
            style={{ background: '#14254A' }}>
            + Add Template
          </button>
        }
      />

      {/* Event types coverage strip */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-blue-800">Event types coverage</p>
          <a href="/admin/email-event-types"
            className="text-xs font-semibold text-blue-600 hover:underline">
            Manage Event Types →
          </a>
        </div>
        <div className="flex flex-wrap gap-2">
          {eventTypes.map(et => {
            const assigned = templates.find(t => t.event_key === et.key)
            return (
              <span key={et.key}
                className={`px-2.5 py-1 rounded-lg text-xs border ${assigned ? 'bg-white border-gray-200 text-gray-700' : 'bg-blue-50 border-blue-200 text-blue-700'}`}>
                {assigned ? '✓ ' : ''}{et.label}
              </span>
            )
          })}
          {eventTypes.length === 0 && (
            <span className="text-xs text-blue-600">No event types configured yet. <a href="/admin/email-event-types" className="underline">Add some →</a></span>
          )}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-16"><div className="spinner" /></div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-6 text-center">
          <p className="font-semibold">Error loading templates</p>
          <p className="text-sm mt-1">{error}</p>
          <button onClick={load} className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg text-sm">Retry</button>
        </div>
      ) : templates.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-12 text-center">
          <p className="text-3xl mb-3">✉️</p>
          <p className="font-medium text-gray-700">No templates configured yet</p>
          <p className="text-sm text-brand-muted mt-1">Click &quot;Add Template&quot; to create your first email template.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
            <span className="text-sm font-semibold text-[#14254A]">
              {sortRows(templates.filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.event_key.toLowerCase().includes(search.toLowerCase()) || t.subject.toLowerCase().includes(search.toLowerCase()))).length} template{templates.length !== 1 ? 's' : ''}
            </span>
            <input autoComplete="off" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, event type, subject…"
              className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-60 focus:outline-none focus:ring-2 focus:ring-blue-300" />
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('name')}>Template Name{si('name')}</th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('event_key')}>Event Type{si('event_key')}</th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('subject')}>Subject{si('subject')}</th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('is_active')}>Status{si('is_active')}</th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('updated_at')}>Last Updated{si('updated_at')}</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortRows(templates.filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.event_key.toLowerCase().includes(search.toLowerCase()) || t.subject.toLowerCase().includes(search.toLowerCase()))).map(t => {
                  const eventLabel = eventTypes.find(et => et.key === t.event_key)?.label ?? t.event_key
                  return (
                    <tr key={t.id}>
                      <td className="font-medium text-gray-800 text-sm">{t.name}</td>
                      <td>
                        <span className="text-xs bg-gray-50 border border-gray-200 text-gray-700 px-2 py-0.5 rounded-lg">{eventLabel}</span>
                      </td>
                      <td className="text-sm text-gray-600 max-w-xs truncate">{t.subject}</td>
                      <td>
                        <span className="inline-flex items-center gap-1.5 text-xs text-gray-700">
                          <span className={`w-1.5 h-1.5 rounded-full ${t.is_active ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                          {t.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="text-xs text-brand-muted whitespace-nowrap">{t.updated_at}</td>
                      <td>
                        <div className="flex items-center gap-1">
                          <button onClick={() => openPreview(t)}
                            className="px-2.5 py-1 text-xs border border-blue-200 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors">Preview</button>
                          <button onClick={() => openEdit(t)}
                            className="px-2.5 py-1 text-xs border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors">Edit</button>
                          <button onClick={() => openDelete(t)}
                            className="px-2.5 py-1 text-xs border border-gray-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors">Delete</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Preview Modal ─────────────────────────────────────────── */}
      {previewTarget && (
        <AdminModal onClose={() => setPreviewTarget(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden flex flex-col"
            style={{ maxWidth: 680, maxHeight: 'calc(100vh - 48px)' }}>
            <div className="flex items-center justify-between px-5 py-4 flex-shrink-0" style={{ background: '#14254A' }}>
              <div>
                <h3 className="font-bold text-sm text-white">Preview — {previewTarget.name}</h3>
                <p className="text-white/50 text-xs mt-0.5">Sample data is used for placeholders</p>
              </div>
              <button onClick={() => setPreviewTarget(null)} className="text-white/60 hover:text-white text-xl leading-none">×</button>
            </div>
            <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 flex-shrink-0 space-y-1">
              <div className="flex items-baseline gap-2 text-xs">
                <span className="text-gray-400 w-14 flex-shrink-0">From</span>
                <span className="text-gray-700 font-medium">IP House &lt;noreply@iphouse.com&gt;</span>
              </div>
              <div className="flex items-baseline gap-2 text-xs">
                <span className="text-gray-400 w-14 flex-shrink-0">Subject</span>
                <span className="text-gray-800 font-semibold">{renderWithSampleVars(previewTarget.subject)}</span>
              </div>
            </div>
            <div className="flex border-b border-gray-100 px-5 flex-shrink-0">
              {(['rendered', 'source'] as const).map(tab => (
                <button key={tab} onClick={() => setPreviewTab(tab)}
                  className={`px-4 py-2.5 text-xs font-semibold border-b-2 -mb-px transition-colors capitalize ${previewTab === tab ? 'border-[#14254A] text-[#14254A]' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                  {tab === 'rendered' ? '👁 Rendered Preview' : '⟨/⟩ HTML Source'}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-hidden min-h-0">
              {previewTab === 'rendered' ? (
                <iframe srcDoc={buildPreviewDoc(previewTarget.body_html)} sandbox="allow-same-origin"
                  className="w-full h-full border-0" style={{ minHeight: 420 }} title="Email preview" />
              ) : (
                <pre className="p-5 text-xs font-mono text-gray-700 bg-gray-50 overflow-auto h-full whitespace-pre-wrap break-all" style={{ minHeight: 420 }}>
                  {previewTarget.body_html}
                </pre>
              )}
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 flex-shrink-0">
              <p className="text-xs text-gray-400">Placeholders are filled with sample values for preview only.</p>
              <div className="flex gap-2">
                <button onClick={() => { openEdit(templates.find(t => t.name === previewTarget.name)!); setPreviewTarget(null) }}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">Edit Template</button>
                <button onClick={() => setPreviewTarget(null)}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-white" style={{ background: '#14254A' }}>Close</button>
              </div>
            </div>
          </div>
        </AdminModal>
      )}

      {/* ── Add / Edit Modal ──────────────────────────────────────── */}
      {(modal === 'add' || modal === 'edit') && (
        <AdminModal onClose={closeModal}>
          <div className="admin-modal-panel" style={{ borderRadius: 16, width: '100%', maxWidth: 680, maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', boxShadow: '0 25px 50px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ background: '#14254A', borderRadius: '16px 16px 0 0', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <span style={{ color: '#fff', fontWeight: 600, fontSize: 14 }}>
                {modal === 'add' ? 'Add Email Template' : 'Edit Email Template'}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {form.body_html && (
                  <button type="button"
                    onClick={() => openPreview({ name: form.name || 'Draft', subject: form.subject, body_html: form.body_html, event_key: form.event_key })}
                    style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.3)', fontSize: 12, fontWeight: 600, color: '#fff', background: 'rgba(255,255,255,0.12)', cursor: 'pointer' }}>
                    👁 Preview
                  </button>
                )}
                <button onClick={closeModal} style={{ color: 'rgba(255,255,255,0.6)', fontSize: 22, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
              </div>
            </div>

            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 16, flex: 1, overflowY: 'auto' }}>

                {saveMsg && (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 10, padding: '8px 14px', fontSize: 13 }}>{saveMsg}</div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Template Name *</label>
                    <input autoComplete="off" value={form.name} required
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Registration Approved"
                      style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 12px', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Event Type *</label>
                    <select value={form.event_key} required
                      onChange={e => setForm(f => ({ ...f, event_key: e.target.value, notify_email: '' }))}
                      style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 12px', fontSize: 13, outline: 'none', background: '#fff', boxSizing: 'border-box' }}>
                      <option value="">— Select event —</option>
                      {availableKeys.map(et => <option key={et.key} value={et.key}>{et.label}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Email Subject *</label>
                  <input autoComplete="off" value={form.subject} required
                    onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                    placeholder="e.g. Your registration has been approved"
                    style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 12px', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
                </div>

                {showNotifyEmail && (
                  <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '12px 14px' }}>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                      Recipient Email (Admin Notification)
                    </label>
                    <input autoComplete="off" type="email" value={form.notify_email}
                      onChange={e => setForm(f => ({ ...f, notify_email: e.target.value }))}
                      placeholder="ashish.rai@ip-house.com"
                      style={{ width: '100%', border: '1px solid #fcd34d', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fff' }} />
                    <p style={{ marginTop: 5, fontSize: 11, color: '#92400e' }}>
                      This email will receive notifications for this event. Leave blank to use the system default (<strong>ashish.rai@ip-house.com</strong>).
                    </p>
                  </div>
                )}

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Email Body (HTML) *</label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                      <span>Active</span>
                      <input type="checkbox" checked={form.is_active === 1}
                        onChange={e => setForm(f => ({ ...f, is_active: e.target.checked ? 1 : 0 }))} />
                    </label>
                  </div>
                  <textarea value={form.body_html} required rows={10}
                    onChange={e => setForm(f => ({ ...f, body_html: e.target.value }))}
                    placeholder={'<p>Dear {{user_name}},</p>\n<p>Your account has been approved.</p>'}
                    style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 12px', fontSize: 12, fontFamily: 'monospace', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />

                  {currentVars.length > 0 && (
                    <div style={{ marginTop: 8, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '10px 12px' }}>
                      <p style={{ fontSize: 11, fontWeight: 600, color: '#1e40af', marginBottom: 6 }}>Click to insert placeholder:</p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {currentVars.map(v => (
                          <button key={v} type="button" onClick={() => appendVar(v)}
                            style={{ padding: '2px 8px', fontSize: 11, fontFamily: 'monospace', border: '1px solid #bfdbfe', borderRadius: 6, background: '#fff', color: '#1d4ed8', cursor: 'pointer' }}>
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ borderTop: '1px solid #f3f4f6', padding: '16px 24px', display: 'flex', justifyContent: 'flex-end', gap: 10, flexShrink: 0 }}>
                <button type="button" onClick={closeModal}
                  style={{ padding: '9px 20px', borderRadius: 10, border: '1px solid #e5e7eb', fontSize: 13, fontWeight: 500, color: '#374151', background: '#fff', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button type="submit" disabled={saving}
                  style={{ padding: '9px 24px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600, color: '#fff', background: '#14254A', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                  {saving ? 'Saving…' : modal === 'add' ? 'Create Template' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* ── Delete Confirm Modal ──────────────────────────────────── */}
      {modal === 'delete' && deleteTarget && (
        <AdminModal onClose={closeModal}>
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-800">Delete Template</h2>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-600">
                Are you sure you want to delete <strong>{deleteTarget.name}</strong>? This cannot be undone.
              </p>
              {saveMsg && <p className="mt-3 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{saveMsg}</p>}
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button onClick={closeModal}
                className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
              <button onClick={handleDelete} disabled={saving}
                className="px-5 py-2.5 rounded-xl border border-gray-300 text-red-600 text-sm font-medium hover:bg-red-50 disabled:opacity-60 transition-colors">
                {saving ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </AdminModal>
      )}
    </div>
  )
}
