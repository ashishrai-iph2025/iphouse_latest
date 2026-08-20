'use client'

/*
 * What the security policy currently says about one login account.
 *
 * Shown inside the account drawer on /admin/registrations, because the moment
 * somebody opens an account is the moment they want to know why that person
 * cannot get in. Three questions, in the order they get asked: when does the
 * password expire, were they told, and are they locked.
 *
 * Read-only. Every action that could change any of this — reset, unlock, change
 * the policy — lives somewhere else with its own confirmation. A panel that
 * informs and also acts is how an accidental unlock happens.
 */

import { useCallback, useEffect, useState } from 'react'

interface Expiry {
  enabled: boolean; daysRemaining: number; expiresOn: string; expired: boolean; warn: boolean
}
interface Notice { expiresOn: string; warnDay: number; sentAt: string }
interface Pending { warnDay: number; dueOn: string }
interface Lock {
  kind: string; failCount: number; lockedUntil: string; lastFailAt: string; active: boolean
}
interface Sibling { loginId: number; passwordChangedAt: string }

interface Detail {
  username: string
  policy: {
    enabled: boolean; passwordExpiryDays: number
    warnDays: number[]; emailWarnDays: number[]
    maxFailedLogins: number; lockoutHours: number
    otpMaxAttempts: number; otpLockoutHours: number
  }
  accountCreated: string
  lastSeen: string
  passwordChangedAt: string
  passwordNeverStamped: boolean
  passwordAgeDays?: number
  expiry: Expiry
  noticesSent: Notice[]
  noticesPending: Pending[]
  locks: Lock[]
  locked: boolean
  siblingLogins?: Sibling[]
  siblingMismatch?: boolean
}

/** "14 Aug 2026, 09:12" from the server's "2026-08-14 09:12:00". Parsed as UTC
    because that is what the server stamps, and rendered in the reader's zone —
    an admin comparing this against a support ticket is working in local time. */
function when(s: string): string {
  if (!s) return '—'
  const d = new Date(s.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return s
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
function day(s: string): string {
  if (!s) return '—'
  const d = new Date(s + 'T00:00:00Z')
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
}

const NAVY = '#14254A'
const ORANGE = '#FC934C'

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'warn' | 'bad' | 'ok' }) {
  const colour = tone === 'bad'
    ? 'text-red-600 dark:text-red-300'
    : tone === 'warn'
      ? 'text-amber-700 dark:text-amber-300'
      : tone === 'ok'
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-[#14254A] dark:text-white'
  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-gray-50 dark:border-white/[0.06] last:border-0">
      <span className="w-36 flex-shrink-0 text-[10px] font-bold uppercase tracking-wider text-gray-400">
        {label}
      </span>
      <span className={`text-sm font-medium ${colour}`}>{value}</span>
    </div>
  )
}

/** A sub-heading with an accent rule, so the three groups inside one card are
    still told apart without three more borders. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 first:mt-0">
      <h4 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest
        text-[#14254A] dark:text-white mb-2">
        <span className="w-1 h-3 rounded-full flex-shrink-0" style={{ background: ORANGE }} />
        {title}
      </h4>
      {children}
    </div>
  )
}

export default function LoginSecurityPanel({ loginId }: { loginId: number }) {
  const [d, setD] = useState<Detail | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    if (!loginId) return
    setErr('')
    try {
      const r = await fetch(`/api/admin/login-security?loginId=${loginId}`, { credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not read the security detail'); return }
      setD(j)
    } catch (e: any) { setErr(e?.message || 'Network error') }
  }, [loginId])

  useEffect(() => { load() }, [load])

  /* The frame stays up whatever happens inside it. A bare red sentence where
     the panel should be reads as a stray form error — which is exactly how the
     first version of this looked when the endpoint failed — rather than as the
     security section having a problem. */
  if (err || !d) {
    return (
      <div className="rounded-2xl border border-gray-100 dark:border-white/10
        bg-white dark:bg-[#1a2d55] shadow-card p-4">
        <h3 className="text-sm font-bold text-[#14254A] dark:text-white mb-2">Password &amp; security</h3>
        {err ? (
          <>
            <p className="text-xs text-red-600 dark:text-red-300 leading-relaxed">{err}</p>
            <button onClick={load}
              className="mt-2 px-3 py-1.5 rounded-lg text-[11px] font-bold border border-gray-200
                text-gray-600 hover:bg-white dark:border-white/15 dark:text-white/60">
              Try again
            </button>
          </>
        ) : (
          <p className="text-xs text-gray-400">Reading the security detail…</p>
        )}
      </div>
    )
  }

  const e = d.expiry
  const expiryValue = !e.enabled
    ? 'Password expiry is switched off'
    : e.expired
      ? `Expired on ${day(e.expiresOn)}`
      : e.daysRemaining === 0
        ? `Expires today (${day(e.expiresOn)})`
        : e.daysRemaining === 1
          ? `Expires tomorrow (${day(e.expiresOn)})`
          : `${e.daysRemaining} days left — ${day(e.expiresOn)}`
  const expiryTone = !e.enabled ? undefined : e.expired ? 'bad' : e.warn ? 'warn' : 'ok'

  return (
    <div className="rounded-2xl border border-gray-100 dark:border-white/10
      bg-white dark:bg-[#1a2d55] shadow-card overflow-hidden">

      {/* Its own header band, matching the form sections above it — and a
          status pill, because "is anything wrong with this account" should be
          answerable without reading the three groups below. */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-gray-100 dark:border-white/10">
        <span className="w-7 h-7 rounded-lg grid place-items-center flex-shrink-0"
          style={{ background: 'rgba(252,147,76,0.14)' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={ORANGE}
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-bold uppercase tracking-widest text-[#14254A] dark:text-white">
            Password &amp; security
          </span>
          <span className="block text-[10px] text-gray-400 truncate">
            What the policy currently says about this account
          </span>
        </span>

        {(d.locked || e.expired || e.warn) && (
          <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider flex-shrink-0 ${
            d.locked || e.expired
              ? 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300'
              : 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'}`}>
            {d.locked ? 'Locked' : e.expired ? 'Expired' : 'Expiring'}
          </span>
        )}

        <button onClick={load}
          className="text-[10px] font-bold uppercase tracking-wider text-gray-400
            hover:text-[#14254A] dark:hover:text-white flex-shrink-0">
          Refresh
        </button>
      </div>

      <div className="p-4">

      {/* ── Where the password stands ─────────────────────────────────────── */}
      <Section title="Password">
        <Row label="Last changed"
          value={d.passwordNeverStamped
            ? 'Never recorded — this account predates the policy'
            : `${when(d.passwordChangedAt)}${d.passwordAgeDays != null ? ` · ${d.passwordAgeDays} days ago` : ''}`}
          tone={d.passwordNeverStamped ? 'warn' : undefined} />
        <Row label="Expires" value={expiryValue} tone={expiryTone} />
        {d.policy.enabled && (
          <Row label="Policy" value={`Every ${d.policy.passwordExpiryDays} days`} />
        )}
        <Row label="Account created" value={when(d.accountCreated)} />
        <Row label="Last signed in" value={when(d.lastSeen)} />
      </Section>

      {/* ── Warnings ──────────────────────────────────────────────────────── */}
      <Section title="Expiry notifications">
        {!d.policy.enabled || d.policy.emailWarnDays.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-white/45">
            No expiry email is configured — the policy sends none.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-gray-500 dark:text-white/45 mb-1.5">
              Sent {d.policy.emailWarnDays.join(' and ')} day
              {d.policy.emailWarnDays.length === 1 && d.policy.emailWarnDays[0] === 1 ? '' : 's'} before expiry.
            </p>

            {d.noticesSent.length === 0 && d.noticesPending.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-white/45">
                Nothing sent yet — this password is not close enough to expiry.
              </p>
            )}

            {d.noticesSent.map(n => (
              <div key={`${n.expiresOn}-${n.warnDay}`}
                className="flex items-center gap-2 py-1 text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                <span className="text-[#14254A] dark:text-white font-medium">
                  {n.warnDay} day{n.warnDay === 1 ? '' : 's'} before
                </span>
                <span className="text-gray-500 dark:text-white/45">
                  sent {when(n.sentAt)}
                  {/* The expiry it was ABOUT — a notice from the previous period
                      is not evidence about this one. */}
                  {' '}· for {day(n.expiresOn)}
                </span>
              </div>
            ))}

            {d.noticesPending.map(n => (
              <div key={`p-${n.warnDay}`} className="flex items-center gap-2 py-1 text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-300 flex-shrink-0" />
                <span className="text-[#14254A] dark:text-white font-medium">
                  {n.warnDay} day{n.warnDay === 1 ? '' : 's'} before
                </span>
                <span className="text-gray-500 dark:text-white/45">due {day(n.dueOn)}</span>
              </div>
            ))}
          </>
        )}
      </Section>

      {/* ── Locks ─────────────────────────────────────────────────────────── */}
      <Section title="Sign-in attempts">
        <p className="text-[11px] text-gray-500 dark:text-white/45 mb-1.5">
          {d.policy.maxFailedLogins > 0
            ? `${d.policy.maxFailedLogins} wrong passwords locks the account for ${d.policy.lockoutHours} hours.`
            : 'Password lockout is switched off.'}
          {d.policy.otpMaxAttempts > 0 &&
            ` ${d.policy.otpMaxAttempts} wrong OTP codes locks it for ${d.policy.otpLockoutHours} hours.`}
        </p>

        {d.locks.length === 0 ? (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            No failed attempts on record.
          </p>
        ) : d.locks.map(l => (
          <div key={l.kind} className="flex items-start gap-2 py-1 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${
              l.active ? 'bg-red-500' : 'bg-gray-300'}`} />
            <span>
              <span className="text-[#14254A] dark:text-white font-medium">
                {l.failCount} wrong {l.kind === 'otp' ? 'code' : 'password'}{l.failCount === 1 ? '' : 's'}
              </span>
              <span className="text-gray-500 dark:text-white/45">
                {' '}· last {when(l.lastFailAt)}
              </span>
              {l.active ? (
                <span className="block text-red-600 dark:text-red-300 font-semibold mt-0.5">
                  Locked until {when(l.lockedUntil)} — it lifts by itself, or a password reset
                  unlocks it immediately.
                </span>
              ) : (
                <span className="block text-gray-500 dark:text-white/45 mt-0.5">
                  Not locked{l.lockedUntil ? ` · last lock lifted ${when(l.lockedUntil)}` : ''}.
                </span>
              )}
            </span>
          </div>
        ))}
      </Section>

      {/* Only when it is actually wrong. A correct set of siblings is not worth
          a paragraph; a mismatched one is the invisible cause of a warning
          nobody can explain, so it gets said outright. */}
      {d.siblingMismatch && (
        <div className="mt-4 rounded-xl border border-amber-300/70 bg-amber-50/60 px-3 py-2
          dark:border-amber-400/30 dark:bg-amber-500/[0.07]">
          <p className="text-[11px] text-amber-800 dark:text-amber-200 leading-relaxed">
            <b>These logins disagree about when the password changed.</b> This username has{' '}
            {d.siblingLogins?.length} active rows and they carry different dates, so one of them may
            warn about a password that has already been changed. Changing the password again from the
            profile screen re-stamps them all.
          </p>
        </div>
      )}
      </div>
    </div>
  )
}
