'use client'

/*
The reporting period the sports reports are bound to.

A window — a start and an end — and every sports report is held inside it: the
charts, the slicer value lists and the live count above them. The server clamps
to it on every request (go-server/handlers/sportsperiod.go); this screen is
where the window is decided, and the report's calendar then refuses to leave it.

Why a whole screen for two dates: a sports report is not a live feed. Its data is
loaded for a season or a contracted term, and outside that term the tables hold
nothing. A reader with a free calendar picks a range that predates the data and
reads the empty result as "nothing was found" — a very different statement from
"you are looking outside the period", and the one that gets raised as a fault.

TWO LEVELS, and the second is why this screen has a list on it:

  - The DEFAULT, which every client follows.
  - A CLIENT's own window, which replaces the default outright — not intersected
    with it, since one client's season need not overlap another's at all.

A client row that is switched OFF is the third state and the one worth knowing
about: it means "no period for this client", which is how a single client is
exempted from a default that applies to everyone else. Removing the row is the
different act of returning them to the default.

Each end is given as a whole month or as an exact day. Months are what these
terms are described in ("the 2025 season, January to March"), and a month is
only shorthand for a pair of days — so it is expanded here, to the 1st and to
the last day. Exact days use the portal's own calendar rather than the browser's
native one, so the control looks like every other date control in the product.
*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import DatePicker from '@/components/ui/DatePicker'
import SearchableSelect from '@/components/ui/SearchableSelect'

type Mode = 'month' | 'date'

interface Period {
  enabled: boolean
  start: string      // YYYY-MM-DD
  end: string        // YYYY-MM-DD
  startMode: Mode
  endMode: Mode
  updatedBy?: string
  updatedAt?: string
}

interface ClientPeriod extends Period { clientId: string }

const BRAND_NAVY = '#14254A'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const pad = (n: number) => String(n).padStart(2, '0')

/** Years offered in the month picker: a decade back, two forward. A term is
 *  routinely configured before its data lands, which is the normal way round. */
const THIS_YEAR = new Date().getUTCFullYear()
const YEARS = Array.from({ length: 13 }, (_, i) => THIS_YEAR - 10 + i)

const firstOf = (y: number, m: number) => `${y}-${pad(m + 1)}-01`
/** Day 0 of the NEXT month is the last day of this one, leap years included. */
const lastOf = (y: number, m: number) =>
  `${y}-${pad(m + 1)}-${pad(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}`

const yearOf  = (d: string) => Number(d.slice(0, 4)) || THIS_YEAR
const monthOf = (d: string) => (Number(d.slice(5, 7)) || 1) - 1

const blankPeriod = (): Period => ({
  enabled: true,
  start: firstOf(THIS_YEAR, 0),
  end: lastOf(THIS_YEAR, 11),
  startMode: 'month',
  endMode: 'month',
})

/**
 * How long the window is, in the words the person setting it would use.
 *
 * The figure that matters is not "89 days" — it is whether this is a month or a
 * season, because that is what the report's calendar and its trend axis become.
 */
function describe(start: string, end: string): string {
  if (!start || !end || start > end) return ''
  const a = new Date(`${start}T00:00:00Z`)
  const b = new Date(`${end}T00:00:00Z`)
  const days = Math.round((b.getTime() - a.getTime()) / 86400e3) + 1
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1

  if (days <= 31 && months <= 1) return `${days} day${days === 1 ? '' : 's'}`
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} · ${days} days`
  const years = Math.floor(months / 12)
  const rest  = months % 12
  const y = `${years} year${years === 1 ? '' : 's'}`
  return rest ? `${y} ${rest} month${rest === 1 ? '' : 's'} · ${days} days` : `${y} · ${days} days`
}

/** One end of a period. Month + year, or an exact day on the portal's own
 *  calendar — never the browser's, which draws itself in the OS's colours and
 *  is the one control on the screen that would not match the rest. */
function EndPicker({ label, mode, value, edge, disabled, onMode, onValue }: {
  label: string
  mode: Mode
  value: string
  edge: 'start' | 'end'
  disabled?: boolean
  onMode: (m: Mode) => void
  onValue: (v: string) => void
}) {
  const y = yearOf(value)
  const m = monthOf(value)
  const setMonth = (yy: number, mm: number) =>
    onValue(edge === 'start' ? firstOf(yy, mm) : lastOf(yy, mm))

  return (
    <div className="flex-1 min-w-[236px]">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <label className="text-xs font-medium text-gray-700 dark:text-white/70">{label}</label>
        {/* Two words rather than a dropdown: there are only two, and a select
            for a binary choice is a click spent finding out what the options
            are. */}
        <div className="flex text-[10px] font-bold uppercase tracking-wide rounded-lg overflow-hidden
          border border-gray-200 dark:border-white/15">
          {(['month', 'date'] as Mode[]).map(op => (
            <button key={op} type="button" disabled={disabled} onClick={() => onMode(op)}
              className={`px-2 py-1 transition-colors disabled:opacity-50 ${mode === op
                ? 'bg-[#14254A] text-white'
                : 'text-gray-500 hover:bg-gray-50 dark:text-white/50 dark:hover:bg-white/5'}`}>
              {op === 'month' ? 'Month' : 'Exact day'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'month' ? (
        /* The product's own dropdown, not the browser's.

           A native <select> has its list drawn by the OPERATING SYSTEM — square
           corners, its own blue highlight, its own font — and nothing in this
           stylesheet reaches it. Beside a date picker that rounds at 12px and
           focuses in brand orange, the month list read as a control borrowed
           from another application. This is the same picker the reports rail and
           every other slicer use: themed, keyboard-navigable, and portalled so
           it escapes the card's overflow instead of being clipped by it.

           `clearable={false}` on both: a period end is a month and a year, and
           there is no "no month". The clear row hands back an empty string,
           Number('') is 0, and 0 is January — so choosing nothing would have
           silently chosen something. Values cross as strings, which is what the
           component speaks; the state keeps the numbers. */
        <div className="flex gap-2">
          <div className="flex-1">
            <SearchableSelect
              options={MONTHS.map((name, i) => ({ key: String(i), label: name }))}
              value={String(m)} disabled={disabled} clearable={false}
              onChange={v => setMonth(y, Number(v))} />
          </div>
          <div className="w-28">
            <SearchableSelect
              options={YEARS.map(yy => ({ key: String(yy), label: String(yy) }))}
              value={String(y)} disabled={disabled} clearable={false}
              onChange={v => setMonth(Number(v), m)} />
          </div>
        </div>
      ) : (
        <DatePicker value={value} onChange={onValue} disabled={disabled}
          accentColor={BRAND_NAVY} placeholder="Pick a day" />
      )}

      {/* The resolved day, always. A month picker hides which day it means, and
          which day it means is exactly what the reports will enforce. */}
      <p className="text-[11px] text-gray-400 dark:text-white/40 mt-1">
        {value
          ? <>Reads {edge === 'start' ? 'from' : 'to'} <span className="font-mono">{value}</span></>
          : 'Not set'}
      </p>
    </div>
  )
}

/** The two ends plus what they add up to. Shared by the default and by every
 *  client override, so the two cannot drift in what they accept. */
function PeriodFields({ p, disabled, onChange }: {
  p: Period
  disabled?: boolean
  onChange: (next: Period) => void
}) {
  const backwards = !!p.start && !!p.end && p.start > p.end
  const span = describe(p.start, p.end)
  const set = (patch: Partial<Period>) => onChange({ ...p, ...patch })

  return (
    <>
      <div className={`flex gap-4 flex-wrap transition-opacity ${disabled ? 'opacity-55' : ''}`}>
        <EndPicker label="Period starts" edge="start" mode={p.startMode} value={p.start}
          disabled={disabled}
          onMode={m => set({ startMode: m })} onValue={v => set({ start: v })} />
        <EndPicker label="Period ends" edge="end" mode={p.endMode} value={p.end}
          disabled={disabled}
          onMode={m => set({ endMode: m })} onValue={v => set({ end: v })} />
      </div>

      {backwards ? (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-3">
          The period ends before it starts.
        </p>
      ) : span ? (
        /* What the two dates ADD UP TO. Setting a start and an end separately
           makes it easy to save a window a month long when a season was meant,
           and the length is the thing nobody computes for themselves. */
        <p className="text-xs text-gray-500 dark:text-white/45 mt-3">
          Covers <span className="font-semibold text-[#14254A] dark:text-white">{span}</span>
          {' — '}<span className="font-mono">{p.start}</span> to <span className="font-mono">{p.end}</span>.
          {' '}Calendars open on the last 7 days of it.
        </p>
      ) : null}
    </>
  )
}

/** The On/Off switch. Its meaning differs between the two levels, so the
 *  caller supplies the words: a default that is off applies to nobody, while a
 *  client that is off is exempted from the default. */
function Toggle({ on, onLabel, offLabel, onClick }: {
  on: boolean; onLabel: string; offLabel: string; onClick: () => void
}) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-colors ${
        on
          ? 'bg-[#14254A] text-white'
          : 'border border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-white/15 dark:text-white/50 dark:hover:bg-white/5'}`}>
      <span className={`w-2 h-2 rounded-full ${on ? 'bg-[#FC934C]' : 'bg-gray-300'}`} />
      {on ? onLabel : offLabel}
    </button>
  )
}

export default function SportsPeriodPanel() {
  const [def, setDef]         = useState<Period | null>(null)
  const [clients, setClients] = useState<ClientPeriod[]>([])
  /** The warehouse's own client list, for the picker and for naming the rows. */
  const [directory, setDirectory] = useState<{ id: string; name: string }[]>([])
  const [draft, setDraft]     = useState<Record<string, Period>>({})
  const [adding, setAdding]   = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy]       = useState('')
  const [err, setErr]         = useState('')
  const [msg, setMsg]         = useState('')

  const nameOf = useCallback((id: string) =>
    directory.find(c => c.id === id)?.name || id, [directory])

  const apply = useCallback((j: any) => {
    const d: Period = j.period || {}
    setDef({
      enabled: !!d.enabled,
      // A blank form is not a useful starting point, so an unset period opens
      // on the current year — a shape to adjust rather than one to invent.
      start: d.start || firstOf(THIS_YEAR, 0),
      end:   d.end   || lastOf(THIS_YEAR, 11),
      startMode: d.startMode === 'date' ? 'date' : 'month',
      endMode:   d.endMode   === 'date' ? 'date' : 'month',
      updatedBy: d.updatedBy, updatedAt: d.updatedAt,
    })
    setClients(Array.isArray(j.clients) ? j.clients : [])
    setDraft({})
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const r = await fetch('/api/admin/report-sports-period', { credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not load the reporting period'); return }
      apply(j)
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }, [apply])

  useEffect(() => { load() }, [load])

  /* The client list comes from the mapping screen's endpoint rather than from
     this one: it is the warehouse's own directory, already served for the
     Client mapping tab, and resolving names on the settings read would put a
     warehouse round-trip behind a two-date lookup. */
  useEffect(() => {
    fetch('/api/admin/report-client-map', { credentials: 'include' })
      .then(r => r.json())
      .then(j => setDirectory(Array.isArray(j.warehouseClients) ? j.warehouseClients : []))
      .catch(() => { /* the picker degrades to ids, which still work */ })
  }, [])

  async function send(body: any, what: string) {
    setBusy(what); setErr(''); setMsg('')
    try {
      const r = await fetch('/api/admin/report-sports-period', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not save'); return }
      apply(j)
      setMsg(what === 'default'
        ? 'Default period saved.'
        : `Period saved for ${nameOf(what)}.`)
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setBusy('')
    }
  }

  async function remove(clientId: string) {
    setBusy(clientId); setErr(''); setMsg('')
    try {
      const r = await fetch(`/api/admin/report-sports-period?clientId=${encodeURIComponent(clientId)}`,
        { method: 'DELETE', credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not remove'); return }
      apply(j)
      setMsg(`${nameOf(clientId)} follows the default period again.`)
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setBusy('')
    }
  }

  /** Clients without a row of their own — the only ones worth offering to add. */
  const addable = useMemo(() => {
    const has = new Set(clients.map(c => c.clientId))
    return directory.filter(c => !has.has(c.id)).map(c => ({ key: c.id, label: c.name }))
  }, [directory, clients])

  const rowOf = (c: ClientPeriod): Period => draft[c.clientId] ?? c
  const dirty = (c: ClientPeriod) => !!draft[c.clientId]
  const bad = (p: Period) => !!p.start && !!p.end && p.start > p.end

  if (loading) return <p className="text-sm text-gray-400 px-1 py-6">Loading the reporting period…</p>
  if (!def) return <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{err}</p>

  return (
    <div className="space-y-4 max-w-3xl">
      {err && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{err}</p>}
      {msg && !err && (
        <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">{msg}</p>
      )}

      {/* ── The default ──────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
        dark:border-white/10 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-bold text-[#14254A] dark:text-white">Default period</h2>
            <p className="text-xs text-gray-500 dark:text-white/45 mt-1 max-w-lg leading-relaxed">
              The window every sports report reads, for every client without one of its own.
              Their calendars are held inside it, and a request for anything outside it is
              brought back in.
            </p>
          </div>
          <Toggle on={def.enabled} onLabel="On" offLabel="Off"
            onClick={() => setDef({ ...def, enabled: !def.enabled })} />
        </div>

        <div className="mt-5">
          <PeriodFields p={def} disabled={!def.enabled} onChange={setDef} />
        </div>

        <div className="flex items-center gap-3 mt-5 flex-wrap">
          <button type="button" onClick={() => send({ ...def }, 'default')}
            disabled={!!busy || bad(def)}
            className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-[#14254A]
              hover:opacity-90 transition-opacity disabled:opacity-50">
            {busy === 'default' ? 'Saving…' : 'Save default'}
          </button>
          <button type="button" onClick={load} disabled={!!busy}
            className="px-4 py-2 rounded-xl text-xs font-semibold border border-gray-200 text-gray-600
              hover:bg-gray-50 dark:border-white/15 dark:text-white/60 dark:hover:bg-white/5 disabled:opacity-50">
            Discard changes
          </button>
          {def.updatedAt && (
            <span className="text-[11px] text-gray-400 dark:text-white/35">
              Last saved {def.updatedAt.slice(0, 16).replace('T', ' ')}
              {def.updatedBy ? ` by ${def.updatedBy}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* ── Per client ───────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
        dark:border-white/10 p-5 sm:p-6">
        <h2 className="font-bold text-[#14254A] dark:text-white">Per client</h2>
        <p className="text-xs text-gray-500 dark:text-white/45 mt-1 max-w-lg leading-relaxed">
          A client listed here reads its own window instead of the default — replaced outright,
          not narrowed, since one client&rsquo;s season need not overlap another&rsquo;s. Switch a
          client <b>Off</b> to give it no period at all; remove it to return it to the default.
        </p>

        <div className="flex items-end gap-2 mt-4 flex-wrap">
          <div className="min-w-[260px] flex-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-white/70 mb-1.5">
              Add a client
            </label>
            <SearchableSelect options={addable} value={adding} onChange={setAdding}
              placeholder={directory.length ? 'Pick a client…' : 'Client list unavailable'}
              emptyLabel="Every client already has its own period"
              disabled={!!busy || addable.length === 0} />
          </div>
          <button type="button" disabled={!adding || !!busy}
            onClick={() => { send({ ...blankPeriod(), clientId: adding }, adding); setAdding('') }}
            className="px-4 py-2.5 rounded-xl text-xs font-bold text-white bg-[#14254A]
              hover:opacity-90 transition-opacity disabled:opacity-50">
            Add
          </button>
        </div>

        {clients.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-white/35 mt-5">
            No client has its own period. Every sports report follows the default above.
          </p>
        ) : (
          <div className="mt-5 space-y-3">
            {clients.map(c => {
              const p = rowOf(c)
              const set = (next: Period) => setDraft(d => ({ ...d, [c.clientId]: next }))
              return (
                <div key={c.clientId}
                  className="rounded-xl border border-gray-100 dark:border-white/10 p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#14254A] dark:text-white truncate">
                        {nameOf(c.clientId)}
                      </p>
                      <p className="text-[11px] text-gray-400 dark:text-white/35 font-mono truncate">
                        {c.clientId}
                      </p>
                    </div>
                    <Toggle on={p.enabled} onLabel="Own period" offLabel="No period"
                      onClick={() => set({ ...p, enabled: !p.enabled })} />
                  </div>

                  <div className="mt-4">
                    <PeriodFields p={p} disabled={!p.enabled} onChange={set} />
                  </div>

                  <div className="flex items-center gap-3 mt-4 flex-wrap">
                    <button type="button" disabled={!!busy || !dirty(c) || bad(p)}
                      onClick={() => send({ ...p, clientId: c.clientId }, c.clientId)}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-[#14254A]
                        hover:opacity-90 transition-opacity disabled:opacity-40">
                      {busy === c.clientId ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" disabled={!!busy} onClick={() => remove(c.clientId)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-200
                        text-gray-600 hover:bg-gray-50 dark:border-white/15 dark:text-white/60
                        dark:hover:bg-white/5 disabled:opacity-50">
                      Use the default
                    </button>
                    {dirty(c) && (
                      <span className="text-[11px] text-amber-700 dark:text-amber-300">Unsaved</span>
                    )}
                    {!dirty(c) && c.updatedAt && (
                      <span className="text-[11px] text-gray-400 dark:text-white/35">
                        Saved {c.updatedAt.slice(0, 16).replace('T', ' ')}
                        {c.updatedBy ? ` by ${c.updatedBy}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Which reports this governs, said outright. It is decided from the
          tables a platform reads rather than from its name, so a list is the
          only way to be sure — and "why is my report not bounded" is otherwise
          a question with no answer on the screen that bounds it. */}
      <p className="text-[11px] text-gray-400 dark:text-white/35 leading-relaxed px-1">
        Applies to every report reading a sports source — Summary, Open Web, UGC &amp; Social Media
        and Telegram on the sports side. The other reports keep their full calendar.
      </p>
    </div>
  )
}
