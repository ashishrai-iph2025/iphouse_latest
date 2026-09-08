'use client'

/*
 * The client's asset register, and the protection requests raised from it.
 *
 * ── The buttons do not change protection ─────────────────────────────────────
 *
 * This platform reads mediascan and never writes to it, so "Start protection"
 * sends a REQUEST — recorded here, emailed to the account contact and to the
 * person who asked, and shown in their bell. A person applies it upstream.
 *
 * Every label says so, and that is not padding. A button that looks like it acts
 * and does not is the worst version of this screen: somebody clicks it, sees the
 * row unchanged, clicks again, and two identical emails go out. The row shows
 * "Requested" afterwards for the same reason.
 *
 * ── One page at a time, filtered on the SERVER ───────────────────────────────
 *
 * The register is not downloaded. Netflix is 2,144 titles and just over a
 * megabyte; the largest client on this platform has 47,000, which is tens of
 * megabytes and a table no browser will render. So the page asks for fifty rows
 * and the server cuts them.
 *
 * The filters go with the request rather than being applied to what came back,
 * and that is the whole reason this is not client-side paging: a search run over
 * the fifty rows in hand would report three matches when the register holds
 * forty. The server filters the register and pages the result.
 *
 * ── Columns come from the DATA, not from a list here ─────────────────────────
 *
 * The Go proxy hands the master's rows back untouched so that a column the
 * warehouse adds is on the page the day the API returns it. A hard-coded column
 * list here would throw that away one layer later. So the table reads the keys
 * off the rows; KNOWN_ORDER only says what comes FIRST, and anything unrecognised
 * still appears, at the end.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import ReportLoader from '@/components/shared/ReportLoader'

type Row = Record<string, any>

type RequestRow = {
  id: number
  asset_id: string
  asset_name: string
  request_action: string
  note: string
  created_at: string
}

/* The readable columns, in the order they answer questions in. Anything the API
   returns that is not named here is still shown — see the header note. */
const KNOWN_ORDER = [
  'AssetName', 'Genre', 'SubGenre', 'Active',
  'StartDate', 'EndDate', 'ReleaseDate',
  'MatchDay', 'FranchiseName', 'IMDBId',
  'IsExclusive', 'IsGlobal', 'IsCountrySpecific', 'IsWarRoom',
]

/* Identifiers. Real columns and genuinely useful when someone is reconciling
   against another system, so they are behind a toggle rather than dropped — but
   a table that opens with four GUIDs per row is a table nobody reads. */
const ID_COLUMNS = new Set(['Id', 'GenreMSId', 'SubGenreMSId', 'ClientMasterId'])

const LABELS: Record<string, string> = {
  AssetName: 'Asset', SubGenre: 'Sub-genre', IMDBId: 'IMDB Id',
  StartDate: 'Start', EndDate: 'End', ReleaseDate: 'Released',
  MatchDay: 'Match day', FranchiseName: 'Franchise',
  IsExclusive: 'Exclusive', IsGlobal: 'Global',
  IsCountrySpecific: 'Country-specific', IsWarRoom: 'War room',
  ClientMasterId: 'Client id', GenreMSId: 'Genre id', SubGenreMSId: 'Sub-genre id',
}

const DATE_COLUMNS = new Set(['StartDate', 'EndDate', 'ReleaseDate'])
const FLAG_COLUMNS = new Set(['Active', 'IsExclusive', 'IsGlobal', 'IsCountrySpecific', 'IsWarRoom'])

/* Dates arrive as RFC3339 at UTC midnight. Read with the local calendar they
   move a day for anyone west of UTC — the same trap the programme calendar
   documents, and the same fix. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/
function fmtDate(v: any): string {
  const s = String(v ?? '').trim()
  if (!s || !ISO_DAY.test(s)) return s || '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

const truthy = (v: any) => v === 1 || v === true || v === '1'

export default function AssetRegister() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [requests, setRequests] = useState<RequestRow[]>([])
  const [err, setErr] = useState('')
  /* First load and page turns are DIFFERENT waits. The first has nothing to
     show and gets the loader; a page turn already has a table on screen, and
     replacing it with a spinner makes paging feel slower than it is. */
  const [loading, setLoading] = useState(true)
  const [paging, setPaging] = useState(false)

  const [q, setQ] = useState('')
  const [onlyActive, setOnlyActive] = useState(true)
  const [genre, setGenre] = useState('all')
  const [showIds, setShowIds] = useState(false)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [meta, setMeta] = useState({
    pages: 1, total: 0, hasActive: false, genres: [] as string[],
  })
  /* The size of the whole register, fetched ONCE. It is a second COUNT upstream
     and it does not change while somebody is reading, so paying for it on every
     page turn would be a query per click for a number that never moves. */
  const [totalAll, setTotalAll] = useState<number | null>(null)

  const [ask, setAsk] = useState<{ row: Row; action: 'enable' | 'disable' } | null>(null)

  /*
    One loader, and it is a REF rather than state.

    Filters and page turns can overlap — typing while a page is in flight — and
    the slower reply must not overwrite the faster one. Each call takes a ticket
    and only the newest is allowed to write, which is the cheap version of an
    abort and needs no AbortController plumbing.
  */
  const reqSeq = useRef(0)

  async function load(opts?: { silent?: boolean }) {
    const seq = ++reqSeq.current
    if (opts?.silent) setPaging(true); else setLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(page), pageSize: String(pageSize),
      })
      if (q.trim()) params.set('q', q.trim())
      if (genre !== 'all') params.set('genre', genre)
      if (onlyActive) params.set('active', '1')
      if (totalAll === null) params.set('counts', '1')

      const r = await fetch('/api/assets/register?' + params.toString(), { credentials: 'include' })
      const d = await r.json()
      if (seq !== reqSeq.current) return   // a newer request has already answered
      if (d?.available === false) { setErr(d.error || 'The reporting service is unavailable.'); return }
      if (!d?.ok) { setErr(d?.error || 'The asset register could not be read.'); return }
      setRows(Array.isArray(d.rows) ? d.rows : [])
      setRequests(Array.isArray(d.requests) ? d.requests : [])
      setMeta({
        pages: d.pages ?? 1, total: d.total ?? 0, hasActive: d.hasActive === true,
        genres: Array.isArray(d.genres) ? d.genres : [],
      })
      if (typeof d.totalAll === 'number') setTotalAll(d.totalAll)
      /* The server clamps a page past the end; take its answer back so the
         control agrees with what is on screen. */
      if (typeof d.page === 'number' && d.page !== page) setPage(d.page)
      setErr('')
    } catch (e: any) {
      if (seq === reqSeq.current) setErr(e?.message || 'The asset register could not be read.')
    } finally {
      if (seq === reqSeq.current) { setLoading(false); setPaging(false) }
    }
  }

  // Page turns and page-size changes: immediate.
  useEffect(() => { load({ silent: rows !== null }) }, [page, pageSize])

  /* Filters: DEBOUNCED, and they reset to page one — staying on page 12 of a
     filter that now has two pages is how a reader ends up staring at an empty
     table. Debounced because this is a round trip per keystroke otherwise. */
  useEffect(() => {
    if (rows === null) return
    const t = setTimeout(() => {
      if (page !== 1) setPage(1); else load({ silent: true })
    }, 300)
    return () => clearTimeout(t)
  }, [q, genre, onlyActive])

  /* Which columns exist, from the rows themselves. Scanned across the first
     hundred rather than off row zero: a column that is null on the first title
     is still a column, and MySQL nulls do not always come back as keys. */
  const columns = useMemo(() => {
    if (!rows || rows.length === 0) return []
    const seen = new Set<string>()
    for (const r of rows.slice(0, 100)) for (const k of Object.keys(r)) seen.add(k)
    const known = KNOWN_ORDER.filter(k => seen.has(k))
    const extra = Array.from(seen)
      .filter(k => !KNOWN_ORDER.includes(k) && !ID_COLUMNS.has(k)).sort()
    const ids = Array.from(seen).filter(k => ID_COLUMNS.has(k)).sort()
    return [...known, ...extra, ...(showIds ? ids : [])]
  }, [rows, showIds])

  /* genres, hasActive and the counts come from the SERVER, computed over the
     whole register. Derived from the fifty rows on screen they would describe
     the page: filter to Sports and the dropdown would offer only Sports, with
     no way back to the others. */
  const genres = meta.genres

  /* The most recent request per asset, so a row shows what was last asked for
     rather than the first thing ever asked. The server returns them newest
     first, so the first one seen for an id wins. */
  const lastRequest = useMemo(() => {
    const m = new Map<string, RequestRow>()
    for (const r of requests) {
      const k = String(r.asset_id || '').toLowerCase()
      if (k && !m.has(k)) m.set(k, r)
    }
    return m
  }, [requests])

  /*
    Whether the feed carries Active at all — answered by the server, for the
    same reason as above and one more: the portal can be deployed before the
    reporting service that added the column. Where it is absent the filter is
    not applied and the control is not drawn, so the register opens complete
    rather than empty.
  */
  const hasActiveColumn = meta.hasActive

  /* No client-side filtering. The rows in hand ARE the answer — filtering them
     again here would silently narrow a page the server already filtered, and
     the counts beside them would stop matching what is listed. */
  const shown = rows || []

  if (loading) return <ReportLoader label="Loading the asset register" className="py-16" />

  if (err) {
    return (
      <div className="rounded-2xl border border-amber-200 dark:border-amber-400/25
        bg-amber-50 dark:bg-amber-500/10 px-5 py-4">
        <p className="text-sm font-bold text-amber-800 dark:text-amber-200">Asset register unavailable</p>
        <p className="text-xs text-amber-700 dark:text-amber-300/80 mt-1">{err}</p>
      </div>
    )
  }

  const total = totalAll ?? meta.total

  return (
    <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card
      border border-gray-100 dark:border-white/10 overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-gray-100 dark:border-white/10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-bold text-[#14254A] dark:text-white">Asset Register</h3>
            <p className="text-[11.5px] text-gray-500 dark:text-white/50 mt-1.5">
              <b className="text-[#14254A] dark:text-white">{meta.total.toLocaleString()}</b>
              {' '}match this filter
              <span className="mx-1 text-gray-300 dark:text-white/20">·</span>
              {total.toLocaleString()} in the register
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search titles…"
              className="h-8 w-[150px] rounded-lg border border-gray-200 dark:border-white/15
                bg-transparent px-2.5 text-[12px] text-[#14254A] dark:text-white
                placeholder:text-gray-400 outline-none focus:border-[#FC934C]" />
            {genres.length > 1 && (
              <select value={genre} onChange={e => setGenre(e.target.value)}
                className="h-8 rounded-lg border border-gray-200 dark:border-white/15
                  bg-transparent px-2 text-[12px] text-[#14254A] dark:text-white outline-none">
                <option value="all">All genres</option>
                {genres.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
            {hasActiveColumn && (
              <label className="flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-white/55">
                <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} />
                Active only
              </label>
            )}
            <label className="flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-white/55">
              <input type="checkbox" checked={showIds} onChange={e => setShowIds(e.target.checked)} />
              Show ids
            </label>
          </div>
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────── */}
      {/* Its own horizontal scroll. The register is eighteen columns wide and
          the page around it must not be. */}
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr className="bg-gray-50 dark:bg-white/5">
              {columns.map(c => (
                <th key={c} className="text-left font-extrabold text-[10px] uppercase tracking-wider
                  text-gray-400 dark:text-white/40 px-3 py-2 whitespace-nowrap">
                  {LABELS[c] || c}
                </th>
              ))}
              <th className="text-right font-extrabold text-[10px] uppercase tracking-wider
                text-gray-400 dark:text-white/40 px-3 py-2 whitespace-nowrap sticky right-0
                bg-gray-50 dark:bg-[#1e3157]">Protection</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1}
                  className="px-4 py-12 text-center text-gray-400 dark:text-white/40">
                  No titles match this filter.
                </td>
              </tr>
            )}
            {shown.map((r, i) => {
              const id = String(r.Id ?? '')
              const req = lastRequest.get(id.toLowerCase())
              const active = truthy(r.Active)
              return (
                <tr key={id || i}
                  className="border-t border-gray-50 dark:border-white/[0.05] hover:bg-[#FC934C]/[0.05]">
                  {columns.map(c => (
                    <td key={c} className="px-3 py-2 align-top whitespace-nowrap
                      text-[#14254A] dark:text-white/85">
                      <CellValue name={c} value={r[c]} />
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right whitespace-nowrap sticky right-0
                    bg-white dark:bg-[#1a2d55]">
                    {req ? (
                      <span title={'Requested ' + fmtDate(req.created_at) + (req.note ? ' — ' + req.note : '')}
                        className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-1 rounded
                          bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/50">
                        {req.request_action === 'disable' ? 'Stop requested' : 'Start requested'}
                      </span>
                    ) : (
                      <button
                        onClick={() => setAsk({ row: r, action: active ? 'disable' : 'enable' })}
                        className="text-[11px] font-bold px-2.5 py-1 rounded-lg border
                          border-gray-200 dark:border-white/15 text-[#14254A] dark:text-white
                          hover:border-[#FC934C] hover:text-[#FC934C] transition-colors">
                        {active ? 'Request stop' : 'Request start'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Pager ──────────────────────────────────────────────────────────
          Rendered whenever there is anything to show, not only past one page:
          a control that appears and disappears as a filter narrows is a control
          the reader has to hunt for. It reports the range so "showing 51-100 of
          1,388" answers where you are without counting pages. */}
      {meta.total > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-5 py-2.5 border-t
          border-gray-100 dark:border-white/10">
          <span className="text-[11.5px] text-gray-500 dark:text-white/50 tabular-nums">
            Showing <b className="text-[#14254A] dark:text-white">
              {((page - 1) * pageSize + 1).toLocaleString()}–
              {Math.min(page * pageSize, meta.total).toLocaleString()}
            </b> of {meta.total.toLocaleString()}
            {paging && <span className="ml-2 text-gray-400 dark:text-white/35">loading…</span>}
          </span>

          <span className="ml-auto flex items-center gap-1.5">
            <select value={pageSize}
              onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}
              className="h-8 rounded-lg border border-gray-200 dark:border-white/15
                bg-transparent px-2 text-[12px] text-[#14254A] dark:text-white outline-none">
              {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n} per page</option>)}
            </select>
            <PagerBtn onClick={() => setPage(1)} disabled={page <= 1} label="First">«</PagerBtn>
            <PagerBtn onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} label="Previous">‹</PagerBtn>
            <span className="text-[12px] font-bold text-[#14254A] dark:text-white tabular-nums px-1">
              {page} / {meta.pages}
            </span>
            <PagerBtn onClick={() => setPage(p => Math.min(meta.pages, p + 1))}
              disabled={page >= meta.pages} label="Next">›</PagerBtn>
            <PagerBtn onClick={() => setPage(meta.pages)} disabled={page >= meta.pages} label="Last">»</PagerBtn>
          </span>
        </div>
      )}

      <div className="px-5 py-2.5 border-t border-gray-100 dark:border-white/10
        text-[11px] text-gray-400 dark:text-white/40">
        Requests are sent to your account contact by email — protection is not changed automatically.
      </div>

      {ask && (
        <RequestModal row={ask.row} action={ask.action}
          onClose={() => setAsk(null)}
          onDone={() => { setAsk(null); load({ silent: true }) }} />
      )}
    </div>
  )
}

function PagerBtn({ children, onClick, disabled, label }: {
  children: React.ReactNode; onClick: () => void; disabled: boolean; label: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className="w-8 h-8 rounded-lg border border-gray-200 dark:border-white/15
        text-[14px] leading-none text-[#14254A] dark:text-white
        hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-30
        disabled:hover:bg-transparent transition-colors">
      {children}
    </button>
  )
}

function CellValue({ name, value }: { name: string; value: any }) {
  if (DATE_COLUMNS.has(name)) {
    return <span className="tabular-nums">{fmtDate(value)}</span>
  }
  if (FLAG_COLUMNS.has(name)) {
    const on = truthy(value)
    /* Word, not a tick. A tick and an empty cell look the same as "yes" and
       "not loaded", and this table is read to answer whether a title is under
       protection right now. */
    return (
      <span className={on
        ? 'text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
        : 'text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-white/30'}>
        {on ? 'Yes' : 'No'}
      </span>
    )
  }
  const s = value === null || value === undefined || value === '' ? '—' : String(value)
  if (name === 'AssetName') {
    return <span className="font-bold block max-w-[320px] truncate" title={s}>{s}</span>
  }
  return <span className="block max-w-[240px] truncate" title={s}>{s}</span>
}

function RequestModal({ row, action, onClose, onDone }: {
  row: Row; action: 'enable' | 'disable'; onClose: () => void; onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const name = String(row.AssetName || '(untitled)')
  const verb = action === 'disable' ? 'stop' : 'start'

  async function submit() {
    setBusy(true); setErr('')
    try {
      const r = await fetch('/api/assets/protection-request', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: String(row.Id || ''), action, note }),
      })
      const d = await r.json()
      if (!r.ok || d?.success !== true) throw new Error(d?.error || 'The request could not be sent.')
      onDone()
    } catch (e: any) {
      setErr(e?.message || 'The request could not be sent.')
      setBusy(false)
    }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-[80] flex items-center justify-center p-5"
      style={{ background: 'rgba(20,37,74,.55)', backdropFilter: 'blur(3px)' }}>
      <div onClick={e => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-white dark:bg-[#1a2d55] p-6
          shadow-[0_24px_70px_rgba(13,36,75,.3)]">
        <h4 className="font-extrabold text-[#14254A] dark:text-white">
          Request to {verb} protection
        </h4>
        <p className="text-[13px] text-gray-500 dark:text-white/55 mt-1.5 break-words">{name}</p>

        <label className="block text-[11px] font-bold uppercase tracking-wider
          text-gray-400 dark:text-white/40 mt-4 mb-1.5">Reason (optional)</label>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={1000}
          placeholder="Anything the team should know…"
          className="w-full rounded-xl border border-gray-200 dark:border-white/15 bg-transparent
            px-3 py-2 text-[13px] text-[#14254A] dark:text-white placeholder:text-gray-400
            outline-none focus:border-[#FC934C] resize-none" />

        <p className="text-[11.5px] text-gray-400 dark:text-white/40 mt-3 leading-relaxed">
          This sends an email to your account contact and a copy to you. Protection is not
          changed automatically.
        </p>

        {err && <p className="text-[12px] text-red-600 dark:text-red-400 mt-3">{err}</p>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} disabled={busy}
            className="px-3.5 py-2 rounded-lg text-[13px] font-bold text-gray-500 dark:text-white/55
              hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50">Cancel</button>
          <button onClick={submit} disabled={busy}
            className="px-3.5 py-2 rounded-lg text-[13px] font-bold text-white bg-[#14254A]
              hover:opacity-90 disabled:opacity-50">
            {busy ? 'Sending…' : 'Send request'}
          </button>
        </div>
      </div>
    </div>
  )
}
