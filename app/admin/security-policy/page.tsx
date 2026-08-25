'use client'

/*
 * Security policy — how long a password lives, what one has to look like, and
 * what happens when somebody gets one wrong too many times.
 *
 * Super Admin only, enforced on the server (main.go routes this through
 * saAuth). This screen is the readable form of one database row; the numbers on
 * it are the ones the login path actually reads, so every field says what it
 * does to somebody signing in rather than naming the column it writes.
 *
 * Laid out as three columns of settings over one full-width list, rather than
 * the two-column grid it started as. Once a third card was added that grid left
 * half the page empty and pushed the complexity settings below the fold — the
 * part of this screen somebody is most likely to have come here to change.
 *
 * SLIDERS rather than number boxes for everything bounded. Every value here has
 * a real range with a sensible middle, and a slider shows where a setting sits
 * within it: 5 wrong passwords out of a possible 20 reads as lenient at a
 * glance, where the bare number 5 reads as nothing at all. The number is still
 * shown and still typeable, because "exactly 30 days" is the sort of thing a
 * policy document specifies, and dragging to it is slower and less certain than
 * typing it.
 */

import { useCallback, useEffect, useState } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import BackToConfiguration from '@/components/admin/BackToConfiguration'

const NAVY = '#14254A'
const ORANGE = '#FC934C'
const YELLOW = '#FFC82B'
const BLUE = '#0078D4'
const RED = '#DC2626'

interface Policy {
  passwordExpiryDays: number
  warnDays: string
  emailWarnDays: string
  maxFailedLogins: number
  lockoutHours: number
  otpMaxAttempts: number
  otpLockoutHours: number
  passwordMinLength: number
  passwordMinDigits: number
  passwordMinUpper: number
  passwordMinLower: number
  passwordMinSymbols: number
  passwordHistory: number
}
interface Locked {
  accountType: string; accountId: number; kind: string
  failCount: number; lockedUntil: string; email: string; name: string
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

/** A settings card. One subject each, so its heading answers "what am I looking
    at" rather than acting as a section divider. */
function Card({ icon, title, blurb, accent, children }: {
  icon: string; title: string; blurb: string; accent: string; children: React.ReactNode
}) {
  return (
    <div className="relative bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
      dark:border-white/10 p-6 overflow-hidden h-full flex flex-col">
      {/* The rail is the only thing separating these cards at a glance once they
          sit side by side; the colour is what makes the page scannable. */}
      <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: accent }} aria-hidden />
      <div className="flex items-start gap-3 mb-5">
        <div className="w-11 h-11 rounded-xl grid place-items-center text-xl flex-shrink-0"
          style={{ background: `${accent}18` }} aria-hidden>{icon}</div>
        <div className="min-w-0">
          <h3 className="font-semibold text-[#14254A] dark:text-white leading-tight">{title}</h3>
          <p className="text-xs text-gray-500 dark:text-white/45 mt-1 leading-relaxed">{blurb}</p>
        </div>
      </div>
      <div className="flex-1">{children}</div>
    </div>
  )
}

/**
 * A bounded setting: slider, live value, and the number still typeable.
 *
 * `offLabel` is what 0 means for this particular setting. Every switch on this
 * screen is a 0, but 0 days and 0 attempts turn off completely different things,
 * and "Off" on its own leaves the reader to work out which.
 */
function Slider({ label, value, onChange, min, max, step = 1, unit, hint, offLabel, accent }: {
  label: string
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  step?: number
  unit?: string
  hint?: string
  offLabel?: string
  accent: string
}) {
  const off = value === 0 && !!offLabel
  // Where the thumb sits, as a percentage, so the filled part of the track can
  // be painted as a hard-stop gradient rather than a second positioned element
  // that would have to be kept in sync with it.
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  const fill = off ? '#cbd5e1' : accent

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <label className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{label}</label>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <input
            type="number" min={min} max={max} step={step} value={value}
            onChange={e => onChange(Math.min(max, Math.max(min, +e.target.value || 0)))}
            aria-label={label}
            className="w-14 text-right rounded-lg px-2 py-1 text-sm font-bold tabular-nums border
              border-transparent bg-gray-50 text-[#14254A] focus:outline-none focus:border-[#FC934C]
              dark:bg-white/5 dark:text-white"
          />
          {unit && <span className="text-[11px] font-semibold text-gray-400">{unit}</span>}
        </div>
      </div>

      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)}
        className="policy-range"
        data-off={off ? 'true' : 'false'}
        aria-label={label}
        style={{
          background: `linear-gradient(to right, ${fill} 0%, ${fill} ${pct}%, #e5e7eb ${pct}%, #e5e7eb 100%)`,
        }}
      />

      <div className="flex items-start justify-between gap-3 mt-1.5">
        <p className="text-[11px] text-gray-500 dark:text-white/45 leading-relaxed">
          {off ? <span className="font-semibold text-gray-400">{offLabel}</span> : hint}
        </p>
        <span className="text-[10px] text-gray-300 dark:text-white/25 tabular-nums flex-shrink-0">{max}</span>
      </div>
    </div>
  )
}

/** The comma-separated day lists. Still a text field — it is the fastest way to
    type "3,2,1" — but showing what it PARSED to, because a stray character
    silently drops a warning and the chips are the proof it was read. */
function DayList({ label, value, onChange, placeholder, hint, accent }: {
  label: string; value: string; onChange: (v: string) => void
  placeholder: string; hint: string; accent: string
}) {
  const days = value.split(',').map(d => d.trim()).filter(d => /^\d+$/.test(d) && +d > 0)
  return (
    <div>
      <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-2">{label}</label>
      <input
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full rounded-xl px-3 py-2.5 text-sm border border-gray-200 bg-white text-[#14254A]
          focus:outline-none focus:border-[#FC934C] dark:bg-white/5 dark:border-white/15 dark:text-white"
      />
      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        {days.length === 0 ? (
          <span className="text-[11px] text-gray-400 italic">Nothing is sent</span>
        ) : days.map((d, i) => (
          /* The brand yellow is unreadable as text on a light tint, so the
             label uses --wr-orange-text — the project's existing readable
             stand-in for it, which also flips for dark mode. */
          <span key={i} className="text-[10px] font-bold px-2 py-0.5 rounded-full"
            style={{ background: `${accent}20`, color: 'var(--wr-orange-text)' }}>
            {d} {d === '1' ? 'day' : 'days'} before
          </span>
        ))}
      </div>
      <p className="text-[11px] text-gray-500 dark:text-white/45 mt-1.5 leading-relaxed">{hint}</p>
    </div>
  )
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function SecurityPolicyPage() {
  const [p, setP] = useState<Policy | null>(null)
  /* The rules as the SERVER words them. Shown back to the admin so the screen
     cannot drift from what a user is actually told — six numbers in boxes do
     not read as a sentence, and the sentence is what people receive. */
  const [requirements, setRequirements] = useState<string[]>([])
  const [locked, setLocked] = useState<Locked[]>([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/security-policy', { credentials: 'include' })
      if (r.status === 403) { setErr('Only a Super Admin can open this page.'); return }
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not load the policy'); return }
      setP(j.policy)
      setRequirements(j.requirements || [])
      setDirty(false)
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

  // Every edit marks the form dirty, so the save bar can say whether what is on
  // screen is what is stored. Sliders invite fiddling, and this page has no
  // other way to tell somebody they have not committed it yet.
  const set = (k: keyof Policy) => (v: number | string) => {
    setP({ ...p, [k]: v } as Policy)
    setDirty(true)
  }

  /* The character rules have to FIT inside the length. The server refuses this
     combination outright; catching it here means the admin sees why before
     pressing Save rather than after. */
  const classTotal = p.passwordMinDigits + p.passwordMinUpper + p.passwordMinLower + p.passwordMinSymbols
  const overStuffed = classTotal > p.passwordMinLength

  return (
    <div className="p-6 fade-in">
      <BackToConfiguration />
      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration', href: '/admin/configuration' }, { label: 'Security Policy' }]}
        title="Security Policy"
        description="How long a password lives, what one has to look like, and what happens after too many wrong attempts."
      />

      {err && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mb-4">{err}</p>}
      {msg && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 mb-4">{msg}</p>}

      {/* ── At a glance ───────────────────────────────────────────────────
          The whole policy in one line, above any of the controls. Somebody
          arriving to check a setting usually wants to READ it, not change it,
          and that reading should not require interpreting five sliders. */}
      <div className="rounded-2xl px-5 py-4 mb-5 flex flex-wrap items-center gap-x-9 gap-y-3"
        style={{ background: `linear-gradient(135deg, ${NAVY} 0%, #1e3a6e 100%)` }}>
        {[
          { k: 'Expires after', v: p.passwordExpiryDays === 0 ? 'Never' : `${p.passwordExpiryDays} days` },
          { k: 'Minimum length', v: `${p.passwordMinLength} characters` },
          { k: 'Cannot reuse', v: p.passwordHistory === 0 ? 'No limit' : `Last ${p.passwordHistory}` },
          { k: 'Locks after', v: p.maxFailedLogins === 0 ? 'Never' : `${p.maxFailedLogins} tries` },
          { k: 'Locked for', v: p.maxFailedLogins === 0 ? '—' : `${p.lockoutHours} hours` },
        ].map(s => (
          <div key={s.k}>
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">{s.k}</p>
            <p className="text-sm font-bold mt-0.5" style={{ color: YELLOW }}>{s.v}</p>
          </div>
        ))}
        {locked.length > 0 && (
          <div className="ml-auto flex items-center gap-2 rounded-xl bg-white/10 px-3 py-1.5">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" aria-hidden />
            <span className="text-xs font-semibold text-white">
              {locked.length} account{locked.length === 1 ? '' : 's'} locked right now
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-5 items-stretch">

        {/* ── Password lifetime ───────────────────────────────────────── */}
        <Card icon="🕒" title="Password lifetime" accent={ORANGE}
          blurb="Everyone is covered — client logins and portal staff alike.">
          <div className="space-y-5">
            <Slider label="Expires after" value={p.passwordExpiryDays} onChange={set('passwordExpiryDays')}
              min={0} max={365} unit="days" accent={ORANGE}
              hint="How long a password may be kept before it has to be changed."
              offLabel="Off — no password ever expires and nobody is warned." />

            {/* The warning lists mean nothing without an expiry to count back
                from, so they are not shown when there is none. */}
            {p.passwordExpiryDays > 0 && (
              <>
                <DayList label="Warn on screen (days before)" value={p.warnDays} onChange={set('warnDays')}
                  placeholder="3,2,1" accent={ORANGE}
                  hint="A banner with a Change password button on it, on each of those days." />

                <DayList label="Email warning (days before)" value={p.emailWarnDays} onChange={set('emailWarnDays')}
                  placeholder="2,1" accent={YELLOW}
                  hint="Deliberately shorter than the on-screen list — being told on screen every day is reasonable, being emailed every day is not. Leave empty to send no email at all." />
              </>
            )}

            <div className="rounded-xl bg-gray-50 dark:bg-white/[0.04] px-3.5 py-3">
              <p className="text-[11px] text-gray-500 dark:text-white/45 leading-relaxed">
                The wording of that email is a template like any other — edit it under{' '}
                <b className="text-[#14254A] dark:text-white">Configuration → Email Templates</b>, event{' '}
                <code className="text-[10px]">password_expiry_warning</code>. The sweep runs hourly and never
                sends the same warning twice.
              </p>
              <button onClick={sendWarnings} disabled={!!busy}
                className="mt-2 px-3 py-1.5 rounded-lg text-[11px] font-bold border border-gray-200
                  text-gray-600 hover:bg-white disabled:opacity-50
                  dark:border-white/15 dark:text-white/60">
                {busy === 'warn' ? 'Sending…' : 'Run the sweep now'}
              </button>
            </div>
          </div>
        </Card>

        {/* ── Complexity ──────────────────────────────────────────────── */}
        <Card icon="🔑" title="What a password must contain" accent={BLUE}
          blurb="Checked whenever anybody sets a password — changing their own, or resetting a forgotten one. Existing passwords are left alone until their owner next changes one.">
          <div className="space-y-5">
            <Slider label="Minimum length" value={p.passwordMinLength} onChange={set('passwordMinLength')}
              min={4} max={64} unit="chars" accent={BLUE}
              hint="Counted in characters, not bytes. Cannot be set below 4." />

            <div className="grid grid-cols-2 gap-x-4 gap-y-5">
              <Slider label="Numbers" value={p.passwordMinDigits} onChange={set('passwordMinDigits')}
                min={0} max={8} accent={BLUE} hint="How many digits." offLabel="Not required." />
              <Slider label="Capitals" value={p.passwordMinUpper} onChange={set('passwordMinUpper')}
                min={0} max={8} accent={BLUE} hint="A–Z and accented equivalents." offLabel="Not required." />
              <Slider label="Lowercase" value={p.passwordMinLower} onChange={set('passwordMinLower')}
                min={0} max={8} accent={BLUE} hint="a–z and accented equivalents." offLabel="Not required." />
              <Slider label="Symbols" value={p.passwordMinSymbols} onChange={set('passwordMinSymbols')}
                min={0} max={8} accent={BLUE}
                hint="Anything that is not a letter, digit or space." offLabel="Not required." />
            </div>

            {overStuffed && (
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 leading-relaxed">
                Those character rules need at least <b>{classTotal}</b> characters, but the minimum length is{' '}
                <b>{p.passwordMinLength}</b>. No password could satisfy both — raise the length, or lower a
                requirement.
              </p>
            )}

            <Slider label="Cannot reuse the last" value={p.passwordHistory} onChange={set('passwordHistory')}
              min={0} max={12} unit="pwds" accent={BLUE}
              hint="A new password is refused if it matches any of that many previous ones."
              offLabel="Off — any previous password may be set again." />

            {/* Read back from the server rather than assembled here, so this says
                what a user will be told and not what this screen believes. */}
            {requirements.length > 0 && (
              <div className="rounded-xl bg-gray-50 dark:bg-white/[0.04] px-3.5 py-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                    People will be asked for
                  </p>
                  {dirty && <span className="text-[10px] font-bold text-amber-600">Save to update</span>}
                </div>
                <ul className="space-y-1">
                  {requirements.map((rq, i) => (
                    <li key={i} className="text-[11px] text-gray-600 dark:text-white/60 flex gap-2">
                      <span className="text-emerald-500 flex-shrink-0" aria-hidden>✓</span>
                      <span>{rq}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-[11px] text-gray-500 dark:text-white/45 leading-relaxed">
              Previous passwords are kept as one-way hashes, never as text — reuse is detected by testing the
              new password against them, so the old ones cannot be read back by anyone.
            </p>
          </div>
        </Card>

        {/* ── Lockout ─────────────────────────────────────────────────── */}
        <Card icon="🚫" title="Too many wrong attempts" accent={RED}
          blurb="A lock lifts by itself when its time is up. Resetting the password lifts it immediately, which is the route to give anyone who cannot wait.">
          <div className="space-y-5">
            <Slider label="Wrong passwords" value={p.maxFailedLogins} onChange={set('maxFailedLogins')}
              min={0} max={20} unit="tries" accent={RED}
              hint="How many wrong passwords before the account locks."
              offLabel="Off — password lockout is disabled." />

            {/* Minimum 1, not 0: a lockout with no duration never lifts, and the
                server refuses that combination outright. */}
            {p.maxFailedLogins > 0 && (
              <Slider label="Locked for" value={p.lockoutHours} onChange={set('lockoutHours')}
                min={1} max={168} unit="hrs" accent={RED}
                hint="Up to a week. The lock lifts by itself when the time is up." />
            )}

            <div className="border-t border-gray-100 dark:border-white/10 pt-5">
              <Slider label="Wrong OTP codes" value={p.otpMaxAttempts} onChange={set('otpMaxAttempts')}
                min={0} max={20} unit="tries" accent={RED}
                hint="Counted across codes, not only within one — otherwise requesting a fresh code resets the count and the limit means nothing."
                offLabel="Off — OTP lockout is disabled." />
            </div>

            {p.otpMaxAttempts > 0 && (
              <Slider label="OTP locked for" value={p.otpLockoutHours} onChange={set('otpLockoutHours')}
                min={1} max={168} unit="hrs" accent={RED}
                hint="Up to a week. The lock lifts by itself when the time is up." />
            )}
          </div>
        </Card>
      </div>

      {/* ── Who is locked right now ───────────────────────────────────────
          Below the settings and at full width: it is a list of PEOPLE, not a
          setting, and squeezed into a third of a card it was two lines of
          truncated email with an Unlock button crushed against them. */}
      <div className="mt-5 bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
        dark:border-white/10 p-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <h3 className="font-semibold text-[#14254A] dark:text-white">Locked right now</h3>
            {locked.length > 0 && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-600
                border border-red-100">
                {locked.length}
              </span>
            )}
          </div>
          <button onClick={loadLocked}
            className="text-[11px] font-bold text-gray-400 hover:text-[#14254A] dark:hover:text-white">
            Refresh
          </button>
        </div>

        {locked.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 dark:border-white/10 px-4 py-8 text-center">
            <p className="text-2xl mb-1" aria-hidden>✓</p>
            <p className="text-sm text-gray-500 dark:text-white/45">No account is locked.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-2.5">
            {locked.map(l => (
              <div key={`${l.accountType}-${l.accountId}-${l.kind}`}
                className="flex items-center gap-3 rounded-xl border border-gray-100 dark:border-white/10
                  px-3.5 py-2.5 hover:border-gray-200 transition-colors">
                <div className="w-9 h-9 rounded-xl bg-red-50 grid place-items-center flex-shrink-0 text-sm"
                  aria-hidden>🔒</div>
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

      {/* ── Save ──────────────────────────────────────────────────────────
          Sticky, because the settings above are now tall enough that the button
          would otherwise be off screen while somebody is dragging a slider. */}
      <div className="sticky bottom-0 mt-5 -mx-6 px-6 py-4 bg-gradient-to-t from-[#eef2f7] via-[#eef2f7]
        to-transparent dark:from-[#0f1f3d] dark:via-[#0f1f3d]">
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={save} disabled={!!busy || overStuffed}
            className="px-6 py-2.5 text-sm font-semibold text-white rounded-xl disabled:opacity-50
              transition-all hover:shadow-lg"
            style={{ background: `linear-gradient(135deg, ${YELLOW} 0%, ${ORANGE} 100%)` }}>
            {busy === 'save' ? 'Saving…' : 'Save policy'}
          </button>
          {dirty && !overStuffed && (
            <span className="text-xs font-semibold text-amber-600">Unsaved changes</span>
          )}
          <span className="text-xs text-gray-500 dark:text-white/45">
            Applies to the next sign-in attempt — nobody is signed out.
          </span>
        </div>
      </div>
    </div>
  )
}
