'use client'

/*
 * Which screens a login sees — set from the account editor, per company.
 *
 * The grants themselves live on /admin/module-permissions and always have. What
 * changed is where they sit RELATIVE to the work: an admin opens an account on
 * /admin/registrations to change a name, a password or which companies it may
 * read, and the one remaining question about that account — what it can actually
 * open once it signs in — was on another screen, reached by remembering that the
 * screen exists. So it is here too, reading and writing the same table through
 * the same endpoint. A second door onto one room, not a second room.
 *
 * ── Why it asks WHICH COMPANY ────────────────────────────────────────────────
 *
 * A shared login is not one row. dcp_user_login holds one row per company the
 * person may read, each with its own loginId, and module grants hang off
 * loginId — so "this person's modules" is not a thing that exists. There are as
 * many sets as companies, and they are allowed to differ, which is the point: an
 * agency user may hold Reports for one client and Dashboard for another.
 *
 * The registrations list collapses those rows to one per person and carries
 * MAX(loginId) for opening the editor. Writing grants against that id would have
 * set whichever company happened to be added last, and looked like it worked.
 * Hence the company picker: the target is chosen, never inferred.
 *
 * Edits are held per company while the drawer is open, so switching to check
 * another company cannot discard what was ticked for this one — a company with
 * unapplied ticks is marked in the picker rather than quietly reverted.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  enforceDashboardReports, selectAllRespectingRule, hasBothDashboardAndReports,
  DASHBOARD_REPORTS_HINT,
} from '@/lib/moduleExclusivity'

const ORANGE = '#FC934C'
const NAVY = '#14254A'

/** One company this login may read, and the login row carrying its grants. */
export interface LoginAssignment {
  loginId: number
  /** dcp_user.userId. 0 is the placeholder row a registration approval leaves
      behind before any company is assigned — see the notice below. */
  userId: number
  clientName: string
}

interface ModuleRow {
  Id: number
  ModuleName: string
  pageName?: string
  status: number
}

const same = (a: number[], b: Set<number>) =>
  a.length === b.size && a.every(id => b.has(id))

export default function LoginModuleAccess({ assignments, pendingUserIds }: {
  assignments: LoginAssignment[]
  /** The companies currently ticked in the form above, saved or not. Used only
      to warn: grants are written against login rows, and a company that has not
      been saved yet has no row to write them on. */
  pendingUserIds: number[]
}) {
  const [modules, setModules] = useState<ModuleRow[]>([])
  const [saved,   setSaved]   = useState<Record<number, number[]>>({})
  const [draft,   setDraft]   = useState<Record<number, Set<number>>>({})
  const [sel,     setSel]     = useState(0)
  const [err,     setErr]     = useState('')
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [note,    setNote]    = useState('')

  // Only a company with a real login row can be a target.
  const targets = useMemo(
    () => assignments.filter(a => a.loginId > 0 && a.userId > 0),
    [assignments])
  const idKey = targets.map(t => t.loginId).join(',')

  /* Keyed on idKey rather than on `targets`: the parent builds that array
     inline, so a fresh identity arrives on every render and listing it as a
     dependency is one request per keystroke in the form above. */
  const load = useCallback(async () => {
    if (!idKey) { setLoading(false); return }
    const ids = idKey.split(',').map(Number)
    setLoading(true); setErr(''); setNote('')
    try {
      const r = await fetch(`/api/admin/user-module-permissions?loginIds=${idKey}`,
        { credentials: 'include' })
      /* This endpoint sits behind the Module Permissions grant while the account
         editor needs only admin, so a reviewer without it gets a 403 here. Said
         plainly: they can still edit the account, they simply cannot also set
         access — which is not at all the same as this login having none, and an
         empty checklist would say exactly that. */
      if (r.status === 403) {
        setErr('You do not hold the Module Permissions grant, so access cannot be set here.')
        return
      }
      const d = await r.json()
      if (!d?.success) { setErr(d?.error || 'The module list could not be read.'); return }
      setModules(Array.isArray(d.modules) ? d.modules : [])

      const nextSaved: Record<number, number[]> = {}
      const nextDraft: Record<number, Set<number>> = {}
      for (const id of ids) {
        const allowed: number[] = (d.byLogin?.[String(id)] ?? []).map(Number)
        nextSaved[id] = allowed
        nextDraft[id] = new Set(allowed)
      }
      setSaved(nextSaved); setDraft(nextDraft)
      // Keep the chosen company across a reload where it still exists.
      setSel(s => (s && nextSaved[s] !== undefined ? s : ids[0] ?? 0))
    } catch {
      setErr('The module list could not be read.')
    } finally {
      setLoading(false)
    }
  }, [idKey])

  useEffect(() => { load() }, [load])

  const moduleNames = useMemo(
    () => modules.map(m => ({ id: m.Id, name: m.ModuleName })), [modules])

  const picked = draft[sel] ?? new Set<number>()
  const dirty = (loginId: number) =>
    !!draft[loginId] && !!saved[loginId] && !same(saved[loginId], draft[loginId])

  function toggle(id: number) {
    setNote('')
    setDraft(prev => {
      const next = new Set(prev[sel] ?? [])
      if (next.has(id)) next.delete(id); else next.add(id)
      // Dashboard and Reports are one entitlement — see lib/moduleExclusivity.
      return { ...prev, [sel]: new Set(enforceDashboardReports([...next], id, moduleNames)) }
    })
  }

  /* "All" is everything the RULE allows, which is fewer than every module — so
     the button's state cannot be a count against modules.length. */
  const want = useMemo(
    () => selectAllRespectingRule(modules.map(m => m.Id), moduleNames),
    [modules, moduleNames])
  const allOn = want.length > 0 && want.every(id => picked.has(id))

  function toggleAll() {
    setNote('')
    setDraft(prev => ({ ...prev, [sel]: new Set(allOn ? [] : want) }))
  }

  async function apply() {
    if (!sel) return
    /* A selection can reach here without passing through a toggle — a grant made
       before the rule existed loads straight into the checklist. Refused rather
       than silently corrected: quietly dropping a module the admin can see
       ticked is worse than saying so. */
    if (hasBothDashboardAndReports([...picked], moduleNames)) {
      setNote(DASHBOARD_REPORTS_HINT); return
    }
    setSaving(true); setNote('')
    try {
      const r = await fetch('/api/admin/user-module-permissions', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: sel, modules: [...picked] }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.success) {
        setNote(d.error || `Access could not be saved (HTTP ${r.status}).`); return
      }
      // Local truth moves with the write, so the picker's marks and counts are
      // right again without reloading the whole drawer.
      setSaved(prev => ({ ...prev, [sel]: [...picked] }))
      setNote(`Saved for ${targets.find(t => t.loginId === sel)?.clientName ?? 'this company'}.`)
    } catch {
      setNote('Access could not be saved — the request did not complete.')
    } finally {
      setSaving(false)
    }
  }

  /* Companies ticked upstairs with no login row yet, and companies whose row is
     about to go. Both are states where this panel and the form above it would
     otherwise disagree in silence. */
  const assignedIds = new Set(assignments.map(a => a.userId))
  const unsaved = pendingUserIds.filter(id => !assignedIds.has(id))
  const leaving = targets.filter(t => !pendingUserIds.includes(t.userId))

  return (
    <div className="rounded-2xl border border-gray-100 dark:border-white/10
      bg-white dark:bg-[#1a2d55] shadow-card overflow-hidden">

      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-gray-100 dark:border-white/10">
        <span className="w-7 h-7 rounded-lg grid place-items-center flex-shrink-0"
          style={{ background: 'rgba(252,147,76,0.14)' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={ORANGE}
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="8" height="7" rx="1.5" />
            <rect x="13" y="4" width="8" height="4" rx="1.5" />
            <rect x="3" y="14" width="8" height="6" rx="1.5" />
            <rect x="13" y="11" width="8" height="9" rx="1.5" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-bold uppercase tracking-widest text-[#14254A] dark:text-white">
            Module access
          </span>
          <span className="block text-[10px] text-gray-400 truncate">
            The screens this login opens, set per company
          </span>
        </span>
        {/* The full screen still exists and is the right place for bulk work
            across many accounts. Named here so this panel reads as a shortcut
            into it rather than as a rival copy of it. */}
        {/* Routed, not a plain href: a full page load here would drop the
            drawer, the list behind it and the search that found the row. */}
        <Link to="/admin/module-permissions"
          className="text-[10px] font-bold uppercase tracking-wider text-gray-400
            hover:text-[#14254A] dark:hover:text-white transition-colors flex-shrink-0">
          All accounts ↗
        </Link>
      </div>

      <div className="p-4 space-y-3">
        {err ? (
          <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">{err}</p>
        ) : targets.length === 0 ? (
          /* Two ways to have no target, and they are not the same sentence.

             With nothing ticked above, this is a login approved from a
             registration request: one row, no company on it. Grants against
             that row are discarded the moment a company IS assigned — the save
             retires the placeholder — so a checklist would be a form that
             throws its own input away.

             With companies ticked above and still no target, something did not
             line up: an older API build that does not send the company↔login
             pairs, or a pair that failed to parse. Saying "no company is
             assigned" there would contradict the list directly above it, and
             the reader would believe the wrong half. */
          pendingUserIds.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-white/50 leading-relaxed">
              No company is assigned to this login yet. Tick one above and press
              Update; module access is granted per company.
            </p>
          ) : (
            <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
              This login&rsquo;s companies could not be matched to their login rows,
              so access cannot be set here. Reload the page; if it persists, set
              access from Module Permissions.
            </p>
          )
        ) : loading ? (
          <p className="text-xs text-gray-400">Reading module access…</p>
        ) : (
          <>
            {/* ── Which company ───────────────────────────────────────────────
                Drawn even for a login with only one, so the panel says what it
                is about. Without it, a login that later gains a second company
                would change meaning without changing appearance. */}
            <div className="flex flex-wrap gap-1.5">
              {targets.map(t => {
                const on = t.loginId === sel
                const n = (draft[t.loginId] ?? new Set()).size
                return (
                  <button key={t.loginId} type="button"
                    onClick={() => { setSel(t.loginId); setNote('') }}
                    title={`${t.clientName} — login #${t.loginId}`}
                    className={`px-2.5 py-1.5 rounded-xl text-[11px] font-semibold border
                      inline-flex items-center gap-1.5 max-w-full transition-colors ${on
                        ? 'text-white border-transparent'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50 ' +
                          'dark:bg-white/5 dark:text-white/70 dark:border-white/15 dark:hover:bg-white/10'}`}
                    style={on ? { background: NAVY } : undefined}>
                    <span className="truncate">{t.clientName}</span>
                    <span className={on ? 'text-white/60' : 'text-gray-400'}>
                      {n === 0 ? 'none' : n}
                    </span>
                    {/* Unapplied ticks, MARKED rather than reverted — switching
                        company to check something must not throw work away. */}
                    {dirty(t.loginId) && (
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: ORANGE }} title="Unapplied changes" />
                    )}
                  </button>
                )
              })}
            </div>

            <div className="flex items-start justify-between gap-3">
              <p className="text-[10px] text-gray-400 leading-snug">{DASHBOARD_REPORTS_HINT}</p>
              {modules.length > 0 && (
                <button type="button" onClick={toggleAll}
                  className="text-[10px] font-bold uppercase tracking-wider flex-shrink-0
                    text-gray-400 hover:text-[#14254A] dark:hover:text-white transition-colors">
                  {allOn ? 'Clear all' : 'Select all'}
                </button>
              )}
            </div>

            {modules.length === 0 ? (
              <p className="text-xs text-gray-400">No modules are available to grant.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {modules.map(m => {
                  const on = picked.has(m.Id)
                  return (
                    <label key={m.Id} title={m.pageName}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border cursor-pointer
                        transition-colors ${on
                          ? 'border-[#FC934C]/40 bg-[#FC934C]/[0.07]'
                          : 'border-gray-100 bg-gray-50 hover:bg-gray-100 ' +
                            'dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.07]'}`}>
                      <input type="checkbox" checked={on} onChange={() => toggle(m.Id)}
                        className="w-4 h-4 rounded flex-shrink-0" style={{ accentColor: ORANGE }} />
                      <span className={`text-xs truncate ${on
                        ? 'font-semibold text-[#14254A] dark:text-white'
                        : 'text-gray-600 dark:text-white/60'}`}>
                        {m.ModuleName}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}

            {/* The form above writes companies; this writes grants. Two writes,
                and the second cannot reach a row the first has not created. */}
            {unsaved.length > 0 && (
              <p className="text-[10px] text-amber-700 dark:text-amber-300 leading-snug">
                {unsaved.length} newly ticked compan{unsaved.length === 1 ? 'y is' : 'ies are'} not
                saved yet — press Update first, then set access for
                {unsaved.length === 1 ? ' it' : ' them'} here.
              </p>
            )}
            {leaving.length > 0 && (
              <p className="text-[10px] text-amber-700 dark:text-amber-300 leading-snug">
                {leaving.map(l => l.clientName).join(', ')} {leaving.length === 1 ? 'is' : 'are'} no
                longer ticked above — access set here goes away when you press Update.
              </p>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[10px] text-gray-400">
                {picked.size} module{picked.size === 1 ? '' : 's'} selected
              </span>
              {/* Its own button, and deliberately not the drawer's Update.
                  Grants are a different table reached by a different endpoint,
                  and folding them into one Save would mean writing access for
                  companies whose login rows that same click is still creating. */}
              <button type="button" onClick={apply} disabled={saving || !dirty(sel)}
                className="px-3.5 py-1.5 rounded-xl text-[11px] font-bold text-white
                  transition-opacity hover:opacity-90 disabled:opacity-40"
                style={{ background: NAVY }}>
                {saving ? 'Applying…' : dirty(sel) ? 'Apply access' : 'Applied'}
              </button>
            </div>

            {note && (
              <p className="text-[11px] text-gray-500 dark:text-white/50 leading-snug">{note}</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
