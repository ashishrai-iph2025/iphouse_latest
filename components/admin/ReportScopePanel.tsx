'use client'

/*
WHICH VALUES A CLIENT'S REPORT IS ALLOWED TO SHOW.

Three dimensions — Franchise, Match Day, Asset — and per client the values to
leave out. Everything is on by default and stays on: what is stored is what to
HIDE, so a fixture loaded tomorrow is reported on without anybody touching this
screen. See go-server/handlers/dimexclusions.go for why that direction is the
only workable one.

── WHY FRANCHISE AND MATCH DAY ARE TICK LISTS AND ASSET IS A SEARCH ─────────

They are the same setting and they are not the same size. A client carries nine
franchises and nine match days — a list you read at a glance and tick. The
largest carries 47,575 titles, and a tick list of those is a scroll bar with a
search box lost somewhere inside it.

So the asset section shows what is HIDDEN, and a search finds more to hide. The
two states are the same request to the same endpoint with a different narrowing,
so there is one code path behind both.

── WHY THE VALUES DO NOT COME FROM THE REPORT ───────────────────────────────

They come from the asset master, which nothing narrows. The report's own slicer
lists are narrowed BY these exclusions — that is the point of the feature — so a
franchise would disappear from this picker the moment it was hidden, and there
would be no way to put it back. A screen whose control removes itself is a
one-way door.
*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'

type DimKey = 'franchise' | 'matchDay' | 'asset'

/** Joins a set for comparison. A NUL, because no franchise, fixture or id has one. */
const SEP = String.fromCharCode(0)

const DIMS: { key: DimKey; label: string; blurb: string }[] = [
  {
    key: 'franchise', label: 'Franchise',
    blurb: 'Competitions this client is not reported on. Hiding one removes every ' +
      'title in it from every figure — the totals, the trend, each chart and the live card.',
  },
  {
    key: 'matchDay', label: 'Match Day',
    blurb: 'Fixture rounds to leave out. Titles with no match day recorded are never ' +
      'affected: the report does not show them under a match day, so there is nothing to hide.',
  },
  {
    key: 'asset', label: 'Asset',
    blurb: 'Individual titles to leave out. Search for the ones to hide — a client can ' +
      'carry tens of thousands, so only what is hidden is listed here.',
  },
]

type ClientRow = { id: string; name: string }
type AssetRow = { id: string; name: string; franchise?: string }

type Values = {
  franchise: string[]
  matchDay: string[]
  assets: AssetRow[]
  assetsTruncated?: boolean
  hidden: Record<DimKey, string[]>
}

export default function ReportScopePanel() {
  const [directory, setDirectory] = useState<ClientRow[]>([])
  const [clientId, setClientId] = useState('')
  const [values, setValues] = useState<Values | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  /* The DRAFT, held apart from what was loaded, so the screen can say whether
     there is anything to save. Same shape as the stored set: a value is in the
     list when it is HIDDEN. */
  const [draft, setDraft] = useState<Record<DimKey, string[]>>({
    franchise: [], matchDay: [], asset: [],
  })

  // Titles seen this session, by id — so a title hidden from a search result
  // still has a name after the search is cleared.
  const [names, setNames] = useState<Record<string, AssetRow>>({})

  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<AssetRow[]>([])
  const [truncated, setTruncated] = useState(false)

  /* The warehouse's own client directory, from the mapping screen's endpoint —
     the same source the sports period picker reads, for the same reason: it is
     already served, and resolving names here would put a second round trip
     behind a settings read. */
  useEffect(() => {
    fetch('/api/admin/report-client-map', { credentials: 'include' })
      .then(r => r.json())
      .then(j => setDirectory(Array.isArray(j.warehouseClients) ? j.warehouseClients : []))
      .catch(() => { /* the picker degrades to ids, which still work */ })
  }, [])

  const load = useCallback(async (id: string) => {
    if (!id) { setValues(null); return }
    setLoading(true); setErr(''); setMsg('')
    try {
      const r = await fetch(`/api/admin/report-dim-values?clientId=${encodeURIComponent(id)}`,
        { credentials: 'include' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setErr(j.error || 'Could not read the value lists'); setValues(null); return
      }
      const v: Values = {
        franchise: j.franchise || [],
        matchDay: j.matchDay || [],
        assets: j.assets || [],
        hidden: {
          franchise: j.hidden?.franchise || [],
          matchDay: j.hidden?.matchDay || [],
          asset: j.hidden?.asset || [],
        },
      }
      setValues(v)
      setDraft({ ...v.hidden })
      setNames(Object.fromEntries((j.assets || []).map((a: AssetRow) => [a.id, a])))
      setResults([]); setSearch(''); setTruncated(false)
    } catch (e: any) {
      setErr(e?.message || 'Network error'); setValues(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(clientId) }, [clientId, load])

  /* The search, run on demand rather than as you type. A keystroke here is a
     query against a 127,000-row master; a debounce would still send one per
     pause, and the admin knows when they have finished typing. */
  async function runSearch() {
    const q = search.trim()
    if (!clientId || !q) { setResults([]); setTruncated(false); return }
    setSearching(true); setErr('')
    try {
      const r = await fetch(
        `/api/admin/report-dim-values?clientId=${encodeURIComponent(clientId)}&q=${encodeURIComponent(q)}`,
        { credentials: 'include' })
      const j = await r.json()
      if (!r.ok || j.success === false) { setErr(j.error || 'Could not search'); return }
      const rows: AssetRow[] = j.assets || []
      setResults(rows)
      setTruncated(!!j.assetsTruncated)
      setNames(n => ({ ...n, ...Object.fromEntries(rows.map(a => [a.id, a])) }))
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setSearching(false)
    }
  }

  const toggle = (dim: DimKey, value: string) => {
    setDraft(d => {
      const on = d[dim].includes(value)
      return { ...d, [dim]: on ? d[dim].filter(v => v !== value) : [...d[dim], value] }
    })
    setMsg('')
  }

  const same = (a: string[], b: string[]) =>
    /* Joined on a separator no value can hold, so ["a","b"] and ["a b"] are not
       the same set. A space would make them look it. */
    a.length === b.length &&
    [...a].sort().join(SEP) === [...b].sort().join(SEP)

  const dirty = useMemo(() => {
    if (!values) return false
    return DIMS.some(d => !same(draft[d.key], values.hidden[d.key]))
  }, [draft, values])

  const hiddenCount = DIMS.reduce((n, d) => n + draft[d.key].length, 0)

  async function save() {
    if (!clientId) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await fetch('/api/admin/report-dim-exclusions', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, hidden: draft }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) { setErr(j.error || 'Could not save'); return }
      setValues(v => (v ? { ...v, hidden: { ...draft } } : v))
      setMsg(hiddenCount === 0
        ? 'Saved. This client is reported on in full.'
        : `Saved. ${hiddenCount} value${hiddenCount === 1 ? '' : 's'} left out of this client's reports.`)
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  const clientOptions = useMemo(
    () => directory.map(c => ({ key: c.id, label: c.name })), [directory])

  /* The titles to draw: the hidden ones, plus whatever the current search
     found. Hidden first, because those are the rows somebody came here to
     change, and a search result that is already hidden appears once. */
  const assetRows = useMemo(() => {
    const rows: AssetRow[] = []
    const seen = new Set<string>()
    for (const id of draft.asset) {
      rows.push(names[id] ?? { id, name: id })
      seen.add(id)
    }
    for (const a of results) {
      if (!seen.has(a.id)) rows.push(a)
    }
    return rows
  }, [draft.asset, names, results])

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a2d55] p-5">
        <h3 className="text-sm font-extrabold text-[#14254A] dark:text-white">Report scope</h3>
        <p className="mt-1 text-[13px] leading-5 text-gray-500 dark:text-white/60 max-w-3xl">
          Everything is reported on unless it is switched off here. Untick a value and it
          leaves this client&apos;s reports entirely — the KPI totals, the daily trend, every
          chart, the filter pane and the live counts card all count without it. Ticked is
          shown, and a value nobody has touched stays ticked however much new data arrives.
        </p>

        <div className="mt-4 grid grid-cols-[110px_minmax(0,360px)] items-center gap-3">
          <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Client</span>
          <SearchableSelect
            options={clientOptions} value={clientId} onChange={setClientId}
            placeholder="Pick a client…" emptyLabel="— none —" clearable={false}
            ariaLabel="The client whose report scope is being set" />
        </div>
      </div>

      {!clientId && (
        <p className="text-sm text-gray-400 px-1 py-6">
          Pick a client to see what its reports cover.
        </p>
      )}

      {clientId && loading && (
        <p className="text-sm text-gray-400 px-1 py-6">Reading this client&apos;s titles…</p>
      )}

      {err && (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-500/10 dark:border-red-500/30 px-4 py-3 text-[13px] text-red-700 dark:text-red-300">
          {err}
        </div>
      )}
      {msg && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-500/10 dark:border-emerald-500/30 px-4 py-3 text-[13px] text-emerald-700 dark:text-emerald-300">
          {msg}
        </div>
      )}

      {clientId && !loading && values && (
        <>
          {/* The two TICK LISTS. Narrowed to their own key type rather than
              filtered out of DIMS at the call site: `values` holds a string list
              under `franchise` and `matchDay` and a row list under `assets`, and
              a filter does not tell the compiler which of the three it left. */}
          {(['franchise', 'matchDay'] as const).map(key => {
            const d = DIMS.find(x => x.key === key)!
            const all: string[] = values[key]
            const hidden = draft[key]
            return (
              <section key={d.key}
                className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a2d55] p-5">
                <div className="flex items-baseline justify-between gap-4 flex-wrap">
                  <h4 className="text-sm font-extrabold text-[#14254A] dark:text-white">{d.label}</h4>
                  <span className="text-[11px] text-gray-400">
                    {all.length - hidden.length} of {all.length} reported on
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-5 text-gray-500 dark:text-white/60 max-w-3xl">{d.blurb}</p>

                {all.length === 0 ? (
                  <p className="mt-3 text-[13px] text-gray-400">
                    This client&apos;s titles record no {d.label.toLowerCase()}, so there is
                    nothing to switch off.
                  </p>
                ) : (
                  <>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {all.map((v: string) => {
                        const off = hidden.includes(v)
                        return (
                          <label key={v}
                            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] cursor-pointer transition-colors ${
                              off
                                ? 'border-gray-200 dark:border-white/10 text-gray-400 line-through'
                                : 'border-[#14254A]/20 dark:border-white/20 text-[#14254A] dark:text-white'}`}>
                            <input type="checkbox" checked={!off} onChange={() => toggle(d.key, v)}
                              className="accent-[#FC934C]" />
                            {v}
                          </label>
                        )
                      })}
                    </div>
                    <div className="mt-3 flex gap-3 text-[11px] font-semibold">
                      <button type="button" className="text-[#FC934C] hover:underline"
                        onClick={() => { setDraft(s => ({ ...s, [d.key]: [] })); setMsg('') }}>
                        Report on all
                      </button>
                      <button type="button" className="text-gray-400 hover:underline"
                        onClick={() => { setDraft(s => ({ ...s, [d.key]: [...all] })); setMsg('') }}>
                        Hide all
                      </button>
                    </div>
                  </>
                )}
              </section>
            )
          })}

          {/* ── The titles, which are a search rather than a list ──────────── */}
          <section className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a2d55] p-5">
            <div className="flex items-baseline justify-between gap-4 flex-wrap">
              <h4 className="text-sm font-extrabold text-[#14254A] dark:text-white">Asset</h4>
              <span className="text-[11px] text-gray-400">
                {draft.asset.length === 0
                  ? 'every title reported on'
                  : `${draft.asset.length} title${draft.asset.length === 1 ? '' : 's'} left out`}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-gray-500 dark:text-white/60 max-w-3xl">
              {DIMS[2].blurb}
            </p>

            <div className="mt-3 flex gap-2 max-w-xl">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); runSearch() } }}
                placeholder="Search this client's titles…"
                className="flex-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5
                  px-3 py-2 text-[13px] text-[#14254A] dark:text-white outline-none
                  focus:border-[#FC934C] focus:ring-2 focus:ring-[#FC934C]/20" />
              <button type="button" onClick={runSearch} disabled={searching || !search.trim()}
                className="rounded-lg bg-[#14254A] px-4 py-2 text-[13px] font-semibold text-white
                  disabled:opacity-40 dark:bg-white/10">
                {searching ? 'Searching…' : 'Search'}
              </button>
            </div>
            {truncated && (
              <p className="mt-2 text-[11px] text-gray-400">
                The first 50 matches are shown — narrow the search to see the rest.
              </p>
            )}

            {assetRows.length === 0 ? (
              <p className="mt-3 text-[13px] text-gray-400">
                Nothing hidden. Search for a title to leave it out of this client&apos;s reports.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-gray-100 dark:divide-white/10">
                {assetRows.map(a => {
                  const off = draft.asset.includes(a.id)
                  return (
                    <li key={a.id} className="flex items-center gap-3 py-2">
                      <input type="checkbox" checked={!off} onChange={() => toggle('asset', a.id)}
                        className="accent-[#FC934C]" />
                      <span className={`text-[13px] truncate ${
                        off ? 'text-gray-400 line-through' : 'text-[#14254A] dark:text-white'}`}
                        title={a.name || a.id}>
                        {a.name || a.id}
                      </span>
                      {a.franchise && (
                        <span className="text-[11px] text-gray-400 shrink-0">{a.franchise}</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <div className="flex items-center gap-3">
            <button type="button" onClick={save} disabled={!dirty || busy}
              className="rounded-lg bg-[#FC934C] px-5 py-2 text-[13px] font-bold text-white disabled:opacity-40">
              {busy ? 'Saving…' : 'Save'}
            </button>
            {dirty && (
              <button type="button" onClick={() => { setDraft({ ...values.hidden }); setMsg('') }}
                className="text-[12px] font-semibold text-gray-400 hover:underline">
                Discard changes
              </button>
            )}
            {!dirty && !msg && (
              <span className="text-[12px] text-gray-400">
                {hiddenCount === 0
                  ? 'This client is reported on in full.'
                  : `${hiddenCount} value${hiddenCount === 1 ? '' : 's'} left out.`}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
