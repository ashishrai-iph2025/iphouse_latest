'use client'

/*
 * What a client login's portal opens on — sidebar or top-nav, header shown
 * or hidden.
 *
 * Sits in its own pane of the Edit Login Account drawer, alongside Module
 * access, for the same reason as everything else there: it is a property of
 * one company's login row, not of the drawer.
 *
 * ── Not a separate "default" layer ───────────────────────────────────────
 *
 * This reads and writes the exact same row the login's own Theme Customizer
 * panel does (see lib/ThemeCustomizerContext.tsx) — there is no admin-only
 * table sitting under it. Setting something here is what the login's portal
 * opens on THE MOMENT they next load it; if they later open their own
 * customizer and change something, their save overwrites this the same way
 * an admin's save would overwrite theirs. Module access and Layout access
 * already work this way in this same drawer, and a third setting behaving
 * differently would be a surprise waiting to be found.
 *
 * ── Keyed on the company, like Module access ─────────────────────────────
 *
 * loginId — the login ROW for the company selected below, its own picker
 * rather than a shared one with the Module access pane, because the two
 * panes are not mounted together (see the PANES list in
 * SharedLoginsClient.tsx) and there is nothing to share it from.
 */

import { useCallback, useEffect, useState } from 'react'
import type { LoginAssignment } from './LoginModuleAccess'
import { DEFAULTS, type CustomizerState } from '@/lib/ThemeCustomizerContext'

const ORANGE = '#FC934C'
const NAVY = '#14254A'

const same = (a: CustomizerState, b: CustomizerState) =>
  a.sidebarEnabled === b.sidebarEnabled && a.headerVisible === b.headerVisible

function ToggleField({ label, hint, checked, onChange, disabled }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
}) {
  return (
    <button type="button" onClick={() => !disabled && onChange(!checked)} disabled={disabled}
      className={`w-full flex items-center justify-between gap-3 text-left rounded-lg border border-gray-200
        dark:border-white/15 px-3 py-2 ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
      <span>
        <span className="block text-xs font-semibold text-[#14254A] dark:text-white">{label}</span>
        <span className="block text-[10px] text-gray-400 mt-0.5">{hint}</span>
      </span>
      <span className={`relative flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-[#FC934C]' : 'bg-gray-200 dark:bg-white/15'}`}
        style={{ width: '36px', height: '20px' }}>
        <span className={`absolute top-[3px] left-[3px] w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[16px]' : ''}`} />
      </span>
    </button>
  )
}

export default function LoginThemeLayout({ assignments }: { assignments: LoginAssignment[] }) {
  const targets = assignments.filter(a => a.loginId > 0 && a.userId > 0)
  const [sel, setSel] = useState(0)
  const [found, setFound] = useState(false)
  const [saved, setSaved] = useState<CustomizerState>(DEFAULTS)
  const [draft, setDraft] = useState<CustomizerState>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')

  const idKey = targets.map(t => t.loginId).join(',')

  /* Picks the company, on the render idKey changes — the render after this
     one is what actually fetches, below, keyed on `sel` alone. Two effects
     rather than one doing both, because idKey changing (a company ticked or
     dropped upstairs) and sel changing (a chip clicked here) are different
     events that would otherwise fetch the SAME company twice: idKey settling
     `sel` to what it already was still re-runs a load-on-idKey effect, and a
     separate load-on-sel effect would fire right behind it for nothing. */
  useEffect(() => {
    if (!idKey) return
    const ids = idKey.split(',').map(Number)
    setSel(s => (s && ids.includes(s) ? s : ids[0]))
  }, [idKey])

  const load = useCallback(async () => {
    if (!sel) { setLoading(false); return }
    setLoading(true); setErr(''); setNote('')
    try {
      const r = await fetch(`/api/admin/login-theme-layout?loginId=${sel}`, { credentials: 'include' })
      if (r.status === 403) {
        setErr('You do not hold the Module Permissions grant, so layout cannot be set here.')
        return
      }
      const d = await r.json()
      if (!d?.success) { setErr(d?.error || 'The layout could not be read.'); return }
      const layout: CustomizerState = { ...DEFAULTS, ...d.layout }
      setFound(!!d.found)
      setSaved(layout)
      setDraft(layout)
    } catch {
      setErr('The layout could not be read.')
    } finally {
      setLoading(false)
    }
  }, [sel])

  useEffect(() => {
    if (!idKey) { setLoading(false); return }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel])

  const dirty = !same(saved, draft)

  function set<K extends keyof CustomizerState>(key: K, value: CustomizerState[K]) {
    setNote('')
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  async function apply() {
    if (!sel) return
    setSaving(true); setNote('')
    try {
      const r = await fetch('/api/admin/login-theme-layout', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: sel, layout: draft }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.success) { setNote(d.error || `Layout could not be saved (HTTP ${r.status}).`); return }
      setFound(true)
      setSaved(draft)
      setNote(`Saved for ${targets.find(t => t.loginId === sel)?.clientName ?? 'this company'}.`)
    } catch {
      setNote('Layout could not be saved — the request did not complete.')
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    if (!sel) return
    setSaving(true); setNote('')
    try {
      const r = await fetch(`/api/admin/login-theme-layout?loginId=${sel}`, {
        method: 'DELETE', credentials: 'include',
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.success) { setNote(d.error || `Could not reset this login's layout.`); return }
      setFound(false)
      setSaved(DEFAULTS)
      setDraft(DEFAULTS)
      setNote(`Reset — this login now opens on the shipped defaults, until it sets its own.`)
    } catch {
      setNote('Could not reset — the request did not complete.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-2xl border border-gray-100 dark:border-white/10
      bg-white dark:bg-[#1a2d55] shadow-card overflow-hidden">

      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-gray-100 dark:border-white/10">
        <span className="w-7 h-7 rounded-lg grid place-items-center flex-shrink-0"
          style={{ background: 'rgba(252,147,76,0.14)' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={ORANGE}
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="7" height="16" rx="1.5" />
            <rect x="14" y="4" width="7" height="7" rx="1.5" />
            <rect x="14" y="15" width="7" height="5" rx="1.5" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-bold uppercase tracking-widest text-[#14254A] dark:text-white">
            Portal layout
          </span>
          <span className="block text-[10px] text-gray-400 truncate">
            Sidebar and header this login opens on, set per company
          </span>
        </span>
      </div>

      <div className="p-4 space-y-3">
        {targets.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-white/50 leading-relaxed">
            No company is assigned to this login yet. Tick one above and press
            Update; layout is set per company.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {targets.map(t => {
                const on = t.loginId === sel
                return (
                  <button key={t.loginId} type="button" onClick={() => setSel(t.loginId)}
                    title={`${t.clientName} — login #${t.loginId}`}
                    className={`px-2.5 py-1.5 rounded-xl text-[11px] font-semibold border
                      max-w-full truncate transition-colors ${on
                        ? 'text-white border-transparent'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50 ' +
                          'dark:bg-white/5 dark:text-white/70 dark:border-white/15 dark:hover:bg-white/10'}`}
                    style={on ? { background: NAVY } : undefined}>
                    {t.clientName}
                  </button>
                )
              })}
            </div>

            {err ? (
              <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">{err}</p>
            ) : loading ? (
              <p className="text-xs text-gray-400">Reading layout…</p>
            ) : (
              <>
                <p className="text-[11px] text-gray-400 leading-snug">
                  {found
                    ? 'This login has its own saved layout — set here, or by the login itself from its Theme Customizer panel.'
                    : 'Nothing set yet — this login opens on the shipped defaults, shown below, until this is saved or it sets its own.'}
                </p>

                <div className="space-y-2">
                  <ToggleField label="Enable sidebar" hint="Left-hand navigation instead of the top tab bar."
                    checked={draft.sidebarEnabled} onChange={v => set('sidebarEnabled', v)} />
                  <ToggleField label="Show header"
                    hint={draft.sidebarEnabled
                      ? 'Hide the top bar since the sidebar carries the navigation.'
                      : 'The header carries the navigation tabs, so it stays on until the sidebar is enabled.'}
                    checked={!draft.sidebarEnabled || draft.headerVisible} disabled={!draft.sidebarEnabled}
                    onChange={v => set('headerVisible', v)} />
                </div>

                <div className="flex items-center justify-between gap-3 pt-1">
                  <button type="button" onClick={reset} disabled={saving || !found}
                    title={found ? 'Clear this login’s saved layout' : 'Nothing saved to reset'}
                    className="text-[10px] font-bold uppercase tracking-wider text-gray-400
                      hover:text-[#14254A] dark:hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none">
                    Reset to shipped default
                  </button>
                  <button type="button" onClick={apply} disabled={saving || !dirty}
                    className="px-3.5 py-1.5 rounded-xl text-[11px] font-bold text-white
                      transition-opacity hover:opacity-90 disabled:opacity-40"
                    style={{ background: NAVY }}>
                    {saving ? 'Applying…' : dirty ? 'Apply layout' : 'Applied'}
                  </button>
                </div>
              </>
            )}

            {note && (
              <p className="text-[11px] text-gray-500 dark:text-white/50 leading-snug">{note}</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
