'use client'

/*
 * Security policy — how long a password lives, and what happens when somebody
 * gets one wrong too many times.
 *
 * Super Admin only, enforced on the server (main.go routes this through
 * saAuth). This screen is the readable form of one database row; the numbers on
 * it are the ones the login path actually reads, so every field says what it
 * does to somebody signing in rather than naming the column it writes.
 */

import { useCallback, useEffect, useState } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import BackToConfiguration from '@/components/admin/BackToConfiguration'

const NAVY = '#14254A'

interface Policy {
  passwordExpiryDays: number
  warnDays: string
  emailWarnDays: string
  maxFailedLogins: number
  lockoutHours: number
  otpMaxAttempts: number
  otpLockoutHours: number
}
interface Locked {
  accountType: string; accountId: number; kind: string
  failCount: number; lockedUntil: string; email: string; name: string
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-gray-500 dark:text-white/45 mt-1 leading-relaxed">{hint}</p>}
    </div>
  )
}

const inputCls =
  'w-full rounded-xl px-3 py-2.5 text-sm border border-gray-200 bg-white text-[#14254A] ' +
  'focus:outline-none focus:border-[#14254A] dark:bg-white/5 dark:border-white/15 dark:text-white'

export default function SecurityPolicyPage() {
  const [p, setP] = useState<Policy | null>(null)
  const [locked, setLocked] = useState<Locked[]>([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/security-policy', { credentials: 'include' })
      if (r.status === 403) { setErr('Only a Super Admin can open this page.'); return }
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not load the policy'); return }
      setP(j.policy)
      setErr('')
    } catch (e: any) { setErr(e?.message || 'Network error') }
  }, [])

  const loadLocked = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/security-policy/locked', { credentials: 'include' })
      const j = await r.json()
      setLocked(j.locked || [])
    } catch { /* the list is supplementary; the form still works without it */ }
  }, [])

  useEffect(() => { load(); loadLocked() }, [load, loadLocked])

  async function save() {
    if (!p) return
    setBusy('save'); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/admin/security-policy', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not save'); return }
      setMsg('Saved. It applies to the next sign-in attempt.')
      await load()
    } catch (e: any) { setErr(e?.message || 'Network error') }
    finally { setBusy('') }
  }

  async function unlock(l: Locked) {
    setBusy(`unlock-${l.accountType}-${l.accountId}`); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/admin/security-policy/unlock', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountType: l.accountType, accountId: l.accountId }),
      })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not unlock'); return }
      setMsg(`${l.email || 'That account'} can sign in again.`)
      await loadLocked()
    } finally { setBusy('') }
  }

  async function sendWarnings() {
    setBusy('warn'); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/admin/security-policy/send-warnings', {
        method: 'POST', credentials: 'include',
      })
      const j = await r.json()
      setMsg(j.sent > 0
        ? `${j.sent} warning email(s) sent.`
        : 'Nothing to send — no password is at a warning threshold today.')
    } finally { setBusy('') }
  }

  if (err && !p) return <div className="p-6"><p className="text-sm text-red-600">{err}</p></div>
  if (!p) return <div className="p-6"><p className="text-sm text-gray-500">Loading…</p></div>

  const num = (k: keyof Policy) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP({ ...p, [k]: Math.max(0, +e.target.value || 0) } as Policy)

  return (
    <div className="p-6 fade-in">
      <BackToConfiguration />
      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration', href: '/admin/configuration' }, { label: 'Security Policy' }]}
        title="Security Policy"
        description="How long a password lives, when people are warned, and what happens after too many wrong attempts."
      />

      {err && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mb-4">{err}</p>}
      {msg && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 mb-4">{msg}</p>}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">

        {/* ── Password lifetime ─────────────────────────────────────────── */}
        <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-6">
          <h3 className="font-semibold text-[#14254A] dark:text-white mb-1">Password lifetime</h3>
          <p className="text-xs text-gray-500 dark:text-white/45 mb-4">
            Everyone is covered — client logins and portal staff alike.
          </p>

          <div className="space-y-4">
            <Field label="Expires after (days)"
              hint="0 switches expiry off entirely — nobody is warned and no password ever expires.">
              <input type="number" min={0} max={3650} value={p.passwordExpiryDays}
                onChange={num('passwordExpiryDays')} className={inputCls} />
            </Field>

            <Field label="Warn on screen (days before)"
              hint="Comma separated. 3,2,1 shows the banner on each of the last three days, with a Change password button on it.">
              <input value={p.warnDays} onChange={e => setP({ ...p, warnDays: e.target.value })}
                placeholder="3,2,1" className={inputCls} />
            </Field>

            <Field label="Email warning (days before)"
              hint="Comma separated, and deliberately shorter than the on-screen list — being told on screen every day is reasonable, being emailed every day is not. Leave empty to send no email at all.">
              <input value={p.emailWarnDays} onChange={e => setP({ ...p, emailWarnDays: e.target.value })}
                placeholder="2,1" className={inputCls} />
            </Field>

            <div className="rounded-xl bg-gray-50 dark:bg-white/[0.04] px-3.5 py-3">
              <p className="text-[11px] text-gray-500 dark:text-white/45 leading-relaxed">
                The wording of that email is a template like any other — edit it under{' '}
                <b className="text-[#14254A] dark:text-white">Configuration → Email Templates</b>, event{' '}
                <code>password_expiry_warning</code>. The sweep runs hourly and never sends the same
                warning twice.
              </p>
              <button onClick={sendWarnings} disabled={!!busy}
                className="mt-2 px-3 py-1.5 rounded-lg text-[11px] font-bold border border-gray-200
                  text-gray-600 hover:bg-white disabled:opacity-50
                  dark:border-white/15 dark:text-white/60">
                {busy === 'warn' ? 'Sending…' : 'Run the sweep now'}
              </button>
            </div>
          </div>
        </div>

        {/* ── Lockout ───────────────────────────────────────────────────── */}
        <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-6">
          <h3 className="font-semibold text-[#14254A] dark:text-white mb-1">Too many wrong attempts</h3>
          <p className="text-xs text-gray-500 dark:text-white/45 mb-4">
            A lock lifts by itself when its time is up. Resetting the password lifts it immediately,
            which is the route to give anyone who cannot wait.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Wrong passwords" hint="0 switches password lockout off.">
              <input type="number" min={0} max={100} value={p.maxFailedLogins}
                onChange={num('maxFailedLogins')} className={inputCls} />
            </Field>
            <Field label="Locked for (hours)">
              <input type="number" min={0} max={720} value={p.lockoutHours}
                onChange={num('lockoutHours')} className={inputCls} />
            </Field>
            <Field label="Wrong OTP codes" hint="0 switches OTP lockout off.">
              <input type="number" min={0} max={100} value={p.otpMaxAttempts}
                onChange={num('otpMaxAttempts')} className={inputCls} />
            </Field>
            <Field label="Locked for (hours)">
              <input type="number" min={0} max={720} value={p.otpLockoutHours}
                onChange={num('otpLockoutHours')} className={inputCls} />
            </Field>
          </div>

          <p className="text-[11px] text-gray-500 dark:text-white/45 mt-3 leading-relaxed">
            OTP failures are counted across codes, not only within one — otherwise requesting a fresh
            code resets the count and the limit means nothing.
          </p>

          {/* ── Who is locked right now ───────────────────────────────── */}
          <div className="mt-5 pt-5 border-t border-gray-100 dark:border-white/10">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-bold text-[#14254A] dark:text-white">
                Locked now {locked.length > 0 && <span className="text-gray-400 font-semibold">· {locked.length}</span>}
              </h4>
              <button onClick={loadLocked} className="text-[11px] font-bold text-gray-400 hover:text-[#14254A]">
                Refresh
              </button>
            </div>
            {locked.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-white/45">No account is locked.</p>
            ) : (
              <div className="space-y-1.5">
                {locked.map(l => (
                  <div key={`${l.accountType}-${l.accountId}-${l.kind}`}
                    className="flex items-center gap-2 rounded-xl border border-gray-100 dark:border-white/10 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-[#14254A] dark:text-white truncate">
                        {l.name || l.email || `#${l.accountId}`}
                      </p>
                      <p className="text-[11px] text-gray-500 dark:text-white/45 truncate">
                        {l.failCount} wrong {l.kind === 'otp' ? 'codes' : 'passwords'} · until {l.lockedUntil} UTC
                      </p>
                    </div>
                    <button onClick={() => unlock(l)} disabled={!!busy}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-bold border border-gray-200
                        text-gray-600 hover:bg-gray-50 disabled:opacity-50
                        dark:border-white/15 dark:text-white/60 flex-shrink-0">
                      Unlock
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={save} disabled={!!busy}
          className="px-5 py-2.5 text-sm font-semibold text-white rounded-xl disabled:opacity-50"
          style={{ background: NAVY }}>
          {busy === 'save' ? 'Saving…' : 'Save policy'}
        </button>
        <span className="text-xs text-gray-500 dark:text-white/45">
          Applies to the next sign-in attempt — nobody is signed out.
        </span>
      </div>
    </div>
  )
}
