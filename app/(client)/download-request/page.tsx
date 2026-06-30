'use client'

import { useState, useEffect } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DatePicker from '@/components/ui/DatePicker'
import Breadcrumb from '@/components/ui/Breadcrumb'
import { useMasterData } from '@/lib/masterDataContext'
import PageLoader from '@/components/ui/PageLoader'

const PER_PAGE = 10

function pgRange(cur: number, tot: number): (number | '…')[] {
  const pages: (number | '…')[] = [1]
  if (cur > 3) pages.push('…')
  for (let p = Math.max(2, cur - 1); p <= Math.min(tot - 1, cur + 1); p++) pages.push(p)
  if (cur < tot - 2) pages.push('…')
  if (tot > 1) pages.push(tot)
  return pages
}

function PgBtn({ onClick, disabled, active, children }: { onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`min-w-[28px] h-7 px-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-40 ${
        active
          ? 'bg-[#14254A] text-white'
          : 'bg-gray-100 text-gray-700 dark:text-gray-200 hover:bg-gray-200'
      }`}>
      {children}
    </button>
  )
}

export default function DownloadRequestPage() {
  const [platform,    setPlatform]    = useState('')
  const [assetName,   setAssetName]   = useState('')
  const [startDate,   setStartDate]   = useState('')
  const [endDate,     setEndDate]     = useState('')
  const [loading,     setLoading]     = useState(false)
  const [result,      setResult]      = useState<any>(null)
  const [history,     setHistory]     = useState<any[]>([])
  const [histLoading, setHistLoading] = useState(true)
  const [page,        setPage]        = useState(1)

  const { platforms, assets } = useMasterData()

  useEffect(() => { loadHistory() }, [])

  async function loadHistory() {
    setHistLoading(true)
    try {
      const res  = await fetch('/api/download?history=1', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setHistory(data.items || [])
    } finally {
      setHistLoading(false)
    }
  }

  const allPlatforms = !platform && !!assetName

  // Clamp end date to max 1 month after start date
  const maxEndDate = startDate
    ? new Date(new Date(startDate).setMonth(new Date(startDate).getMonth() + 1))
        .toISOString().slice(0, 10)
    : ''

  function handleStartDateChange(val: string) {
    setStartDate(val)
    if (endDate && val && endDate > new Date(new Date(val).setMonth(new Date(val).getMonth() + 1)).toISOString().slice(0, 10)) {
      setEndDate('')
    }
  }

  const dateRangeError = startDate && endDate && endDate > maxEndDate
    ? 'End date cannot be more than 1 month after start date.'
    : ''

  const canSubmit = (platform || assetName) && !dateRangeError

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setResult(null)
    setLoading(true)
    try {
      const res  = await fetch('/api/download', {
        method:  'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ platform, assetName, startDate, endDate }),
      })
      const data = await res.json()
      setResult(data)
      if (data.success) { loadHistory(); setPage(1) }
    } finally {
      setLoading(false)
    }
  }

  async function downloadFile(id: string) {
    const res  = await fetch(`/api/download/${id}`, { credentials: 'include' })
    const data = await res.json()
    if (data.url) window.open(data.url, '_blank')
    else alert(data.error || 'Download URL not available')
  }

  const totalPages = Math.max(1, Math.ceil(history.length / PER_PAGE))
  const pageRows   = history.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  return (
    <div className="fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 sm:mb-6">
        <Breadcrumb items={[{ label: 'Reporting' }, { label: 'Download Request' }]} />
        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A]">Download Data Request</h1>
          <p className="text-brand-muted text-sm">Request a data extraction for download.</p>
        </div>
      </div>

      {result && (
        <div className={`rounded-xl px-5 py-4 mb-6 text-sm font-medium ${result.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {result.success ? '✅ ' : '❌ '}{result.message || result.error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 sm:gap-6">
        {/* Request form */}
        <form onSubmit={handleRequest}
          className="lg:col-span-2 bg-white rounded-2xl shadow-card border border-gray-100 p-5 space-y-4 h-fit">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <span className="w-5 h-5 rounded-md flex items-center justify-center text-white text-[10px]"
              style={{ background: '#14254A' }}>↓</span>
            New Request
          </h2>

          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              Platform
              {!assetName && <span className="text-red-500 ml-0.5">*</span>}
              {assetName && <span className="ml-1.5 text-[10px] font-normal text-gray-400 normal-case">(optional when asset selected)</span>}
            </label>
            <SearchableSelect options={platforms} value={platform} onChange={setPlatform}
              placeholder="Select platform…" emptyLabel="— All platforms —" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              Asset Name
              {!platform && <span className="text-red-500 ml-0.5">*</span>}
              {platform && <span className="ml-1.5 text-[10px] font-normal text-gray-400 normal-case">(optional)</span>}
            </label>
            <SearchableSelect options={assets} value={assetName} onChange={setAssetName}
              placeholder="All assets…" emptyLabel="— All assets —" />
          </div>

          {/* Mode indicator */}
          {allPlatforms && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-orange-50 border border-orange-200 text-xs text-orange-700">
              <svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
              <span><strong>All Platforms</strong> mode — extraction will run across every platform for the selected asset.</span>
            </div>
          )}

          {/* 1-month limit info */}
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-blue-50 border border-blue-100 text-xs text-blue-700">
            <svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Date range is limited to <strong>1 month</strong> per request. For larger ranges, submit multiple requests.</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Start Date</label>
              <DatePicker value={startDate} onChange={handleStartDateChange} placeholder="Start date" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">End Date</label>
              <DatePicker value={endDate} onChange={setEndDate} placeholder="End date" min={startDate} max={maxEndDate || undefined} />
            </div>
          </div>
          {dateRangeError && (
            <p className="text-xs text-red-600 flex items-center gap-1.5 -mt-2">
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {dateRangeError}
            </p>
          )}

          <button type="submit" disabled={loading || !canSubmit}
            className="w-full py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 flex items-center justify-center gap-2"
            style={{ background: allPlatforms ? 'linear-gradient(135deg,#14254A,#FC934C)' : '#14254A' }}>
            {loading
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Requesting…</>
              : allPlatforms ? '🌐 Request — All Platforms' : 'Request Download'}
          </button>
        </form>

        {/* History */}
        <div className="lg:col-span-3 bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
            <div>
              <h2 className="font-bold text-[#14254A]">
                <span className="mr-2" style={{ color: '#F97316' }}>≡</span>Download History
              </h2>
              {history.length > 0 && (
                <p className="text-xs text-brand-muted mt-0.5">{history.length} record{history.length !== 1 ? 's' : ''}</p>
              )}
            </div>
            <button onClick={() => { loadHistory(); setPage(1) }}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-[#14254A] hover:border-gray-300 transition-colors">
              ↻ Refresh
            </button>
          </div>

          {histLoading ? (
            <PageLoader />
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-brand-muted">
              <p className="text-3xl mb-2">📭</p>
              <p className="text-sm">No download requests yet</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto flex-1">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: '#14254A' }}>
                      {['Platform', 'Asset', 'Date Range', 'Status', 'Action'].map(h => (
                        <th key={h} className={`text-left px-4 py-3 text-[10px] font-bold text-white/60 uppercase tracking-widest whitespace-nowrap ${h === 'Date Range' ? 'hidden sm:table-cell' : ''}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row: any, i: number) => (
                      <tr key={i} className="border-b border-gray-50 hover:bg-orange-50/30 transition-colors">
                        <td className="px-4 py-3">
                          <span className="font-semibold text-gray-800 text-xs">{row.platform}</span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">{row.assetName || '—'}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 hidden sm:table-cell">
                          <span className="whitespace-nowrap">{row.startDate ? String(row.startDate).slice(0, 10) : '—'}</span>
                          <span className="mx-1 text-gray-300">→</span>
                          <span className="whitespace-nowrap">{row.endDate ? String(row.endDate).slice(0, 10) : '—'}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                            row.processed
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-amber-50 text-amber-700 border border-amber-200'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${row.processed ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                            {row.processed ? 'Ready' : 'Pending'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {row.processed && (
                            <button onClick={() => downloadFile(row.id)}
                              className="text-xs font-semibold px-3 py-1 rounded-lg border border-gray-200 text-[#0078D4] hover:bg-blue-50 transition-colors">
                              Download
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-t border-gray-100 bg-gray-50/50 flex-shrink-0">
                <div className="text-xs text-gray-500 font-medium">
                  {history.length > PER_PAGE
                    ? <>Showing <strong className="text-[#14254A]">{(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, history.length)}</strong> of <strong className="text-[#14254A]">{history.length}</strong></>
                    : <><strong className="text-[#14254A]">{history.length}</strong> record{history.length !== 1 ? 's' : ''}</>
                  }
                </div>
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <PgBtn onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>‹</PgBtn>
                    {pgRange(page, totalPages).map((p, i) =>
                      p === '…' ? (
                        <span key={i} className="w-7 h-7 inline-flex items-center justify-center text-xs text-gray-400">…</span>
                      ) : (
                        <PgBtn key={p} active={p === page} onClick={() => setPage(p as number)}>{p}</PgBtn>
                      )
                    )}
                    <PgBtn onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>›</PgBtn>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
