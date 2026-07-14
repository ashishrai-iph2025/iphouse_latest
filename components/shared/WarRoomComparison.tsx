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
import DatePicker from '@/components/ui/DatePicker'
import {
  streamWarRoom, fetchWarRoom, aggregate,
  type WarRoomReport as Report, type WarRoomRow, type WarRoomProgressEvent,
} from '@/lib/warroom'

const NAVY_TEXT = 'var(--wr-navy-text)'
const ORANGE_TEXT = 'var(--wr-orange-text)'

// Series color per compared asset (selection is capped at MAX_COMPARE).
const ASSET_COLORS = ['#14254A', '#FC934C', '#0EA5E9', '#10B981']
const MAX_COMPARE = 4

interface Opt { key: string; label: string; warRoomEndDate?: string }

interface AssetResult {
  name: string
  color: string
  report: Report
  rowCount: number
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
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [progressDone, setProgressDone] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [results, setResults] = useState<AssetResult[] | null>(null)

  function onSelChange(v: string[]) {
    if (v.length > MAX_COMPARE) v = v.slice(0, MAX_COMPARE)
    setSelNames(v)
  }

  async function compare() {
    if (selNames.length < 2) { setError('Select at least two assets to compare'); return }
    if (!startDate) { setError('Please pick a start date'); return }
    setError(''); setLoading(true); setProgressDone(0); setProgressLabel('')
    try {
      let res
      try {
        res = await streamWarRoom(
          { assetNames: selNames, startDate, endDate, mode: 'auto', clientUserId },
          (evt: WarRoomProgressEvent) => {
            if (evt.phase === 'done') setProgressDone(d => d + 1)
            setProgressLabel(`${evt.asset} · ${evt.platform}`)
          })
      } catch {
        // Same resilience as the dashboard: a cut SSE stream is retried once
        // as a plain request served from the accumulated store.
        res = await fetchWarRoom({ assetNames: selNames, startDate, endDate, mode: 'incremental', clientUserId })
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
        const rows = byAsset.get(name.trim().toLowerCase()) ?? []
        return {
          name, color: ASSET_COLORS[i % ASSET_COLORS.length],
          report: aggregate(rows, {}), rowCount: rows.length,
        }
      }))
    } catch (e: any) {
      setError(e.message || 'Comparison failed')
    } finally {
      setLoading(false)
    }
  }

  const progressTotal = selNames.length * 11 // platforms per asset (mirrors WAR_ROOM_PLATFORMS)

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
            <div className="lg:flex-1 lg:min-w-[150px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Start Date *</label>
              <DatePicker value={startDate} onChange={setStartDate} placeholder="Start date" />
            </div>
            <div className="lg:flex-1 lg:min-w-[150px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">End Date</label>
              <DatePicker value={endDate} onChange={setEndDate} placeholder="Optional" min={startDate} />
            </div>
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
          <p className="text-sm text-gray-400">Pick two or more assets and a start date, then Compare.</p>
        </div>
      )}

      {results && !loading && <ComparisonBody results={results} />}
    </>
  )
}

/* ═══ Comparison layout ═══════════════════════════════════════════════════ */

function ComparisonBody({ results }: { results: AssetResult[] }) {
  return (
    <div className="space-y-6">
      <OverviewCards results={results} />
      <HeadToHeadTable results={results} />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <PlatformComparisonChart results={results} />
        <TrendComparisonChart results={results} />
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

/* ── 4. Daily identification trend ── */
function TrendComparisonChart({ results }: { results: AssetResult[] }) {
  const data = useMemo(() => {
    const days = new Map<string, Record<string, any>>()
    results.forEach(r => {
      for (const p of r.report.breakdowns.byDate ?? []) {
        let row = days.get(p.date)
        if (!row) { row = { date: p.date }; days.set(p.date, row) }
        row[r.name] = p.identified
      }
    })
    return [...days.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  }, [results])

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <h3 className="font-bold text-sm mb-1" style={{ color: NAVY_TEXT }}>Daily Identification Trend</h3>
      <p className="text-[11px] text-gray-400 mb-4">Link identifications per day, per asset.</p>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 py-10 text-center">No dated rows in this range.</p>
      ) : (
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ left: 0, right: 16, top: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef1f5" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9aa3b2' }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
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
