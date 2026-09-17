'use client'

/*
Report Configuration → Welcome calendar.

Which arrows the programme calendar on /welcome draws, per client with a shared
default underneath — see components/client/ProgramCalendar.tsx for what the
calendar itself does with the answer, and go-server/handlers/welcomecalendar.go
for how it is stored and resolved.

Three checkboxes, not a single three-way choice, because the two directions are
independent: a client can be given a Previous arrow, a Next arrow, or both.
COMPLETE is its own checkbox rather than shorthand for ticking the other two —
it is how the calendar behaved before this screen existed (every direction
open) and switching a client onto it is one click rather than two. It is no
longer the SHIPPED default, though: a fresh install, and the shared setting's
own "reset", both land on Next only now — see go-server/handlers/
welcomecalendar.go's schema comment for why.

Same two-layer lookup as Appearance beside it: a client with a row of their own
takes it whole, and the shared default underneath is what everyone else reads.
*/

import { useCallback, useEffect, useState } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'

interface Nav {
  previous: boolean
  next: boolean
  complete: boolean
  /** Which row the server answered from: '' is the shared default. */
  source?: string
}

// Matches the shipped default in go-server/handlers/welcomecalendar.go — shown
// only for the instant before the fetch below resolves the real answer, but
// worth getting right rather than flashing "Complete" for a frame before the
// server's "Next" replaces it.
const DEFAULT_NAV: Nav = { previous: false, next: true, complete: false }

function Checkbox({ on, title, hint, onClick }: {
  on: boolean; title: string; hint: string; onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`text-left p-3 rounded-xl border transition-colors flex items-start gap-3 ${
        on
          ? 'border-[#FC934C] bg-[#FC934C]/[0.07] dark:bg-[#FC934C]/10'
          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-white/15 dark:hover:bg-white/5'
      }`}>
      <span className={`mt-0.5 w-4 h-4 rounded-[4px] border flex items-center justify-center shrink-0 ${
        on ? 'bg-[#FC934C] border-[#FC934C]' : 'border-gray-300 dark:border-white/25'}`}>
        {on && (
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
            <path d="M1 4l3 3 5-6" stroke="white" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        <span className={`block text-xs font-bold ${
          on ? 'text-[#14254A] dark:text-white' : 'text-gray-600 dark:text-gray-300'}`}>
          {title}
        </span>
        <span className="block text-[10.5px] text-gray-400 leading-snug mt-0.5">{hint}</span>
      </span>
    </button>
  )
}

export default function WelcomeCalendarPanel() {
  const [clientId, setClientId] = useState('')
  const [directory, setDirectory] = useState<{ id: string; name: string }[]>([])
  const [withOwn, setWithOwn] = useState<string[]>([])

  const [saved, setSaved] = useState<Nav>(DEFAULT_NAV)
  const [draft, setDraft] = useState<Nav>(DEFAULT_NAV)
  const [inherited, setInherited] = useState(false)

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const nameOf = useCallback((id: string) =>
    directory.find(c => c.id === id)?.name || id, [directory])

  // The warehouse's own client directory — same source Appearance and Sports
  // period read, so the three screens never disagree about who exists.
  useEffect(() => {
    fetch('/api/admin/report-client-map', { credentials: 'include' })
      .then(r => r.json())
      .then(j => setDirectory(Array.isArray(j.warehouseClients)
        ? j.warehouseClients.map((c: any) => ({ id: String(c.id), name: String(c.name || c.id) }))
        : []))
      .catch(() => { /* the picker degrades to ids, which still work */ })
  }, [])

  const load = useCallback(async (id: string) => {
    setLoading(true); setErr(''); setMsg('')
    try {
      const r = await fetch(`/api/admin/report-welcome-calendar?clientId=${encodeURIComponent(id)}`,
        { credentials: 'include' })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Could not load the calendar setting')
      const n: Nav = {
        previous: !!j.nav?.previous,
        next: !!j.nav?.next,
        complete: !!j.nav?.complete,
        source: String(j.nav?.source ?? ''),
      }
      setSaved(n)
      setDraft(n)
      setInherited(!!j.inherited)
      setWithOwn(Array.isArray(j.clients) ? j.clients.map(String) : [])
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(clientId) }, [clientId, load])

  const dirty = draft.previous !== saved.previous
    || draft.next !== saved.next
    || draft.complete !== saved.complete

  async function save() {
    setBusy('save'); setErr(''); setMsg('')
    try {
      const r = await fetch('/api/admin/report-welcome-calendar', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId, previous: draft.previous, next: draft.next, complete: draft.complete,
        }),
      })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not save the calendar setting'); return }
      setMsg(clientId ? `Calendar setting saved for ${nameOf(clientId)}.` : 'Default calendar setting saved.')
      await load(clientId)
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setBusy('')
    }
  }

  async function reset() {
    setBusy('reset'); setErr(''); setMsg('')
    try {
      const r = await fetch(`/api/admin/report-welcome-calendar?clientId=${encodeURIComponent(clientId)}`,
        { method: 'DELETE', credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not reset the calendar setting'); return }
      setMsg(clientId
        ? `${nameOf(clientId)} follows the shared calendar setting again.`
        : 'Default calendar setting back to Next only.')
      await load(clientId)
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setBusy('')
    }
  }

  const scopeLabel = clientId ? nameOf(clientId) : 'every client'

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 dark:text-white/45 max-w-3xl leading-relaxed">
        Whether a client can page their <strong>/welcome</strong> calendar off the current month, and
        which direction. Set it once for everybody, or give one client their own — a client with
        their own takes it whole, so a later change to the shared setting cannot silently open or
        close a direction on a screen you set up deliberately.
      </p>

      {err && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2
          dark:bg-red-500/10 dark:border-red-400/25 dark:text-red-300">{err}</p>
      )}
      {msg && !err && (
        <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2
          dark:bg-emerald-500/10 dark:border-emerald-400/25 dark:text-emerald-300">{msg}</p>
      )}

      {/* ── Whose calendar ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
          Setting for
        </label>
        <span className="w-[300px] max-w-full">
          <SearchableSelect
            options={directory.map(c => ({
              key: c.id,
              label: withOwn.includes(c.id) ? `${c.name}  ·  has its own setting` : c.name,
            }))}
            value={clientId}
            onChange={setClientId}
            placeholder="All clients (shared setting)"
            emptyLabel="All clients (shared setting)" />
        </span>
        {inherited && (
          <span className="px-2 py-1 rounded-lg text-[10.5px] font-bold uppercase tracking-wide
            bg-amber-50 text-amber-800 border border-amber-200
            dark:bg-amber-500/10 dark:border-amber-400/25 dark:text-amber-200">
            Following the shared setting — saving creates one for this client
          </span>
        )}
        {directory.length === 0 && (
          <span className="text-[11px] text-gray-400">
            Client list unavailable — the shared setting can still be set.
          </span>
        )}
      </div>

      {loading ? (
        <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
          dark:border-white/10 p-8 text-center text-sm text-gray-400">
          Loading the calendar setting…
        </div>
      ) : (
        <>
          <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
            dark:border-white/10 p-5 sm:p-6">
            <h2 className="font-bold text-[#14254A] dark:text-white">Which months can be reached</h2>
            <p className="text-xs text-gray-500 dark:text-white/45 mt-1 max-w-2xl leading-relaxed">
              The calendar always opens on the current month. These decide what a reader can page to
              from there. <strong>Complete</strong> is both directions at once, so it stands apart from
              the other two rather than beside them: turning it on clears Previous and Next, and
              turning either of those on turns Complete back off. Check Previous and Next together for
              the same reach with two ticks instead of one, either alone for a single arrow, or leave
              all three off to keep the calendar locked to the current month with no arrows at all.
            </p>
            <div className="grid gap-2 mt-4 sm:grid-cols-3">
              <Checkbox on={draft.complete}
                title="Complete calendar"
                hint="Both arrows — previous, current and next are all reachable."
                onClick={() => setDraft(d => (d.complete
                  ? { ...d, complete: false }
                  // Exclusive with the other two: it is not shorthand for
                  // ticking them both, it is the state that replaces them.
                  : { previous: false, next: false, complete: true }))} />
              <Checkbox on={draft.previous}
                title="Previous"
                hint="A ‹ arrow that steps back one month at a time."
                onClick={() => setDraft(d => ({ ...d, previous: !d.previous, complete: false }))} />
              <Checkbox on={draft.next}
                title="Next (default)"
                hint="A › arrow that steps forward one month at a time."
                onClick={() => setDraft(d => ({ ...d, next: !d.next, complete: false }))} />
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={save} disabled={!!busy || !dirty}
              className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-[#14254A]
                hover:opacity-90 transition-opacity disabled:opacity-50">
              {busy === 'save'
                ? 'Saving…'
                : clientId ? 'Save for this client' : 'Save the shared setting'}
            </button>
            <button type="button" onClick={() => load(clientId)} disabled={!!busy || !dirty}
              className="px-4 py-2 rounded-xl text-xs font-semibold border border-gray-200 text-gray-600
                hover:bg-gray-50 dark:border-white/15 dark:text-white/60 dark:hover:bg-white/5
                disabled:opacity-50">
              Discard changes
            </button>
            {(!clientId || !inherited) && (
              <button type="button" onClick={reset} disabled={!!busy}
                className="px-4 py-2 rounded-xl text-xs font-semibold border border-gray-200 text-gray-500
                  hover:border-red-300 hover:text-red-600 dark:border-white/15 dark:text-white/50
                  transition-colors disabled:opacity-50">
                {busy === 'reset'
                  ? 'Resetting…'
                  : clientId ? 'Follow the shared setting' : 'Back to Next only'}
              </button>
            )}
            <span className="text-[11px] text-gray-400 dark:text-white/35">
              Applies to the welcome calendar {scopeLabel === 'every client' ? 'for every client' : `for ${scopeLabel}`}.
            </span>
          </div>
        </>
      )}
    </div>
  )
}
