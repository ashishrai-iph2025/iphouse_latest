'use client'

import { useState } from 'react'
import { Link } from 'react-router-dom'

export default function RegisterPage() {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', designation: '', remarks: '',
  })
  const [error,   setError]   = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res  = await fetch('/api/auth/register', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(form),
      })
      const data = await res.json()
      if (data.success) {
        setSuccess(true)
      } else {
        setError(data.error || 'Registration failed. Please try again.')
      }
    } catch {
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ fontFamily: "'Poppins', sans-serif", background: '#f3f6fb' }}>

      {/* Hero */}
      <section
        className="text-center text-white px-4"
        style={{
          background: "linear-gradient(rgba(20,37,74,.88),rgba(20,37,74,.88)), url('/background2.png') center/cover no-repeat",
          padding: '60px 16px 120px',
        }}
      >
        <img src="/newlogo.png" alt="IP House" width={160} height={44} className="h-10 w-auto mx-auto mb-4" style={{ filter: 'brightness(0) invert(1)' }} />
        <h1 className="text-4xl font-bold m-0">User Registration</h1>
        <p className="mt-2 font-light max-w-2xl mx-auto" style={{ opacity: 0.9 }}>
          Request secure access to the IP House reporting and analytics platform.
        </p>
      </section>

      {/* Page */}
      <main className="w-full px-5 pb-24 z-10 relative" style={{ maxWidth: 760, margin: '-80px auto 0' }}>

        <div className="bg-white rounded-2xl p-7" style={{ boxShadow: '0 24px 60px rgba(2,18,46,0.12)' }}>

          {/* Back to login */}
          <div className="mb-4">
            <Link to="/login"
              className="inline-flex items-center gap-1.5 text-sm font-medium no-underline transition-colors"
              style={{ color: '#14254A' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#FC934C')}
              onMouseLeave={e => (e.currentTarget.style.color = '#14254A')}
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
              Back to Login
            </Link>
          </div>

          <h3 className="font-bold text-xl mb-0.5" style={{ color: '#14254A' }}>Registration form</h3>
          <p className="text-xs mb-5" style={{ color: '#6b7c93' }}>
            Submit your details. Credentials will be emailed after approval.
          </p>

          {success ? (
            <div className="text-center py-8">
              <div className="text-5xl mb-4">✅</div>
              <h4 className="font-bold text-lg mb-2" style={{ color: '#14254A' }}>Request Submitted!</h4>
              <p className="text-sm mb-6" style={{ color: '#6b7c93', maxWidth: 420, margin: '0 auto 24px' }}>
                Registration has been received. We will take 24–48 hours to validate.
                Once enrolled, login credentials will be shared to your registered email.
              </p>
              <Link to="/login"
                className="inline-flex items-center gap-1.5 text-sm font-semibold no-underline"
                style={{ color: '#14254A' }}>
                ← Back to Login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>

              {error && (
                <div className="rounded-xl px-4 py-2.5 text-sm mb-4 border"
                  style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c' }}>
                  {error}
                </div>
              )}

              {/* First & Last Name */}
              <div className="grid grid-cols-1 gap-3 mb-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#374151' }}>First Name <span style={{ color: '#ef4444' }}>*</span></label>
                  <input
                    autoComplete="off"
                    type="text"
                    name="first_name"
                    placeholder="First Name"
                    value={form.first_name}
                    onChange={handleChange}
                    required
                    className="w-full px-4 py-2.5 text-sm rounded-xl border focus:outline-none"
                    style={{ borderColor: '#dce3ee' }}
                    onFocus={e => (e.target.style.borderColor = '#14254A')}
                    onBlur={e  => (e.target.style.borderColor = '#dce3ee')}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#374151' }}>Last Name <span style={{ color: '#ef4444' }}>*</span></label>
                  <input
                    autoComplete="off"
                    type="text"
                    name="last_name"
                    placeholder="Last Name"
                    value={form.last_name}
                    onChange={handleChange}
                    required
                    className="w-full px-4 py-2.5 text-sm rounded-xl border focus:outline-none"
                    style={{ borderColor: '#dce3ee' }}
                    onFocus={e => (e.target.style.borderColor = '#14254A')}
                    onBlur={e  => (e.target.style.borderColor = '#dce3ee')}
                  />
                </div>
              </div>

              {/* Email & Designation */}
              <div className="grid grid-cols-1 gap-3 mb-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#374151' }}>Email Address <span style={{ color: '#ef4444' }}>*</span></label>
                  <input
                    autoComplete="off"
                    type="email"
                    name="email"
                    placeholder="you@example.com"
                    value={form.email}
                    onChange={handleChange}
                    required
                    className="w-full px-4 py-2.5 text-sm rounded-xl border focus:outline-none"
                    style={{ borderColor: '#dce3ee' }}
                    onFocus={e => (e.target.style.borderColor = '#14254A')}
                    onBlur={e  => (e.target.style.borderColor = '#dce3ee')}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#374151' }}>Designation</label>
                  <input
                    autoComplete="off"
                    type="text"
                    name="designation"
                    placeholder="Your role or title"
                    value={form.designation}
                    onChange={handleChange}
                    className="w-full px-4 py-2.5 text-sm rounded-xl border focus:outline-none"
                    style={{ borderColor: '#dce3ee' }}
                    onFocus={e => (e.target.style.borderColor = '#14254A')}
                    onBlur={e  => (e.target.style.borderColor = '#dce3ee')}
                  />
                </div>
              </div>

              {/* Remarks */}
              <div className="mb-4">
                <label className="block text-xs font-medium mb-1" style={{ color: '#374151' }}>Remarks</label>
                <textarea
                  name="remarks"
                  rows={4}
                  placeholder="Please mention Dashboard/Client name for which access is required."
                  value={form.remarks}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 text-sm rounded-xl border focus:outline-none resize-none"
                  style={{ borderColor: '#dce3ee' }}
                  onFocus={e => (e.target.style.borderColor = '#14254A')}
                  onBlur={e  => (e.target.style.borderColor = '#dce3ee')}
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl font-semibold text-sm transition-all disabled:opacity-60"
                style={{
                  background: 'linear-gradient(135deg,#FFC82B,#FC934C)',
                  border: 'none',
                  color: '#14254A',
                  cursor: loading ? 'not-allowed' : 'pointer',
                }}
              >
                {loading ? 'Submitting…' : 'Submit Registration'}
              </button>

            </form>
          )}
        </div>
      </main>

      <footer className="text-center py-4 text-xs mt-auto" style={{ color: '#555' }}>
        © {new Date().getFullYear()} <strong>IP House</strong>. Confidential &amp; proprietary.
      </footer>
    </div>
  )
}
