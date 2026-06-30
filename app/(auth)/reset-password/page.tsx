'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from '@/lib/router'
import { Link } from 'react-router-dom'

function ResetPasswordForm() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const token        = searchParams.get('token') || ''

  const [password,  setPassword]  = useState('')
  const [confirm,   setConfirm]   = useState('')
  const [error,     setError]     = useState('')
  const [success,   setSuccess]   = useState(false)
  const [loading,   setLoading]   = useState(false)
  const [validating,setValidating]= useState(true)
  const [tokenOk,   setTokenOk]   = useState(false)

  useEffect(() => {
    if (!token) { setValidating(false); return }
    fetch('/api/auth/reset-password', {
        credentials: 'include',
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token, validate: true }),
    })
      .then(r => r.json())
      .then(d => { setTokenOk(d.valid); setValidating(false) })
      .catch(() => setValidating(false))
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    setLoading(true)
    try {
      const res  = await fetch('/api/auth/reset-password', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token, password }),
      })
      const data = await res.json()
      if (data.success) {
        setSuccess(true)
        setTimeout(() => router.push('/login'), 3000)
      } else {
        setError(data.error || 'Failed to reset password')
      }
    } catch {
      setError('Unexpected error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-bg px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-4"
            style={{ background: '#14254A' }}>
            <span className="text-white text-2xl font-bold">IP</span>
          </div>
          <h1 className="text-2xl font-bold text-[#14254A]">Set New Password</h1>
          <p className="text-brand-muted text-sm mt-1">Enter your new password below</p>
        </div>

        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-8">
          {validating ? (
            <div className="flex justify-center py-8"><div className="spinner" /></div>
          ) : !token || !tokenOk ? (
            <div className="text-center">
              <div className="text-4xl mb-3">🔗</div>
              <p className="text-red-600 font-medium mb-1">Invalid or expired link</p>
              <p className="text-brand-muted text-sm mb-5">
                This password reset link is no longer valid.
              </p>
              <Link to="/forgot-password"
                className="inline-block px-5 py-2.5 rounded-xl text-white text-sm font-semibold"
                style={{ background: '#14254A' }}>
                Request a new link
              </Link>
            </div>
          ) : success ? (
            <div className="text-center">
              <div className="text-4xl mb-3">✅</div>
              <p className="font-semibold text-gray-800 mb-1">Password updated!</p>
              <p className="text-brand-muted text-sm">Redirecting to login…</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                <input
                  autoComplete="off"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="Minimum 8 characters"
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm Password</label>
                <input
                  autoComplete="off"
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  placeholder="Repeat new password"
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <button type="submit" disabled={loading}
                className="w-full py-3 rounded-xl font-semibold text-white text-sm disabled:opacity-60 mt-2"
                style={{ background: '#14254A' }}>
                {loading ? 'Updating…' : 'Update Password'}
              </button>

              <p className="text-center text-xs text-brand-muted pt-1">
                <Link to="/login" className="hover:text-[#FC934C]">Back to Login</Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="spinner" /></div>}>
      <ResetPasswordForm />
    </Suspense>
  )
}
