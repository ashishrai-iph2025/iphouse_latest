'use client'

import { useState, useEffect } from 'react'
import { useRouter } from '@/lib/router'
import { Link } from 'react-router-dom'

interface ClientOption { userId: number; name: string; email: string }

export default function AddUserPage() {
  const router = useRouter()
  const [clients,  setClients]  = useState<ClientOption[]>([])
  const [form, setForm] = useState({
    userId: '', firstName: '', lastName: '',
    loginUsername: '', loginPassword: '', loginType: '0',
  })
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/admin/clients?list=1', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.success) setClients(d.items) })
  }, [])

  function handle(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/users', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(form),
      })
      const data = await res.json()
      if (data.success) router.push('/admin/users')
      else setError(data.error || 'Failed to create user')
    } catch { setError('Unexpected error') }
    finally { setLoading(false) }
  }

  const loginTypeOptions = [
    { value: '0', label: 'Email OTP — sends a one-time code by email' },
    { value: '2', label: 'Password — standard username/password login' },
  ]

  return (
    <div className="p-6 max-w-2xl mx-auto fade-in">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/admin/users" className="text-brand-muted hover:text-[#FC934C] text-sm">← Back</Link>
        <h1 className="text-2xl font-bold text-[#14254A]">Add Login Account</h1>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-5 py-3 text-sm mb-4">{error}</div>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Parent Account (Client) *</label>
          <select name="userId" value={form.userId} onChange={handle} required
            className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">— Select client —</option>
            {clients.map(c => (
              <option key={c.userId} value={c.userId}>{c.name} ({c.email})</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[
            { name: 'firstName', label: 'First Name *', placeholder: 'First name' },
            { name: 'lastName',  label: 'Last Name',    placeholder: 'Last name' },
          ].map(f => (
            <div key={f.name}>
              <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
              <input autoComplete="off" name={f.name} type="text" placeholder={f.placeholder}
                value={(form as any)[f.name]} onChange={handle}
                required={f.label.includes('*')}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          ))}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Login Username *</label>
          <input autoComplete="off" name="loginUsername" type="text" placeholder="Usually an email address"
            value={form.loginUsername} onChange={handle} required
            className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Login Type *</label>
          <select name="loginType" value={form.loginType} onChange={handle} required
            className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {loginTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {form.loginType === '2' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password *</label>
            <input autoComplete="off" name="loginPassword" type="password" placeholder="Min. 8 characters"
              value={form.loginPassword} onChange={handle}
              required={form.loginType === '2'} minLength={8}
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Link to="/admin/users" className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </Link>
          <button type="submit" disabled={loading}
            className="px-7 py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60"
            style={{ background: '#14254A' }}>
            {loading ? 'Creating...' : 'Create Login'}
          </button>
        </div>
      </form>
    </div>
  )
}
