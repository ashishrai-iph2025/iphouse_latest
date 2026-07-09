'use client'

import { useEffect, useRef, useState } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import MultiSearchableSelect from '@/components/ui/MultiSearchableSelect'
import DatePicker from '@/components/ui/DatePicker'
import Breadcrumb from '@/components/ui/Breadcrumb'
import WarRoomReport from '@/components/shared/WarRoomReport'
import {
  streamWarRoom, fetchWarRoom, fetchWarRoomClients, fetchWarRoomClientToken,
  type WarRoomReport as Report, type WarRoomRow, type WarRoomMeta,
  type ClientOption, type WarRoomProgressEvent,
} from '@/lib/warroom'

// Mirrors go-server/markscan/warroom.go's warRoomPlatforms + PlatformLabels, so
// the loader can list every platform up front (as "pending") before any progress
// events arrive.
const WAR_ROOM_PLATFORMS: { key: string; label: string }[] = [
  { key: 'facebook', label: 'Facebook' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'twitter', label: 'X (Twitter)' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'internet', label: 'Open Web' },
  { key: 'ugc and other social media', label: 'UGC & Other' },
  { key: 'i-tunes', label: 'iTunes' },
  { key: 'play store', label: 'Play Store' },
  { key: 'third party app', label: 'Third-Party App' },
  { key: 'third party mobile app', label: 'Third-Party Mobile' },
]

type PlatformProgress = { phase: 'pending' | 'start' | 'done' | 'error'; count: number; error?: string }
import { useMasterData } from '@/lib/masterDataContext'
import { useSession } from '@/lib/auth-client'

// Brand colors. NAVY_TEXT/ORANGE_TEXT read CSS vars (globals.css) that flip
// for dark-mode contrast — see the comment there for why plain hex can't be
// used directly for text painted via inline style.
const NAVY_TEXT = 'var(--wr-navy-text)'
const ORANGE_TEXT = 'var(--wr-orange-text)'
const ORANGE_GRADIENT = 'linear-gradient(135deg,#FFC82B,#FC934C)'

interface Opt { key: string; label: string }

function isoDaysAgo(n: number) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10)
}

export default function WarRoomPage({ area = 'War Room', admin: adminProp = false }: { area?: string; admin?: boolean }) {
  // Auto-elevate to admin mode if the logged-in user has role >= 1, regardless
  // of which route loaded this page. An admin visiting /war-room must pick a
  // client and generate their token — their own MarkScan account has different
  // (usually fewer) assets than a client account.
  const { data: session } = useSession()
  const admin = adminProp || ((session?.user?.role ?? null) !== null && (session?.user?.role ?? 0) >= 1)

  const [assets, setAssets] = useState<Opt[]>([])
  const [assetNames, setAssetNames] = useState<string[]>([])
  const [assetTouched, setAssetTouched] = useState(false)
  const [startDate, setStartDate] = useState(isoDaysAgo(30))
  const [endDate, setEndDate] = useState('')

  // Admin-only client selection + token state.
  const [clients, setClients] = useState<ClientOption[]>([])
  const [clientId, setClientId] = useState('')
  const [tokenReady, setTokenReady] = useState(false)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenMsg, setTokenMsg] = useState('')

  const [report, setReport] = useState<Report | null>(null)
  const [rows, setRows] = useState<WarRoomRow[]>([])
  const [meta, setMeta] = useState<WarRoomMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [platformProgress, setPlatformProgress] = useState<Record<string, PlatformProgress>>({})

  // Client mode: use the MasterDataContext already loaded by ClientShell —
  // same source as infringement, reports, and every other client page.
  // In admin mode assets come from the per-client token step instead.
  const { assets: ctxAssets } = useMasterData()
  useEffect(() => {
    if (admin) return
    if (ctxAssets.length > 0) setAssets(ctxAssets)
  }, [admin, ctxAssets])

  // Admin: load client list on mount.
  useEffect(() => {
    if (!admin) return
    fetchWarRoomClients().then(setClients).catch(() => setClients([]))
  }, [admin])

  const clientOpts: Opt[] = clients.map(c => ({ key: String(c.userId), label: c.name }))
  const clientUserId = admin && clientId ? Number(clientId) : undefined

  function onClientChange(v: string) {
    setClientId(v)
    setTokenReady(false); setTokenMsg(''); setAssets([]); setAssetNames([]); setAssetTouched(false)
    setReport(null); setRows([]); setMeta(null); setFiltersOpen(true)
  }

  async function generateToken() {
    if (!clientId) { setTokenMsg('Select a client first'); return }
    setTokenBusy(true); setTokenMsg(''); setError('')
    try {
      const list = await fetchWarRoomClientToken(Number(clientId))
      setAssets(list); setTokenReady(true)
      setTokenMsg(`Token generated · ${list.length} assets`)
    } catch (e: any) {
      setTokenReady(false); setTokenMsg(e.message || 'Failed to generate token')
    } finally {
      setTokenBusy(false)
    }
  }

  async function run(mode: 'auto' | 'full' | 'incremental', opts?: { silent?: boolean }) {
    if (admin && !tokenReady) { if (!opts?.silent) setError('Generate the client token first'); return }
    if (!opts?.silent) setAssetTouched(true)
    if (assetNames.length === 0) { if (!opts?.silent) setError('Please select at least one asset'); return }
    if (mode !== 'incremental' && !startDate) { setError('Please pick a start date'); return }
    setError('')
    setPlatformProgress(Object.fromEntries(WAR_ROOM_PLATFORMS.map(p => [p.key, { phase: 'pending', count: 0 }])))
    mode === 'incremental' ? setRefreshing(true) : setLoading(true)
    try {
      let res
      try {
        res = await streamWarRoom({ assetNames, startDate, endDate, mode, clientUserId }, (evt: WarRoomProgressEvent) => {
          setPlatformProgress(prev => ({
            ...prev,
            [evt.platform]: { phase: evt.error ? 'error' : evt.phase, count: evt.count, error: evt.error },
          }))
        })
      } catch {
        // The SSE stream can get cut mid-flight (idle-killed connection,
        // flaky network) even though the server finishes the pull and stores
        // everything in Redis. One plain (non-stream) retry then serves the
        // report straight from the accumulated store instead of surfacing a
        // bare "network error".
        res = await fetchWarRoom({ assetNames, startDate, endDate, mode: 'incremental', clientUserId })
      }
      setReport(res.data); setRows(res.rows); setMeta(res.meta)
      setFiltersOpen(false)
    } catch (e: any) {
      if (!opts?.silent) setError(e.message || 'Failed to load report')
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }

  // Auto-refresh: once a report is on screen, silently pull incremental
  // (updatedSince) data every 5 minutes so new/changed rows keep flowing in
  // without the user re-clicking Generate. Skipped while a fetch is running.
  const autoRef = useRef({ run, report, loading, refreshing })
  autoRef.current = { run, report, loading, refreshing }
  useEffect(() => {
    const t = setInterval(() => {
      const a = autoRef.current
      if (a.report && !a.loading && !a.refreshing) a.run('incremental', { silent: true })
    }, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  const assetDisabled = admin && !tokenReady
  const assetInvalid = assetTouched && assetNames.length === 0

  return (
    <>
      {/* On very wide screens the centered max-w-[1680px] column leaves blank
          gutters either side — filled with a fixed, viewport-anchored "WAR ROOM"
          brand strip instead of empty space. position:fixed (not sticky) keeps
          it pinned to the exact same spot regardless of page scroll or content
          height. Each label's own width is exactly the gutter width
          (50vw - half the box width), right/left-aligned with a small inner
          padding, so the text always sits close to the box edge — not the
          screen edge — no matter how wide the viewport gets. Hidden below the
          width where gutters exist. */}
      <div className="hidden min-[1800px]:flex fixed left-0 top-1/2 -translate-y-1/2 z-0 items-center justify-end pr-4 pointer-events-none select-none"
        style={{ width: 'calc(50% - 840px)' }} aria-hidden>
        <span className="whitespace-nowrap uppercase text-xl font-bold tracking-[0.4em]"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
          <span style={{ color: NAVY_TEXT }}>War</span>{' '}
          <span style={{ backgroundImage: ORANGE_GRADIENT, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>Room</span>
        </span>
      </div>
      <div className="hidden min-[1800px]:flex fixed right-0 top-1/2 -translate-y-1/2 z-0 items-center justify-start pl-4 pointer-events-none select-none"
        style={{ width: 'calc(50% - 840px)' }} aria-hidden>
        <span className="whitespace-nowrap uppercase text-xl font-bold tracking-[0.4em]" style={{ writingMode: 'vertical-rl' }}>
          <span style={{ color: NAVY_TEXT }}>War</span>{' '}
          <span style={{ backgroundImage: ORANGE_GRADIENT, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>Room</span>
        </span>
      </div>

      {/* The client shell already pads its content; the admin shell does not, so in
          admin mode the page supplies its own gap from the sidebar and screen edges. */}
      <div className="fade-in w-full max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 sm:mb-6">
        <Breadcrumb items={[{ label: area }, { label: 'War Room' }]} />
        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A]">War Room</h1>
          <p className="text-brand-muted text-sm">Cross-platform anti-piracy intelligence for an asset.</p>
        </div>
      </div>

      {/* Controls — collapses to a summary bar once a report is generated */}
      <div className="relative bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden mb-6">
        <div className="h-1" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />

        {/* ── Collapsed summary bar ── */}
        {!filtersOpen && report ? (
          <div className="px-5 py-3 flex items-center gap-3 flex-wrap">
            <div className="flex-1 flex items-center gap-2 text-sm min-w-0 flex-wrap">
              <span className="font-bold text-[#14254A] truncate max-w-[260px]">
                {assetNames.length === 1 ? assetNames[0] : `${assetNames[0]} +${assetNames.length - 1} more`}
              </span>
              {startDate && (
                <><span className="text-gray-300">·</span>
                <span className="text-gray-500 text-xs">{startDate}{endDate ? ` → ${endDate}` : ''}</span></>
              )}
              {meta && (
                <><span className="text-gray-300">·</span>
                <span className="text-gray-400 text-xs">{meta.rowCount.toLocaleString()} rows · {meta.source}</span></>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => run('incremental')} disabled={loading || refreshing}
                className="px-3 py-1.5 rounded-lg font-bold text-xs border-2 disabled:opacity-60 transition-all flex items-center gap-1.5 whitespace-nowrap"
                style={{ borderColor: '#FC934C', color: ORANGE_TEXT }}>
                {refreshing
                  ? <><span className="w-3 h-3 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" /> Refreshing…</>
                  : <>↻ Refresh</>}
              </button>
              <button onClick={() => setFiltersOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-colors whitespace-nowrap"
                style={{ borderColor: NAVY_TEXT, color: NAVY_TEXT }}>
                <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Change filters
              </button>
            </div>
          </div>
        ) : (
          /* ── Full expanded form ── */
          <div className="p-5 sm:p-6">
            {/* Collapse button — only when report already exists */}
            {report && (
              <button onClick={() => setFiltersOpen(false)} title="Hide filters"
                className="absolute top-3 right-4 w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors text-base leading-none">
                ✕
              </button>
            )}

            {error && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-2.5 text-sm mb-4">
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                {error}
              </div>
            )}

            {/* Admin: client + token row */}
            {admin && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end gap-3 lg:gap-4 mb-4 pb-4 border-b border-gray-100">
                <div className="sm:col-span-1 lg:flex-[2] lg:min-w-[220px]">
                  <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Client *</label>
                  <SearchableSelect options={clientOpts} value={clientId} onChange={onClientChange} placeholder="Select client…" emptyLabel="– Select client –" />
                </div>
                <div className="lg:flex-shrink-0">
                  <button onClick={generateToken} disabled={!clientId || tokenBusy}
                    className="w-full lg:w-auto px-5 py-2.5 rounded-xl font-bold text-sm border-2 disabled:opacity-60 transition-all flex items-center justify-center gap-2 whitespace-nowrap"
                    style={{ borderColor: NAVY_TEXT, color: NAVY_TEXT }}>
                    {tokenBusy ? <><span className="w-4 h-4 border-2 border-[#14254A]/30 border-t-[#14254A] rounded-full animate-spin" /> Generating…</>
                      : tokenReady ? <>✓ Token ready — regenerate</> : <>🔑 Generate token</>}
                  </button>
                </div>
                {tokenMsg && (
                  <div className={`text-xs font-semibold self-center ${tokenReady ? 'text-green-600' : 'text-red-600'}`}>{tokenMsg}</div>
                )}
              </div>
            )}

            {/* Asset + dates + generate */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end gap-3 lg:gap-4">
              <div className={`sm:col-span-1 lg:flex-[2] lg:min-w-[220px] ${assetDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Asset <span className="text-red-500">*</span>
                </label>
                <MultiSearchableSelect
                  options={assets}
                  values={assetNames}
                  onChange={v => { setAssetNames(v); setAssetTouched(true) }}
                  placeholder={assetDisabled ? 'Generate a token first…' : 'Select assets…'}
                  disabled={assetDisabled}
                  invalid={assetInvalid}
                />
                {assetInvalid && (
                  <p className="text-red-500 text-[11px] mt-1">At least one asset is required</p>
                )}
              </div>
              <div className="lg:flex-1 lg:min-w-[150px]">
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Start Date *</label>
                <DatePicker value={startDate} onChange={setStartDate} placeholder="Start date" />
              </div>
              <div className="lg:flex-1 lg:min-w-[150px]">
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">End Date</label>
                <DatePicker value={endDate} onChange={setEndDate} placeholder="Optional" min={startDate} />
              </div>
              <div className="sm:col-span-2 lg:flex-shrink-0 flex gap-2">
                <button onClick={() => run('auto')} disabled={loading || refreshing || assetDisabled}
                  className="flex-1 lg:flex-none px-6 py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 flex items-center justify-center gap-2 whitespace-nowrap shadow-sm"
                  style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                  {loading ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Generating…</> : <>Generate</>}
                </button>
              </div>
            </div>

            {meta && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-4 text-[11px] text-gray-400">
                <span>Store: <b className="text-gray-600">{meta.source}</b></span>
                <span>Rows stored: <b className="text-gray-600">{meta.rowCount.toLocaleString()}</b></span>
                {meta.displayCount !== undefined && (
                  <span>Rows shown: <b className="text-gray-600">{meta.displayCount.toLocaleString()}</b></span>
                )}
                <span>Last pull ({meta.mode}): <b className="text-gray-600">+{meta.pulledNow.toLocaleString()}</b></span>
                <span>Updated: <b className="text-gray-600">{new Date(meta.lastFetch).toLocaleString()}</b></span>
              </div>
            )}

            {/* Live per-platform progress — stays inside this controls box,
                doesn't take over the page body below. */}
            {loading && <PlatformLoader progress={platformProgress} />}
          </div>
        )}
      </div>

      {/* Report / empty state */}
      {!report && !loading && (
        <div className="text-center py-16 bg-white rounded-2xl border border-dashed border-gray-200">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl grid place-items-center bg-[#14254A]/5 text-[#14254A]">
            <svg width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
          </div>
          <h2 className="text-lg font-bold text-[#14254A] mb-1">No report yet</h2>
          <p className="text-sm text-gray-400">
            {admin ? 'Select a client, generate its token, pick an asset and start date, then Generate.'
              : 'Pick an asset and start date, then Generate. Click any bar to cross-filter.'}
          </p>
        </div>
      )}
      {report && !loading && <WarRoomReport report={report} rows={rows} admin={admin} />}
      </div>
    </>
  )
}

/* ── Live per-platform loader — shown while Generate is fanning out across
   every MarkScan endpoint, reflecting each platform's real fetch state. ───── */
function PlatformLoader({ progress }: { progress: Record<string, PlatformProgress> }) {
  const done  = Object.values(progress).filter(p => p.phase === 'done' || p.phase === 'error').length
  const total = WAR_ROOM_PLATFORMS.length

  return (
    <div className="mt-4 pt-4 border-t border-gray-100">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-[#14254A]">Fetching across platforms…</h2>
          <p className="text-xs text-gray-400 mt-0.5">Pulling and aggregating data from every endpoint in real time.</p>
        </div>
        <div className="text-xs font-bold text-gray-400">{done} / {total}</div>
      </div>

      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mb-4">
        <div className="h-full rounded-full transition-all duration-300"
          style={{ width: `${total ? (done / total) * 100 : 0}%`, background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {WAR_ROOM_PLATFORMS.map(p => {
          const st = progress[p.key]?.phase ?? 'pending'
          const count = progress[p.key]?.count ?? 0
          const errMsg = progress[p.key]?.error
          return (
            <div key={p.key} title={errMsg}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-sm transition-colors ${
                st === 'error' ? 'border-red-200 bg-red-50'
                : st === 'done' ? 'border-green-200 bg-green-50/60'
                : st === 'start' ? 'border-[#FC934C]/40 bg-orange-50/50'
                : 'border-gray-100 bg-gray-50/50'
              }`}>
              <span className="w-4 h-4 flex-shrink-0 grid place-items-center">
                {st === 'pending' && <span className="w-2 h-2 rounded-full bg-gray-300" />}
                {st === 'start' && <span className="w-3.5 h-3.5 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />}
                {st === 'done' && <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#16a34a" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                {st === 'error' && <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#dc2626" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>}
              </span>
              <span className={`flex-1 truncate font-semibold ${
                st === 'pending' ? 'text-gray-400' : 'text-[#14254A]'
              }`}>{p.label}</span>
              {st === 'done' && <span className="text-xs font-bold text-gray-400 flex-shrink-0">{count.toLocaleString()}</span>}
              {st === 'error' && (
                <span className="text-[10px] font-bold text-red-500 flex-shrink-0 truncate max-w-[110px]">
                  {errMsg || 'failed'}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
