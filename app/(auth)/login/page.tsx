'use client'

import { useState, useEffect, Suspense } from 'react'
import { signIn, useSession } from '@/lib/auth-client'
import { useRouter, useSearchParams } from '@/lib/router'
import { Link } from 'react-router-dom'
import AuthShell from '@/components/auth/AuthShell'
import { validateLoginForm, sanitizeInput, detectSuspiciousInput } from '@/lib/validation'
import { recordAttempt, clearRateLimit } from '@/lib/rateLimit'

function LoginForm() {
  const router  = useRouter()
  const params  = useSearchParams()
  const { data: session, status, update } = useSession()

  const [username,   setUsername]   = useState('')
  const [password,   setPassword]   = useState('')
  const [showPw,     setShowPw]     = useState(false)
  const [error,      setError]      = useState('')
  /* What the server said about the lockout, kept apart from the message.

     The sentence in `error` already names the count, but a page that had to
     read the number back out of that sentence would break the day somebody
     rewords it. These are the same facts as fields, so the meter below is
     drawn from data. Null whenever lockout is switched off, or when the
     failure had nothing to do with a password. */
  const [attempts,   setAttempts]   = useState<
    { remaining: number; max: number; hours: number; locked: boolean } | null>(null)
  const [loading,    setLoading]    = useState(false)
  const [idleBanner, setIdleBanner] = useState(false)
  const [validationErrors, setValidationErrors] = useState<string[]>([])

  useEffect(() => {
    if (params.get('reason') === 'idle') setIdleBanner(true)
  }, [params])

  useEffect(() => {
    if (status === 'authenticated') {
      const role = (session?.user as any)?.role
      clearRateLimit('login', username)
      router.replace(role === 1 || role === 2 ? '/admin/home' : '/dashboard')
    }
  }, [status, session, username])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setAttempts(null)
    setValidationErrors([])
    setLoading(true)

    try {
      // Input validation
      const validation = validateLoginForm(username, password)
      if (!validation.valid) {
        setValidationErrors(validation.errors)
        setLoading(false)
        return
      }

      // Rate limiting check
      const rateLimitCheck = recordAttempt('login', username)
      if (!rateLimitCheck.allowed) {
        setError(rateLimitCheck.message)
        setLoading(false)
        return
      }

      // Sanitize inputs
      const sanitizedUsername = sanitizeInput(username)

      // Additional suspicious input detection
      if (detectSuspiciousInput(username) || detectSuspiciousInput(password)) {
        setError('Invalid input detected. Please try again.')
        setLoading(false)
        return
      }

      const checkRes = await fetch('/api/auth/check-multiple-logins', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: sanitizedUsername, password }),
      })
      const checkData = await checkRes.json()
      if (!checkData.success) {
        setError(checkData.error || 'Invalid username or password')
        if (typeof checkData.maxAttempts === 'number' && checkData.maxAttempts > 0) {
          setAttempts({
            remaining: Number(checkData.remaining) || 0,
            max:       Number(checkData.maxAttempts),
            hours:     Number(checkData.lockoutHours) || 0,
            locked:    !!checkData.locked,
          })
        }
        return
      }

      const loginType = checkData.login_type as number
      const role      = checkData.role as number | null

      sessionStorage.setItem('pending_otp_email',    checkData.email)
      sessionStorage.setItem('pending_otp_userId',   String(checkData.userId))
      sessionStorage.setItem('pending_otp_username', username)
      sessionStorage.setItem('pending_login_rows',   JSON.stringify(checkData.rows))
      if (checkData.tempToken) sessionStorage.setItem('pending_multi_tempToken', checkData.tempToken)
      // Staff (role 1/2) go through OTP only when a Super Admin enabled it
      // (check-multiple-logins returns otpRequired). Their verify step sets the
      // session directly, so remember it's a staff OTP for the verify page.
      const staffOtp = checkData.staff === true && checkData.otpRequired === true
      sessionStorage.setItem('pending_otp_staff', staffOtp ? '1' : '0')

      const needsOtp = staffOtp || ((loginType === 0 || loginType === 1) && role !== 1 && role !== 2)
      if (needsOtp) {
        const otpRes  = await fetch('/api/auth/send-otp', {
          credentials: 'include',
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ userId: checkData.userId, email: checkData.email }),
        })
        const otpData = await otpRes.json()
        if (!otpData.success) { setError(otpData.error || 'Failed to send verification code'); return }
        router.push('/verify-email')
        return
      }

      if (checkData.rows.length > 1) { router.push('/client-selection'); return }

      const result = await signIn('credentials', { redirect: false, username, password })
      if (result?.error) {
        setError('Login failed. Please try again.')
      } else {
        sessionStorage.removeItem('pending_otp_email')
        sessionStorage.removeItem('pending_otp_userId')
        sessionStorage.removeItem('pending_otp_username')
        sessionStorage.removeItem('pending_login_rows')
        await update()
      }
    } catch {
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      eyebrow="Anti-piracy platform"
      title={<>Online <em>Dashboard</em></>}
      lede={<>
        Live infringement analytics, takedown enforcement and embedded Power BI
        dashboards.
      </>}
      powered="Powered by IP House"
      stats={[
        { value: '8.2k+', label: 'Takedowns / Hour' },
        { value: '96%', label: 'Detection rate' },
        { value: '150+', label: 'Clients served' },
      ]}
      /* The four stages, named across the foot of the brand panel and set out
         in full in the sections below. This is what stands where the mocked-up
         dashboard window used to: the shape of the service rather than a
         picture of the software. */
      marks={['Detect', 'Disrupt', 'Escalate', 'Enforce']}
      /* No `aside`, and no prop to pass it to.

         This carried the "How it works" section — the four stages with every
         service listed under each — and a "Built for rights holders" section of
         capability chips, plus the SVG cycle diagram. All of it was a second,
         longer answer to the question the hero already answers: the eyebrow, the
         headline, the figures and the four stages named. A page whose only job
         is to be signed in to should not need scrolling. */
    >
                <h2>Welcome back</h2>
                <p className="lp-card-sub">Sign in to access your dashboards &amp; reports.</p>
            {idleBanner && (
              <div className="lp-idle">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Your session expired due to inactivity. Please sign in again.
              </div>
            )}
            {validationErrors.length > 0 && (
              <div className="lp-error">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {validationErrors.map((err, idx) => <span key={idx}>{err}</span>)}
                </div>
              </div>
            )}
            {error && (
              <div className="lp-error">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                {error}
              </div>
            )}

            {/* How much room is left, as a count AND as a bar.

                Under the message rather than inside it: the message says what
                went wrong, this says what happens next, and somebody who has
                mistyped their password twice is scanning for the second. The
                bar is there because "2 of 5" is a fraction, and a fraction is
                read faster as a length than as arithmetic.

                It goes amber at one remaining rather than counting down through
                colours — a scale that changes hue every attempt spends its
                urgency early and has nothing left for the attempt that matters.

                Nothing is drawn once the account is locked: the message then
                carries the time it lifts, and a meter reading zero beside it
                would only repeat that in a form nobody can act on. */}
            {attempts && !attempts.locked && attempts.remaining > 0 && (
              <div className={`lp-attempts ${attempts.remaining === 1 ? 'lp-attempts-last' : ''}`}>
                <div className="lp-attempts-row">
                  <span>
                    <strong>{attempts.remaining}</strong> of {attempts.max} attempt
                    {attempts.max === 1 ? '' : 's'} remaining
                  </span>
                  {attempts.hours > 0 && (
                    <span className="lp-attempts-note">
                      then locked {attempts.hours}h
                    </span>
                  )}
                </div>
                <div className="lp-attempts-track"
                  role="meter" aria-valuemin={0} aria-valuemax={attempts.max}
                  aria-valuenow={attempts.remaining}
                  aria-label={`${attempts.remaining} of ${attempts.max} sign-in attempts remaining`}>
                  <span style={{ width: `${(attempts.remaining / attempts.max) * 100}%` }} />
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label className="lp-label">Username</label>
                <div className="lp-input-wrap">
                  <div className="lp-input-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </div>
                  <input type="text" className="lp-input" placeholder="Enter your username"
                    value={username} onChange={e => setUsername(e.target.value)}
                    required autoComplete="username" />
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label className="lp-label" style={{ marginBottom: 0 }}>Password</label>
                  <Link to="/forgot-password" style={{ fontSize: 11.5, color: '#14254A', fontWeight: 600, textDecoration: 'none', opacity: 0.6 }}>
                    Forgot password?
                  </Link>
                </div>
                <div className="lp-input-wrap">
                  <div className="lp-input-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  </div>
                  <input type={showPw ? 'text' : 'password'} className="lp-input"
                    style={{ paddingRight: 42 }} placeholder="••••••••••"
                    value={password} onChange={e => setPassword(e.target.value)}
                    required autoComplete="off" />
                  <button type="button" className="lp-eye" onClick={() => setShowPw(v => !v)}>
                    {showPw
                      ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </div>

              <button type="submit" disabled={loading} className="lp-btn"
                style={{ opacity: loading ? 0.72 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}>
                {loading
                  ? <><span className="lp-spin" /> Signing in…</>
                  : <>Sign in <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg></>
                }
              </button>
            </form>

            <p style={{ marginTop: 18, textAlign: 'center', fontSize: 13, color: '#64748b' }}>
              Don&apos;t have an account?{' '}
              <Link to="/register" style={{ color: '#14254A', fontWeight: 700, textDecoration: 'none' }}>
                Create one
              </Link>
            </p>
    </AuthShell>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
