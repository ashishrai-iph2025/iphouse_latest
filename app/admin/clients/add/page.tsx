'use client'

import { useState } from 'react'
import { useRouter } from '@/lib/router'
import { Link } from 'react-router-dom'

export default function AddClientPage() {
  const router  = useRouter()
  const [form, setForm] = useState({
    name: '', email: '', username: '', password: '',
    apiUserName: '', apiPassword: '', company: '',
  })
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  function handle(e: React.ChangeEvent<HTMLInputElement>) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/clients', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(form),
      })
      const data = await res.json()
      if (data.success) router.push('/admin/clients')
      else setError(data.error || 'Failed to create client')
    } catch { setError('Unexpected error') }
    finally { setLoading(false) }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto fade-in">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/admin/clients" className="text-brand-muted hover:text-[#FC934C] text-sm">← Back</Link>
        <h1 className="text-2xl font-bold text-[#14254A]">Add New Client</h1>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-5 py-3 text-sm mb-4">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 space-y-5">
        <div>
          <h3 className="font-semibold text-gray-700 mb-4 pb-2 border-b border-gray-100">Client Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { name: 'name',    label: 'Full Name *',    placeholder: 'Client full name',  type: 'text'  },
              { name: 'company', label: 'Company',        placeholder: 'Company name',       type: 'text'  },
              { name: 'email',   label: 'Email *',        placeholder: 'client@example.com', type: 'email' },
            ].map(f => (
              <div key={f.name} className={f.name === 'email' ? 'md:col-span-2' : ''}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
                <input autoComplete="off" name={f.name} type={f.type} placeholder={f.placeholder}
                  value={(form as any)[f.name]} onChange={handle}
                  required={f.label.includes('*')}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="font-semibold text-gray-700 mb-4 pb-2 border-b border-gray-100">Login Credentials</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { name: 'username', label: 'Login Username *', placeholder: 'Username / email', type: 'text'     },
              { name: 'password', label: 'Password *',        placeholder: 'Min. 8 chars',    type: 'password' },
            ].map(f => (
              <div key={f.name}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
                <input autoComplete="off" name={f.name} type={f.type} placeholder={f.placeholder}
                  value={(form as any)[f.name]} onChange={handle}
                  required minLength={f.name === 'password' ? 8 : 1}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="font-semibold text-gray-700 mb-4 pb-2 border-b border-gray-100">API Credentials (IP House)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { name: 'apiUserName', label: 'API Username', placeholder: 'IP House API username', type: 'text'     },
              { name: 'apiPassword', label: 'API Password', placeholder: 'IP House API password', type: 'password' },
            ].map(f => (
              <div key={f.name}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
                <input autoComplete="off" name={f.name} type={f.type} placeholder={f.placeholder}
                  value={(form as any)[f.name]} onChange={handle}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Link to="/admin/clients"
            className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </Link>
          <button type="submit" disabled={loading}
            className="px-7 py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60"
            style={{ background: '#14254A' }}>
            {loading ? 'Creating...' : 'Create Client'}
          </button>
        </div>
      </form>
    </div>
  )
}
