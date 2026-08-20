'use client'

/*
 * "Your password expires in N days" — and the means to do something about it.
 *
 * The warning and the remedy are ONE component on purpose. A banner that only
 * announces the problem sends somebody hunting for a settings page; staff do
 * not have one at all, so for them a link would have been a dead end. Carrying
 * its own form means the action button does the thing it names, in both shells,
 * without a route that has to exist first.
 *
 * What counts as "expiring soon" is not decided here. The server grades the
 * password against the security policy and sends back `warn` — so changing the
 * thresholds on the policy screen changes this banner, and nobody has to
 * remember that a second copy of "3, 2, 1" lives in the front end.
 */

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface Status {
  enabled: boolean
  daysRemaining: number
  expiresOn: string
  expired: boolean
  warn: boolean
}

export default function PasswordExpiryBanner() {
  const [status, setStatus] = useState<Status | null>(null)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  /* Dismissal is per page load and deliberately NOT persisted. Someone who
     dismisses this on Monday still needs to see it on Tuesday — the deadline
     has moved a day closer, which is the whole point of a countdown. */
  const [dismissed, setDismissed] = useState(false)

  const [form, setForm] = useState({ current: '', newPass: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/password-status', { credentials: 'include' })
      if (!r.ok) return          // not signed in, or expiry is switched off
      const j = await r.json()
      if (j?.passwordExpiry) setStatus(j.passwordExpiry)
    } catch { /* a banner that cannot load is simply not shown */ }
  }, [])

  useEffect(() => { load() }, [load])

  async function submit() {
    setMsg('')
    if (form.newPass.length < 8) { setMsg('New password must be at least 8 characters.'); return }
    if (form.newPass !== form.confirm) { setMsg('The two new passwords do not match.'); return }
    if (form.newPass === form.current) { setMsg('The new password must be different from the current one.'); return }

    setBusy(true)
    try {
      const r = await fetch('/api/profile/change-password', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: form.current, newPass: form.newPass }),
      })
      const j = await r.json()
      if (!j.success) { setMsg(j.error || 'Could not change your password.'); return }
      setDone(true)
      setForm({ current: '', newPass: '', confirm: '' })
      // Re-asked rather than assumed: the server restarts the clock, and the
      // banner should disappear because the server says so.
      await load()
      setTimeout(() => { setOpen(false); setDone(false) }, 1600)
    } catch (e: any) {
      setMsg(e?.message || 'Network error')
    } finally { setBusy(false) }
  }

  if (!status?.enabled || !status.warn || dismissed) return null

  const urgent = status.expired || status.daysRemaining <= 1
  const headline = status.expired
    ? 'Your password has expired'
    : status.daysRemaining === 0
      ? 'Your password expires today'
      : status.daysRemaining === 1
        ? 'Your password expires tomorrow'
        : `Your password expires in ${status.daysRemaining} days`

  const input = 'w-full rounded-xl px-3 py-2.5 text-sm border border-gray-200 bg-white text-[#14254A] ' +
    'focus:outline-none focus:border-[#14254A] dark:bg-white/5 dark:border-white/15 dark:text-white'

  return (
    <>
      <div className={`flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm border-b ${urgent
        ? 'bg-red-50 border-red-200 text-red-800 dark:bg-red-500/10 dark:border-red-400/25 dark:text-red-200'
        : 'bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-500/10 dark:border-amber-400/25 dark:text-amber-200'}`}>
        <span className="font-bold">{headline}</span>
        <span className="opacity-80 text-[13px]">
          {status.expired
            ? 'Change it now to keep using your account.'
            : `It expires on ${status.expiresOn}. Change it now and nothing is interrupted.`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button onClick={() => setOpen(true)}
            className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-white bg-[#14254A] hover:opacity-90 transition-opacity">
            Change password
          </button>
          {/* An EXPIRED password cannot be dismissed. There is nothing to defer
              to — the next thing that happens either way is being asked to
              change it. */}
          {!status.expired && (
            <button onClick={() => setDismissed(true)} aria-label="Dismiss"
              className="w-6 h-6 grid place-items-center rounded-md opacity-50 hover:opacity-100">✕</button>
          )}
        </span>
      </div>

      {open && mounted && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
          <div className="admin-modal-panel bg-white dark:bg-[#1a2d55]"
            style={{ borderRadius: 16, width: '100%', maxWidth: 440, boxShadow: '0 24px 60px rgba(2,18,46,0.18)' }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f0f0f0',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }} className="text-[#14254A] dark:text-white">
                Change your password
              </h3>
              <button onClick={() => { setOpen(false); setMsg('') }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 20, padding: 4 }}>
                ✕
              </button>
            </div>

            <div style={{ padding: '20px 24px' }} className="space-y-3">
              {done ? (
                <p className="text-sm text-emerald-700 dark:text-emerald-300 font-semibold py-4 text-center">
                  Password changed. Your next expiry has been reset.
                </p>
              ) : (
                <>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-1">
                      Current password
                    </label>
                    <input type="password" autoComplete="current-password" className={input}
                      value={form.current} onChange={e => setForm(f => ({ ...f, current: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-1">
                      New password
                    </label>
                    <input type="password" autoComplete="new-password" className={input}
                      value={form.newPass} onChange={e => setForm(f => ({ ...f, newPass: e.target.value }))} />
                    <p className="text-[11px] text-gray-400 mt-1">At least 8 characters.</p>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-1">
                      Confirm new password
                    </label>
                    <input type="password" autoComplete="new-password" className={input}
                      value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} />
                  </div>
                  {msg && <p className="text-xs text-red-600 dark:text-red-300">{msg}</p>}
                </>
              )}
            </div>

            {!done && (
              <div style={{ padding: '12px 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => { setOpen(false); setMsg('') }} disabled={busy}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600
                    hover:bg-gray-50 disabled:opacity-50 dark:border-white/15 dark:text-white/60">
                  Cancel
                </button>
                <button onClick={submit} disabled={busy || !form.current || !form.newPass}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white bg-[#14254A]
                    hover:opacity-90 disabled:opacity-50">
                  {busy ? 'Saving…' : 'Change password'}
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
