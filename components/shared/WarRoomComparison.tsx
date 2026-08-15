'use client'

// War Room "Asset Comparison" tab — side-by-side intelligence for 2–4 assets.
// One pull fetches every selected asset (the backend fans out per asset per
// platform anyway); rows are then split by assetName and re-aggregated
// client-side with the same aggregate() used for cross-filtering, so every
// number matches what the single-asset dashboard would show.

import { useMemo, useState } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ComposedChart, Line,
} from 'recharts'
import MultiSearchableSelect from '@/components/ui/MultiSearchableSelect'
import { platformLabel } from '@/lib/platformCategories'
import DatePicker from '@/components/ui/DatePicker'
import {
  streamWarRoom, fetchWarRoom, aggregate, rowDay, shiftIsoDays, todayIsoDay,
  type WarRoomReport as Report, type WarRoomRow, type WarRoomProgressEvent,
} from '@/lib/warroom'

const NAVY_TEXT = 'var(--wr-navy-text)'
const ORANGE_TEXT = 'var(--wr-orange-text)'

// Series color per compared asset (selection is capped at MAX_COMPARE).
const ASSET_COLORS = ['#14254A', '#FC934C', '#0EA5E9', '#10B981']
const MAX_COMPARE = 4

/* Comparison periods. A preset is deliberately NOT a shared calendar window:
   assets are monitored over different lifecycles, so comparing "1 Jul → 7 Jul"
   for a title released in March against one released last week is meaningless.
   Instead each asset contributes its OWN FIRST N days, counted forward from
   that asset's earliest URL upload date — so "7 Days" reads as "asset A's first
   week of monitoring vs asset B's first week", whenever each of those started.
   Custom falls back to one shared calendar range. */
const PERIODS = [1, 7, 15, 30] as const
type Period = (typeof PERIODS)[number] | 'custom'

/* When no asset advertises a start date, the preset fetch has to reach back far
   enough to contain every asset's first upload, because that first upload is
   what the window is anchored on. The backend caches the pull per asset, so the
   wide scan is paid once. */
const HISTORY_FLOOR = '2015-01-01'

interface Opt { key: string; label: string; warRoomStartDate?: string; warRoomEndDate?: string }

interface AssetResult {
  name: string
  color: string
  report: Report
  rowCount: number
  /** The window this asset was actually measured over (inclusive ISO days). */
  windowStart: string
  windowEnd: string
}

/** n days AFTER an ISO day. shiftIsoDays only counts backwards. */
const plusIsoDays = (iso: string, days: number) => shiftIsoDays(iso, -days)

/** Whole days from `from` to `to` (both ISO days); negative if `to` precedes it. */
function dayOffset(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!isFinite(a) || !isFinite(b)) return 0
  return Math.round((b - a) / 86400000)
}

const nf = (n: number) => n.toLocaleString()
const compact = (n: number) =>
  Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0)

export default function WarRoomComparison({
  assets, defaultStart, defaultEnd = '', clientUserId,
}: {
  assets: Opt[]
  defaultStart: string
  defaultEnd?: string
  clientUserId?: number
}) {
  // Pre-select the two most recent assets by warRoomEndDate.
  const initialSel = useMemo(() => {
    const sorted = [...assets].sort((a, b) =>
      String(b.warRoomEndDate ?? '').localeCompare(String(a.warRoomEndDate ?? '')))
    return sorted.slice(0, 2).map(a => a.key)
  }, [assets])

  const [selNames, setSelNames] = useState<string[]>(initialSel)
  const [period, setPeriod] = useState<Period>(30)
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [progressDone, setProgressDone] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [results, setResults] = useState<AssetResult[] | null>(null)
  const [periodUsed, setPeriodUsed] = useState<Period>(30)

  function onSelChange(v: string[]) {
    if (v.length > MAX_COMPARE) v = v.slice(0, MAX_COMPARE)
    setSelNames(v)
  }

  // Best guess at an asset's EARLIEST URL upload date before any rows are in
  // hand — used only to size the fetch window. '' means unknown, which forces
  // the fetch back to HISTORY_FLOOR so the true first upload is inside it. The
  // authoritative anchor is always the earliest dated row that comes back.
  const startAnchorFor = (name: string): string => {
    const s = String(assets.find(a => a.key === name)?.warRoomStartDate ?? '').slice(0, 10)
    return s.length === 10 ? s : ''
  }

  // Newest known date for an asset — the ceiling on any window it can have.
  const endAnchorFor = (name: string): string => {
    const end = String(assets.find(a => a.key === name)?.warRoomEndDate ?? '').slice(0, 10)
    const today = todayIsoDay()
    if (end.length !== 10) return today
    return end > today ? today : end
  }

  async function compare() {
    if (selNames.length < 2) { setError('Select at least two assets to compare'); return }
    if (period === 'custom' && !startDate) { setError('Please pick a start date'); return }
    setError(''); setLoading(true); setProgressDone(0); setProgressLabel('')

    // For a preset, pull one window wide enough to contain every asset's own
    // first N days (the union of their individual windows); each asset is
    // trimmed back to its own window once the rows arrive. An asset with no
    // advertised start date drags the fetch back to HISTORY_FLOOR, because its
    // first upload — the thing the window is anchored on — could be anywhere.
    let fetchStart = startDate
    let fetchEnd = endDate
    if (period !== 'custom') {
      const known = selNames.map(startAnchorFor)
      if (known.every(Boolean)) {
        const sorted = [...known].sort()
        fetchStart = sorted[0]
        fetchEnd = plusIsoDays(sorted[sorted.length - 1], period - 1)
      } else {
        fetchStart = HISTORY_FLOOR
        fetchEnd = selNames.map(endAnchorFor).sort().slice(-1)[0]
      }
      const today = todayIsoDay()
      if (fetchEnd > today) fetchEnd = today
    }

    try {
      let res
      try {
        res = await streamWarRoom(
          { assetNames: selNames, startDate: fetchStart, endDate: fetchEnd, mode: 'auto', clientUserId },
          (evt: WarRoomProgressEvent) => {
            if (evt.phase === 'done') setProgressDone(d => d + 1)
            setProgressLabel(`${evt.asset} · ${platformLabel(evt.platform)}`)
          })
      } catch {
        // Same resilience as the dashboard: a cut SSE stream is retried once
        // as a plain request served from the accumulated store.
        res = await fetchWarRoom({
          assetNames: selNames, startDate: fetchStart, endDate: fetchEnd,
          mode: 'incremental', clientUserId,
        })
      }
      // Split rows per asset and re-aggregate each slice.
      const byAsset = new Map<string, WarRoomRow[]>()
      for (const r of res.rows) {
        const k = String(r.assetName ?? '').trim().toLowerCase()
        if (!k) continue
        const arr = byAsset.get(k) ?? []
        arr.push(r); byAsset.set(k, arr)
      }
      setResults(selNames.map((name, i) => {
        let rows = byAsset.get(name.trim().toLowerCase()) ?? []
        let windowStart = fetchStart
        let windowEnd = fetchEnd

        if (period !== 'custom') {
          // Anchor on THIS asset's EARLIEST dated row — its first URL upload —
          // then keep only the N days that follow it. The rows decide the
          // anchor, not the advertised start date, so an asset whose metadata
          // is missing or stale still lands on its real first day.
          const days = rows.map(rowDay).filter(Boolean).sort()
          windowStart = days.length > 0 ? days[0] : (startAnchorFor(name) || fetchStart)
          windowEnd = plusIsoDays(windowStart, period - 1)
          rows = rows.filter(r => {
            const d = rowDay(r)
            return d !== '' && d >= windowStart && d <= windowEnd
          })
        }

        return {
          name, color: ASSET_COLORS[i % ASSET_COLORS.length],
          report: aggregate(rows, {}), rowCount: rows.length,
          windowStart, windowEnd,
        }
      }))
      setPeriodUsed(period)
    } catch (e: any) {
      setError(e.message || 'Comparison failed')
    } finally {
      setLoading(false)
    }
  }

  const progressTotal = selNames.length * 11 // platforms per asset (mirrors WAR_ROOM_PLATFORMS)

  // A preset anchored on an asset with no advertised start date can only find
  // that asset's first upload by scanning back to HISTORY_FLOOR.
  const needsHistoryScan = period !== 'custom' && selNames.some(n => !startAnchorFor(n))

  return (
    <>
      {/* ── Controls ── */}
      <div className="relative bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden mb-6">
        <div className="h-1" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />
        <div className="p-5 sm:p-6">
          {error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-2.5 text-sm mb-4">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
              {error}
            </div>
          )}

          {/* Comparison period */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mr-1">Compare over</span>
            {PERIODS.map(d => (
              <button key={d} type="button" onClick={() => setPeriod(d)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-all ${
                  period === d
                    ? 'border-[#FC934C] bg-orange-50/70'
                    : 'border-gray-200 bg-white text-gray-500 hover:border-[#FC934C]/40 hover:text-[#FC934C]'
                }`}
                style={period === d ? { color: ORANGE_TEXT } : undefined}>
                {d} Day{d === 1 ? '' : 's'}
              </button>
            ))}
            <button type="button" onClick={() => setPeriod('custom')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-all ${
                period === 'custom'
                  ? 'border-[#14254A] bg-[#14254A]/5'
                  : 'border-gray-200 bg-white text-gray-500 hover:border-[#14254A]/40'
              }`}
              style={period === 'custom' ? { color: NAVY_TEXT } : undefined}>
              Date Range
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end gap-3 lg:gap-4">
            <div className="sm:col-span-1 lg:flex-[2] lg:min-w-[260px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                Assets to compare (2–{MAX_COMPARE}) <span className="text-red-500">*</span>
              </label>
              <MultiSearchableSelect
                options={assets}
                values={selNames}
                onChange={onSelChange}
                placeholder="Select assets…"
              />
            </div>
            {period === 'custom' && (
              <>
                <div className="lg:flex-1 lg:min-w-[150px]">
                  <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Start Date *</label>
                  <DatePicker value={startDate} onChange={setStartDate} placeholder="Start date" max={endDate || todayIsoDay()} />
                </div>
                <div className="lg:flex-1 lg:min-w-[150px]">
                  <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">End Date</label>
                  <DatePicker value={endDate} onChange={setEndDate} placeholder="Optional" min={startDate} max={todayIsoDay()} />
                </div>
              </>
            )}
            <div className="sm:col-span-2 lg:flex-shrink-0">
              <button onClick={compare} disabled={loading || selNames.length < 2}
                className="w-full lg:w-auto px-6 py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 flex items-center justify-center gap-2 whitespace-nowrap shadow-sm"
                style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                {loading
                  ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Comparing…</>
                  : <>⚖ Compare</>}
              </button>
            </div>
          </div>

          {/* How the selected period is applied */}
          <div className="flex items-start gap-2 mt-4 px-3 py-2 rounded-xl bg-blue-50/70 border border-blue-100 text-[11px] text-blue-800">
            <svg className="w-3.5 h-3.5 flex-shrink-0 mt-px" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              {period === 'custom'
                ? <>All assets are compared over the same date range you pick above.</>
                : <>Each asset contributes its own first <b>{period} day{period === 1 ? '' : 's'}</b>, counted forward from
                   that asset&apos;s earliest URL upload date — not from a shared calendar window. An asset whose first
                   upload was 1 Jul is measured from 1 Jul; one whose first upload was 20 Jun is measured from 20 Jun.
                   Assets launched at different times therefore stay comparable.
                   {needsHistoryScan && (
                     <> <b>Note:</b> at least one selected asset does not publish a start date, so this pull scans
                     its full history to locate the first upload — the first run may take noticeably longer.</>
                   )}</>}
            </span>
          </div>

          {/* Selection legend chips */}
          {selNames.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-4">
              {selNames.map((n, i) => (
                <span key={n} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-50 border border-gray-100 text-gray-600">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: ASSET_COLORS[i % ASSET_COLORS.length] }} />
                  {n}
                </span>
              ))}
            </div>
          )}

          {loading && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-gray-500 truncate">
                  Fetching{progressLabel ? ` — ${progressLabel}` : '…'}
                </p>
                <span className="text-xs font-bold text-gray-400 flex-shrink-0">{progressDone} / {progressTotal}</span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${progressTotal ? Math.min(100, (progressDone / progressTotal) * 100) : 0}%`, background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Empty state ── */}
      {!results && !loading && (
        <div className="text-center py-16 bg-white rounded-2xl border border-dashed border-gray-200">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl grid place-items-center bg-[#14254A]/5 text-[#14254A] text-2xl">⚖</div>
          <h2 className="text-lg font-bold text-[#14254A] mb-1">No comparison yet</h2>
          <p className="text-sm text-gray-400">Pick two or more assets and a comparison period, then Compare.</p>
        </div>
      )}

      {results && !loading && <ComparisonBody results={results} period={periodUsed} />}
    </>
  )
}

/* ═══ Comparison layout ═══════════════════════════════════════════════════ */

function ComparisonBody({ results, period }: { results: AssetResult[]; period: Period }) {
  return (
    <div className="space-y-6">
      {period !== 'custom' && (
        <div className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-xl px-4 py-2.5">
          Each asset below is measured over its own first <b>{period} day{period === 1 ? '' : 's'}</b> from
          its earliest URL upload. Windows used: {results.map((r, i) => (
            <span key={r.name}>
              {i > 0 && ' · '}
              <b style={{ color: r.color }}>{r.name}</b> {r.windowStart} → {r.windowEnd}
            </span>
          ))}
        </div>
      )}
      <OverviewCards results={results} />
      <DailyComparisonBars results={results} period={period} />
      <HeadToHeadTable results={results} />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <PlatformComparisonChart results={results} />
        <TrendComparisonChart results={results} period={period} />
      </div>
      <RemovalRateBars results={results} />
      <TopReasonsGrid results={results} />
    </div>
  )
}

/* ── 1. Per-asset overview cards ── */
function OverviewCards({ results }: { results: AssetResult[] }) {
  const cols = results.length <= 2 ? 'sm:grid-cols-2' : results.length === 3 ? 'sm:grid-cols-2 xl:grid-cols-3' : 'sm:grid-cols-2 xl:grid-cols-4'
  return (
    <div className={`grid grid-cols-1 ${cols} gap-4`}>
      {results.map(r => {
        const s = r.report.summary
        const rate = pct(s.removed, s.identified)
        return (
          <div key={r.name} className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
            <div className="h-1" style={{ background: r.color }} />
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: r.color }} />
                <h3 className="font-bold text-sm truncate" style={{ color: NAVY_TEXT }} title={r.name}>{r.name}</h3>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                <div>
                  <p className="text-gray-400 font-semibold uppercase tracking-wide text-[10px]">Identification</p>
                  <p className="font-extrabold text-base" style={{ color: NAVY_TEXT }}>{nf(s.identified)}</p>
                </div>
                <div>
                  <p className="text-gray-400 font-semibold uppercase tracking-wide text-[10px]">Removed</p>
                  <p className="font-extrabold text-base" style={{ color: NAVY_TEXT }}>{nf(s.removed)}</p>
                </div>
                <div>
                  <p className="text-gray-400 font-semibold uppercase tracking-wide text-[10px]">Enforced</p>
                  <p className="font-bold" style={{ color: NAVY_TEXT }}>{nf(s.enforced)}</p>
                </div>
                <div>
                  <p className="text-gray-400 font-semibold uppercase tracking-wide text-[10px]">Views</p>
                  <p className="font-bold" style={{ color: NAVY_TEXT }}>{compact(s.views)}</p>
                </div>
              </div>
              {/* Removal-rate bar */}
              <div className="mt-3">
                <div className="flex items-center justify-between text-[10px] font-bold mb-1">
                  <span className="text-gray-400 uppercase tracking-wide">Removal rate</span>
                  <span style={{ color: ORANGE_TEXT }}>{rate}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${rate}%`, background: r.color }} />
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── 1b. Day-wise identification bars ──
   The same day-by-day comparison as the trend line, drawn as grouped bars so
   individual days can be read off and compared directly rather than inferred
   from a slope. In preset mode the axis is "day N of that asset's own window",
   which is what makes two assets launched months apart line up; every day in
   the window is plotted, including the ones with nothing on them, so a quiet
   day reads as a gap rather than vanishing. */
function DailyComparisonBars({ results, period }: { results: AssetResult[]; period: Period }) {
  const relative = period !== 'custom'

  const data = useMemo(() => {
    // date → per-asset totals, keyed by day index when relative.
    const byKey = new Map<string | number, Record<string, any>>()

    if (relative) {
      const n = period as number
      for (let i = 0; i < n; i++) {
        const row: Record<string, any> = { label: `Day ${i + 1}`, offset: i, sort: i }
        results.forEach(r => { row[r.name] = 0 })
        byKey.set(i, row)
      }
    }

    results.forEach(r => {
      for (const p of r.report.breakdowns.byDate ?? []) {
        const key = relative ? dayOffset(r.windowStart, p.date) : p.date
        if (relative && ((key as number) < 0 || (key as number) >= (period as number))) continue
        let row = byKey.get(key)
        if (!row) {
          row = { label: relative ? `Day ${(key as number) + 1}` : p.date, offset: key, sort: key }
          results.forEach(x => { row![x.name] = 0 })
          byKey.set(key, row)
        }
        row[r.name] = p.identified
      }
    })

    return [...byKey.values()].sort((a, b) =>
      relative ? Number(a.sort) - Number(b.sort) : String(a.sort).localeCompare(String(b.sort)))
  }, [results, relative, period])

  const hasAny = data.some(row => results.some(r => Number(row[r.name]) > 0))

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
        <h3 className="font-bold text-sm" style={{ color: NAVY_TEXT }}>Day-by-Day Identification</h3>
        {relative && (
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">
            First {period} day{period === 1 ? '' : 's'} per asset
          </span>
        )}
      </div>
      <p className="text-[11px] text-gray-400 mb-4">
        {relative
          ? 'Day 1 is each asset’s own earliest URL upload date, so the bars compare like for like. Hover a day for the calendar date behind each bar.'
          : 'Link identifications per calendar day, per asset.'}
      </p>
      {!hasAny ? (
        <p className="text-sm text-gray-400 py-10 text-center">No dated rows in this range.</p>
      ) : (
        <div style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ left: 0, right: 16, top: 4, bottom: 0 }} barCategoryGap="18%">
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef1f5" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9aa3b2' }}
                tickFormatter={(d: string) => (relative ? d.replace('Day ', '') : d.slice(5))}
                interval="preserveStartEnd" minTickGap={8} />
              <YAxis tick={{ fontSize: 11, fill: '#9aa3b2' }} tickFormatter={compact} width={44} />
              <Tooltip cursor={{ fill: '#14254A08' }}
                content={<DayBarTooltip results={results} relative={relative} />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {results.map(r => (
                <Bar key={r.name} dataKey={r.name} fill={r.color} radius={[3, 3, 0, 0]} maxBarSize={26} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

/* Tooltip for the day-wise bars. In relative mode each asset sits on a
   different calendar date for the same day index, so the real date is resolved
   per asset rather than shown once in the header. */
function DayBarTooltip({ active, payload, label, results, relative }: any) {
  if (!active || !payload?.length) return null
  const offset = Number(payload[0]?.payload?.offset ?? 0)
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-lg px-3 py-2">
      <p className="text-xs font-bold mb-1.5" style={{ color: NAVY_TEXT }}>{label}</p>
      {payload.map((p: any) => {
        const r = (results as AssetResult[]).find(x => x.name === p.dataKey)
        const date = relative && r ? plusIsoDays(r.windowStart, offset) : null
        return (
          <div key={p.dataKey} className="flex items-center gap-2 text-[11px] py-0.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
            <span className="font-semibold text-gray-600 truncate max-w-[150px]">{p.dataKey}</span>
            {date && <span className="text-gray-400 font-mono">{date}</span>}
            <span className="font-mono font-bold text-gray-700 ml-auto">{nf(Number(p.value ?? 0))}</span>
          </div>
        )
      })}
    </div>
  )
}

/* ── 2. Head-to-head metric table (bold = highest per row) ── */
function HeadToHeadTable({ results }: { results: AssetResult[] }) {
  const metrics: { label: string; get: (r: AssetResult) => number; fmt?: (n: number) => string }[] = [
    { label: 'Identification (links)', get: r => r.report.summary.identified },
    { label: 'Links enforced',        get: r => r.report.summary.enforced },
    { label: 'Links removed',         get: r => r.report.summary.removed },
    { label: 'Links pending',         get: r => r.report.funnel.pending },
    { label: 'Removal rate',          get: r => pct(r.report.summary.removed, r.report.summary.identified), fmt: n => `${n}%` },
    { label: 'Views on infringing content', get: r => r.report.summary.views, fmt: compact },
    { label: 'Engagement (likes + comments)', get: r => r.report.summary.engagement, fmt: compact },
    { label: 'Channels / profiles flagged',   get: r => r.report.removal.channelsTotal },
    { label: 'Channels / profiles removed',   get: r => r.report.removal.channelsRemoved },
    { label: 'Subscribers impacted',  get: r => r.report.removal.subscribersImpacted, fmt: compact },
  ]
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
      <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-2 flex-wrap">
        <h3 className="font-bold text-sm" style={{ color: NAVY_TEXT }}>Head-to-Head</h3>
        <span className="text-[10px] text-gray-400 font-semibold">Highlighted = highest value in the row</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: '#14254A' }}>
              <th className="text-left px-4 py-2.5 text-[10px] font-bold text-white/70 uppercase tracking-widest whitespace-nowrap">Metric</th>
              {results.map(r => (
                <th key={r.name} className="text-right px-4 py-2.5 text-[10px] font-bold text-white uppercase tracking-widest whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: r.color }} />
                    <span className="max-w-[180px] truncate inline-block align-bottom">{r.name}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map(m => {
              const vals = results.map(m.get)
              const best = Math.max(...vals)
              return (
                <tr key={m.label} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-2.5 text-xs font-semibold text-gray-500 whitespace-nowrap">{m.label}</td>
                  {results.map((r, i) => {
                    const v = vals[i]
                    const isBest = v === best && best > 0
                    return (
                      <td key={r.name} className={`px-4 py-2.5 text-right font-mono text-xs whitespace-nowrap ${isBest ? 'font-extrabold' : 'text-gray-600'}`}
                        style={isBest ? { color: ORANGE_TEXT, background: '#FC934C0d' } : undefined}>
                        {(m.fmt ?? nf)(v)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── 3. Per-platform grouped bars ── */
function PlatformComparisonChart({ results }: { results: AssetResult[] }) {
  const data = useMemo(() => {
    // Platform order comes from the report itself (fixed PLATFORM_ORDER); keep
    // only platforms where at least one compared asset has identifications.
    const base = results[0].report.platforms
    return base
      .map(p => {
        const row: Record<string, any> = { platform: p.label }
        let any = 0
        results.forEach(r => {
          const match = r.report.platforms.find(x => x.platform === p.platform)
          const v = match?.totals.identified ?? 0
          row[r.name] = v; any += v
        })
        return any > 0 ? row : null
      })
      .filter(Boolean) as Record<string, any>[]
  }, [results])

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <h3 className="font-bold text-sm mb-1" style={{ color: NAVY_TEXT }}>Identification by Platform</h3>
      <p className="text-[11px] text-gray-400 mb-4">Infringing link identifications per platform, per asset.</p>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 py-10 text-center">No platform data in this range.</p>
      ) : (
        <div style={{ height: Math.max(260, data.length * (26 * results.length + 18)) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24, top: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#eef1f5" />
              <XAxis type="number" tick={{ fontSize: 11, fill: '#9aa3b2' }} tickFormatter={compact} />
              <YAxis type="category" dataKey="platform" width={110} tick={{ fontSize: 11, fill: '#5b6678' }} />
              <Tooltip formatter={(v: any) => nf(Number(v))} contentStyle={{ fontSize: 12, borderRadius: 10 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {results.map(r => (
                <Bar key={r.name} dataKey={r.name} fill={r.color} radius={[0, 4, 4, 0]} barSize={12} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

/* ── 4. Daily identification trend ──
   With a preset period every asset has its own window, so plotting against
   absolute dates would leave the series side by side instead of overlaid. The
   x-axis therefore becomes "day N of that asset's window"; custom mode keeps
   real dates, since there the window genuinely is shared. */
function TrendComparisonChart({ results, period }: { results: AssetResult[]; period: Period }) {
  const relative = period !== 'custom'

  const data = useMemo(() => {
    const days = new Map<string | number, Record<string, any>>()
    results.forEach(r => {
      for (const p of r.report.breakdowns.byDate ?? []) {
        const key = relative ? dayOffset(r.windowStart, p.date) : p.date
        if (relative && (key as number) < 0) continue
        let row = days.get(key)
        if (!row) { row = { date: relative ? `Day ${(key as number) + 1}` : p.date, sort: key }; days.set(key, row) }
        row[r.name] = p.identified
      }
    })
    return [...days.values()].sort((a, b) =>
      relative ? Number(a.sort) - Number(b.sort) : String(a.sort).localeCompare(String(b.sort)))
  }, [results, relative])

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <h3 className="font-bold text-sm mb-1" style={{ color: NAVY_TEXT }}>Daily Identification Trend</h3>
      <p className="text-[11px] text-gray-400 mb-4">
        {relative
          ? 'Link identifications per day, aligned to day 1 of each asset’s own window.'
          : 'Link identifications per day, per asset.'}
      </p>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 py-10 text-center">No dated rows in this range.</p>
      ) : (
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ left: 0, right: 16, top: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef1f5" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9aa3b2' }}
                tickFormatter={(d: string) => (relative ? d : d.slice(5))} minTickGap={24} />
              <YAxis tick={{ fontSize: 11, fill: '#9aa3b2' }} tickFormatter={compact} width={44} />
              <Tooltip formatter={(v: any) => nf(Number(v))} contentStyle={{ fontSize: 12, borderRadius: 10 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {results.map(r => (
                <Line key={r.name} type="monotone" dataKey={r.name} stroke={r.color} strokeWidth={2.5} dot={false} connectNulls />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

/* ── 5. Removal funnel side-by-side ── */
function RemovalRateBars({ results }: { results: AssetResult[] }) {
  const maxIdent = Math.max(1, ...results.map(r => r.report.summary.identified))
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <h3 className="font-bold text-sm mb-1" style={{ color: NAVY_TEXT }}>Enforcement Funnel</h3>
      <p className="text-[11px] text-gray-400 mb-4">Identification → enforced → removed, scaled to the largest asset.</p>
      <div className="space-y-5">
        {results.map(r => {
          const s = r.report.summary
          const w = (n: number) => `${Math.max(1, (n / maxIdent) * 100)}%`
          return (
            <div key={r.name}>
              <div className="flex items-center gap-2 mb-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: r.color }} />
                <span className="text-xs font-bold truncate" style={{ color: NAVY_TEXT }}>{r.name}</span>
                <span className="text-[10px] text-gray-400 font-semibold flex-shrink-0 ml-auto">
                  {pct(s.removed, s.identified)}% removed
                </span>
              </div>
              <div className="space-y-1.5">
                {[
                  { label: 'Identification', value: s.identified, opacity: 0.25 },
                  { label: 'Enforced',       value: s.enforced,   opacity: 0.55 },
                  { label: 'Removed',        value: s.removed,    opacity: 1 },
                ].map(seg => (
                  <div key={seg.label} className="flex items-center gap-2">
                    <span className="w-16 text-[10px] font-semibold text-gray-400 uppercase tracking-wide flex-shrink-0">{seg.label}</span>
                    <div className="flex-1 h-4 rounded bg-gray-50 overflow-hidden">
                      <div className="h-full rounded transition-all" style={{ width: w(seg.value), background: r.color, opacity: seg.opacity }} />
                    </div>
                    <span className="w-16 text-right text-[11px] font-mono font-bold text-gray-600 flex-shrink-0">{nf(seg.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── 6. Top infringement reasons per asset ── */
function TopReasonsGrid({ results }: { results: AssetResult[] }) {
  const cols = results.length <= 2 ? 'sm:grid-cols-2' : results.length === 3 ? 'sm:grid-cols-2 xl:grid-cols-3' : 'sm:grid-cols-2 xl:grid-cols-4'
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <h3 className="font-bold text-sm mb-1" style={{ color: NAVY_TEXT }}>Top Infringement Reasons</h3>
      <p className="text-[11px] text-gray-400 mb-4">The five most common infringement types per asset.</p>
      <div className={`grid grid-cols-1 ${cols} gap-4`}>
        {results.map(r => {
          const segs = (r.report.breakdowns.byReason ?? []).slice(0, 5)
          const max = Math.max(1, ...segs.map(s => s.identified))
          return (
            <div key={r.name} className="rounded-xl border border-gray-100 p-3.5">
              <div className="flex items-center gap-2 mb-3 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: r.color }} />
                <span className="text-xs font-bold truncate" style={{ color: NAVY_TEXT }}>{r.name}</span>
              </div>
              {segs.length === 0 ? (
                <p className="text-xs text-gray-400">No reason data.</p>
              ) : segs.map(s => (
                <div key={s.key} className="mb-2 last:mb-0">
                  <div className="flex items-center justify-between text-[11px] mb-0.5">
                    <span className="font-semibold text-gray-600 truncate pr-2">{s.label}</span>
                    <span className="font-mono font-bold text-gray-500 flex-shrink-0">{nf(s.identified)}</span>
                  </div>
                  <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(s.identified / max) * 100}%`, background: r.color }} />
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
