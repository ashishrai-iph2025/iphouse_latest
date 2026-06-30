'use client'

import { useState, useEffect } from 'react'
import { useRouter } from '@/lib/router'
import { Link } from 'react-router-dom'

export default function AddDashboardPage() {
  const router = useRouter()
  const [clients,  setClients]  = useState<{userId:number; name:string}[]>([])
  const [modules,  setModules]  = useState<{moduleId:number; moduleName:string}[]>([])
  const [form, setForm] = useState({ userId: '', moduleId: '', link: '', active: '1', isDefault: '0' })
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/admin/clients?list=1', { credentials: 'include' }).then(r => r.json()).then(d => { if (d.success) setClients(d.items ?? []) })
    fetch('/api/admin/dashboards?modules=1', { credentials: 'include' }).then(r => r.json()).then(d => { if (d.success) setModules(d.modules ?? []) })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/dashboards', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userId:    Number(form.userId),
          moduleId:  Number(form.moduleId),
          link:      form.link,
          active:    Number(form.active),
          isDefault: Number(form.isDefault),
        }),
      })
      const data = await res.json()
      if (data.success) router.push('/admin/dashboards')
      else setError(data.error || 'Failed to create dashboard')
    } catch { setError('Unexpected error') }
    finally { setLoading(false) }
  }

  const fields = [
    { key: 'active',    label: 'Is Active',   type: 'select', opts: [['1','Active'],['0','Inactive']] },
    { key: 'isDefault', label: 'Is Default',  type: 'select', opts: [['0','No'],['1','Yes']] },
  ]

  return (
    <div className="p-6 max-w-2xl mx-auto fade-in">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs text-gray-400 mb-5">
        <Link to="/admin/home" className="hover:text-gray-600">Home</Link>
        <span>›</span>
        <Link to="/admin/dashboards" className="hover:text-gray-600">PowerBI Dashboards</Link>
        <span>›</span>
        <span className="text-gray-700 font-medium">Create Dashboard</span>
      </div>

      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#14254A]">Create Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">Assign a PowerBI embed link to a client module</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm mb-4">{error}</div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        {/* Form header */}
        <div className="px-6 py-4 border-b border-gray-100" style={{ background: '#14254A' }}>
          <h2 className="text-sm font-semibold text-white">Dashboard Details</h2>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Client */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Client <span className="text-red-400">*</span></label>
            <select value={form.userId} onChange={e => setForm(f => ({...f, userId: e.target.value}))} required
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 bg-white text-gray-800">
              <option value="">— Select Client —</option>
              {clients.map(c => <option key={c.userId} value={c.userId}>{c.name}</option>)}
            </select>
          </div>

          {/* Module */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Dashboard Module <span className="text-red-400">*</span></label>
            <select value={form.moduleId} onChange={e => setForm(f => ({...f, moduleId: e.target.value}))} required
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 bg-white text-gray-800">
              <option value="">— Select Module —</option>
              {modules.map(m => <option key={m.moduleId} value={m.moduleId}>{m.moduleName}</option>)}
            </select>
          </div>

          {/* PowerBI Link */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">PowerBI Dashboard Link <span className="text-red-400">*</span></label>
            <input value={form.link} onChange={e => setForm(f => ({...f, link: e.target.value}))} required
              placeholder="https://app.powerbi.com/..."
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 text-gray-800" />
          </div>

          {/* Active + Default */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {fields.map(f => (
              <div key={f.key}>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">{f.label}</label>
                <select value={(form as any)[f.key]} onChange={e => setForm(prev => ({...prev, [f.key]: e.target.value}))}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 bg-white text-gray-800">
                  {f.opts.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}
                </select>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
            <Link to="/admin/dashboards"
              className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 no-underline transition-colors">
              Cancel
            </Link>
            <button type="submit" disabled={loading}
              className="px-7 py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60 transition-all"
              style={{ background: '#14254A' }}>
              {loading ? 'Creating…' : 'Create Dashboard'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
