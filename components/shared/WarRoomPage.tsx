'use client'

import { useEffect, useRef, useState } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import MultiSearchableSelect from '@/components/ui/MultiSearchableSelect'
import DatePicker from '@/components/ui/DatePicker'
import Breadcrumb from '@/components/ui/Breadcrumb'
import WarRoomReport from '@/components/shared/WarRoomReport'
import WarRoomComparison from '@/components/shared/WarRoomComparison'
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

interface Opt { key: string; label: string; warRoomEndDate?: string }

function isoDaysAgo(n: number) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10)
}

// Default asset when landing on the page: the only asset if there is just one,
// otherwise the asset with the latest warRoomEndDate (assets without an end
// date sort last). ISO datetimes compare correctly as strings.
function pickDefaultAsset(list: Opt[]): string | null {
  if (list.length === 0) return null
  if (list.length === 1) return list[0].key
  const sorted = [...list].sort((a, b) =>
    String(b.warRoomEndDate ?? '').localeCompare(String(a.warRoomEndDate ?? '')))
  return sorted[0].key
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

  // Tabs: single-asset dashboard vs multi-asset comparison. The comparison tab
  // only appears when the account has more than one asset; it is mounted
  // lazily on first visit and then kept alive so its results survive
  // switching back and forth.
  const [view, setView] = useState<'dashboard' | 'comparison'>('dashboard')
  const [comparisonVisited, setComparisonVisited] = useState(false)

  // Client mode: the asset dropdown lists only War Room assets (MarkScan
  // GetAllWarRoomAssets, asset names only) via /api/warroom/assets. A
  // successful-but-empty list is authoritative (MarkScan has no war-room
  // assets for this client) — the master-data fallback applies only when the
  // request itself fails. In admin mode assets come from the token step.
  const { assets: ctxAssets } = useMasterData()
  const [wrAssetsFailed, setWrAssetsFailed] = useState(false)
  const [wrAssetsEmpty, setWrAssetsEmpty] = useState(false)
  // Per-client flag managed on /admin/war-room-assets: clients only get the
  // Asset Comparison tab when an admin has enabled it for their account.
  const [comparisonEnabled, setComparisonEnabled] = useState(false)
  // Auto-load on navigation: once the war-room asset list arrives, pre-select
  // the default asset (single asset, or latest warRoomEndDate) and generate
  // its dashboard without the user clicking anything.
  const [autoRunArmed, setAutoRunArmed] = useState(false)
  const autoRanRef = useRef(false)
  useEffect(() => {
    if (admin) return
    let alive = true
    fetch('/api/warroom/assets', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!alive) return
        setComparisonEnabled(!!d.comparisonEnabled)
        if (d.success && Array.isArray(d.assets)) {
          setAssets(d.assets)
          setWrAssetsEmpty(d.assets.length === 0)
          const def = pickDefaultAsset(d.assets)
          if (def && !autoRanRef.current) {
            setAssetNames(prev => (prev.length > 0 ? prev : [def]))
            setAutoRunArmed(true)
          }
        }
        else setWrAssetsFailed(true)
      })
      .catch(() => { if (alive) setWrAssetsFailed(true) })
    return () => { alive = false }
  }, [admin])
  useEffect(() => {
    if (admin || !wrAssetsFailed) return
    if (ctxAssets.length > 0) setAssets(ctxAssets)
  }, [admin, wrAssetsFailed, ctxAssets])

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

  // Fire the auto-load exactly once, on the render after the default asset
  // selection was committed (run() reads assetNames from state). Skipped if
  // the user already generated something or a fetch is in flight.
  useEffect(() => {
    if (admin || !autoRunArmed || autoRanRef.current) return
    if (assetNames.length === 0 || loading || refreshing || report) return
    autoRanRef.current = true
    run('auto', { silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, autoRunArmed, assetNames])

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

      {/* Tab switcher — comparison needs 2+ assets, and for clients it must
          also be enabled per client on /admin/war-room-assets. */}
      {assets.length > 1 && (admin || comparisonEnabled) && (
        <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit mb-5">
          {([
            { key: 'dashboard',  label: '📊 Dashboard' },
            { key: 'comparison', label: '⚖ Asset Comparison' },
          ] as const).map(t => (
            <button key={t.key}
              onClick={() => { setView(t.key); if (t.key === 'comparison') setComparisonVisited(true) }}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${view === t.key ? 'bg-white shadow text-[#14254A]' : 'text-gray-500 hover:text-gray-700'}`}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Dashboard view (kept mounted so its report survives tab switches) ── */}
      <div className={view === 'dashboard' ? '' : 'hidden'}>

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
                <span className="text-gray-400 text-xs">{meta.rowCount.toLocaleString()} rows</span></>
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
                  placeholder={assetDisabled ? 'Generate a token first…'
                    : (!admin && wrAssetsEmpty) ? 'No War Room assets available' : 'Select assets…'}
                  disabled={assetDisabled}
                  invalid={assetInvalid}
                />
                {!admin && wrAssetsEmpty && (
                  <p className="text-[11px] mt-1 text-gray-400">
                    No assets are currently flagged for the War Room on your account. Please contact the <b className="text-[#FC934C]">IP House team</b> to enable War Room monitoring for your titles.
                  </p>
                )}
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

      </div>{/* end dashboard view */}

      {/* ── Comparison view ── */}
      {(comparisonVisited || view === 'comparison') && assets.length > 1 && (admin || comparisonEnabled) && (
        <div className={view === 'comparison' ? '' : 'hidden'}>
          <WarRoomComparison
            assets={assets}
            defaultStart={startDate}
            defaultEnd={endDate}
            clientUserId={clientUserId}
          />
        </div>
      )}
      </div>
    </>
  )
}

/* ── Live per-platform loader — shown while Generate is fanning out across
   every MarkScan endpoint. A compact, professional treatment: progress ring +
   status line + slim gradient bar, with one small pill chip per platform. ── */
function PlatformLoader({ progress }: { progress: Record<string, PlatformProgress> }) {
  const entries = WAR_ROOM_PLATFORMS.map(p => ({
    ...p,
    st:    progress[p.key]?.phase ?? 'pending',
    count: progress[p.key]?.count ?? 0,
    error: progress[p.key]?.error,
  }))
  const total     = entries.length
  const done      = entries.filter(e => e.st === 'done' || e.st === 'error').length
  const pctDone   = total ? Math.round((done / total) * 100) : 0
  const active    = entries.filter(e => e.st === 'start')
  const rowsSoFar = entries.reduce((n, e) => n + (e.st === 'done' ? e.count : 0), 0)
  const finishing = done === total

  return (
    <div className="mt-4 pt-5 border-t border-gray-100">
      <div className="flex items-center gap-5">
        {/* Progress ring */}
        <div className="relative w-[74px] h-[74px] flex-shrink-0 rounded-full grid place-items-center transition-all"
          style={{ background: `conic-gradient(#FC934C ${Math.max(pctDone, 2)}%, #eef1f5 0)` }}>
          <div className="w-[58px] h-[58px] rounded-full bg-white dark:bg-[#1a2d55] grid place-items-center">
            <span className="text-sm font-extrabold" style={{ color: NAVY_TEXT }}>{pctDone}%</span>
          </div>
        </div>

        {/* Status line + slim bar */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-bold truncate" style={{ color: NAVY_TEXT }}>
              {finishing ? 'Finalizing report…' : 'Generating report'}
            </h2>
            <span className="text-[11px] font-bold text-gray-400 flex-shrink-0">{done} / {total} platforms</span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5 truncate">
            {finishing
              ? 'Aggregating cross-platform intelligence…'
              : active.length > 0
                ? <>Scanning <b className="text-gray-500">{active.map(a => a.label).join(', ')}</b></>
                : 'Contacting MarkScan endpoints…'}
            {rowsSoFar > 0 && <> · {rowsSoFar.toLocaleString()} rows collected</>}
          </p>
          <div className="relative h-1 rounded-full bg-gray-100 overflow-hidden mt-2.5">
            <div className="h-full rounded-full transition-all duration-500 ease-out"
              style={{ width: `${Math.max(pctDone, 3)}%`, background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />
            <div className="absolute inset-y-0 w-16 animate-pulse rounded-full"
              style={{ left: `calc(${Math.max(pctDone, 3)}% - 4rem)`, background: 'linear-gradient(90deg,transparent,rgba(255,255,255,0.55))' }} />
          </div>
        </div>
      </div>

      {/* Platform chips */}
      <div className="flex flex-wrap gap-1.5 mt-4">
        {entries.map(e => (
          <span key={e.key} title={e.error ?? (e.st === 'done' ? `${e.count.toLocaleString()} rows` : undefined)}
            className={`inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full border text-[11px] font-semibold transition-all duration-300 ${
              e.st === 'error' ? 'border-red-200 bg-red-50 text-red-500'
              : e.st === 'done' ? 'border-emerald-200/70 bg-emerald-50/70 text-emerald-700'
              : e.st === 'start' ? 'border-[#FC934C]/50 bg-orange-50/70 text-[#d97b2e]'
              : 'border-gray-200/70 bg-gray-50/60 text-gray-400'
            }`}>
            <span className="relative w-2 h-2 grid place-items-center flex-shrink-0">
              {e.st === 'start' && <span className="absolute inline-flex w-2 h-2 rounded-full bg-orange-400 opacity-60 animate-ping" />}
              <span className={`relative w-1.5 h-1.5 rounded-full ${
                e.st === 'error' ? 'bg-red-400'
                : e.st === 'done' ? 'bg-emerald-500'
                : e.st === 'start' ? 'bg-orange-500'
                : 'bg-gray-300'
              }`} />
            </span>
            {e.label}
            {e.st === 'done' && e.count > 0 && (
              <span className="font-bold opacity-60">{e.count.toLocaleString()}</span>
            )}
            {e.st === 'error' && <span className="font-bold">✕</span>}
          </span>
        ))}
      </div>
    </div>
  )
}
