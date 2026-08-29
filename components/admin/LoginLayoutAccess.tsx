'use client'

/*
 * Whether this login account may rearrange its own Reports page.
 *
 * Sits INSIDE the Module access panel of the Edit Login Account drawer, and
 * only once Reports is among the modules ticked for the account — see
 * LoginModuleAccess. That pairing is not decoration: what this grant governs IS
 * the Reports page, so on an account that cannot open Reports it would be a
 * permission with nothing to spend it on.
 *
 * Saves on the switch rather than on the drawer's Update button, matching the
 * Valid/Invalid switch on the Sign-in pane and the panel's own Apply access
 * button: this is a single boolean about the account as a whole, not a field of
 * the form being filled in.
 *
 * Keyed on login_username, like everything else about a shared login that is
 * per-PERSON — a shared login is one row per company and loginId names only one
 * of them. That also means the grant does NOT vary by company, while the
 * Reports tick that reveals it does; the copy below says so rather than leaving
 * an admin to infer it from where the switch happens to be drawn.
 *
 * The ARRANGEMENT itself is not stored against the login. It lives in
 * report_panel_layout keyed per client, so what a granted user saves is the
 * report their whole company opens — which is the half of this an admin is most
 * likely to get wrong, and so the half the copy leads with.
 * See go-server/handlers/admin/layoutaccess.go.
 */

import { useEffect, useState } from 'react'

interface Props {
  /** The account's username — the identity the grant is stored against. */
  loginUsername: string
  /** True when more than one company is assigned, so the copy can say that the
      grant spans all of them rather than the one selected above. */
  multiCompany?: boolean
}

export default function LoginLayoutAccess({ loginUsername, multiCompany }: Props) {
  const [on,      setOn]      = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState(false)
  const [err,     setErr]     = useState('')

  /* The list endpoint, filtered here rather than a per-account one.

     It is one small row per login and it is the same handler that writes, so
     there is no second shape to keep in step — cheaper than the extra endpoint
     it would take to avoid loading the rest. */
  async function load() {
    setLoading(true); setErr('')
    try {
      const res  = await fetch('/api/admin/layout-access', { credentials: 'include' })
      const data = await res.json()
      if (!data.success) { setErr(data.error || 'Could not read the layout grant'); return }
      const row = (data.logins || []).find((l: any) => l.login_username === loginUsername)
      setOn(Number(row?.layout_enabled) === 1)
    } catch {
      setErr('Network error')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [loginUsername])

  async function toggle() {
    const next = !on
    setBusy(true); setErr('')
    // Optimistic: the switch IS the feedback, and one that waits on a round trip
    // before moving reads as a click that did not register.
    setOn(next)
    try {
      const res = await fetch('/api/admin/layout-access', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginUsername, layoutEnabled: next }),
      })
      const data = await res.json()
      if (!data.success) { setOn(!next); setErr(data.error || 'Could not save') }
    } catch {
      setOn(!next); setErr('Network error')
    }
    setBusy(false)
  }

  /* An inset block, not a card. It lives inside the Module access panel, and a
     second bordered card with its own header band there would read as a second
     panel that had been dropped in the wrong place. */
  return (
    <div className="pt-3 mt-1 border-t border-gray-100 dark:border-white/10">
      <div className="flex items-start gap-3">
        <button type="button" onClick={toggle} disabled={busy || loading}
          role="switch" aria-checked={on}
          className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors
            disabled:opacity-50 flex-shrink-0 mt-0.5 ${on ? 'bg-emerald-500' : 'bg-gray-200 dark:bg-white/15'}`}>
          <span className={`inline-block w-[18px] h-[18px] bg-white rounded-full shadow transform
            transition-transform ${on ? 'translate-x-[24px]' : 'translate-x-[3px]'}`} />
        </button>

        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-widest text-[#14254A] dark:text-white">
            Layout
          </p>
          <p className={`text-xs font-semibold mt-0.5 ${on ? 'text-emerald-600' : 'text-gray-500 dark:text-white/60'}`}>
            {loading ? 'Checking…' : on ? 'May arrange the Reports page' : 'Uses the layout you configure'}
          </p>

          <p className="text-[11px] text-gray-500 dark:text-white/50 mt-1.5 leading-relaxed">
            Adds an <strong>Arrange</strong> button to their Reports page, for the same things
            Report Configuration sets: which <strong>KPI cards, charts and filters</strong>
            {' '}appear, in what order, at what width, and as which chart.
          </p>

          {/* The consequence that does not follow from looking at a switch: a
              report is shared, so this is not a personal view. */}
          <p className="text-[11px] text-gray-500 dark:text-white/50 mt-1.5 leading-relaxed">
            What they save becomes <strong>their whole company&rsquo;s report</strong> — it
            replaces the layout you set for that client, and everyone there sees it. They can
            reset back to yours at any time.
          </p>

          {/* Drawn under a per-company checklist, so say plainly that this one
              is not per-company. Only when it can actually differ. */}
          {multiCompany && (
            <p className="text-[11px] text-gray-400 mt-1.5 leading-relaxed">
              Unlike the modules above, this applies to the whole login rather than to the
              company selected.
            </p>
          )}

          {err && <p className="text-[11px] text-red-600 mt-1.5">{err}</p>}
        </div>
      </div>
    </div>
  )
}
