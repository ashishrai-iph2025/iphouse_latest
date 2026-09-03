'use client'

import { useState } from 'react'
import { Link } from 'react-router-dom'
import AuthShell from '@/components/auth/AuthShell'

export default function RegisterPage() {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', designation: '', remarks: '',
  })
  const [error,   setError]   = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  /* What the server says about the address typed so far.
     'unknown' also covers the case where it declines to distinguish — see
     AUTH_HIDE_UNKNOWN_EMAIL — and the form then submits and lets the server
     answer, exactly as it did before this check existed. */
  type MailState = 'idle' | 'checking' | 'available' | 'account' | 'pending' | 'unknown'
  const [mailState, setMailState] = useState<MailState>('idle')

  // Only a plausible address is worth a round trip; the auth routes allow ten
  // a minute and a check per keystroke would spend that before the domain is
  // finished.
  const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
    if (e.target.name === 'email') {
      // A verdict about the previous address must not linger over a new one.
      setMailState('idle')
      if (error) setError('')
    }
  }

  /* Checked when the field is left, so someone learns they already have an
     account while they are still looking at the address — rather than after
     filling in the rest of the form, submitting, and being turned away. */
  async function checkEmail(value: string): Promise<boolean> {
    const v = value.trim()
    if (!looksLikeEmail(v)) { setMailState('idle'); return true }
    setMailState('checking')
    try {
      const res  = await fetch('/api/auth/check-email', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: v }),
      })
      const data = await res.json()
      if (!data.success || data.checked === false) { setMailState('unknown'); return true }
      const st = data.status as MailState
      setMailState(st)
      return st === 'available'
    } catch {
      // A failed check must not block a legitimate sign-up: fall through and
      // let the server have the final say, which it does regardless.
      setMailState('unknown')
      return true
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      /* Re-checked on submit rather than trusting the field state: an autofill
         followed by Enter never blurs the input, and the answer can change
         between typing and submitting. The server checks again either way —
         this only saves filling in a form that cannot be accepted. */
      if (!(await checkEmail(form.email))) return

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
        // The server names which of the two it was, so the field can show the
        // same guidance the inline check would have.
        if (data.reason === 'account' || data.reason === 'pending') setMailState(data.reason)
        setError(data.error || 'Registration failed. Please try again.')
      }
    } catch {
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      wide
      eyebrow="Request access"
      title={<>Get your team on<br />the <em>platform</em>.</>}
      lede={<>
        Tell us who you are and which dashboards you need. Requests are reviewed
        within 24&ndash;48 hours, and credentials are emailed once approved.
      </>}
    >
      {success ? (
        <div className="lp-done">
          <div className="lp-tick">&#10003;</div>
          <h2>Request submitted</h2>
          <p className="lp-card-sub">
            Your registration has been received. We take 24&ndash;48 hours to validate it,
            and once you are enrolled your login credentials are sent to the email
            address you gave us.
          </p>
          <Link to="/login" className="lp-back">&larr; Back to sign in</Link>
        </div>
      ) : (
        <>
          <h2>Registration form</h2>
          <p className="lp-card-sub">
            Submit your details. Credentials are emailed after approval.
          </p>

          {error && (
            <div className="lp-error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="lp-form">
            <div className="lp-row">
              <div>
                <label className="lp-label">First name <span className="lp-req">*</span></label>
                <input autoComplete="off" type="text" name="first_name" placeholder="First name"
                  value={form.first_name} onChange={handleChange} required
                  className="lp-input lp-input-plain" />
              </div>
              <div>
                <label className="lp-label">Last name <span className="lp-req">*</span></label>
                <input autoComplete="off" type="text" name="last_name" placeholder="Last name"
                  value={form.last_name} onChange={handleChange} required
                  className="lp-input lp-input-plain" />
              </div>
            </div>

            <div className="lp-row">
              <div>
                <label className="lp-label">Email address <span className="lp-req">*</span></label>
                <input autoComplete="off" type="email" name="email" placeholder="you@example.com"
                  value={form.email} onChange={handleChange}
                  onBlur={e => { void checkEmail(e.target.value) }} required
                  className="lp-input lp-input-plain"
                  style={{ borderColor:
                    mailState === 'account' || mailState === 'pending' ? '#e05252'
                    : mailState === 'available' ? '#16A34A' : undefined }} />

                {/* The answer under the field, where the reader is looking, and
                    each state gets the action that resolves it — a message that
                    says only "cannot register" leaves somebody who already has an
                    account with no idea what to do instead. */}
                <div className="lp-hint">
                  {mailState === 'checking' && <span>Checking&hellip;</span>}
                  {mailState === 'available' && <span className="lp-hint-ok">&#10003; Available</span>}
                  {mailState === 'account' && (
                    <span className="lp-hint-bad">
                      You already have an account.{' '}
                      <Link to="/login">Sign in</Link>
                      {' · '}
                      <Link to="/forgot-password">Forgot password</Link>
                    </span>
                  )}
                  {mailState === 'pending' && (
                    <span className="lp-hint-wait">
                      A request for this email is already awaiting review &mdash; you will be
                      emailed once it is approved.
                    </span>
                  )}
                </div>
              </div>
              <div>
                <label className="lp-label">Designation</label>
                <input autoComplete="off" type="text" name="designation" placeholder="Your role or title"
                  value={form.designation} onChange={handleChange}
                  className="lp-input lp-input-plain" />
              </div>
            </div>

            <div>
              <label className="lp-label">Remarks</label>
              <textarea name="remarks" rows={4}
                placeholder="Please mention the dashboard or client name you need access to."
                value={form.remarks} onChange={handleChange}
                className="lp-input lp-input-plain lp-textarea" />
            </div>

            {/* Blocked only on the two answers that cannot succeed. 'unknown' and
                'idle' stay submittable, so a failed check never stops a
                legitimate sign-up. */}
            <button type="submit"
              disabled={loading || mailState === 'checking' || mailState === 'account' || mailState === 'pending'}
              className="lp-btn"
              style={{
                opacity: loading || mailState === 'account' || mailState === 'pending' ? 0.62 : 1,
                cursor: loading || mailState === 'account' || mailState === 'pending' ? 'not-allowed' : 'pointer',
              }}>
              {loading ? <><span className="lp-spin" /> Submitting&hellip;</>
                : mailState === 'checking' ? 'Checking&hellip;'
                : 'Submit registration'}
            </button>
          </form>

          <p className="lp-alt">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </>
      )}
    </AuthShell>
  )
}
