'use client'

/*
 * The programme calendar — the client's own titles, placed on the dates
 * mediascan.Asset already records.
 *
 * ── Where the two programmes come from ───────────────────────────────────────
 *
 * There is NO programme column on an asset. `IsWarRoom` looked like the obvious
 * classifier and is not one: across all 1,657 DAZN titles it is 0 on every
 * single row, so splitting on it puts everything in one bucket and leaves the
 * other empty. The dates are what actually separate them:
 *
 *   · NPC  — the title carries a ReleaseDate. It is a published work, and the
 *            release is the date the calendar places it on.
 *   · Live — no ReleaseDate. These are fixtures, and their date is the
 *            StartDate, running to EndDate where a window is recorded.
 *
 * That is a rule about the DATA, not a guess about the business, which is why it
 * is written here rather than hidden in a ternary.
 *
 * ── Two traps in the feed, both load-bearing ─────────────────────────────────
 *
 * MatchDay is NOT a date — it holds "Matchday 4", "Matchday 26", "-" — and V8
 * turns `new Date("Matchday 4")` into 4 January 2001 rather than an Invalid
 * Date. Reading it as a date papered the grid with phantom 2001 fixtures. Hence
 * ISO_DAY: a column that is not a date must read as absent, never as a wrong day.
 *
 * And a few windows run for YEARS — "Snooker of DAZN" is booked 2024 to 2032. A
 * title drawn on all 3,075 of those days would fill every cell of every month
 * between. Hence SPAN_FILL_MAX_DAYS.
 *
 * ── Why a PICKER and a LIST, and not a month grid ────────────────────────────
 *
 * A full month grid was the first shape this took and it was the wrong one. Most
 * months here hold a handful of titles, so 42 large cells rendered four things
 * and a lot of empty rectangle — and in a cell that narrow every title truncated
 * to "DAZN - FIFA 2026: Braz…", which is not a title anybody can read.
 *
 * So the month is a COMPACT PICKER — small cells, a dot where something falls —
 * and the reading happens in the list beside it, where a title has the width to
 * be a title. The picker answers "when is there anything?", the list answers
 * "what is it?", and neither pretends the month is fuller than it is.
 */

import { useEffect, useMemo, useState } from 'react'

const NAVY = '#14254A'
const ORANGE = '#FC934C'
const GOLD = '#FFC82B'

export type AssetRow = {
  Id?: string
  AssetName?: string
  StartDate?: string | null
  EndDate?: string | null
  ReleaseDate?: string | null
  MatchDay?: string | null
  FranchiseName?: string | null
  IMDBId?: string | null
  IsExclusive?: number | boolean | null
  IsGlobal?: number | boolean | null
  IsCountrySpecific?: number | boolean | null
}

type Program = 'Live' | 'NPC'
type State = 'upcoming' | 'running' | 'past'
/** `window` is the coverage span (Start→End); `release` is the release-date
 *  marker, plotted in its own right so a title covered from one date and
 *  released on another shows both facts. */
type Kind = 'window' | 'release'

type Occ = {
  a: AssetRow
  program: Program
  kind: Kind
  start: number
  end: number
  state: State
}

/* A date column is only read when it actually LOOKS like one — see the header
   note on MatchDay. Requiring a leading yyyy-mm-dd means a column that is not a
   date reads as absent instead of as the wrong day. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/
const DAY = 86400000

/* How long a window may run before the picker stops dotting every day of it.
   Past this only its ends are marked; the title is still counted as running and
   still listed under "Running now". */
const SPAN_FILL_MAX_DAYS = 31

/* Dates arrive as RFC3339 at UTC midnight. Reading them with the LOCAL calendar
   would move a date across the boundary for anyone west of UTC, so the day is
   taken from the UTC parts and compared as a UTC-midnight stamp. */
function toDay(s?: string | null): number | null {
  if (!s || !ISO_DAY.test(String(s).trim())) return null
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

const addMonths = (ts: number, n: number) => {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)
}
const startOfMonth = (ts: number) => {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
const fmtDay = (ts: number | null) =>
  ts === null ? '—'
    : new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const fmtDayLong = (ts: number) =>
  new Date(ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
const fmtDayRow = (ts: number) =>
  new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const monthLabel = (ts: number) =>
  new Date(ts).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthShort = (ts: number) =>
  new Date(ts).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })

const nowDay = () => {
  const n = new Date()
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())
}

const programOf = (a: AssetRow): Program => (a.ReleaseDate ? 'NPC' : 'Live')
const truthy = (v: unknown) => v === true || v === 1 || v === '1'

/*
 * The programme colours are CSS VARIABLES, not constants, and that is a dark-mode
 * fix rather than a style preference.
 *
 * Live is navy — and navy is also the dark card's own ground (#1a2d55), so a navy
 * mark on a dark panel is invisible. These colours ride on inline styles, and an
 * inline style cannot hold a `dark:` variant. A variable with a `.dark` override
 * can, so the same rule resolves to navy on white and to a light steel blue on
 * navy. Orange survives both grounds and only its tint opacity lifts.
 */
const TONE_VARS = `
.ipcal{--cal-live:${NAVY};--cal-live-t:${NAVY}1C;--cal-npc:${ORANGE};--cal-npc-t:${ORANGE}1C;
  --cal-soon-bg:${NAVY}12;--cal-soon-fg:${NAVY}}
.dark .ipcal{--cal-live:#8FB4F2;--cal-live-t:#8FB4F226;--cal-npc:${ORANGE};--cal-npc-t:${ORANGE}2E;
  --cal-soon-bg:#8FB4F229;--cal-soon-fg:#CFE0FB}
`
const toneVar = (p: Program) => (p === 'Live' ? 'var(--cal-live)' : 'var(--cal-npc)')
const tintVar = (p: Program) => (p === 'Live' ? 'var(--cal-live-t)' : 'var(--cal-npc-t)')

/** Every dated appearance a title makes: at most its coverage window and its
    release marker. A title with no usable date makes none — the caller counts
    those separately rather than dropping them, because a title missing from a
    calendar with no explanation reads as a title that does not exist. */
function occurrencesOf(a: AssetRow, today: number): Occ[] {
  const program = programOf(a)
  const out: Occ[] = []
  const push = (kind: Kind, start: number, end: number) => {
    const e = end < start ? start : end
    const state: State = start > today ? 'upcoming' : e >= today ? 'running' : 'past'
    out.push({ a, program, kind, start, end: e, state })
  }
  // StartDate only. MatchDay is a label ("Matchday 4"), never a date.
  const start = toDay(a.StartDate)
  if (start !== null) push('window', start, toDay(a.EndDate) ?? start)
  /* The release marker, unless it lands on the day the window already opens —
     170 titles carry the same value in both columns, and listing the title twice
     on one day says nothing the first mark did not. */
  const rel = toDay(a.ReleaseDate)
  if (rel !== null && rel !== start) push('release', rel, rel)
  return out
}

/* ── The card ─────────────────────────────────────────────────────────────── */

/*
onLoadingChange lets the PAGE own the waiting state.

This component used to draw its own loader, and the welcome page drew a second
one for its own fetch — so arriving at the page showed two identical loaders in
two stacked boxes, for one wait. Reporting upward instead means one loader on
the page and no argument about which of them is finished.

Only the LOADING state is lifted. The fetch, the rows and the ERROR stay here,
deliberately: this endpoint and the overview's fail independently, and a title
list that 404s must not blank the week's figures — see the note in welcome/page.
*/
export default function ProgramCalendar({ onLoadingChange }: {
  onLoadingChange?: (loading: boolean) => void
} = {}) {
  const [rows, setRows] = useState<AssetRow[] | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const [prog, setProg] = useState<'all' | Program>('all')
  const [month, setMonth] = useState<number | null>(null)
  const [day, setDay] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Occ | null>(null)

  const today = useMemo(nowDay, [])

  // Told to the page whenever it changes, including the first true.
  useEffect(() => { onLoadingChange?.(loading) }, [loading, onLoadingChange])

  useEffect(() => {
    let live = true
    setLoading(true)
    fetch('/api/reports/assets', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!live) return
        if (d?.available === false) { setErr(d.error || 'The reporting service is unavailable.'); return }
        if (!d?.ok) { setErr(d?.error || 'The title list could not be read.'); return }
        setRows(Array.isArray(d.rows) ? d.rows : [])
        setErr('')
      })
      .catch(e => { if (live) setErr(e?.message || 'The title list could not be read.') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  const all = useMemo(() => {
    if (!rows) return { occs: [] as Occ[], undated: [] as AssetRow[] }
    const occs: Occ[] = []
    const undated: AssetRow[] = []
    for (const a of rows) {
      const o = occurrencesOf(a, today)
      if (o.length === 0) undated.push(a)
      else occs.push(...o)
    }
    return { occs, undated }
  }, [rows, today])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.occs.filter(o =>
      (prog === 'all' || o.program === prog) &&
      (!needle || (o.a.AssetName || '').toLowerCase().includes(needle)))
  }, [all.occs, prog, q])

  /* Counted as TITLES, not as marks: an NPC title can put two marks on the
     calendar, so counting occurrences reported "NPC 2,026" for 1,027 titles. */
  const stats = useMemo(() => {
    const titles = (f: (o: Occ) => boolean) => new Set(all.occs.filter(f).map(o => o.a)).size
    return {
      live: titles(o => o.program === 'Live'),
      npc: titles(o => o.program === 'NPC'),
      running: titles(o => o.state === 'running'),
      upcoming: titles(o => o.state === 'upcoming'),
    }
  }, [all])

  const running = useMemo(() => {
    const seen = new Set<AssetRow>()
    return shown.filter(o => o.state === 'running').sort((a, b) => a.start - b.start)
      .filter(o => (seen.has(o.a) ? false : (seen.add(o.a), true)))
  }, [shown])

  const upcoming = useMemo(() => {
    const seen = new Set<AssetRow>()
    return shown.filter(o => o.state === 'upcoming').sort((a, b) => a.start - b.start)
      .filter(o => (seen.has(o.a) ? false : (seen.add(o.a), true)))
  }, [shown])

  // Open on the newest month that holds something — most of this data is
  // historical, and an empty opening month reads as broken rather than accurate.
  useEffect(() => {
    if (month !== null || all.occs.length === 0) return
    const max = all.occs.reduce((m, o) => (o.start > m ? o.start : m), all.occs[0].start)
    setMonth(startOfMonth(max))
  }, [all.occs, month])

  const gridDays = useMemo(() => {
    if (month === null) return []
    const first = new Date(month)
    const lead = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1 - first.getUTCDay())
    /* Only the weeks this month actually occupies — five for most of them, six
       when a long month starts late in the week. A fixed 42 cells always drew a
       final row belonging entirely to the NEXT month, which is a whole row of
       greyed-out nothing at the bottom of every picker. */
    const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
    const weeks = Math.ceil((first.getUTCDay() + days) / 7)
    return Array.from({ length: weeks * 7 }, (_, i) => lead + i * DAY)
  }, [month])

  /* What each visible day holds. Built once per month rather than filtered per
     cell, and a long booking is dotted only on its ends — see SPAN_FILL_MAX_DAYS. */
  const byDay = useMemo(() => {
    const m = new Map<number, Occ[]>()
    if (gridDays.length === 0) return m
    const from = gridDays[0], to = gridDays[gridDays.length - 1]
    for (const o of shown) {
      if (o.end < from || o.start > to) continue
      const short = (o.end - o.start) / DAY <= SPAN_FILL_MAX_DAYS
      for (let t = Math.max(o.start, from); t <= Math.min(o.end, to); t += DAY) {
        if (!short && t !== o.start && t !== o.end) continue
        const g = m.get(t)
        if (g) g.push(o); else m.set(t, [o])
      }
    }
    return m
  }, [shown, gridDays])

  /* The list beside the picker: the chosen day, or the whole chosen month.
     Grouped by date so the date is said once per group, not once per row. */
  const listing = useMemo(() => {
    if (month === null) return [] as Array<[number, Occ[]]>
    const next = addMonths(month, 1)
    const seen = new Set<string>()
    const picked = shown.filter(o => {
      const inScope = day !== null
        ? o.start === day || (o.start <= day && o.end >= day && (o.end - o.start) / DAY <= SPAN_FILL_MAX_DAYS)
        : o.start >= month && o.start < next
      if (!inScope) return false
      const k = `${o.start}|${o.a.AssetName}|${o.kind}`
      return seen.has(k) ? false : (seen.add(k), true)
    })
    const groups = new Map<number, Occ[]>()
    for (const o of picked.sort((x, y) => x.start - y.start)) {
      const g = groups.get(o.start)
      if (g) g.push(o); else groups.set(o.start, [o])
    }
    return Array.from(groups.entries())
  }, [shown, month, day])

  const listCount = listing.reduce((n, [, v]) => n + v.length, 0)

  const card = 'rounded-2xl border border-gray-100 dark:border-white/10 bg-white dark:bg-[#1a2d55]'

  /* Nothing while loading — the page shows the one loader for both fetches.
     Still MOUNTED though, which is the point: unmounting it until the page
     stopped waiting would mean this fetch never started, and the page would
     wait on it for ever. */
  if (loading) return null
  if (err) {
    return (
      <div className="rounded-2xl border border-amber-200 dark:border-amber-400/25 bg-amber-50 dark:bg-amber-500/10 px-5 py-4">
        <p className="text-sm font-bold text-amber-800 dark:text-amber-200">Calendar unavailable</p>
        <p className="text-xs text-amber-700 dark:text-amber-300/80 mt-1">{err}</p>
      </div>
    )
  }

  return (
    <div className={`ipcal ${card} overflow-hidden`}>
      <style>{TONE_VARS}</style>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-gray-100 dark:border-white/10">
        <div className="flex flex-wrap items-start justify-between gap-2.5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-extrabold text-[#14254A] dark:text-white leading-none">
              Programme calendar
            </h2>
            {/* The summary as one sentence rather than a row of tiles — the page
                already carries the week's figures, and a second bank of numbers
                under them competes with the ones that matter. */}
            <p className="text-[11.5px] text-gray-500 dark:text-white/50 mt-2">
              <b className="text-[#14254A] dark:text-white">{(rows?.length ?? 0).toLocaleString()}</b> titles
              <Dot /> <b className="text-[#14254A] dark:text-white">{stats.live.toLocaleString()}</b> Live
              <Dot /> <b className="text-[#14254A] dark:text-white">{stats.npc.toLocaleString()}</b> NPC
              <Dot /> <b className="text-[#14254A] dark:text-white">{stats.running}</b> running
              {all.undated.length > 0 && <><Dot /> {all.undated.length.toLocaleString()} undated</>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Seg options={['all', 'Live', 'NPC']} value={prog} onChange={setProg} labels={{ all: 'All' }} />
            <div className="relative">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" width="12" height="12"
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
                strokeLinecap="round" style={{ color: '#9aa5b5' }}>
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
              </svg>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…"
                className="h-8 w-[120px] focus:w-[168px] rounded-lg border border-gray-200 dark:border-white/15
                  bg-transparent pl-7 pr-2 text-[12px] text-[#14254A] dark:text-white placeholder:text-gray-400
                  outline-none focus:border-[#FC934C] transition-all" />
            </div>
          </div>
        </div>
      </div>

      {/* ── Picker + list ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[368px_minmax(0,1fr)_348px]">

        {/* Picker */}
        <div className="p-5 border-b lg:border-b-0 lg:border-r border-gray-100 dark:border-white/10
          bg-gray-50/60 dark:bg-black/10">
          <div className="flex items-center justify-between gap-1">
            <NavBtn onClick={() => { if (month !== null) { setMonth(addMonths(month, -1)); setDay(null) } }}
              label="Previous month">‹</NavBtn>
            <span className="text-[15px] font-extrabold text-[#14254A] dark:text-white tabular-nums">
              {month === null ? '—' : monthLabel(month)}
            </span>
            <NavBtn onClick={() => { if (month !== null) { setMonth(addMonths(month, 1)); setDay(null) } }}
              label="Next month">›</NavBtn>
          </div>

          <div className="grid grid-cols-7 mt-2.5 mb-1">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <div key={i} className="text-[11px] font-extrabold text-gray-400 dark:text-white/35 text-center pb-1">{d}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-y-1">
            {gridDays.map(ts => {
              const d = new Date(ts)
              const outside = month !== null && d.getUTCMonth() !== new Date(month).getUTCMonth()
              const evs = byDay.get(ts) || []
              const isToday = ts === today
              const isSel = ts === day
              const has = evs.length > 0
              return (
                <button key={ts} disabled={!has && !isToday}
                  onClick={() => setDay(isSel ? null : ts)}
                  title={has ? `${evs.length} title${evs.length === 1 ? '' : 's'}` : undefined}
                  className={`relative h-[46px] rounded-lg flex flex-col items-center justify-center leading-none
                    transition-colors ${has ? 'cursor-pointer hover:bg-[#FC934C]/15' : 'cursor-default'}
                    ${isSel ? 'bg-[#14254A] dark:bg-white/20' : ''}`}>
                  <span className={`text-[13.5px] tabular-nums ${isSel ? 'text-white font-extrabold'
                    : outside ? 'text-gray-300 dark:text-white/20'
                      : has ? 'font-extrabold text-[#14254A] dark:text-white'
                        : 'text-gray-400 dark:text-white/40'}`}>
                    {d.getUTCDate()}
                  </span>
                  {/* Dots say WHICH programme falls here; the list says what it is. */}
                  <span className="flex gap-[3px] h-[5px] mt-[3px]">
                    {has && Array.from(new Set(evs.map(e => e.program))).slice(0, 2).map(p => (
                      <span key={p} className="w-[5px] h-[5px] rounded-full"
                        style={{ background: isSel ? '#fff' : toneVar(p) }} />
                    ))}
                  </span>
                  {isToday && !isSel && (
                    <span className="absolute inset-0 rounded-md ring-[1.5px] ring-[#FC934C] pointer-events-none" />
                  )}
                </button>
              )
            })}
          </div>

          <button onClick={() => { setMonth(startOfMonth(today)); setDay(null) }}
            className="w-full mt-3.5 h-9 rounded-lg border border-gray-200 dark:border-white/15 text-[13px]
              font-bold text-[#14254A] dark:text-white hover:bg-white dark:hover:bg-white/5 transition">
            Today
          </button>

        </div>

        {/* List */}
        <div className="min-w-0 flex flex-col">
          <div className="flex items-center justify-between gap-2 px-4 py-2.5
            border-b border-gray-100 dark:border-white/10">
            <p className="text-[12px] font-extrabold text-[#14254A] dark:text-white truncate">
              {day !== null ? fmtDayLong(day) : month === null ? '—' : monthLabel(month)}
              <span className="ml-1.5 font-bold text-gray-400 dark:text-white/40">
                {listCount} title{listCount === 1 ? '' : 's'}
              </span>
            </p>
            {day !== null && (
              <button onClick={() => setDay(null)}
                className="text-[11px] font-bold text-[#FC934C] hover:underline flex-shrink-0">
                Whole month
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto max-h-[520px] min-h-[400px]">
            {listCount === 0 ? (
              <div className="h-full min-h-[400px] flex flex-col items-center justify-center text-center px-6 py-10">
                <span className="w-11 h-11 grid place-items-center rounded-xl bg-[#14254A]/[0.05] dark:bg-white/5
                  text-gray-400 dark:text-white/30">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" />
                  </svg>
                </span>
                <p className="text-[12.5px] font-bold text-[#14254A] dark:text-white/80 mt-2.5">
                  Nothing {day !== null ? 'on this day' : 'this month'}
                </p>
                <p className="text-[11.5px] text-gray-400 dark:text-white/40 mt-1 max-w-[240px]">
                  Days carrying a title are marked with a dot in the picker.
                </p>
              </div>
            ) : listing.map(([ts, items]) => (
              <div key={ts}>
                <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-1
                  bg-gray-50/95 dark:bg-[#16294d]/95 backdrop-blur
                  border-b border-gray-100 dark:border-white/[0.07]">
                  <span className={`text-[10.5px] font-extrabold tabular-nums
                    ${ts === today ? 'text-[#FC934C]' : 'text-gray-500 dark:text-white/55'}`}>
                    {fmtDayRow(ts)}{ts === today ? ' · today' : ''}
                  </span>
                  <span className="text-[10px] font-bold text-gray-400 dark:text-white/30">{items.length}</span>
                </div>
                {items.map((o, i) => (
                  <button key={i} onClick={() => setOpen(o)}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-left
                      border-b border-gray-50 dark:border-white/[0.05]
                      hover:bg-[#FC934C]/[0.07] transition-colors">
                    <span className="w-1.5 h-7 rounded-full flex-shrink-0"
                      style={{
                        background: o.kind === 'release' ? tintVar(o.program) : toneVar(o.program),
                        boxShadow: o.kind === 'release' ? `inset 0 0 0 1.5px ${toneVar(o.program)}` : undefined,
                      }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-bold text-[#14254A] dark:text-white/90 truncate">
                        {o.a.AssetName || '(untitled)'}
                      </span>
                      <span className="block text-[10px] text-gray-400 dark:text-white/40">
                        {o.program} · {o.kind === 'release' ? 'release date' : 'coverage'}
                        {o.end > o.start ? ` → ${fmtDay(o.end)}` : ''}
                      </span>
                    </span>
                    <StatePill state={o.state} />
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Legend, on the list's own footer so it sits under what it explains. */}
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 px-4 py-2 border-t
            border-gray-100 dark:border-white/10 text-[10px] text-gray-400 dark:text-white/40">
            <Key program="Live" label="Live" />
            <Key program="NPC" label="NPC" />
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-3.5 rounded-full"
                style={{ background: 'var(--cal-npc-t)', boxShadow: 'inset 0 0 0 1.5px var(--cal-npc)' }} />
              Release marker
            </span>
          </div>
        </div>

        {/* Rails. On a full-width page these get a column of their own; below xl
            they fall under the list rather than crowding the picker, which is
            where they used to live and where they squeezed the month. */}
        <div className="border-t xl:border-t-0 xl:border-l border-gray-100 dark:border-white/10
          bg-gray-50/60 dark:bg-black/10 p-4 space-y-3.5">
          <Rail title="Running now" items={running} onPick={setOpen} empty="Nothing running today" />
          <Rail title="Upcoming" items={upcoming} onPick={setOpen} empty="Nothing scheduled ahead" />
          {all.undated.length > 0 && (
            <div className="rounded-xl border border-gray-200/70 dark:border-white/10
              bg-white dark:bg-white/[0.03] p-4">
              <p className="text-[10.5px] font-extrabold uppercase tracking-[0.08em]
                text-gray-400 dark:text-white/40">No scheduled date</p>
              <p className="text-[12px] text-gray-500 dark:text-white/45 mt-2 leading-relaxed">
                <b className="text-[#14254A] dark:text-white">{all.undated.length.toLocaleString()}</b> titles
                carry no start or release date, so they cannot be placed on a calendar.
              </p>
            </div>
          )}
        </div>
      </div>

      {open && <AssetModal occ={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

const Dot = () => <span className="mx-1 text-gray-300 dark:text-white/20">·</span>

function NavBtn({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      className="w-8 h-8 rounded-lg border border-gray-200 dark:border-white/15 text-[17px] leading-none
        text-[#14254A] dark:text-white hover:bg-white dark:hover:bg-white/5 transition flex-shrink-0">
      {children}
    </button>
  )
}

function Seg<T extends string>({ options, value, onChange, labels = {} }: {
  options: T[]; value: T; onChange: (v: T) => void; labels?: Partial<Record<T, string>>
}) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 dark:border-white/15 overflow-hidden">
      {options.map(o => (
        <button key={o} onClick={() => onChange(o)}
          className={`px-2.5 h-8 text-[11.5px] font-bold transition-colors ${value === o
            ? 'bg-[#14254A] text-white'
            : 'text-gray-500 dark:text-white/55 hover:bg-gray-50 dark:hover:bg-white/5'}`}>
          {labels[o] ?? o}
        </button>
      ))}
    </div>
  )
}

function Rail({ title, items, onPick, empty }: {
  title: string; items: Occ[]; onPick: (o: Occ) => void; empty: string
}) {
  return (
    <div className="rounded-xl border border-gray-200/70 dark:border-white/10
      bg-white dark:bg-white/[0.03] p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10.5px] font-extrabold uppercase tracking-[0.08em]
          text-gray-400 dark:text-white/40">{title}</p>
        <span className="text-[11px] font-extrabold rounded-full bg-gray-100 dark:bg-white/10
          text-gray-500 dark:text-white/50 px-2 py-0.5 tabular-nums">{items.length}</span>
      </div>
      <div className="mt-2.5 space-y-1 max-h-[236px] overflow-y-auto">
        {items.length === 0 && <p className="text-[12px] text-gray-400 py-1">{empty}</p>}
        {items.slice(0, 25).map((o, i) => (
          <button key={i} onClick={() => onPick(o)}
            className="w-full flex items-start gap-2.5 text-left rounded-lg px-2 py-1.5
              hover:bg-[#FC934C]/10 transition-colors">
            <span className="w-1.5 h-8 rounded-full flex-shrink-0 mt-[1px]"
              style={{ background: toneVar(o.program) }} />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-bold text-[#14254A] dark:text-white/90 truncate">
                {o.a.AssetName || '(untitled)'}
              </span>
              <span className="block text-[10.5px] text-gray-400 dark:text-white/40 tabular-nums mt-0.5">
                {o.end > o.start ? `to ${fmtDay(o.end)}` : fmtDay(o.start)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Key({ program, label }: { program: Program; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-1.5 h-3.5 rounded-full" style={{ background: toneVar(program) }} />
      {label}
    </span>
  )
}

function StatePill({ state }: { state: State }) {
  if (state === 'past') return null
  const on = state === 'running'
  return (
    <span className="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0"
      style={on
        ? { background: `${GOLD}33`, color: '#8a5a00' }
        : { background: 'var(--cal-soon-bg)', color: 'var(--cal-soon-fg)' }}>
      {on ? 'Running' : 'Soon'}
    </span>
  )
}

function AssetModal({ occ, onClose }: { occ: Occ; onClose: () => void }) {
  const a = occ.a
  const flags = [
    truthy(a.IsExclusive) && 'Exclusive',
    truthy(a.IsGlobal) && 'Global',
    truthy(a.IsCountrySpecific) && 'Country-specific',
  ].filter(Boolean) as string[]
  const stateWord = occ.state === 'upcoming' ? 'Upcoming' : occ.state === 'running' ? 'Running' : 'Past'

  return (
    <div onClick={onClose}
      className="fixed inset-0 z-[80] flex items-center justify-center p-5"
      style={{ background: 'rgba(20,37,74,.55)', backdropFilter: 'blur(3px)' }}>
      <div onClick={e => e.stopPropagation()}
        className="ipcal w-full max-w-lg max-h-[82vh] overflow-auto rounded-2xl bg-white dark:bg-[#1a2d55]
          shadow-[0_24px_70px_rgba(13,36,75,.3)]">
        <style>{TONE_VARS}</style>
        <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-100 dark:border-white/10">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              <span className="text-[10.5px] font-extrabold px-2.5 py-0.5 rounded-full text-white"
                style={{ background: toneVar(occ.program) }}>{occ.program}</span>
              <span className="text-[10.5px] font-extrabold px-2.5 py-0.5 rounded-full
                bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70">{stateWord}</span>
              {occ.kind === 'release' && (
                <span className="text-[10.5px] font-semibold text-gray-400">release marker</span>
              )}
            </div>
            <p className="text-[17px] font-extrabold leading-snug text-[#14254A] dark:text-white break-words">
              {a.AssetName || '(untitled)'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/60 flex-shrink-0">×</button>
        </div>
        <div className="p-5 grid grid-cols-[112px_1fr] gap-y-2.5 gap-x-4 text-[13px]">
          <Cell k="Start date" v={fmtDay(toDay(a.StartDate))} />
          <Cell k="End date" v={fmtDay(toDay(a.EndDate))} />
          <Cell k="Release date" v={fmtDay(toDay(a.ReleaseDate))} />
          {/* Verbatim: this column holds "Matchday 4", not a date. */}
          <Cell k="Match day" v={a.MatchDay || '—'} />
          <Cell k="Franchise" v={a.FranchiseName || '—'} />
          <Cell k="IMDB Id" v={a.IMDBId || '—'} />
        </div>
        {flags.length > 0 && (
          <div className="px-5 pb-5 flex flex-wrap gap-1.5">
            {flags.map(f => (
              <span key={f} className="text-[11px] font-bold rounded-full border border-gray-200
                dark:border-white/15 px-2.5 py-1 text-[#14254A] dark:text-white/80">{f}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div className="font-bold text-gray-400 dark:text-white/40">{k}</div>
      <div className="text-[#14254A] dark:text-white/90">{v}</div>
    </>
  )
}
