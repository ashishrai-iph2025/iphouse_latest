'use client'

import { useState } from 'react'
import { Link } from 'react-router-dom'

type Step = 'email' | 'reset' | 'done'

export default function ForgotPasswordPage() {
  const [step,       setStep]       = useState<Step>('email')
  const [email,      setEmail]      = useState('')
  const [resetToken, setResetToken] = useState('')
  const [newPass,    setNewPass]    = useState('')
  const [confirmPas, setConfirmPas] = useState('')
  const [showPass,   setShowPass]   = useState(false)
  const [error,      setError]      = useState('')
  const [loading,    setLoading]    = useState(false)

  // ── Step 1: send reset token to email ──────────────────────────────────────
  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res  = await fetch('/api/auth/forgot-password', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email }),
      })
      const data = await res.json()
      if (data.success) {
        setStep('reset')
      } else {
        setError(data.error || 'Failed to send reset token.')
      }
    } catch {
      setError('An unexpected error occurred.')
    } finally {
      setLoading(false)
    }
  }

  // ── Step 2: paste token + set new password ──────────────────────────────────
  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    const token = resetToken.replace(/\s+/g, '')
    if (!token)                { setError('Please paste the reset token from your email.'); return }
    if (newPass !== confirmPas) { setError('Passwords do not match.'); return }
    if (newPass.length < 8)    { setError('Password must be at least 8 characters.'); return }
    setError('')
    setLoading(true)
    try {
      const res  = await fetch('/api/auth/reset-password', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ resetToken: token, password: newPass }),
      })
      const data = await res.json()
      if (data.success) setStep('done')
      else setError(data.error || 'Failed to reset password.')
    } catch {
      setError('An unexpected error occurred.')
    } finally {
      setLoading(false)
    }
  }

  const stepNum = { email: 1, reset: 2, done: 2 }[step]

  return (
    <div className="min-h-screen flex flex-col" style={{ fontFamily: "'Poppins', sans-serif", background: '#f3f6fb' }}>

      {/* Hero */}
      <section className="text-center text-white px-4" style={{
        background: "linear-gradient(rgba(20,37,74,.88),rgba(20,37,74,.88)), url('/background2.png') center/cover no-repeat",
        padding: '60px 16px 120px',
      }}>
        <img src="/newlogo.png" alt="IP House" width={160} height={44} className="h-10 w-auto mx-auto mb-4"
          style={{ filter: 'brightness(0) invert(1)' }} />
        <h1 className="text-4xl font-bold m-0">Reset Password</h1>
        <p className="mt-2 font-light max-w-lg mx-auto" style={{ opacity: 0.9 }}>
          We'll email you a reset token. Paste it here to set a new password.
        </p>
      </section>

      {/* Card */}
      <main className="w-full px-5 pb-24 z-10 relative" style={{ maxWidth: 480, margin: '-80px auto 0' }}>
        <div className="bg-white rounded-2xl p-7" style={{ boxShadow: '0 24px 60px rgba(2,18,46,0.12)' }}>

          {/* Back link */}
          {step !== 'done' && (
            <div className="mb-4">
              <Link to="/login"
                className="inline-flex items-center gap-1.5 text-sm font-medium no-underline"
                style={{ color: '#14254A' }}>
                <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/>
                </svg>
                Back to Login
              </Link>
            </div>
          )}

          {/* Step indicator */}
          {step !== 'done' && (
            <div className="flex items-center gap-2 mb-5">
              {[1, 2].map(n => (
                <div key={n} className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                    style={{
                      background: n < stepNum ? '#16A34A' : n === stepNum ? '#14254A' : '#e5e7eb',
                      color:      n <= stepNum ? '#fff' : '#9ca3af',
                    }}>
                    {n < stepNum ? '✓' : n}
                  </div>
                  {n < 2 && <div className="h-px w-8 rounded" style={{ background: n < stepNum ? '#16A34A' : '#e5e7eb' }} />}
                </div>
              ))}
              <span className="text-xs text-gray-400 ml-1">
                {step === 'email' ? 'Enter email' : 'Reset password'}
              </span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-xl px-4 py-2.5 text-sm mb-4 border flex items-center gap-2"
              style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c' }}>
              <span>⚠</span> {error}
            </div>
          )}

          {/* ── STEP 1: Email ── */}
          {step === 'email' && (
            <>
              <h3 className="font-bold text-xl mb-1" style={{ color: '#14254A' }}>Forgot Password?</h3>
              <p className="text-xs mb-5" style={{ color: '#6b7c93' }}>
                Enter your registered email and we'll send a reset token valid for 30 minutes.
              </p>
              <form onSubmit={handleSend}>
                <label className="block text-xs font-medium mb-1" style={{ color: '#374151' }}>
                  Email Address <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  autoComplete="off" type="email" value={email}
                  onChange={e => setEmail(e.target.value)} required
                  placeholder="you@example.com"
                  className="w-full px-4 py-2.5 text-sm rounded-xl border focus:outline-none mb-4"
                  style={{ borderColor: '#dce3ee' }}
                  onFocus={e => (e.target.style.borderColor = '#14254A')}
                  onBlur={e  => (e.target.style.borderColor = '#dce3ee')}
                />
                <button type="submit" disabled={loading}
                  className="w-full py-3 rounded-xl font-semibold text-sm disabled:opacity-60"
                  style={{ background: 'linear-gradient(135deg,#FFC82B,#FC934C)', color: '#14254A', border: 'none' }}>
                  {loading ? 'Sending…' : 'Send Reset Token'}
                </button>
              </form>
            </>
          )}

          {/* ── STEP 2: Paste token + new password ── */}
          {step === 'reset' && (
            <>
              <h3 className="font-bold text-xl mb-1" style={{ color: '#14254A' }}>Check Your Email</h3>
              <p className="text-xs mb-5" style={{ color: '#6b7c93' }}>
                A reset token was sent to <strong style={{ color: '#14254A' }}>{email}</strong>. Copy it from the email and paste it below.
              </p>

              <form onSubmit={handleReset}>
                <label className="block text-xs font-medium mb-1" style={{ color: '#374151' }}>
                  Reset Token <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <textarea
                  value={resetToken}
                  onChange={e => setResetToken(e.target.value)}
                  placeholder="Paste the reset token from your email…"
                  rows={2}
                  className="w-full px-4 py-2.5 text-sm rounded-xl border focus:outline-none mb-4 resize-none font-mono"
                  style={{ borderColor: '#dce3ee', fontSize: 12 }}
                  onFocus={e => (e.target.style.borderColor = '#14254A')}
                  onBlur={e  => (e.target.style.borderColor = '#dce3ee')}
                />

                <label className="block text-xs font-medium mb-1" style={{ color: '#374151' }}>New Password</label>
                <div className="relative mb-3">
                  <input
                    type={showPass ? 'text' : 'password'} value={newPass}
                    onChange={e => setNewPass(e.target.value)} required minLength={8}
                    placeholder="Minimum 8 characters"
                    className="w-full px-4 py-2.5 text-sm rounded-xl border focus:outline-none pr-10"
                    style={{ borderColor: '#dce3ee' }}
                    onFocus={e => (e.target.style.borderColor = '#14254A')}
                    onBlur={e  => (e.target.style.borderColor = '#dce3ee')}
                  />
                  <button type="button" onClick={() => setShowPass(s => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">
                    {showPass ? '🙈' : '👁'}
                  </button>
                </div>

                {/* Password strength */}
                {newPass && (
                  <div className="flex gap-1 mb-3">
                    {[1,2,3,4].map(n => {
                      const score = [newPass.length >= 8, /[A-Z]/.test(newPass), /\d/.test(newPass), /[^A-Za-z0-9]/.test(newPass)].filter(Boolean).length
                      const colors = ['#ef4444','#f97316','#eab308','#16A34A']
                      return <div key={n} className="flex-1 h-1 rounded-full transition-all"
                        style={{ background: n <= score ? colors[score - 1] : '#e5e7eb' }} />
                    })}
                    <span className="text-[10px] ml-1" style={{ color: '#9ca3af' }}>
                      {['','Weak','Fair','Good','Strong'][[newPass.length >= 8, /[A-Z]/.test(newPass), /\d/.test(newPass), /[^A-Za-z0-9]/.test(newPass)].filter(Boolean).length]}
                    </span>
                  </div>
                )}

                <label className="block text-xs font-medium mb-1" style={{ color: '#374151' }}>Confirm Password</label>
                <input
                  type={showPass ? 'text' : 'password'} value={confirmPas}
                  onChange={e => setConfirmPas(e.target.value)} required minLength={8}
                  placeholder="Repeat new password"
                  className="w-full px-4 py-2.5 text-sm rounded-xl border focus:outline-none mb-4"
                  style={{ borderColor: '#dce3ee' }}
                  onFocus={e => (e.target.style.borderColor = '#14254A')}
                  onBlur={e  => (e.target.style.borderColor = '#dce3ee')}
                />

                <button type="submit" disabled={loading}
                  className="w-full py-3 rounded-xl font-semibold text-sm disabled:opacity-60"
                  style={{ background: 'linear-gradient(135deg,#FFC82B,#FC934C)', color: '#14254A', border: 'none' }}>
                  {loading ? 'Saving…' : 'Reset Password'}
                </button>

                <p className="text-center text-xs mt-3" style={{ color: '#6b7c93' }}>
                  Didn't receive the email?{' '}
                  <button type="button" onClick={() => { setStep('email'); setError('') }}
                    className="font-semibold underline"
                    style={{ color: '#14254A', background: 'none', border: 'none', cursor: 'pointer' }}>
                    Try again
                  </button>
                </p>
              </form>
            </>
          )}

          {/* ── DONE ── */}
          {step === 'done' && (
            <div className="text-center py-6">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-4"
                style={{ background: '#f0fdf4' }}>✅</div>
              <h3 className="font-bold text-xl mb-2" style={{ color: '#14254A' }}>Password Reset!</h3>
              <p className="text-sm mb-6" style={{ color: '#6b7c93' }}>
                Your password has been updated successfully. You can now sign in with your new password.
              </p>
              <Link to="/login"
                className="inline-block w-full py-3 rounded-xl font-semibold text-sm text-center no-underline"
                style={{ background: 'linear-gradient(135deg,#FFC82B,#FC934C)', color: '#14254A' }}>
                Go to Login
              </Link>
            </div>
          )}
        </div>
      </main>

      <footer className="text-center py-4 text-xs mt-auto" style={{ color: '#555' }}>
        © {new Date().getFullYear()} <strong>IP House</strong>. Confidential &amp; proprietary.
      </footer>
    </div>
  )
}
