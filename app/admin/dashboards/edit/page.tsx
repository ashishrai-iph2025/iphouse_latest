'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from '@/lib/router'
import { Link } from 'react-router-dom'

interface Dashboard {
  userId: number
  name: string
  email: string
  moduleId: number
  moduleName: string
  link: string
  active: number
  default: number
}

function EditDashboardForm() {
  const router = useRouter()
  const params = useSearchParams()
  const userId   = params.get('userId')
  const moduleId = params.get('moduleId')

  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [form, setForm] = useState({ link: '', active: '1', isDefault: '0' })
  const [loading, setLoading]   = useState(true)
  const [saving,  setSaving]    = useState(false)
  const [error,   setError]     = useState('')
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!userId || !moduleId) { setNotFound(true); setLoading(false); return }
    fetch(`/api/admin/dashboards?userId=${userId}&moduleId=${moduleId}`)
      .then(r => r.json())
      .then(data => {
        if (!data.success) { setNotFound(true); return }
        const d: Dashboard = data.dashboard
        setDashboard(d)
        setForm({ link: d.link ?? '', active: String(d.active), isDefault: String(d.default) })
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [userId, moduleId])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.link.trim()) { setError('Dashboard link is required'); return }
    setError('')
    setSaving(true)
    try {
      const res = await fetch('/api/admin/dashboards', {
        credentials: 'include',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId:    Number(userId),
          moduleId:  Number(moduleId),
          link:      form.link.trim(),
          active:    Number(form.active),
          isDefault: Number(form.isDefault),
        }),
      })
      const data = await res.json()
      if (data.success) router.push('/admin/dashboards')
      else setError(data.error || 'Failed to update dashboard')
    } catch { setError('Unexpected error') }
    finally { setSaving(false) }
  }

  if (loading) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="h-64 flex items-center justify-center text-gray-400 text-sm">Loading…</div>
      </div>
    )
  }

  if (notFound || !dashboard) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-6 text-sm text-center">
          Dashboard not found.{' '}
          <Link to="/admin/dashboards" className="underline font-medium">Go back</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-2xl mx-auto fade-in">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs text-gray-400 mb-5">
        <Link to="/admin/home" className="hover:text-gray-600">Home</Link>
        <span>›</span>
        <Link to="/admin/dashboards" className="hover:text-gray-600">PowerBI Dashboards</Link>
        <span>›</span>
        <span className="text-gray-700 font-medium">Edit Dashboard</span>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#14254A]">Edit Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">Update PowerBI embed link and settings</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm mb-4">{error}</div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100" style={{ background: '#14254A' }}>
          <h2 className="text-sm font-semibold text-white">Dashboard Details</h2>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Read-only client info */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">Client</label>
              <div className="border border-gray-100 rounded-xl px-4 py-2.5 text-sm bg-gray-50 truncate" style={{ color: dashboard.name ? '#374151' : '#9ca3af' }}>
                {dashboard.name || `User ID: ${dashboard.userId}`}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">Email</label>
              <div className="border border-gray-100 rounded-xl px-4 py-2.5 text-sm bg-gray-50 truncate" style={{ color: dashboard.email ? '#6b7280' : '#9ca3af' }}>
                {dashboard.email || '—'}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">Dashboard Module</label>
            <div className="border border-gray-100 rounded-xl px-4 py-2.5 text-sm text-gray-700 bg-gray-50">
              {dashboard.moduleName}
            </div>
          </div>

          {/* Editable fields */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">
              PowerBI Dashboard Link <span className="text-red-400">*</span>
            </label>
            <input
              autoComplete="off"
              value={form.link}
              onChange={e => setForm(f => ({ ...f, link: e.target.value }))}
              required
              placeholder="https://app.powerbi.com/..."
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 text-gray-800"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Is Active</label>
              <select value={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.value }))}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 bg-white text-gray-800">
                <option value="1">Active</option>
                <option value="0">Inactive</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Is Default</label>
              <select value={form.isDefault} onChange={e => setForm(f => ({ ...f, isDefault: e.target.value }))}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 bg-white text-gray-800">
                <option value="0">No</option>
                <option value="1">Yes</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
            <Link to="/admin/dashboards"
              className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 no-underline transition-colors">
              Cancel
            </Link>
            <button type="submit" disabled={saving}
              className="px-7 py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60 transition-all"
              style={{ background: '#14254A' }}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function EditDashboardPage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-400 text-sm">Loading…</div>}>
      <EditDashboardForm />
    </Suspense>
  )
}
