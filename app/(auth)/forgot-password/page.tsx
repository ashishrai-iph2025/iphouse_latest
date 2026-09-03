'use client'
import { usePasswordPolicy, checkPassword, PasswordRules } from '@/lib/passwordPolicy'

import { useState } from 'react'
import { Link } from 'react-router-dom'
import AuthShell from '@/components/auth/AuthShell'

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

  /* Whether the address typed so far belongs to an account.
     'unknown' also covers the case where the server declines to say — see
     AUTH_HIDE_UNKNOWN_EMAIL — and the form then behaves as it did before,
     submitting and letting the reset endpoint answer. */
  const [emailState, setEmailState] = useState<'idle' | 'checking' | 'found' | 'missing' | 'unknown'>('idle')

  /* Only a syntactically plausible address is worth asking the server about.
     Firing on every keystroke would spend the 10/min rate limit before the
     reader finished typing their own domain. */
  const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

  /* Checked when the field is left, not on every keystroke. The point is to say
     "that address has no account here" while the reader is still looking at the
     field — rather than after they have submitted, been told to check their
     email, and gone to wait at an inbox nothing is coming to. */
  async function checkEmail(value: string): Promise<boolean> {
    const v = value.trim()
    if (!looksLikeEmail(v)) { setEmailState('idle'); return true }
    setEmailState('checking')
    try {
      const res  = await fetch('/api/auth/check-email', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: v }),
      })
      const data = await res.json()
      // `checked: false` means the server is configured not to distinguish.
      // Treat that as "carry on" so the form works under either setting.
      if (!data.success || data.checked === false) { setEmailState('unknown'); return true }
      if (data.exists) { setEmailState('found'); setError(''); return true }
      setEmailState('missing')
      setError('No account is registered with that email address.')
      return false
    } catch {
      // A failed check must not block a legitimate reset: fall through to the
      // submit, where the server has the final say either way.
      setEmailState('unknown')
      return true
    }
  }

  // ── Step 1: send reset token to email ──────────────────────────────────────
  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    /* Re-checked on submit rather than trusting the field state. The blur check
       may never have run — a browser autofill plus Enter never blurs the input —
       and the account could have been deactivated in between. The server checks
       again regardless; this is only so the reader is not made to wait for a
       round trip that ends in the same message. */
    setLoading(true)
    try {
      if (!(await checkEmail(email))) return

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

  const policy = usePasswordPolicy()

  // ── Step 2: paste token + set new password ──────────────────────────────────
  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    const token = resetToken.replace(/\s+/g, '')
    if (!token)                { setError('Please paste the reset token from your email.'); return }
    if (newPass !== confirmPas) { setError('Passwords do not match.'); return }
    const bad = checkPassword(newPass, policy)
    if (bad)                   { setError(bad); return }
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
    <AuthShell
      eyebrow="Account recovery"
      title={<>Reset your<br /><em>password</em>.</>}
      lede={<>
        We will email you a one-time reset token. Paste it back here with a new
        password and you are straight back in.
      </>}
    >
      {/* Where the reader is in the two steps. Dots rather than "Step 1 of 2":
          the shape says it faster than the sentence does, and the sentence is
          the same length either way. */}
      {step !== 'done' && (
        <div className="lp-steps-dots" aria-label={`Step ${stepNum} of 2`}>
          <i className="on" />
          <i className={step === 'reset' ? 'on' : ''} />
          <span style={{ fontSize: 11.5, fontWeight: 700, color: '#8a96a8', marginLeft: 4 }}>
            {step === 'email' ? 'Enter email' : 'Reset password'}
          </span>
        </div>
      )}

      {error && (
        <div className="lp-error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          {error}
        </div>
      )}

      {step === 'email' && (
        <>
          <h2>Forgot your password?</h2>
          <p className="lp-card-sub">
            Enter the email address on your account and we will send a reset token to it.
          </p>

          <form onSubmit={handleSend} className="lp-form">
            <div>
              <label className="lp-label">Email address <span className="lp-req">*</span></label>
              <input autoComplete="off" type="email" value={email}
                onChange={e => {
                  setEmail(e.target.value)
                  // A verdict about the previous value must not linger over the new one.
                  setEmailState('idle')
                  if (error) setError('')
                }}
                onBlur={e => { void checkEmail(e.target.value) }}
                required placeholder="you@example.com"
                className="lp-input lp-input-plain"
                style={{ borderColor: emailState === 'missing' ? '#e05252'
                       : emailState === 'found' ? '#16A34A' : undefined }} />

              {/* One line under the field, so the answer is where the reader is
                  looking rather than only in the banner above. */}
              <div className="lp-hint">
                {emailState === 'checking' && <span>Checking&hellip;</span>}
                {emailState === 'found' && <span className="lp-hint-ok">&#10003; Account found</span>}
                {emailState === 'missing' && (
                  <span className="lp-hint-bad">
                    No account is registered with this email.{' '}
                    <Link to="/login">Back to sign in</Link>
                  </span>
                )}
              </div>
            </div>

            <button type="submit"
              disabled={loading || emailState === 'checking' || emailState === 'missing'}
              className="lp-btn"
              style={{
                opacity: loading || emailState === 'missing' ? 0.62 : 1,
                cursor: loading || emailState === 'missing' ? 'not-allowed' : 'pointer',
              }}>
              {loading ? <><span className="lp-spin" /> Sending&hellip;</>
                : emailState === 'checking' ? 'Checking…'
                : 'Send reset token'}
            </button>
          </form>

          <p className="lp-alt">
            Remembered it? <Link to="/login">Back to sign in</Link>
          </p>
        </>
      )}

      {step === 'reset' && (
        <>
          <h2>Check your email</h2>
          <p className="lp-card-sub">
            Paste the reset token we sent you, then choose a new password.
          </p>

          <form onSubmit={handleReset} className="lp-form">
            <div>
              <label className="lp-label">Reset token <span className="lp-req">*</span></label>
              <textarea value={resetToken} onChange={e => setResetToken(e.target.value)}
                rows={3} placeholder="Paste the reset token from your email&hellip;"
                className="lp-input lp-input-plain lp-textarea"
                style={{ minHeight: 76, fontSize: 12.5 }} />
            </div>

            <div>
              <label className="lp-label">New password <span className="lp-req">*</span></label>
              <div className="lp-input-wrap">
                <input type={showPass ? 'text' : 'password'} value={newPass}
                  onChange={e => setNewPass(e.target.value)} required minLength={policy.minLength}
                  placeholder={`Minimum ${policy.minLength} characters`}
                  className="lp-input lp-input-plain" style={{ paddingRight: 42 }} />
                <button type="button" className="lp-eye" onClick={() => setShowPass(s => !s)}
                  aria-label={showPass ? 'Hide password' : 'Show password'}>
                  {showPass
                    ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  }
                </button>
              </div>
              <PasswordRules policy={policy} value={newPass} />
            </div>

            <div>
              <label className="lp-label">Confirm password <span className="lp-req">*</span></label>
              <input type={showPass ? 'text' : 'password'} value={confirmPas}
                onChange={e => setConfirmPas(e.target.value)} required minLength={policy.minLength}
                placeholder="Repeat new password" className="lp-input lp-input-plain" />
            </div>

            <button type="submit" disabled={loading} className="lp-btn"
              style={{ opacity: loading ? 0.72 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? <><span className="lp-spin" /> Saving&hellip;</> : 'Reset password'}
            </button>
          </form>

          <p className="lp-alt">
            Didn&apos;t receive the email?{' '}
            <button type="button" onClick={() => { setStep('email'); setError('') }}
              style={{ color: '#14254A', fontWeight: 700, background: 'none', border: 'none',
                cursor: 'pointer', font: 'inherit', padding: 0 }}>
              Try again
            </button>
          </p>
        </>
      )}

      {step === 'done' && (
        <div className="lp-done">
          <div className="lp-tick">&#10003;</div>
          <h2>Password reset</h2>
          <p className="lp-card-sub">
            Your password has been updated. You can sign in with it now.
          </p>
          <Link to="/login" className="lp-btn">Go to sign in</Link>
        </div>
      )}
    </AuthShell>
  )
}
