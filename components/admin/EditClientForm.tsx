'use client'

import { useState } from 'react'
import { useRouter } from '@/lib/router'
import { Link } from 'react-router-dom'

interface Client {
  userId: number; name: string; email: string
  deleted: number; api_user_name: string; api_password: string
}

export default function EditClientForm({ client }: { client: Client }) {
  const router = useRouter()
  const [form, setForm] = useState({
    name:        client.name,
    email:       client.email,
    apiUserName: client.api_user_name || '',
    apiPassword: '',
    deleted:     client.deleted,
  })
  const [error,   setError]   = useState('')
  const [saving,  setSaving]  = useState(false)

  function handle(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const val = e.target.type === 'number' ? Number(e.target.value) : e.target.value
    setForm(f => ({ ...f, [e.target.name]: val }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setError(''); setSaving(true)
    try {
      const payload: any = { userId: client.userId, ...form }
      if (!form.apiPassword) delete payload.apiPassword
      const res  = await fetch('/api/admin/clients', {
        credentials: 'include',
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.success) router.push('/admin/clients')
      else setError(data.error || 'Failed to save')
    } catch { setError('Unexpected error') }
    finally { setSaving(false) }
  }

  return (
    <>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-5 py-3 text-sm mb-4">{error}</div>
      )}
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 space-y-5">
        <div className="space-y-4">
          {[
            { name: 'name',  label: 'Full Name *',    type: 'text'  },
            { name: 'email', label: 'Email Address *', type: 'email' },
          ].map(f => (
            <div key={f.name}>
              <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
              <input autoComplete="off" name={f.name} type={f.type} value={(form as any)[f.name]} onChange={handle} required
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          ))}
        </div>

        <div>
          <h3 className="font-semibold text-gray-700 mb-3 text-sm">API Credentials</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">API Username</label>
              <input autoComplete="off" name="apiUserName" type="text" value={form.apiUserName} onChange={handle}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">API Password <span className="text-xs text-brand-muted">(leave blank to keep)</span></label>
              <input autoComplete="off" name="apiPassword" type="password" value={form.apiPassword} onChange={handle}
                placeholder="Leave blank to keep existing"
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
          <select name="deleted" value={form.deleted} onChange={handle}
            className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value={0}>Active</option>
            <option value={1}>Inactive (soft-deleted)</option>
          </select>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Link to="/admin/clients" className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </Link>
          <button type="submit" disabled={saving}
            className="px-7 py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60"
            style={{ background: '#14254A' }}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </>
  )
}
