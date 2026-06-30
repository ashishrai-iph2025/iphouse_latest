'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from '@/lib/router'
import Breadcrumb from '@/components/ui/Breadcrumb'
import PageLoader from '@/components/ui/PageLoader'

// ─── Types ───────────────────────────────────────────────────────────────────

type PlatformType = 'youtube' | 'telegram' | 'internet' | 'other'
type ActionType   = 'approved' | 'rejected'

interface UrlRecord {
  [key: string]: unknown
}

interface SchemaCol {
  label: string
  keys:  string[]
}

// ─── Schema per platform ─────────────────────────────────────────────────────

const SCHEMAS: Record<PlatformType, SchemaCol[]> = {
  internet: [
    { label: 'Type',             keys: ['isSourceURL'] },
    { label: 'Asset Name',       keys: ['assetName','AssetName','asset','Asset'] },
    { label: 'Source URL',       keys: ['sourceURL','sourceUrl','SourceURL','source'] },
    { label: 'Infringing URL',   keys: ['infringingURL','infringingUrl','url','URL','link'] },
    { label: 'Infringing Domain',keys: ['infringingDomain','infringingHost','domain'] },
    { label: 'Language',         keys: ['language','lang'] },
  ],
  youtube: [
    { label: 'Asset Name',       keys: ['assetName','AssetName','asset'] },
    { label: 'Video URL',        keys: ['videoURL','videoUrl','video','VideoURL'] },
    { label: 'Channel URL',      keys: ['channelURL','channelUrl','ChannelURL'] },
    { label: 'Channel Name',     keys: ['channelName','ChannelName'] },
    { label: 'Channel ID',       keys: ['channelId','channelID','ChannelId'] },
    { label: 'Type',             keys: ['infringementType'] },
    { label: 'Language',         keys: ['language'] },
    { label: 'Subscribers',      keys: ['subscrbers','followersCount','subscriberCount'] },
  ],
  telegram: [
    { label: 'Asset Name',       keys: ['assetName','AssetName','asset'] },
    { label: 'Post URL',         keys: ['postURL','postUrl','videoURL','videoUrl','post'] },
    { label: 'Channel URL',      keys: ['channelURL','channelUrl','ChannelURL','chat'] },
    { label: 'Channel Name',     keys: ['channelName','ChannelName','chatTitle','title'] },
    { label: 'Type',             keys: ['infringementType','type'] },
    { label: 'Subscribers',      keys: ['subscribers','subscrbers','followersCount','members'] },
    { label: 'Language',         keys: ['language'] },
  ],
  other: [
    { label: 'Asset Name',       keys: ['assetName','AssetName','asset'] },
    { label: 'Video URL',        keys: ['videoURL','videoUrl','video','VideoURL'] },
    { label: 'Profile URL',      keys: ['profileURL','profileUrl','ProfileURL'] },
    { label: 'Profile Name',     keys: ['profileName','ProfileName','name','userFullName'] },
    { label: 'Type',             keys: ['infringementType'] },
    { label: 'Language',         keys: ['language'] },
    { label: 'Subscribers',      keys: ['subscrbers','followersCount','subscriberCount'] },
  ],
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectType(platform: string): PlatformType {
  const lc = platform.toLowerCase()
  if (lc.includes('youtube') || lc.includes(' yt')) return 'youtube'
  if (lc.includes('telegram') || lc.includes(' tg')) return 'telegram'
  if (lc.includes('internet')) return 'internet'
  return 'other'
}

function resolve(row: UrlRecord, keys: string[]): string {
  for (const k of keys) {
    const v = row[k]
    if (v != null && String(v).trim() !== '') {
      if (k === 'isSourceURL') return v ? 'Source' : 'Infringing'
      return String(v)
    }
  }
  return '–'
}

function getId(row: UrlRecord): string {
  const idKeys = [
    'id','_id','ID','Id',
    'urlId','urlID','UrlId','UrlID',
    'discoveryId','discoveryID','DiscoveryId','DiscoveryID',
    'recordId','recordID','RecordId','RecordID',
    'qcId','qcID','QcId','QcID',
    'caseId','caseID','CaseId','CaseID',
    'sourceId','sourceID','SourceId','SourceID',
    'submissionId','SubmissionId',
  ]
  for (const k of idKeys) {
    if (row[k] != null && String(row[k]).trim() !== '') return String(row[k])
  }
  return ''
}

function isUrl(s: string): boolean {
  return s !== '–' && (s.startsWith('http://') || s.startsWith('https://'))
}

const PAGE_SIZE_OPTIONS = [15, 25, 50, 100, 250, 1000]

// ─── Inner component (uses useSearchParams) ───────────────────────────────────

function QcActionInner() {
  const params    = useSearchParams()
  const router    = useRouter()

  const platform  = params.get('platform')  || ''
  const asset     = params.get('asset')     || ''
  const auto30    = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const startDate = params.get('startDate') || auto30

  const platformType = detectType(platform)
  const schema       = SCHEMAS[platformType]

  const [data,         setData]         = useState<UrlRecord[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [selected,     setSelected]     = useState<Set<number>>(new Set())
  const [pageSize,     setPageSize]     = useState(15)
  const [page,         setPage]         = useState(1)
  const [searchQ,      setSearchQ]      = useState('')

  // Modal state
  const [modal,        setModal]        = useState<{ action: ActionType } | null>(null)
  const [comment,      setComment]      = useState('')
  const [submitting,   setSubmitting]   = useState(false)
  const [submitResult, setSubmitResult] = useState<{ success: boolean; message: string } | null>(null)
  const [toast,        setToast]        = useState<{ count: number; action: string; platform: string } | null>(null)

  // ─── Fetch data ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!platform) { setError('No platform specified.'); setLoading(false); return }
    setLoading(true)
    fetch('/api/qc-urls', {
        credentials: 'include',
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ platform, assetName: asset || undefined, startDate: startDate || undefined }),
    })
      .then(r => r.json())
      .then(d => {
        if (!d.success) { setError(d.error || 'Failed to fetch URLs'); return }
        setData(d.data || [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [platform, asset, startDate])

  // ─── Derived ────────────────────────────────────────────────────────────────

  const filtered = searchQ.trim()
    ? data.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(searchQ.toLowerCase())))
    : data

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageStart  = (page - 1) * pageSize
  const pageRows   = filtered.slice(pageStart, pageStart + pageSize)

  const allOnPage  = pageRows.length > 0 && pageRows.every((_, i) => selected.has(pageStart + i))

  function toggleRow(idx: number) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(idx)) { next.delete(idx) } else { next.add(idx) }
      return next
    })
  }

  function togglePage() {
    setSelected(prev => {
      const next = new Set(prev)
      if (allOnPage) {
        pageRows.forEach((_, i) => next.delete(pageStart + i))
      } else {
        pageRows.forEach((_, i) => next.add(pageStart + i))
      }
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(filtered.map((_, i) => i)))
  }

  function clearSelection() {
    setSelected(new Set())
  }

  // ─── Submit enforcement ──────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!modal) return
    if (comment.trim().length < 10) return

    setSubmitting(true)
    setSubmitResult(null)

    const selectedRows = Array.from(selected).map(i => filtered[i]).filter(Boolean)
    const urlIds = selectedRows.map(r => getId(r)).filter(Boolean)
    const firstAsset = resolve(selectedRows[0] || {}, ['assetName','AssetName','asset','Asset'])

    // Debug: log available field keys so we can identify the ID field if urlIds is empty
    if (urlIds.length === 0 && selectedRows.length > 0) {
      console.warn('[QC] Could not resolve IDs. Available fields in first row:', Object.keys(selectedRows[0]))
      setSubmitResult({ success: false, message: `Could not find ID field in row data. Available fields: ${Object.keys(selectedRows[0]).join(', ')}` })
      setSubmitting(false)
      return
    }

    try {
      const res  = await fetch('/api/qc-enforce', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          actionType: modal.action,
          platform,
          assetName:  asset || (firstAsset !== '–' ? firstAsset : undefined),
          comment:    comment.trim(),
          urlIds,
        }),
      })
      const json = await res.json()
      if (json.success) {
        setSubmitResult({ success: true, message: `${selected.size} URL(s) ${modal.action} successfully.` })
        setToast({ count: selected.size, action: modal.action, platform })
        setTimeout(() => setToast(null), 6000)
        // Remove approved/rejected rows from data
        const selectedIdxs = new Set(selected)
        setData(prev => prev.filter((_, i) => !selectedIdxs.has(i)))
        setSelected(new Set())
        setModal(null)
        setComment('')
      } else {
        const debugInfo = json.debug_payload
          ? `\n\nPayload sent: ${JSON.stringify(json.debug_payload, null, 2)}`
          : ''
        setSubmitResult({ success: false, message: (json.error || 'Submission failed.') + debugInfo })
      }
    } catch (e: any) {
      setSubmitResult({ success: false, message: e.message })
    } finally {
      setSubmitting(false)
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  const typeColors: Record<PlatformType, string> = {
    youtube:  '#FF0000',
    telegram: '#0088cc',
    internet: '#16A34A',
    other:    '#FC934C',
  }
  const accentColor = typeColors[platformType]

  const typeIcons: Record<PlatformType, string> = {
    youtube:  '▶',
    telegram: '✈',
    internet: '🌐',
    other:    '📱',
  }

  return (
    <div className="flex flex-col fade-in">

      {/* ── BREADCRUMB ── */}
      <Breadcrumb items={[{ label: 'Approvals', href: '/pending-count' }, { label: 'QC Action' }]} />

      {/* ── HEADER ── */}
      <div className="bg-white border-b border-gray-100 shadow-sm px-3 sm:px-5 py-3">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <button onClick={() => router.back()}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors flex-shrink-0">
            ← <span className="hidden sm:inline">Back</span>
          </button>
          <div className="w-px h-5 bg-gray-200 hidden sm:block" />
          <div className="flex items-center gap-2 sm:gap-2.5 flex-1 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center text-sm sm:text-base font-bold text-white flex-shrink-0"
              style={{ background: accentColor }}>
              {typeIcons[platformType]}
            </div>
            <div className="min-w-0">
              <h1 className="font-bold text-[#14254A] text-sm sm:text-base leading-tight truncate">
                QC Review – {platform}
              </h1>
              <p className="text-xs text-gray-400 truncate">
                {asset && <span className="mr-2">Asset: <strong>{asset}</strong></span>}
                {startDate && <span>From: <strong>{startDate}</strong></span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <span className="text-[10px] sm:text-xs font-semibold px-2 sm:px-3 py-1 rounded-full text-white"
              style={{ background: accentColor }}>
              {platformType.toUpperCase()}
            </span>
            {!loading && (
              <span className="text-[10px] sm:text-xs font-semibold px-2 sm:px-3 py-1 rounded-full bg-gray-100 text-gray-600">
                {data.length.toLocaleString()} URLs
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── LOADING ── */}

      {loading && (
        <div className="flex flex-col items-center">
          <PageLoader />
          <p className="text-xs text-gray-400 -mt-4">Platform: <strong>{platform}</strong></p>
        </div>
      )}

      {/* ── ERROR ── */}
      {!loading && error && (
        <div className="m-6 bg-red-50 border border-red-200 text-red-700 rounded-2xl p-6 text-sm">
          <p className="font-semibold mb-1">Failed to load URLs</p>
          <p>{error}</p>
        </div>
      )}

      {/* ── RESULTS ── */}
      {!loading && !error && (
        <div className="flex-1 p-5 space-y-4">

          {/* Toolbar */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-card px-3 sm:px-4 py-3 flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              {/* Search */}
              <div className="flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-2 flex-1 min-w-0 sm:min-w-[180px]">
                <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
                <input value={searchQ} onChange={e => { setSearchQ(e.target.value); setPage(1) }}
                  placeholder="Filter URLs, assets…"
                  className="flex-1 text-sm outline-none bg-transparent placeholder-gray-400 text-gray-700 min-w-0" />
                {searchQ && <button onClick={() => setSearchQ('')} className="text-gray-400 hover:text-gray-600 text-base leading-none flex-shrink-0">×</button>}
              </div>

              {/* Page size */}
              <div className="flex items-center gap-1.5 text-xs text-gray-500 flex-shrink-0">
                <span className="hidden sm:inline">Show</span>
                <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none">
                  {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            </div>

            {/* Selection info + actions */}
            {selected.size > 0 ? (
              <div className="flex items-center gap-1.5 sm:gap-2 sm:ml-auto flex-wrap">
                <span className="text-xs font-semibold text-gray-600">{selected.size.toLocaleString()} selected</span>
                <button onClick={clearSelection} className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded-lg border border-gray-200 hover:border-transparent hover:bg-gradient-to-r hover:from-[#FFC82B] hover:to-[#FC934C] transition-all">
                  Clear
                </button>
                <button onClick={() => setModal({ action: 'approved' })}
                  className="flex items-center gap-1 sm:gap-1.5 px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl text-xs sm:text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors shadow-sm">
                  ✓ <span className="hidden sm:inline">Approve</span> ({selected.size})
                </button>
                <button onClick={() => setModal({ action: 'rejected' })}
                  className="flex items-center gap-1 sm:gap-1.5 px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl text-xs sm:text-sm font-semibold text-white bg-red-500 hover:bg-red-600 transition-colors shadow-sm">
                  ✕ <span className="hidden sm:inline">Reject</span> ({selected.size})
                </button>
              </div>
            ) : (
              <div className="sm:ml-auto flex items-center gap-2">
                <button onClick={selectAll}
                  className="text-xs font-semibold px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:text-white hover:border-transparent transition-all"
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'linear-gradient(135deg, #FFC82B 0%, #FC934C 100%)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}>
                  Select All ({filtered.length})
                </button>
              </div>
            )}
          </div>

          {/* Table */}
          {data.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card flex flex-col items-center justify-center py-20 text-center">
              <p className="text-4xl mb-3">📭</p>
              <p className="font-semibold text-gray-600">No URLs found for QC</p>
              <p className="text-sm text-gray-400 mt-1">Try adjusting your filters on the previous page</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[700px] border-collapse">
                  <thead>
                    <tr style={{ background: '#14254A' }}>
                      <th className="px-4 py-3.5 w-10 text-center">
                        <input type="checkbox" checked={allOnPage} onChange={togglePage}
                          className="w-4 h-4 rounded cursor-pointer accent-orange-400" />
                      </th>
                      <th className="px-3 py-3.5 text-left w-10">
                        <span className="text-[10px] font-bold text-white/50 uppercase tracking-widest">#</span>
                      </th>
                      {schema.map(col => (
                        <th key={col.label} className="px-4 py-3.5 text-left">
                          <span className="text-[10px] font-bold text-white/60 uppercase tracking-widest whitespace-nowrap">{col.label}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-100">
                    {pageRows.map((row, ri) => {
                      const absIdx = pageStart + ri
                      const isSel  = selected.has(absIdx)
                      return (
                        <tr key={absIdx}
                          onClick={() => toggleRow(absIdx)}
                          className="cursor-pointer transition-colors"
                          style={{ background: isSel ? 'rgba(252,147,76,0.08)' : undefined }}
                          onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = 'rgba(20,37,74,0.03)' }}
                          onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = '' }}>
                          <td className="px-4 py-3 text-center" onClick={e => e.stopPropagation()}>
                            <input type="checkbox" checked={isSel} onChange={() => toggleRow(absIdx)}
                              className="w-4 h-4 rounded cursor-pointer accent-orange-400" />
                          </td>
                          <td className="px-3 py-3">
                            <span className="text-xs font-medium text-gray-400 tabular-nums">{absIdx + 1}</span>
                          </td>
                          {schema.map(col => {
                            const val = resolve(row, col.keys)
                            const isTypeCol = col.label === 'Type'
                            return (
                              <td key={col.label} className="px-4 py-3 max-w-[220px]">
                                {isTypeCol ? (
                                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wide border
                                    ${val === 'Source'
                                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                                      : val === '–'
                                        ? 'bg-gray-50 text-gray-400 border-gray-200'
                                        : 'bg-orange-50 text-orange-700 border-orange-200'}`}>
                                    {val}
                                  </span>
                                ) : isUrl(val) ? (
                                  <a href={val} target="_blank" rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    title={val}
                                    className="text-[#0369a1] hover:text-[#FC934C] text-xs block truncate transition-colors font-medium">
                                    {val.replace(/^https?:\/\//, '').slice(0, 55)}{val.replace(/^https?:\/\//, '').length > 55 ? '…' : ''}
                                  </a>
                                ) : val === '–' ? (
                                  <span className="text-xs text-gray-300">–</span>
                                ) : (
                                  <span className="text-xs text-gray-700 font-medium block truncate" title={val}>{val}</span>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination bar */}
              <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between bg-gray-50/80">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">
                    <strong className="text-[#14254A]">{pageStart + 1}–{Math.min(filtered.length, pageStart + pageSize)}</strong>
                    {' '}of{' '}
                    <strong className="text-[#14254A]">{filtered.length.toLocaleString()}</strong> records
                  </span>
                  {selected.size > 0 && (
                    <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full text-white"
                      style={{ background: 'linear-gradient(135deg,#FFC82B,#FC934C)' }}>
                      {selected.size} selected
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <QcPgBtn onClick={() => setPage(1)} disabled={page === 1}>«</QcPgBtn>
                  <QcPgBtn onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>‹</QcPgBtn>
                  {(() => {
                    const pages: (number|'…')[] = [1]
                    if (page > 3) pages.push('…')
                    for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p++) pages.push(p)
                    if (page < totalPages - 2) pages.push('…')
                    if (totalPages > 1) pages.push(totalPages)
                    return pages.map((p, i) => p === '…'
                      ? <span key={`e${i}`} className="px-1 text-xs text-gray-400">…</span>
                      : <QcPgBtn key={`p${p}`} active={p === page} onClick={() => setPage(p as number)}>{p}</QcPgBtn>
                    )
                  })()}
                  <QcPgBtn onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>›</QcPgBtn>
                  <QcPgBtn onClick={() => setPage(totalPages)} disabled={page === totalPages}>»</QcPgBtn>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── APPROVAL / REJECTION MODAL ── */}
      {modal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-16 px-4"
          onClick={() => { if (!submitting) setModal(null) }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
            onClick={e => e.stopPropagation()}>

            {/* Modal header */}
            <div className={`px-5 py-4 flex items-center gap-3 ${modal.action === 'approved' ? 'bg-emerald-600' : 'bg-red-500'}`}>
              <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center text-2xl">
                {modal.action === 'approved' ? '✓' : '✕'}
              </div>
              <div>
                <h2 className="font-bold text-white text-base">
                  {modal.action === 'approved' ? 'Approve' : 'Reject'} Selected URLs
                </h2>
                <p className="text-white/70 text-xs">{selected.size} URL{selected.size !== 1 ? 's' : ''} selected · {platform}</p>
              </div>
              <button onClick={() => !submitting && setModal(null)}
                className="ml-auto text-white/60 hover:text-white text-xl leading-none">×</button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              {/* Info row */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-[10px] text-gray-400 uppercase tracking-wide font-bold mb-0.5">Action</div>
                  <div className={`text-sm font-bold ${modal.action === 'approved' ? 'text-emerald-600' : 'text-red-500'}`}>
                    {modal.action === 'approved' ? 'Approve' : 'Reject'}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-[10px] text-gray-400 uppercase tracking-wide font-bold mb-0.5">URLs Selected</div>
                  <div className="text-sm font-bold text-gray-800">{selected.size.toLocaleString()}</div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-[10px] text-gray-400 uppercase tracking-wide font-bold mb-0.5">Platform</div>
                  <div className="text-sm font-semibold text-gray-800 truncate">{platform}</div>
                </div>
                {asset && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <div className="text-[10px] text-gray-400 uppercase tracking-wide font-bold mb-0.5">Asset</div>
                    <div className="text-sm font-semibold text-gray-800 truncate">{asset}</div>
                  </div>
                )}
              </div>

              {/* Comment */}
              <div>
                <label className="block text-xs font-bold text-gray-600 uppercase tracking-wide mb-1.5">
                  Remarks / Comment <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  rows={4}
                  required
                  minLength={10}
                  placeholder="Enter reason for this action (min 10 characters)…"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                />
                <div className="flex justify-between mt-1">
                  <p className="text-xs text-gray-400">Minimum 10 characters required</p>
                  <p className={`text-xs ${comment.length < 10 ? 'text-red-400' : 'text-emerald-600'}`}>{comment.length} chars</p>
                </div>
              </div>

              {/* Error/success */}
              {submitResult && !submitResult.success && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
                  <pre className="whitespace-pre-wrap break-all font-mono text-xs">{submitResult.message}</pre>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-1">
                <button type="button" disabled={submitting} onClick={() => setModal(null)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button type="submit"
                  disabled={submitting || comment.trim().length < 10}
                  className={`flex-1 py-2.5 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2
                    ${modal.action === 'approved' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-500 hover:bg-red-600'}`}>
                  {submitting
                    ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Submitting…</>
                    : modal.action === 'approved' ? '✓ Submit Approval' : '✕ Submit Rejection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── TOAST (top-right) ── */}
      {toast && (
        <div className="fixed top-20 right-5 z-50 w-72 rounded-2xl shadow-2xl overflow-hidden animate-fade-in"
             style={{ background: toast.action === 'approved' ? '#059669' : '#dc2626' }}>
          <div className="flex items-start gap-3 px-4 py-3.5">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0 text-white font-bold text-sm">
              {toast.action === 'approved' ? '✓' : '✕'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-sm">
                {toast.action === 'approved' ? 'Approved Successfully' : 'Marked as Invalid'}
              </p>
              <p className="text-white/80 text-xs mt-0.5 truncate">{toast.platform}</p>
            </div>
            <button onClick={() => setToast(null)} className="text-white/60 hover:text-white text-lg leading-none flex-shrink-0">×</button>
          </div>
          <div className="flex items-center justify-between px-4 py-2 bg-black/10">
            <span className="text-white/70 text-xs">URLs processed</span>
            <span className="text-white font-bold text-sm">{toast.count}</span>
          </div>
          <div className="h-1 bg-white/20">
            <div className="h-full bg-white/50 animate-[shrink_6s_linear_forwards]"
                 style={{ animation: 'shrink 6s linear forwards' }} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Pagination button ────────────────────────────────────────────────────────

function QcPgBtn({ children, onClick, disabled, active }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="min-w-[28px] h-[28px] px-2 rounded-lg text-xs font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
      style={{
        border: active ? '1.5px solid transparent' : '1.5px solid #e2e8f0',
        background: active ? '#14254A' : 'white',
        color: active ? '#FFC82B' : '#14254A',
      }}
      onMouseEnter={e => { if (!active && !disabled) { const el = e.currentTarget as HTMLElement; el.style.background = 'linear-gradient(135deg,#FFC82B,#FC934C)'; el.style.color = '#fff'; el.style.borderColor = 'transparent' }}}
      onMouseLeave={e => { if (!active) { const el = e.currentTarget as HTMLElement; el.style.background = 'white'; el.style.color = '#14254A'; el.style.borderColor = '#e2e8f0' }}}>
      {children}
    </button>
  )
}

// ─── Page (Suspense wrapper for useSearchParams) ──────────────────────────────

export default function QcActionPage() {
  return (
    <Suspense fallback={<PageLoader />}>
      <QcActionInner />
    </Suspense>
  )
}
