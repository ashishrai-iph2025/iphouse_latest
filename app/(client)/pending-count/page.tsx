'use client'

import { useState } from 'react'
import { useRouter } from '@/lib/router'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DatePicker from '@/components/ui/DatePicker'
import Breadcrumb from '@/components/ui/Breadcrumb'
import { useMasterData } from '@/lib/masterDataContext'
import { useTheme } from '@/lib/ThemeContext'
import PageLoader from '@/components/ui/PageLoader'

interface PendingRow {
  platform?: string
  platformName?: string
  assetName?: string
  urlCount?: number
  pendingCount?: number
  count?: number
  [key: string]: unknown
}

const getPlatform = (row: PendingRow) => String(row.platform ?? row.platformName ?? '–')
const getAsset    = (row: PendingRow) => String(row.assetName ?? '–')
const getUrlCount = (row: PendingRow) => Number(row.urlCount ?? row.pendingCount ?? row.count ?? 0)

async function fetchPendingCount(
  platformName: string,
  assetName: string,
  dateToUse: string,
): Promise<PendingRow[]> {
  const body: Record<string, string> = { platformName }
  if (assetName)  body.assetName  = assetName
  if (dateToUse)  body.startDate  = dateToUse

  const res  = await fetch('/api/pending-count', {
        credentials: 'include',
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const json = await res.json()
  if (!json.success) return []

  const data = json.data
  if (Array.isArray(data)) return data as PendingRow[]
  if (data && typeof data === 'object') {
    const arr = Object.values(data).find(v => Array.isArray(v))
    return arr ? (arr as PendingRow[]) : [data as PendingRow]
  }
  return []
}

export default function PendingCountPage() {
  const router = useRouter()

  const [platformName,  setPlatformName]  = useState('')
  const [assetName,     setAssetName]     = useState('')
  const [startDate,     setStartDate]     = useState('')
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState('')
  const [rows,          setRows]          = useState<PendingRow[]>([])
  const [fetched,       setFetched]       = useState(false)
  const [usedAutoDate,  setUsedAutoDate]  = useState(false)
  const [effectiveDate, setEffectiveDate] = useState('')
  const [isAllMode,     setIsAllMode]     = useState(false)
  const [progress,      setProgress]      = useState({ done: 0, total: 0 })

  const { platforms, assets } = useMasterData()
  const { theme } = useTheme()

  async function handleLoad(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    setRows([])
    setFetched(false)
    setProgress({ done: 0, total: 0 })

    const autoDate  = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const dateToUse = startDate || autoDate
    setUsedAutoDate(!startDate)
    setEffectiveDate(dateToUse)

    // ── Single platform ────────────────────────────────────────────────────────
    if (platformName) {
      setIsAllMode(false)
      try {
        const parsed = await fetchPendingCount(platformName, assetName, dateToUse)
        parsed.sort((a, b) => getUrlCount(b) - getUrlCount(a))
        setRows(parsed)
        setFetched(true)
      } catch {
        setError('Network error. Please try again.')
      } finally {
        setLoading(false)
      }
      return
    }

    // ── All platforms ──────────────────────────────────────────────────────────
    setIsAllMode(true)
    const total = platforms.length
    setProgress({ done: 0, total })

    const results: PendingRow[] = []
    const BATCH = 5

    try {
      for (let i = 0; i < platforms.length; i += BATCH) {
        const batch = platforms.slice(i, i + BATCH)
        await Promise.all(batch.map(async p => {
          try {
            const rows = await fetchPendingCount(p.key, assetName, dateToUse)
            const total = rows.reduce((s, r) => s + getUrlCount(r), 0)
            if (total > 0) {
              results.push({ platform: p.key, platformName: p.label, urlCount: total })
            }
          } catch { /* skip failed platform */ }
          setProgress(prev => ({ ...prev, done: prev.done + 1 }))
        }))
      }
      results.sort((a, b) => getUrlCount(b) - getUrlCount(a))
      setRows(results)
      setFetched(true)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const grandTotal = rows.reduce((sum, r) => sum + getUrlCount(r), 0)
  const showAsset  = !isAllMode && rows.some(r => r.assetName)
  const maxCount   = rows.length ? Math.max(...rows.map(getUrlCount)) : 1

  const topPct = rows.length > 0 ? getUrlCount(rows[0]) : 0

  return (
    <div className="fade-in">
      {/* Header row: breadcrumb left, title right */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 mb-4 sm:mb-6">
        <Breadcrumb items={[{ label: 'Approvals', href: '/pending-count' }, { label: 'Pending QC Count' }]} />
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
          <div className="sm:text-right">
            <h1 className="text-lg sm:text-xl font-bold text-[#14254A]">Platform Discovery QC Count</h1>
            <p className="text-brand-muted text-xs sm:text-sm">View pending discovery QC counts per platform and asset.</p>
          </div>
          {fetched && (
            <div className="flex items-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 rounded-2xl border border-orange-200 bg-orange-50 self-start sm:self-auto">
              <svg className="w-4 h-4 text-orange-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <span className="text-xs sm:text-sm font-bold text-orange-700">{grandTotal.toLocaleString()} pending URLs</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 sm:gap-6">

        {/* ── SIDEBAR ── */}
        <div className="w-full lg:w-72 xl:w-80 flex-shrink-0 space-y-4">

          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
            {/* accent bar */}
            <div className="h-1" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />
            <form onSubmit={handleLoad} className="p-5">
              <h2 className="text-sm font-bold text-[#14254A] mb-4 flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
                </svg>
                Filter Options
              </h2>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl px-3 py-2.5 text-xs mb-4 flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  {error}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                    Platform
                  </label>
                  <SearchableSelect
                    options={platforms}
                    value={platformName}
                    onChange={setPlatformName}
                    placeholder="All platforms…"
                    emptyLabel="– All platforms –"
                  />
                  {!platformName && (
                    <p className="text-[10px] text-gray-400 mt-1 ml-0.5">Leave blank to scan all platforms</p>
                  )}
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                    Asset Name
                  </label>
                  <SearchableSelect
                    options={assets}
                    value={assetName}
                    onChange={setAssetName}
                    placeholder="All assets…"
                    emptyLabel="– All assets –"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                    Start Date
                  </label>
                  <DatePicker value={startDate} onChange={setStartDate} placeholder="Default: last 30 days" />
                </div>
              </div>

              <button type="submit" disabled={loading}
                className="w-full mt-5 py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 flex items-center justify-center gap-2 shadow-sm"
                style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {isAllMode && progress.total > 0
                      ? `Scanning ${progress.done}/${progress.total}…`
                      : 'Loading…'}
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Load Report
                  </>
                )}
              </button>
            </form>
          </div>

          {/* Summary card */}
          {fetched && rows.length > 0 && (
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
              <div className="px-5 pt-4 pb-3 border-b border-gray-50">
                <h2 className="text-xs font-bold text-gray-500 uppercase tracking-widest">Summary</h2>
              </div>
              <div className="p-5 space-y-3">
                {/* Stat boxes */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl p-3 text-center" style={{ background: '#14254A10' }}>
                    <div className="text-xl font-black text-[#14254A]">{rows.length}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">{isAllMode ? 'Platforms' : 'Records'}</div>
                  </div>
                  <div className="rounded-xl p-3 text-center bg-orange-50">
                    <div className="text-xl font-black text-orange-600">{grandTotal.toLocaleString()}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">Total URLs</div>
                  </div>
                </div>

                <div className="flex items-center justify-between py-2.5 border-b border-gray-50">
                  <span className="text-xs text-gray-400">Mode</span>
                  <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${isAllMode ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'}`}>
                    {isAllMode ? 'All Platforms' : platformName}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-xs text-gray-400">From Date</span>
                  <div className="text-right">
                    <span className="text-xs font-semibold text-gray-700">{effectiveDate}</span>
                    {usedAutoDate && <p className="text-[10px] text-blue-500">auto: last 30 days</p>}
                  </div>
                </div>

                {/* Top 3 podium */}
                <div className="pt-1">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">
                    Top {isAllMode ? 'Platforms' : 'Assets'}
                  </p>
                  <div className="space-y-2">
                    {rows.slice(0, 3).map((row, i) => {
                      const cnt  = getUrlCount(row)
                      const pct  = topPct > 0 ? Math.round((cnt / topPct) * 100) : 0
                      const medalColors = ['#FC934C', '#64748b', '#b45309']
                      const medalBg    = theme === 'dark'
                        ? ['rgba(252,147,76,0.12)', 'rgba(148,163,184,0.12)', 'rgba(180,83,9,0.15)']
                        : ['#fff7ed', '#f8fafc', '#fffbeb']
                      return (
                        <div key={i} className="rounded-xl px-3 py-2.5" style={{ background: medalBg[i] }}>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black text-white flex-shrink-0"
                              style={{ background: medalColors[i] }}>
                              {i + 1}
                            </span>
                            <span className="text-xs text-gray-700 flex-1 truncate font-medium">
                              {isAllMode ? getPlatform(row) : getAsset(row)}
                            </span>
                            <span className="text-xs font-black text-gray-800">{cnt.toLocaleString()}</span>
                          </div>
                          <div className="h-1 bg-gray-200 rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: medalColors[i] }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── MAIN PANEL ── */}
        <div className="flex-1 min-w-0">

          {/* Progress – all-platform scan */}
          {loading && isAllMode && progress.total > 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-6 mb-4">
              <div className="flex items-center gap-4 mb-4">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0" style={{ background: '#14254A10' }}>
                  <span className="w-6 h-6 border-[3px] border-[#14254A]/20 border-t-[#14254A] rounded-full animate-spin block" />
                </div>
                <div className="flex-1">
                  <p className="font-bold text-[#14254A] text-sm">Scanning all platforms…</p>
                  <p className="text-xs text-gray-400 mt-0.5">{progress.done} of {progress.total} platforms checked</p>
                </div>
                <div className="text-right">
                  <span className="text-2xl font-black text-[#14254A]">{Math.round((progress.done / progress.total) * 100)}%</span>
                </div>
              </div>
              <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%`, background: 'linear-gradient(90deg,#14254A,#FC934C)' }}
                />
              </div>
              <p className="text-[10px] text-gray-400 mt-2 text-right">{progress.total - progress.done} remaining</p>
            </div>
          )}

          {/* Loading – single platform */}
          {loading && !isAllMode && (
            <div className="bg-white dark:bg-[#1a2d55] rounded-2xl border border-gray-100 dark:border-white/10 shadow-card">
              <PageLoader />
            </div>
          )}

          {/* Empty state */}
          {!loading && !fetched && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card flex flex-col items-center justify-center py-20 text-center px-6">
              <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-5" style={{ background: '#14254A0D' }}>
                <svg className="w-10 h-10 text-[#14254A]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <h3 className="text-gray-700 font-bold text-lg mb-1">No report loaded yet</h3>
              <p className="text-gray-400 text-sm max-w-xs">Select a platform and date range, then click Load Report to view pending QC counts.</p>
            </div>
          )}

          {/* No results */}
          {!loading && fetched && rows.length === 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card flex flex-col items-center justify-center py-20 text-center px-6">
              <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-5 bg-gray-50">
                <svg className="w-10 h-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                </svg>
              </div>
              <h3 className="text-gray-600 font-bold text-lg mb-1">No pending QC items</h3>
              <p className="text-gray-400 text-sm">Try adjusting your filters or date range.</p>
            </div>
          )}

          {/* Results */}
          {!loading && fetched && rows.length > 0 && (
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">

              {/* Auto-date banner */}
              {usedAutoDate && (
                <div className="mx-5 mt-4 flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm bg-blue-50 border border-blue-200 text-blue-700">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>
                    No start date selected – showing last <strong>30 days</strong>
                    <span className="ml-1 opacity-70">(from {effectiveDate})</span>
                  </span>
                </div>
              )}

              {/* Toolbar */}
              <div className="px-5 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-bold text-[#14254A] text-base">
                    {isAllMode ? 'All Platforms – Pending QC' : `${platformName} – Pending QC`}
                  </h2>
                  <p className="text-xs text-brand-muted mt-0.5">
                    {assetName ? `Asset: ${assetName} · ` : ''}From {effectiveDate}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-[#14254A] px-3 py-1.5 rounded-xl border-2 border-[#14254A]/20 bg-[#14254A]/5">
                    {rows.length} record{rows.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[380px]">
                  <thead>
                    <tr style={{ background: '#14254A' }}>
                      <th className="text-left px-3 sm:px-5 py-3 text-[10px] font-bold text-white/60 uppercase tracking-widest w-8 sm:w-10">#</th>
                      <th className="text-left px-3 sm:px-5 py-3 text-[10px] font-bold text-white/60 uppercase tracking-widest">Platform</th>
                      {showAsset && (
                        <th className="text-left px-3 sm:px-5 py-3 text-[10px] font-bold text-white/60 uppercase tracking-widest hidden sm:table-cell">Asset</th>
                      )}
                      <th className="text-left px-3 sm:px-5 py-3 text-[10px] font-bold text-white/60 uppercase tracking-widest hidden md:table-cell">Distribution</th>
                      <th className="text-right px-3 sm:px-5 py-3 text-[10px] font-bold text-white/60 uppercase tracking-widest">URLs</th>
                      <th className="px-3 sm:px-5 py-3 w-20 sm:w-28"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const cnt   = getUrlCount(row)
                      const pct   = maxCount > 0 ? Math.round((cnt / maxCount) * 100) : 0
                      const isHigh = cnt > 50
                      const barColor = isHigh ? '#FC934C' : '#0078D4'
                      return (
                        <tr key={i} className="border-b border-gray-50 hover:bg-orange-50/30 transition-colors group">
                          <td className="px-3 sm:px-5 py-3 sm:py-4">
                            <span className="w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold bg-gray-100 text-gray-500 group-hover:bg-orange-100 group-hover:text-orange-600 transition-colors">
                              {i + 1}
                            </span>
                          </td>
                          <td className="px-3 sm:px-5 py-3 sm:py-4">
                            <div className="flex items-center gap-1.5 sm:gap-2.5">
                              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center font-bold text-xs sm:text-sm text-white flex-shrink-0"
                                style={{ background: `hsl(${(i * 47) % 360}, 55%, 45%)` }}>
                                {getPlatform(row).charAt(0).toUpperCase()}
                              </div>
                              <span className="font-semibold text-gray-800 text-xs sm:text-sm">{getPlatform(row)}</span>
                            </div>
                          </td>
                          {showAsset && (
                            <td className="px-3 sm:px-5 py-3 sm:py-4 text-gray-500 max-w-[140px] hidden sm:table-cell">
                              <span className="block truncate text-xs" title={getAsset(row)}>{getAsset(row)}</span>
                            </td>
                          )}
                          <td className="px-3 sm:px-5 py-3 sm:py-4 min-w-[100px] hidden md:table-cell">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-700"
                                  style={{ width: `${pct}%`, background: barColor }} />
                              </div>
                              <span className="text-[10px] font-semibold w-8 text-right flex-shrink-0"
                                style={{ color: barColor }}>{pct}%</span>
                            </div>
                          </td>
                          <td className="px-3 sm:px-5 py-3 sm:py-4 text-right">
                            <span className={`inline-flex items-center justify-center px-3 py-1 rounded-lg text-xs font-black min-w-[3rem]
                              ${isHigh ? 'bg-orange-100 text-orange-700 ring-1 ring-orange-200' : 'bg-blue-50 text-blue-700'}`}>
                              {cnt.toLocaleString()}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-right">
                            {cnt > 0 && (
                              <button
                                onClick={() => {
                                  const p = new URLSearchParams({ platform: getPlatform(row), startDate: effectiveDate })
                                  if (!isAllMode && getAsset(row) !== '–') p.set('asset', getAsset(row))
                                  window.open(`/qc-action?${p}`, '_blank')
                                }}
                                className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[10px] sm:text-xs font-bold text-white transition-all hover:opacity-90 shadow-sm whitespace-nowrap"
                                style={{ background: '#FC934C' }}>
                                <span className="hidden sm:inline">Start </span>QC
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#14254A08' }} className="border-t-2 border-[#14254A]/10">
                      <td colSpan={2} className="px-3 sm:px-5 py-3 sm:py-4 font-bold text-[#14254A] text-sm">
                        Grand Total
                      </td>
                      <td className="px-3 sm:px-5 py-3 sm:py-4 text-right">
                        <span className="text-base font-black text-[#14254A]">{grandTotal.toLocaleString()}</span>
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
