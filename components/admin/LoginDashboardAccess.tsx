'use client'

/*
 * Which report modules this login account may open.
 *
 * Sits INSIDE the Module access panel of the Edit Login Account drawer, and
 * only once Reports is among the modules ticked — same pairing, and for the
 * same reason, as the layout switch beside it: what this narrows IS the Reports
 * page, so on an account that cannot open Reports it would be a permission with
 * nothing to spend it on.
 *
 * ── Two steps, and why ───────────────────────────────────────────────────────
 *
 * Category first, then modules. The catalogue is one flat list of near-identical
 * names — Open Web, Open Web, UGC & Social Media, UGC & Social Media — where the
 * only thing telling a pair apart is which cut of the report it is. Asked to
 * pick from that list directly, an admin is reading twenty rows to find four,
 * and the ones they are choosing between look the same. Picking VOD first turns
 * it into four rows that differ.
 *
 * The categories themselves are NOT stored. They are how the list is narrowed,
 * not part of the grant — what is saved is the modules. On reopening, the
 * categories come back from what was granted, so the drawer opens showing the
 * groups the admin was last working in without having to record them.
 *
 * ── Keyed on the company ─────────────────────────────────────────────────────
 *
 * loginId — the login ROW for the company selected in the picker above, exactly
 * like the module checklist it sits under.
 *
 * It was keyed on login_username, which spoke for the person and wrote every one
 * of their companies alike. Drawn directly beneath a per-company checklist and
 * inside that company's own picker, the one thing it looked like it did was the
 * one thing it did not: switching from ABP to DAZN changed the boxes above it
 * and not these, and an edit meant for one client silently landed on both.
 *
 * The layout grant beside it is still per person, and says so. That is not an
 * inconsistency — a layout is a property of the reader, and which reports a
 * client may see is a property of the client.
 *
 * ── Default ──────────────────────────────────────────────────────────────────
 *
 * Every account starts unrestricted and the switch says so. Restricting is a
 * deliberate act, because the opposite default would have taken every report
 * from every existing login the day this shipped.
 *
 * See go-server/handlers/dashboardaccess.go, which owns the resolution from a
 * module to the report it opens — and hands that resolution back here, so a
 * module whose name matches no report is visible as such WHILE it is being
 * granted rather than discovered later by the person it was granted to.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DASHBOARD_CATEGORIES, categoryLabel, chipFor } from '@/lib/dashboardCategories'

const ORANGE = '#FC934C'
const NAVY = '#14254A'

/** The bucket an uncategorised module is shown under. Not a category — the
    server stores '' for these — just somewhere for them to be picked from. */
const UNFILED = '__unfiled__'

interface DashModuleRow {
  moduleId:   number
  moduleName: string
  category:   string
  /** The report this module resolves to, '' when it matches none. */
  reportKey:   string
  reportLabel: string
}

const sameIds = (a: number[], b: Set<number>) =>
  a.length === b.size && a.every(id => b.has(id))

export default function LoginDashboardAccess({ loginId, clientName }: {
  /** The login row for the company selected above — what this grant is keyed
      on, and what makes it change when the picker changes. */
  loginId: number
  /** That company's name, so the copy can say which client is being narrowed
      rather than leaving it to be inferred from a picker further up. */
  clientName?: string
}) {
  const [modules,    setModules]    = useState<DashModuleRow[]>([])
  /* Two flags, not one. `serverRestricted` is what is stored; `restricted` is
     where the switch is. They part company for exactly one useful moment —
     the switch is on, nothing has been applied yet, and the picker is open —
     which is the whole reason turning it on does not revoke anything. */
  const [serverRestricted, setServerRestricted] = useState(false)
  const [restricted, setRestricted] = useState(false)
  /** Reports this account holds that no module in the catalogue names. They
      cannot be ticked here, and Apply keeps them rather than dropping them. */
  const [unlisted, setUnlisted] = useState<string[]>([])
  const [saved,      setSaved]      = useState<number[]>([])
  const [picked,     setPicked]     = useState<Set<number>>(new Set())
  const [cats,       setCats]       = useState<Set<string>>(new Set())
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [note,       setNote]       = useState('')
  const [err,        setErr]        = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(''); setNote('')
    try {
      const res = await fetch(
        `/api/admin/dashboard-access?loginId=${loginId}`,
        { credentials: 'include' })
      const data = await res.json()
      if (!data?.success) { setErr(data?.error || 'Could not read report access'); return }

      const rows: DashModuleRow[] = Array.isArray(data.modules) ? data.modules : []
      const allowed: number[] = Array.isArray(data.allowed) ? data.allowed.map(Number) : []
      setModules(rows)
      setUnlisted(Array.isArray(data.unlisted) ? data.unlisted : [])
      setServerRestricted(!!data.restricted)
      setRestricted(!!data.restricted)
      setSaved(allowed)
      setPicked(new Set(allowed))

      /* Open on the groups the grant is already in. The categories are not
         stored, so they are recovered from what was granted — which is the same
         answer, and one fewer thing to keep in step. */
      const seed = new Set<string>()
      for (const r of rows) {
        if (allowed.includes(r.moduleId)) seed.add((r.category || '').trim() || UNFILED)
      }
      setCats(seed)
    } catch {
      setErr('Could not read report access')
    } finally {
      setLoading(false)
    }
  }, [loginId])

  useEffect(() => { load() }, [load])

  /* Which category buttons to draw: the vocabulary, plus the unfiled bucket
     only when something is actually in it. An always-present "Uncategorised"
     on a fully categorised catalogue is a button that can only ever open an
     empty list. */
  const groups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of modules) {
      const k = (m.category || '').trim() || UNFILED
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const out = DASHBOARD_CATEGORIES
      .filter(c => (counts.get(c) ?? 0) > 0)
      .map(c => ({ key: c as string, label: c as string, count: counts.get(c) ?? 0 }))
    if ((counts.get(UNFILED) ?? 0) > 0) {
      out.push({ key: UNFILED, label: 'Uncategorised', count: counts.get(UNFILED) ?? 0 })
    }
    return out
  }, [modules])

  /* The modules on offer. With no category chosen the list is empty on purpose
     — the prompt below says which button to press, and showing all twenty
     would make the category row look optional when it is the whole point. */
  const shown = useMemo(
    () => modules.filter(m => cats.has((m.category || '').trim() || UNFILED)),
    [modules, cats])

  /* Ticked modules whose category is no longer shown. Kept in the grant — a
     category is a lens, not a scope, and un-pressing one must not silently
     revoke what was granted through it — but SAID, because they are ticks the
     admin cannot currently see. */
  const hiddenPicked = useMemo(
    () => modules.filter(m => picked.has(m.moduleId) &&
      !cats.has((m.category || '').trim() || UNFILED)),
    [modules, picked, cats])

  /* Ticked modules that resolve to no report. The one failure this panel exists
     to make visible: the grant looks complete and takes every report away. */
  const unresolved = useMemo(
    () => modules.filter(m => picked.has(m.moduleId) && !m.reportKey),
    [modules, picked])

  /* There is something to apply when the switch is on and the stored state
     does not already say exactly this — either because nothing is stored yet
     or because the ticks have moved. Turning the switch OFF is not a pending
     change: it saves itself, like the layout switch above. */
  const dirty = restricted && (!serverRestricted || !sameIds(saved, picked))

  function toggleCat(key: string) {
    setNote('')
    setCats(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function toggleModule(id: number) {
    setNote('')
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  /* "All" and "None" over the VISIBLE modules only. They act on what is on
     screen, which is what a reader expects of a control sitting on top of a
     filtered list, and never reach into a category they cannot see. */
  const allShownOn = shown.length > 0 && shown.every(m => picked.has(m.moduleId))
  function toggleAllShown() {
    setNote('')
    setPicked(prev => {
      const next = new Set(prev)
      for (const m of shown) { if (allShownOn) next.delete(m.moduleId); else next.add(m.moduleId) }
      return next
    })
  }

  /* Turning the switch ON opens the picker and writes NOTHING.

     It is the difference between "I am about to narrow this account" and "this
     account now opens no reports", and a switch that saved on the click would
     mean the second every time somebody went looking for the first — access
     revoked by opening a panel to grant it. Applying is the deliberate second
     act, on its own button.

     Turning it OFF is the opposite case and saves at once: it restores every
     report, it is what somebody reaches for to undo a mistake, and there is
     nothing to compose first. */
  function toggle() {
    setNote('')
    if (restricted) { save(false); return }
    setRestricted(true)
  }

  async function save(nextRestricted: boolean) {
    setSaving(true); setNote('')
    try {
      const res = await fetch('/api/admin/dashboard-access', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // null clears the restriction; an array — empty included — sets one.
        body: JSON.stringify({
          loginId,
          modules: nextRestricted ? [...picked] : null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        setNote(data.error || `Report access could not be saved (HTTP ${res.status}).`)
        return
      }
      setRestricted(nextRestricted)
      setServerRestricted(nextRestricted)
      setSaved(nextRestricted ? [...picked] : [])
      setNote(nextRestricted
        ? `Saved — this account opens ${picked.size} report module${picked.size === 1 ? '' : 's'}.`
        : 'Saved — this account opens every report.')
    } catch {
      setNote('Report access could not be saved — the request did not complete.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pt-3 mt-1 border-t border-gray-100 dark:border-white/10">
      <div className="flex items-start gap-3">
        {/* The same switch as the layout grant above, because it answers the
            same shape of question: is this account narrowed at all. What it is
            narrowed TO is the two steps below, and they only exist once it is. */}
        <button type="button" role="switch" aria-checked={restricted}
          onClick={toggle} disabled={saving || loading}
          className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors
            disabled:opacity-50 flex-shrink-0 mt-0.5 ${restricted ? 'bg-emerald-500' : 'bg-gray-200 dark:bg-white/15'}`}>
          <span className={`inline-block w-[18px] h-[18px] bg-white rounded-full shadow transform
            transition-transform ${restricted ? 'translate-x-[24px]' : 'translate-x-[3px]'}`} />
        </button>

        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-widest text-[#14254A] dark:text-white">
            Report modules
          </p>
          <p className={`text-xs font-semibold mt-0.5 ${restricted ? 'text-emerald-600' : 'text-gray-500 dark:text-white/60'}`}>
            {loading ? 'Checking…'
              : !restricted ? 'Opens every report'
              : serverRestricted ? 'Only the modules chosen below'
              /* On, but nothing written yet. Said plainly, because until Apply
                 is pressed this account still opens everything and the switch
                 alone would suggest otherwise. */
              : 'Choose modules below, then apply'}
          </p>

          <p className="text-[11px] text-gray-500 dark:text-white/50 mt-1.5 leading-relaxed">
            Narrows the <strong>Reports</strong> page to chosen modules from the
            dashboard module catalogue. Everything else about the report — the figures,
            the filters, the layout — is unchanged; this only decides which reports are
            in the sidebar and which the server will serve.
          </p>

          {/* Said plainly, because two screens editing one thing is the sort of
              arrangement people discover by making a change that appears to
              undo someone else's. */}
          <p className="text-[11px] text-gray-500 dark:text-white/50 mt-1.5 leading-relaxed">
            This is the same grant as <strong>Report Configuration › User access</strong> —
            one list, shown two ways. Ticking here ticks there, and the reverse.
          </p>

          {/* Which client this is about, named rather than left to the picker
              two sections up — this control is far enough below it that "the
              selected company" is a claim the reader has to go and check. */}
          <p className="text-[11px] text-gray-400 mt-1.5 leading-relaxed">
            Applies to <strong>{clientName || 'the company selected above'}</strong> only,
            like the modules above it. Switch company to set another.
          </p>

          {/* A control that silently destroys what it never showed is the
              failure this line exists to rule out. */}
          {unlisted.length > 0 && (
            <p className="text-[11px] text-gray-500 dark:text-white/50 mt-1.5 leading-relaxed">
              Also held, and kept when you apply: <strong>{unlisted.join(', ')}</strong> — no
              module in the catalogue names {unlisted.length === 1 ? 'it' : 'them'}, so
              {unlisted.length === 1 ? ' it' : ' they'} cannot be ticked here.
            </p>
          )}

          {err && <p className="text-[11px] text-red-600 mt-1.5">{err}</p>}

          {restricted && !loading && !err && (
            <div className="mt-3 space-y-2.5">
              {/* ── Step one: category ─────────────────────────────────────── */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">
                  Category
                </p>
                {groups.length === 0 ? (
                  <p className="text-[11px] text-gray-400">
                    The dashboard module catalogue is empty. Add modules on
                    Configuration → PowerBI Dashboard Modules first.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {groups.map(g => {
                      const on = cats.has(g.key)
                      return (
                        <button key={g.key} type="button" onClick={() => toggleCat(g.key)}
                          className={`px-2.5 py-1.5 rounded-xl text-[11px] font-semibold border
                            inline-flex items-center gap-1.5 transition-colors ${on
                              ? 'text-white border-transparent'
                              : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50 ' +
                                'dark:bg-white/5 dark:text-white/70 dark:border-white/15 dark:hover:bg-white/10'}`}
                          style={on ? { background: NAVY } : undefined}>
                          <span>{g.label}</span>
                          <span className={on ? 'text-white/60' : 'text-gray-400'}>{g.count}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* ── Step two: the modules in it ────────────────────────────── */}
              {cats.size === 0 ? (
                groups.length > 0 && (
                  <p className="text-[11px] text-gray-400 leading-snug">
                    Choose a category to see the modules in it. More than one may be chosen.
                  </p>
                )
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                      Modules
                    </p>
                    {shown.length > 0 && (
                      <button type="button" onClick={toggleAllShown}
                        className="text-[10px] font-bold uppercase tracking-wider
                          text-gray-400 hover:text-[#14254A] dark:hover:text-white transition-colors">
                        {allShownOn ? 'Clear these' : 'Select these'}
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {shown.map(m => {
                      const on = picked.has(m.moduleId)
                      return (
                        <label key={m.moduleId}
                          title={m.reportKey ? `Opens “${m.reportLabel}”` : 'Matches no report'}
                          className={`flex items-start gap-2.5 px-3 py-2 rounded-xl border cursor-pointer
                            transition-colors ${on
                              ? 'border-[#FC934C]/40 bg-[#FC934C]/[0.07]'
                              : 'border-gray-100 bg-gray-50 hover:bg-gray-100 ' +
                                'dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.07]'}`}>
                          <input type="checkbox" checked={on} onChange={() => toggleModule(m.moduleId)}
                            className="w-4 h-4 rounded flex-shrink-0 mt-0.5" style={{ accentColor: ORANGE }} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className={`text-xs truncate ${on
                                ? 'font-semibold text-[#14254A] dark:text-white'
                                : 'text-gray-600 dark:text-white/60'}`}>
                                {m.moduleName}
                              </span>
                              <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md flex-shrink-0 ${chipFor(m.category)}`}>
                                {categoryLabel(m.category)}
                              </span>
                            </span>
                            {/* What this module will actually OPEN. The module
                                catalogue and the report list are two different
                                tables joined by name, so the join is shown here
                                — where it is being relied on and where a name
                                that does not line up can still be corrected. */}
                            <span className={`block text-[10px] mt-0.5 truncate ${m.reportKey
                              ? 'text-gray-400 dark:text-white/35'
                              : 'text-amber-700 dark:text-amber-300 font-semibold'}`}>
                              {m.reportKey ? m.reportLabel : 'Matches no report — grants nothing'}
                            </span>

                          </span>
                        </label>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Ticks the current category filter is hiding. Not revoked —
                  see the note on hiddenPicked — so they have to be stated, or
                  the count on the button below contradicts what is on screen. */}
              {hiddenPicked.length > 0 && (
                <p className="text-[10px] text-gray-400 leading-snug">
                  {hiddenPicked.length} more module{hiddenPicked.length === 1 ? ' is' : 's are'} granted
                  in {hiddenPicked.length === 1 ? 'a category' : 'categories'} not shown
                  ({[...new Set(hiddenPicked.map(m => categoryLabel(m.category)))].join(', ')}).
                  They stay granted.
                </p>
              )}

              {/* The misconfiguration that otherwise looks like success. */}
              {unresolved.length > 0 && (
                <p className="text-[10px] text-amber-700 dark:text-amber-300 leading-snug">
                  {unresolved.length} chosen module{unresolved.length === 1 ? '' : 's'} match no report
                  and grant nothing: {unresolved.map(m => m.moduleName).join(', ')}. A module opens the
                  report whose name matches it — check the spelling against Report Configuration.
                </p>
              )}

              {/* The other way to reach nothing, and the one most likely to be
                  reached by accident. */}
              {picked.size === 0 && (
                <p className="text-[10px] text-amber-700 dark:text-amber-300 leading-snug">
                  Nothing is chosen. Saved as it stands, this account opens no reports at all —
                  turn the switch off instead to give it every report.
                </p>
              )}

              <div className="flex items-center justify-between gap-3 pt-0.5">
                <span className="text-[10px] text-gray-400">
                  {picked.size} module{picked.size === 1 ? '' : 's'} granted
                </span>
                <button type="button" onClick={() => save(true)} disabled={saving || !dirty}
                  className="px-3.5 py-1.5 rounded-xl text-[11px] font-bold text-white
                    transition-opacity hover:opacity-90 disabled:opacity-40"
                  style={{ background: NAVY }}>
                  {saving ? 'Applying…' : dirty ? 'Apply modules' : 'Applied'}
                </button>
              </div>
            </div>
          )}

          {note && (
            <p className="text-[11px] text-gray-500 dark:text-white/50 mt-2 leading-snug">{note}</p>
          )}
        </div>
      </div>
    </div>
  )
}
