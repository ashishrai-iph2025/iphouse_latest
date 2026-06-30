'use client'

import { useState, useEffect, useRef } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DatePicker from '@/components/ui/DatePicker'
import Breadcrumb from '@/components/ui/Breadcrumb'

interface IPRecord {
  ip?: string; port?: string; country?: string; city?: string; state?: string
  continent?: string; currency?: string; isp?: string; organization?: string
  asNumber?: string; mobile?: string; proxy?: string; hosting?: string
  assetTitle?: string; assetName?: string; torrentFileName?: string
  infohash?: string; torrentUrl?: string; p2PNetwork?: string
  torrentStatus?: string; torrentClient?: string; size?: string
  pieceLength?: string; totalPieces?: string; hasPieces?: string
  dateAdded?: string; captureDetailsUpdatedOn?: string
  [key: string]: unknown
}

const PER = 10

const COUNTRY_CODES: Record<string, string> = {
  'China': 'CN', 'Russia': 'RU', 'United States': 'US', 'Germany': 'DE',
  'France': 'FR', 'United Kingdom': 'GB', 'India': 'IN', 'Brazil': 'BR',
  'Canada': 'CA', 'Australia': 'AU', 'Netherlands': 'NL', 'Ukraine': 'UA',
  'Poland': 'PL', 'Sweden': 'SE', 'Romania': 'RO', 'Spain': 'ES', 'Italy': 'IT',
  'Japan': 'JP', 'South Korea': 'KR', 'Turkey': 'TR', 'Mexico': 'MX',
  'Argentina': 'AR', 'Portugal': 'PT', 'Czech Republic': 'CZ', 'Hungary': 'HU',
  'Bulgaria': 'BG', 'Greece': 'GR', 'Finland': 'FI', 'Norway': 'NO',
  'Denmark': 'DK', 'Switzerland': 'CH', 'Austria': 'AT', 'Belgium': 'BE',
  'Indonesia': 'ID', 'Vietnam': 'VN', 'Thailand': 'TH', 'Malaysia': 'MY',
  'Philippines': 'PH', 'Pakistan': 'PK', 'Iran': 'IR', 'Saudi Arabia': 'SA',
  'United Arab Emirates': 'AE', 'Egypt': 'EG', 'South Africa': 'ZA',
  'Taiwan': 'TW', 'Hong Kong': 'HK', 'Singapore': 'SG', 'Israel': 'IL',
  'Colombia': 'CO', 'Chile': 'CL', 'Peru': 'PE', 'Venezuela': 'VE',
}

function fmt(s?: string) {
  if (!s) return '—'
  try {
    const d = new Date(s)
    return isNaN(d.getTime()) ? s : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch { return s }
}
function flag(c?: string) {
  const map: Record<string, string> = { 'Russia': '🇷🇺', 'United States': '🇺🇸', 'China': '🇨🇳', 'Germany': '🇩🇪', 'France': '🇫🇷', 'United Kingdom': '🇬🇧', 'India': '🇮🇳', 'Brazil': '🇧🇷', 'Canada': '🇨🇦', 'Australia': '🇦🇺', 'Netherlands': '🇳🇱', 'Ukraine': '🇺🇦', 'Poland': '🇵🇱', 'Sweden': '🇸🇪', 'Romania': '🇷🇴', 'Spain': '🇪🇸', 'Italy': '🇮🇹', 'Japan': '🇯🇵', 'South Korea': '🇰🇷' }
  return map[c || ''] || '🌐'
}
function countryCode(c?: string) { return COUNTRY_CODES[c || ''] || (c ? c.slice(0, 2).toUpperCase() : '??') }
function va(x: unknown) { return x == null || String(x).trim() === '' ? '—' : String(x) }
function tr(s: string, n: number) { return s.length > n ? s.slice(0, n) + '…' : s }
function fmtShort(s: string) {
  try { return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) } catch { return s }
}

function StatusPill({ status }: { status?: string }) {
  const l = (status || '').toLowerCase()
  if (l === 'alive') return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-600 border border-emerald-200">● Alive</span>
  if (l === 'dead')  return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-50 text-red-500 border border-red-200">○ Dead</span>
  return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-gray-100 text-gray-500 border border-gray-200">· {status || 'Unknown'}</span>
}

// Labelled field used inside modal
function Field({ label, value, mono, full, onClick, children }: {
  label: string; value?: string; mono?: boolean; full?: boolean
  onClick?: () => void; children?: React.ReactNode
}) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <div className="text-[10px] font-bold uppercase tracking-widest mb-1"
        style={{ color: '#FC934C' }}>{label}</div>
      {children ?? (
        <div
          onClick={onClick}
          className={`bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 truncate
            ${mono ? 'font-mono text-xs' : ''}
            ${onClick ? 'cursor-pointer hover:bg-orange-50 hover:border-orange-300 transition-colors' : ''}`}
          title={value}
        >
          {value || '—'}
        </div>
      )}
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-50 last:border-0 odd:bg-white even:bg-gray-50/60">
      <span className="text-xs text-gray-400 flex-shrink-0">{label}</span>
      <strong className="text-xs text-[#14254A] text-right max-w-[55%] truncate ml-2" title={value}>{value}</strong>
    </div>
  )
}

export default function IPTrackingPage() {
  const today     = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  const [startDate, setStartDate] = useState(yesterday)
  const [endDate,   setEndDate]   = useState(today)
  const [owner,     setOwner]     = useState('')
  const [asset,     setAsset]     = useState('')
  const [pageNo,    setPageNo]    = useState(1)
  const [filter,    setFilter]    = useState('')

  const [owners,    setOwners]    = useState<{ key: string; label: string }[]>([])
  const [assets,    setAssets]    = useState<{ key: string; label: string }[]>([])
  const [cdLoading, setCdLoading] = useState(true)

  const [loading,     setLoading]     = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,       setError]       = useState('')
  const [fetchTime,   setFetchTime]   = useState('')

  const [allItems,   setAllItems]   = useState<IPRecord[]>([])
  const [filtered,   setFiltered]   = useState<IPRecord[]>([])
  const [totalRec,   setTotalRec]   = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [curApiPage, setCurApiPage] = useState(0)
  const [curPage,    setCurPage]    = useState(1)
  const [fetched,    setFetched]    = useState(false)

  const [activeOwner, setActiveOwner] = useState('—')
  const [activeAsset, setActiveAsset] = useState('—')
  const [activeRange, setActiveRange] = useState('—')

  const [modal,  setModal]  = useState<IPRecord | null>(null)
  const [copied, setCopied] = useState('')

  const nextApiPage = useRef(0)

  useEffect(() => {
    fetch('/api/ip-tracking/client-details', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setOwners((d.copyrightOwners as string[]).map(o => ({ key: o, label: o })))
          setAssets((d.assets as string[]).map(a => ({ key: a, label: a })))
        }
      })
      .catch(() => {})
      .finally(() => setCdLoading(false))
  }, [])

  useEffect(() => {
    const q = filter.toLowerCase().trim()
    setFiltered(q ? allItems.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q))) : [...allItems])
    setCurPage(1)
  }, [filter, allItems])

  function setQuickDate(days: number) {
    const end = new Date(), start = new Date()
    start.setDate(end.getDate() - days + 1)
    setStartDate(start.toISOString().slice(0, 10))
    setEndDate(end.toISOString().slice(0, 10))
  }

  async function fetchRecords(apiPage: number, append: boolean) {
    if (!owner) { setError('Please select a Copyright Owner'); return }
    setError('')
    append ? setLoadingMore(true) : setLoading(true)
    const t0 = performance.now()
    try {
      const res  = await fetch('/api/ip-tracking', {
        method:  'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ startDate, endDate, copyrightOwner: owner, pageNo: apiPage, asset: asset || undefined }),
      })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to fetch'); return }
      const el = ((performance.now() - t0) / 1000).toFixed(2)
      setFetchTime('⏱ ' + el + 's')
      const incoming: IPRecord[] = data.data ?? []
      setAllItems(prev => append ? [...prev, ...incoming] : incoming)
      setTotalRec(data.totalRecords ?? 0)
      setTotalPages(data.totalPages ?? 0)
      setCurApiPage(apiPage)
      nextApiPage.current = apiPage + 1
      if (!append) { setCurPage(1); setFilter('') }
      setFetched(true)
      setActiveOwner(owner || '—')
      setActiveAsset(asset || 'All')
      setActiveRange(fmtShort(startDate) + ' → ' + fmtShort(endDate))
    } catch (e: any) {
      setError(e.message)
    } finally {
      append ? setLoadingMore(false) : setLoading(false)
    }
  }

  function handleFetch() {
    nextApiPage.current = 0
    setAllItems([])
    fetchRecords(pageNo, false)
  }

  function handleReset() {
    setOwner(''); setAsset(''); setFilter(''); setPageNo(0)
    setAllItems([]); setFiltered([]); setTotalRec(0); setTotalPages(0)
    setFetched(false); setError(''); setFetchTime('')
    setStartDate(yesterday); setEndDate(today)
    setActiveOwner('—'); setActiveAsset('—'); setActiveRange('—')
  }

  function copyText(text: string) {
    if (!text || text === '—') return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(text); setTimeout(() => setCopied(''), 2000)
    })
  }

  const hasMoreApi      = curApiPage < totalPages - 1
  const totalPagesLocal = Math.max(1, Math.ceil(filtered.length / PER))
  const pageStart       = (curPage - 1) * PER
  const pageItems       = filtered.slice(pageStart, pageStart + PER)

  function renderPagination() {
    if (totalPagesLocal <= 1) return null
    const pages: (number | '…')[] = []
    const st = Math.max(1, curPage - 3), en = Math.min(totalPagesLocal, st + 6)
    if (st > 1) { pages.push(1); if (st > 2) pages.push('…') }
    for (let p = st; p <= en; p++) pages.push(p)
    if (en < totalPagesLocal) { if (en < totalPagesLocal - 1) pages.push('…'); pages.push(totalPagesLocal) }
    return (
      <div className="flex items-center gap-1 flex-wrap">
        <button onClick={() => setCurPage(p => Math.max(1, p - 1))} disabled={curPage === 1}
          className="w-8 h-8 rounded-lg border border-gray-200 text-gray-500 dark:text-gray-300 text-sm flex items-center justify-center disabled:opacity-40 hover:bg-gray-50">‹</button>
        {pages.map((p, i) => p === '…'
          ? <span key={`e${i}`} className="w-8 h-8 flex items-center justify-center text-gray-400 text-sm">…</span>
          : <button key={p} onClick={() => setCurPage(p as number)}
              className={`w-8 h-8 rounded-lg border text-sm transition-colors ${
                p === curPage
                  ? 'bg-[#14254A] text-white border-[#14254A]'
                  : 'border-gray-200 text-gray-600 dark:text-gray-300 hover:bg-gray-50'
              }`}>
              {p}
            </button>
        )}
        <button onClick={() => setCurPage(p => Math.min(totalPagesLocal, p + 1))} disabled={curPage === totalPagesLocal}
          className="w-8 h-8 rounded-lg border border-gray-200 text-gray-500 dark:text-gray-300 text-sm flex items-center justify-center disabled:opacity-40 hover:bg-gray-50">›</button>
      </div>
    )
  }

  return (
    <>
    <div className="fade-in">

      {/* ── Header row ── */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 mb-4 sm:mb-6">
        <Breadcrumb items={[{ label: 'IP Tracking' }]} />
        <div className="sm:text-right hidden sm:block">
          <h1 className="text-xl font-bold text-[#14254A]">IP Tracking</h1>
          <p className="text-brand-muted text-sm">Track and analyze IP activity across platforms.</p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-5 lg:items-start">

      {/* ══ SIDEBAR ══ */}
      <aside className="w-full lg:w-72 lg:flex-shrink-0 bg-white rounded-2xl border border-gray-100 shadow-card lg:self-start lg:sticky lg:top-5">
        <div className="h-1 rounded-t-2xl" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />
        <div className="p-4">

          {/* Platform header */}
          <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'linear-gradient(135deg,#14254A,#FC934C)' }}>
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
            </div>
            <div>
              <div className="font-bold text-[#14254A] text-sm">IP Tracking</div>
              <div className="text-[10px] text-gray-400">P2P Torrent Intelligence</div>
            </div>
          </div>

          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Search Parameters</div>

          {/* Dates */}
          <div className="mb-4">
            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
              Date Range <span className="text-red-400">*</span>
            </label>
            <div className="flex flex-col gap-2">
              <DatePicker value={startDate} onChange={setStartDate} placeholder="Start date" />
              <DatePicker value={endDate}   onChange={setEndDate}   placeholder="End date" min={startDate} />
            </div>
            <div className="flex gap-2 mt-2">
              {[['Last 7 days', 7], ['Last 30 days', 30]].map(([l, d]) => (
                <button key={l as string} type="button" onClick={() => setQuickDate(d as number)}
                  className="flex-1 text-[10px] font-semibold px-2 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-[#14254A] hover:text-[#14254A] hover:bg-[#14254A]/5 transition-all">
                  {l as string}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-gray-100 my-4" />

          <div className="mb-4">
            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
              Copyright Owner <span className="text-red-400">*</span>
            </label>
            <SearchableSelect options={owners} value={owner} onChange={setOwner}
              placeholder={cdLoading ? 'Loading…' : 'Click to select…'}
              emptyLabel="— Select owner —" disabled={cdLoading} />
          </div>

          <div className="mb-4">
            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
              Asset <span className="text-gray-300 normal-case font-normal">(optional)</span>
            </label>
            <SearchableSelect options={assets} value={asset} onChange={setAsset}
              placeholder={cdLoading ? 'Loading…' : 'All assets'}
              emptyLabel="— All assets —" disabled={cdLoading} />
          </div>

          <div className="mb-5">
            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
              Page No <span className="text-gray-300 normal-case font-normal">(0-based)</span>
            </label>
            <input type="number" min={1} value={pageNo}
              onChange={e => setPageNo(Math.max(1, Number(e.target.value)))}
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A]" />
          </div>

          {/* Buttons */}
          <div className="flex flex-col gap-2 mb-2">
            <button onClick={handleFetch} disabled={loading || !owner}
              className="w-full py-2.5 rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-50 transition-all hover:opacity-90"
              style={{ background: 'linear-gradient(135deg,#14254A,#1a3060)' }}>
              {loading ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Fetching…</> : <>⚡ Fetch Records</>}
            </button>
            <button onClick={handleReset}
              className="w-full py-2 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors flex items-center justify-center gap-1.5">
              ↺ Reset
            </button>
            {hasMoreApi && (
              <button onClick={() => fetchRecords(nextApiPage.current, true)} disabled={loadingMore}
                className="w-full py-2 rounded-xl text-sm font-semibold border flex items-center justify-center gap-1.5 transition-colors disabled:opacity-60"
                style={{ borderColor: '#FC934C', color: '#FC934C', background: '#FC934C0f' }}>
                {loadingMore
                  ? <><span className="w-3.5 h-3.5 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />Loading…</>
                  : <>↓ Load page {nextApiPage.current} of {totalPages - 1}</>}
              </button>
            )}
          </div>

          {fetchTime && <p className="text-[11px] text-gray-400 text-center mt-1">{fetchTime}</p>}
          {error && <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        </div>
      </aside>

      {/* ══ RESULTS PANEL ══ */}
      <div className="flex-1 min-w-0">

        {loading && (
          <div className="flex items-center justify-center py-32">
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-10 flex flex-col items-center gap-4 max-w-sm w-full mx-6">
              <div className="w-14 h-14 rounded-full border-4 border-gray-100 border-t-orange-400 animate-spin" />
              <p className="font-bold text-[#14254A]">Fetching Records…</p>
              <p className="text-sm text-gray-400">Please wait while we retrieve the data</p>
            </div>
          </div>
        )}

        {!fetched && !loading && (
          <div className="flex flex-col items-center justify-center py-32 text-center px-6">
            <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-4xl mb-4" style={{ background: '#14254A10' }}>🌐</div>
            <h3 className="text-gray-700 font-semibold text-lg">No records yet</h3>
            <p className="text-gray-400 text-sm mt-1 max-w-xs">Select a copyright owner and date range, then click Fetch Records.</p>
          </div>
        )}

        {fetched && !loading && (
          <div className="p-5">

            {/* Header bar */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card px-5 py-4 mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-bold text-[#14254A] text-base">IP Tracking Results</h2>
                <p className="text-xs text-gray-400 mt-0.5">{activeOwner}{activeAsset !== 'All' ? ' · ' + activeAsset : ''} · {activeRange}</p>
              </div>
              <div className="flex gap-6">
                {[['Records', totalRec.toLocaleString()], ['Pages', totalPages], ['Loaded', allItems.length.toLocaleString()], ['Page', `${curApiPage}/${totalPages}`]].map(([l, v]) => (
                  <div key={l as string} className="text-center">
                    <div className="text-base font-bold text-[#14254A]">{v}</div>
                    <div className="text-[10px] text-gray-400 uppercase tracking-wide">{l as string}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Filter bar */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card px-4 py-3 mb-4 flex items-center gap-3">
              <svg className="w-4 h-4 text-orange-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
                placeholder="Filter by IP, country, ISP, asset, hash…"
                className="flex-1 text-sm bg-transparent outline-none text-gray-700 placeholder-gray-400" />
              {filter && <button onClick={() => setFilter('')} className="text-gray-300 hover:text-gray-500 text-base leading-none">×</button>}
              <span className="text-xs text-gray-400 flex-shrink-0">
                {filter ? `${filtered.length.toLocaleString()} match${filtered.length !== 1 ? 'es' : ''}` : `${pageStart + 1}–${Math.min(filtered.length, pageStart + PER)} of ${filtered.length.toLocaleString()}`}
              </span>
            </div>

            {/* Record list */}
            {pageItems.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-100 flex flex-col items-center justify-center py-20 text-center">
                <p className="text-3xl mb-2">📭</p>
                <p className="text-gray-500 font-medium">No records match your filter</p>
                {filter && <button onClick={() => setFilter('')} className="mt-2 text-sm text-blue-600 hover:underline">Clear filter</button>}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {pageItems.map((r, i) => {
                  const ip         = r.ip || '—'
                  const port       = r.port || ''
                  const cc         = countryCode(r.country)
                  const assetLabel = r.assetTitle || r.assetName || ''
                  const loc        = [r.city, r.country].filter(Boolean).join(', ') || '—'
                  return (
                    <div key={i} onClick={() => setModal(r)}
                      className="bg-white rounded-2xl border border-gray-100 shadow-card hover:shadow-md hover:border-orange-200 transition-all cursor-pointer flex items-center gap-4 p-4">

                      {/* IP box */}
                      <div className="flex-shrink-0 w-[90px] sm:w-[120px] border-2 border-yellow-400 rounded-xl p-2 sm:p-3 text-center bg-white">
                        <div className="font-mono font-bold text-[#14254A] text-sm leading-tight">{ip}</div>
                        {port && <div className="text-[11px] text-gray-400 mt-0.5">:{port}</div>}
                        <div className="text-sm font-bold text-gray-500 mt-1">{cc}</div>
                      </div>

                      {/* Body */}
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-gray-900 text-sm mb-1.5">{assetLabel || '—'}</h3>
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {loc !== '—' && (
                            <span className="inline-flex items-center gap-1 text-[11px] bg-gray-50 border border-gray-200 rounded-lg px-2 py-0.5 text-gray-600">
                              📍 {tr(loc, 30)}
                            </span>
                          )}
                          {r.isp && (
                            <span className="inline-flex items-center gap-1 text-[11px] bg-gray-50 border border-gray-200 rounded-lg px-2 py-0.5 text-gray-600">
                              📶 {tr(r.isp as string, 28)}
                            </span>
                          )}
                          {r.p2PNetwork && (
                            <span className="inline-flex items-center gap-1 text-[11px] bg-blue-50 border border-blue-100 rounded-lg px-2 py-0.5 text-blue-600">
                              🔗 {r.p2PNetwork}
                            </span>
                          )}
                          {r.size && (
                            <span className="inline-flex items-center gap-1 text-[11px] bg-gray-50 border border-gray-200 rounded-lg px-2 py-0.5 text-gray-600">
                              💾 {r.size}
                            </span>
                          )}
                        </div>
                        {r.torrentFileName && (
                          <div className="text-[12px] font-semibold mb-1" style={{ color: '#FC934C' }}>
                            🧲 {tr(r.torrentFileName as string, 60)}
                          </div>
                        )}
                        {r.infohash && (
                          <div className="text-[11px] text-gray-400 font-mono mb-0.5">
                            🔑 {tr(r.infohash as string, 48)}
                          </div>
                        )}
                        {r.dateAdded && (
                          <div className="text-[11px] text-gray-400">
                            🕐 {fmt(r.dateAdded)}
                          </div>
                        )}
                      </div>

                      {/* Right */}
                      <div className="flex-shrink-0 flex flex-col items-end gap-2 sm:gap-3">
                        <StatusPill status={r.torrentStatus} />
                        <button
                          onClick={e => { e.stopPropagation(); setModal(r) }}
                          className="px-2 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-bold text-white transition-all hover:opacity-90 whitespace-nowrap"
                          style={{ background: 'linear-gradient(135deg,#FC934C,#e8832a)' }}>
                          <span className="hidden sm:inline">View Details</span>
                          <span className="sm:hidden">Details</span>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Pagination */}
            {totalPagesLocal > 1 && (
              <div className="mt-5 flex items-center justify-between flex-wrap gap-3">
                <span className="text-xs text-gray-400">
                  Showing {pageStart + 1}–{Math.min(filtered.length, pageStart + PER)} of {filtered.length.toLocaleString()}
                </span>
                {renderPagination()}
              </div>
            )}
          </div>
        )}
      </div>
      </div>

    </div>

    {/* ══ MODAL — outside fade-in so fixed positioning works correctly ══ */}
    {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/50 backdrop-blur-sm"
          onClick={() => setModal(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col overflow-hidden"
            style={{ maxHeight: 'calc(100vh - 80px)' }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4 flex-shrink-0"
              style={{ background: 'linear-gradient(135deg,#0f1f40,#14254A)' }}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: '#FC934C' }}>
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-white font-mono text-base leading-tight">{modal.ip || 'IP Record'}</div>
                <div className="text-white/40 text-xs truncate mt-0.5">
                  {[modal.assetTitle || modal.assetName, modal.p2PNetwork, modal.country].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button onClick={() => copyText(modal.ip || '')}
                  className="text-xs px-2.5 py-1.5 rounded-lg font-semibold border border-white/20 text-white/80 hover:bg-white/10 transition-all">
                  {copied === modal.ip ? '✓ Copied' : 'Copy IP'}
                </button>
                {modal.infohash && (
                  <button onClick={() => copyText(modal.infohash || '')}
                    className="text-xs px-2.5 py-1.5 rounded-lg font-semibold border border-white/20 text-white/80 hover:bg-white/10 transition-all">
                    {copied === modal.infohash ? '✓ Copied' : 'Copy Hash'}
                  </button>
                )}
                {modal.torrentUrl && (
                  <a href={modal.torrentUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs px-2.5 py-1.5 rounded-lg font-semibold border border-white/20 text-white/80 hover:bg-white/10 transition-all">
                    Open Torrent
                  </a>
                )}
                <button onClick={() => setModal(null)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-all ml-1">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Stats strip */}
            <div className="grid grid-cols-5 border-b border-gray-100 flex-shrink-0">
              {([
                ['Status',   <StatusPill key="s" status={modal.torrentStatus} />],
                ['Network',  va(modal.p2PNetwork)],
                ['Country',  `${COUNTRY_CODES[modal.country || ''] || ''} ${modal.country || '—'}`.trim()],
                ['Size',     va(modal.size)],
                ['Date Added', modal.dateAdded ? fmt(modal.dateAdded) : '—'],
              ] as [string, React.ReactNode][]).map(([l, v]) => (
                <div key={l as string} className="px-4 py-3 flex flex-col gap-0.5 border-r border-gray-100 last:border-0">
                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{l as string}</div>
                  <div className="font-semibold text-sm text-gray-800">{typeof v === 'string' ? v : v}</div>
                </div>
              ))}
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 min-h-0 p-5">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                {/* IP & Location */}
                <div className="bg-gray-50 rounded-xl border border-gray-100 p-4">
                  <div className="flex items-center gap-2 mb-3 pb-2.5 border-b border-gray-200">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#FC934C' }}>
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
                      </svg>
                    </div>
                    <h3 className="font-bold text-[#14254A] text-sm">IP &amp; Location</h3>
                  </div>

                  <div className="rounded-lg px-3 py-2.5 mb-3 cursor-pointer flex items-center justify-between"
                    style={{ background: '#14254A' }} onClick={() => copyText(modal.ip || '')} title="Click to copy">
                    <span className="font-mono font-bold text-white text-sm">{modal.ip || '—'}{modal.port ? `:${modal.port}` : ''}</span>
                    <span className="text-white/40 text-[10px]">click to copy</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {[['Country', va(modal.country)], ['City', va(modal.city)], ['State', va(modal.state)], ['Continent', va(modal.continent)], ['ISP', va(modal.isp)], ['Organization', va(modal.organization)], ['AS Number', va(modal.asNumber)], ['Currency', va(modal.currency)]].map(([lbl, val]) => (
                      <div key={lbl as string} className={lbl === 'ISP' || lbl === 'Organization' ? 'col-span-2' : ''}>
                        <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">{lbl as string}</div>
                        <div className="bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-700 truncate">{val as string}</div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-gray-200 flex gap-4 text-xs">
                    {[['Mobile', modal.mobile], ['Proxy', modal.proxy], ['Hosting', modal.hosting]].map(([lbl, val]) => (
                      <span key={lbl as string} className="text-gray-500">
                        {lbl as string}:{' '}
                        <strong className={String(val || '').toLowerCase() === 'yes' ? 'text-emerald-600' : 'text-gray-400'}>
                          {String(val || '').toLowerCase() === 'yes' ? 'Yes' : 'No'}
                        </strong>
                      </span>
                    ))}
                  </div>
                </div>

                {/* Torrent Information */}
                <div className="bg-gray-50 rounded-xl border border-gray-100 p-4">
                  <div className="flex items-center gap-2 mb-3 pb-2.5 border-b border-gray-200">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#FC934C' }}>
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
                      </svg>
                    </div>
                    <h3 className="font-bold text-[#14254A] text-sm">Torrent Information</h3>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {[['Asset', va(modal.assetTitle || modal.assetName)], ['File Name', va(modal.torrentFileName)], ['P2P Network', va(modal.p2PNetwork)], ['Status', va(modal.torrentStatus)], ['Client', va(modal.torrentClient)], ['Size', va(modal.size)], ['Piece Length', va(modal.pieceLength)], ['Total Pieces', va(modal.totalPieces)], ['Has Pieces', va(modal.hasPieces)], ['Capture Updated', modal.captureDetailsUpdatedOn ? fmt(modal.captureDetailsUpdatedOn) : '—']].map(([lbl, val]) => (
                      <div key={lbl as string} className={lbl === 'Asset' || lbl === 'File Name' ? 'col-span-2' : ''}>
                        <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">{lbl as string}</div>
                        <div className="bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-700 truncate">{val as string}</div>
                      </div>
                    ))}
                  </div>

                  {modal.infohash && (
                    <div className="mt-2 text-xs">
                      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Infohash</div>
                      <div className="bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 font-mono text-gray-600 truncate cursor-pointer hover:border-orange-300 hover:bg-orange-50/50 transition-colors"
                        onClick={() => copyText(modal.infohash || '')} title="Click to copy">
                        {modal.infohash}
                      </div>
                    </div>
                  )}
                  {modal.torrentUrl && (
                    <div className="mt-2 text-xs">
                      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Torrent URL</div>
                      <a href={modal.torrentUrl} target="_blank" rel="noopener noreferrer"
                        className="block bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-blue-600 hover:underline truncate font-mono">
                        {modal.torrentUrl}
                      </a>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

    {/* Toast */}
    {copied && (
      <div className="fixed bottom-6 right-6 z-[60] bg-emerald-600 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2">
        ✓ Copied!
      </div>
    )}
    </>
  )
}
