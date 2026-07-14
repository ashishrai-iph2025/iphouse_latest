'use client'

import { useState, useEffect, useRef } from 'react'
import { signIn, useSession } from '@/lib/auth-client'
import { useRouter } from '@/lib/router'
import { Link } from 'react-router-dom'

export default function VerifyEmailPage() {
  const router = useRouter()
  const { data: session, status, update } = useSession()

  useEffect(() => {
    if (status === 'authenticated') {
      const role = (session?.user as any)?.role
      router.replace(role === 1 || role === 2 ? '/admin/home' : '/dashboard')
    }
  }, [status, session])

  const [digits,    setDigits]    = useState(['', '', '', '', '', ''])
  const [error,     setError]     = useState('')
  const [loading,   setLoading]   = useState(false)
  const [sending,   setSending]   = useState(false)
  const [sendError, setSendError] = useState('')
  const [countdown, setCountdown] = useState(60)

  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  const clean = (v: string | null) => (v && v !== 'undefined' && v !== 'null' && v !== '0' ? v : '')
  const email    = typeof window !== 'undefined' ? clean(sessionStorage.getItem('pending_otp_email'))    : ''
  const userId   = typeof window !== 'undefined' ? clean(sessionStorage.getItem('pending_otp_userId'))   : ''
  const username = typeof window !== 'undefined' ? clean(sessionStorage.getItem('pending_otp_username')) : ''

  useEffect(() => {
    if (!email) { router.replace('/login'); return }
    inputRefs.current[0]?.focus()
  }, [])

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  async function sendCode() {
    setSending(true); setSendError('')
    try {
      const res  = await fetch('/api/auth/send-otp', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId, email }),
      })
      const data = await res.json()
      if (data.success) {
        setCountdown(60)
        inputRefs.current[0]?.focus()
      } else {
        setSendError(data.error || 'Failed to send code')
      }
    } catch {
      setSendError('Network error. Please try again.')
    } finally {
      setSending(false)
    }
  }

  function handleDigitChange(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[index] = digit
    setDigits(next)
    if (digit && index < 5) inputRefs.current[index + 1]?.focus()
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault(); inputRefs.current[index - 1]?.focus()
    } else if (e.key === 'ArrowRight' && index < 5) {
      e.preventDefault(); inputRefs.current[index + 1]?.focus()
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (!pasted) return
    const next = [...digits]
    pasted.split('').forEach((d, i) => { if (i < 6) next[i] = d })
    setDigits(next)
    const nextEmpty = next.findIndex(d => d === '')
    inputRefs.current[nextEmpty === -1 ? 5 : nextEmpty]?.focus()
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    const code = digits.join('')
    if (code.length !== 6) { setError('Please enter the complete 6-digit code'); return }
    setError(''); setLoading(true)

    try {
      const res  = await fetch('/api/auth/verify-otp', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId, email, code }),
      })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Invalid code'); return }

      // Staff OTP: verify-otp already set the session cookie, so there's no
      // account-selection or signIn step — just refresh the session and let the
      // useEffect route to /admin/home.
      if (data.staff) {
        sessionStorage.removeItem('pending_otp_email')
        sessionStorage.removeItem('pending_otp_userId')
        sessionStorage.removeItem('pending_otp_username')
        sessionStorage.removeItem('pending_login_rows')
        sessionStorage.removeItem('pending_otp_staff')
        await update()
        return
      }

      // Check if multiple logins need selection
      const rows = JSON.parse(sessionStorage.getItem('pending_login_rows') || '[]')
      if (rows.length > 1) {
        // Store the verified tempToken so client-selection can use it directly
        sessionStorage.setItem('otp_verified_tempToken', data.tempToken)
        sessionStorage.setItem('otp_verified_username',  data.username)
        router.replace('/client-selection')
        return
      }

      // Single login – sign in with the verified temp token. It MUST be passed
      // as `tempToken` (not `password`) so the Login handler's temp-token branch
      // fires — otherwise it tries to verify the token as a password and fails.
      const result = await signIn('credentials', {
        redirect:  false,
        username:  data.username,
        tempToken: data.tempToken,
        loginId:   String(data.loginId),
      })

      if (result?.error) {
        setError('Login failed. Please try again.')
      } else {
        // Clean up
        sessionStorage.removeItem('pending_otp_email')
        sessionStorage.removeItem('pending_otp_userId')
        sessionStorage.removeItem('pending_otp_username')
        sessionStorage.removeItem('pending_login_rows')
        await update()
        // Navigation handled by useEffect once status === 'authenticated'
      }
    } catch {
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const codeComplete = digits.every(d => d !== '')

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: '#eef1f6' }}>
      <div className="w-full max-w-2xl bg-white rounded-3xl shadow-2xl overflow-hidden flex fade-in" style={{ minHeight: 340 }}>

        {/* ── LEFT: orange gradient + logo ── */}
        <div
          className="hidden sm:flex w-[44%] flex-shrink-0 flex-col items-center justify-center p-10"
          style={{ background: 'linear-gradient(160deg,#FFC82B 0%,#FC934C 100%)' }}
        >
          <img src="/newlogo.png" alt="IP House" width={160} height={50} className="w-auto max-w-[160px]" />
        </div>

        {/* ── RIGHT: OTP form ── */}
        <div className="flex-1 flex flex-col justify-center px-8 py-10">

          <div className="text-center mb-6">
            <p className="text-sm text-gray-400 mb-0.5">Welcome</p>
            <h1 className="text-2xl font-bold text-[#14254A]">Email verification</h1>
            {email && (
              <p className="text-xs text-gray-400 mt-2">
                Code sent to <span className="font-semibold text-gray-600">{email}</span>
              </p>
            )}
          </div>

          {/* Errors */}
          {(error || sendError) && (
            <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl px-4 py-2.5 text-xs text-center mb-4">
              {error || sendError}
            </div>
          )}

          {/* OTP boxes */}
          <form onSubmit={handleVerify}>
            <div className="flex justify-center gap-2.5 mb-5" onPaste={handlePaste}>
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={el => { inputRefs.current[i] = el }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={e => handleDigitChange(i, e.target.value)}
                  onKeyDown={e => handleKeyDown(i, e)}
                  autoComplete="one-time-code"
                  className="w-11 h-13 text-center text-xl font-bold rounded-xl border-2 transition-all outline-none focus:ring-2 focus:ring-[#14254A]/10"
                  style={{
                    height: 52,
                    borderColor: d ? '#14254A' : i === digits.findIndex(x => x === '') ? '#14254A' : '#e5e7eb',
                  }}
                />
              ))}
            </div>

            {/* Verify button */}
            <button
              type="submit"
              disabled={loading || !codeComplete}
              className="w-full py-3 rounded-full font-semibold text-white text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 mb-3"
              style={{ background: '#14254A' }}
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              )}
              {loading ? 'Verifying…' : 'Verify'}
            </button>

            {/* Resend + Cancel */}
            <div className="flex gap-3">
              <button
                type="button"
                disabled={sending || countdown > 0}
                onClick={sendCode}
                className="flex-1 py-2.5 rounded-full text-sm font-semibold border-2 transition-all disabled:opacity-50"
                style={{ borderColor: '#16A34A', color: '#16A34A', background: 'transparent' }}
              >
                {sending ? 'Sending…' : countdown > 0 ? `Resend (${countdown}s)` : 'Resend code'}
              </button>
              <Link
                to="/login"
                className="flex-1 py-2.5 rounded-full text-sm font-semibold border-2 border-gray-200 text-gray-500 text-center transition-all hover:bg-gray-50"
              >
                Cancel
              </Link>
            </div>
          </form>

          <p className="text-center text-[11px] text-gray-400 mt-5 leading-relaxed">
            Code valid for 10 minutes. If you didn&apos;t request this,<br />contact support.
          </p>
        </div>
      </div>
    </div>
  )
}

