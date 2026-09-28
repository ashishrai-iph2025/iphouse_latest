'use client'

// Traffic Analysis and Torrent Analysis on the Cache & Redis tab.
//
// Both are computed by reports_api and cached in reports_api's OWN Redis
// (reports_redis, on the reports API server) — not the portal's. The portal
// never connects to it, so this panel reads and steers those entries through
// the reports API (handlers/admin/analyticscache.go). Same four questions as
// the portal's panel: is it connected, is it doing any good, what is in it,
// how do I refresh it.

import { useEffect, useMemo, useState } from 'react'
import CachePeriodForm, { Progress, type PeriodRequest } from './cache/CachePeriodForm'

interface Entry {
  key: string; clientId: string; clientName: string; view: string; detail: string
  bytes: number; ttlSeconds: number; current: boolean
}
interface Scope {
  error?: string
  redis?: boolean; redisAddr?: string; dataVersion?: string
  counters?: { fromMemory: number; fromRedis: number; computed: number; prepared: number; hitRatePct: number | null }
  totals?: { entries: number; clients: number; bytes: number; previousVersion: number }
  entries?: Entry[]
  prepared?: { at?: string; clients?: number; running?: boolean }
  versionFrom?: { inf?: string; src?: string; sw?: number }
  versionSeenAt?: string
  recentClients?: number
  running?: number
  onDemand?: { period: string; windows: string[]; total: number; done: number; ready: number; running: boolean
    startedAt: string; finishedAt: string; clients: number } | null
}

const kb = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
const left = (s: number) => (s < 0 ? '—' : s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
  : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`)
const when = (v?: string) => (!v || v.startsWith('0001') ? '—' : new Date(v).toLocaleString())

/*
AnalyticsSection is ONE scope's card — the Traffic or Torrent tab of "Cache by
report". Same data as the panel below, with the cache-on-demand form.
*/
export function AnalyticsSection({ scope }: { scope: 'traffic' | 'torrent' }) {
  const [s, setS] = useState<Scope | undefined>()
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [clients, setClients] = useState<{ key: string; label: string }[]>([])

  async function load() {
    try {
      const r = await fetch('/api/admin/report-cache/analytics', { credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not load'); return }
      setErr(''); setS(j[scope])
    } catch (e: any) { setErr(e?.message || 'Network error') }
  }
  useEffect(() => {
    setS(undefined); load()
    fetch(`/api/admin/${scope === 'traffic' ? 'traffic' : 'torrent'}-analysis/clients`, { credentials: 'include' })
      .then(r => r.json())
      .then(j => setClients((j.clients || []).map((c: any) => ({ key: String(c.id), label: String(c.name || c.id) }))))
      .catch(() => {})
  }, [scope]) // eslint-disable-line react-hooks/exhaustive-deps
  const active = !!(s?.onDemand?.running || s?.prepared?.running || (s?.running ?? 0) > 0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  async function act(sc: 'traffic' | 'torrent', action: 'clear' | 'prepare', period?: PeriodRequest) {
    const name = sc === 'traffic' ? 'Traffic' : 'Torrent'
    if (action === 'clear' && !confirm(`Empty the ${name} Analysis cache? Its reports will be rebuilt from the warehouse on next open.`)) return
    setBusy(sc + action + (period ? 'period' : '')); setMsg(''); setErr('')
    const q = new URLSearchParams({ scope: sc })
    if (period) {
      q.set('clients', period.clientIds.join(','))
      if (period.months) q.set('months', period.months.join(','))
      if (period.from) { q.set('from', period.from); q.set('to', period.to || '') }
    }
    try {
      const r = await fetch(`/api/admin/report-cache/analytics/${action}?${q}`, { credentials: 'include', method: 'POST' })
      const j = await r.json()
      if (!j.success) setErr(j.error || 'Failed')
      else setMsg(action === 'clear'
        ? `${name} Analysis cache emptied — ${j.cleared} entr${j.cleared === 1 ? 'y' : 'ies'} removed.`
        : period ? `${name} Analysis: caching ${j.onDemand?.total ?? ''} view(s) for ${j.onDemand?.period ?? 'the period'} — progress below.`
        : `${name} Analysis default views are being prepared in the background.`)
      await load()
    } catch (e: any) { setErr(e?.message || 'Network error') } finally { setBusy('') }
  }

  if (!s && !err) return <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 text-sm text-gray-500">Loading…</div>
  return (
    <div className="space-y-3">
      {err && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">{err}</p>}
      {msg && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">{msg}</p>}
      <ScopeCard title={scope === 'traffic' ? 'Traffic Analysis' : 'Torrent Analysis'} scope={scope} s={s} busy={busy} act={act}
        clients={clients} />
    </div>
  )
}

export default function AnalyticsCachePanel() {
  const [data, setData] = useState<{ traffic?: Scope; torrent?: Scope } | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  async function load() {
    try {
      const r = await fetch('/api/admin/report-cache/analytics', { credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not load'); return }
      setErr(''); setData(j)
    } catch (e: any) { setErr(e?.message || 'Network error') }
  }
  useEffect(() => { load() }, [])
  // Polled while a preparation or search is running, so the list fills in view.
  const active = !!(data?.traffic?.prepared?.running || (data?.torrent?.running ?? 0) > 0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [active])

  async function act(scope: 'traffic' | 'torrent', action: 'clear' | 'prepare') {
    if (action === 'clear' && !confirm(`Empty the ${scope === 'traffic' ? 'Traffic' : 'Torrent'} Analysis cache? Its reports will be rebuilt from the warehouse on next open.`)) return
    setBusy(scope + action); setMsg('')
    try {
      const r = await fetch(`/api/admin/report-cache/analytics/${action}?scope=${scope}`, { credentials: 'include', method: 'POST' })
      const j = await r.json()
      if (!j.success) setMsg(j.error || 'Failed')
      else setMsg(action === 'clear'
        ? `${scope === 'traffic' ? 'Traffic' : 'Torrent'} Analysis cache emptied — ${j.cleared} entr${j.cleared === 1 ? 'y' : 'ies'} removed.`
        : `${scope === 'traffic' ? 'Traffic' : 'Torrent'} Analysis default views are being prepared in the background.`)
      await load()
    } catch (e: any) { setMsg(e?.message || 'Network error') } finally { setBusy('') }
  }

  return (
    <div className="space-y-3 mt-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-bold text-[#14254A]">Traffic &amp; Torrent Analysis</h2>
        <p className="text-xs text-gray-500">
          Computed by the reports API and cached in its own Redis, each under its own prefix — emptying one never touches the portal&rsquo;s report cache.
        </p>
        <button onClick={load} className="ml-auto text-xs text-[#14254A] hover:underline">Refresh</button>
      </div>
      {err && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">{err}</p>}
      {msg && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">{msg}</p>}
      {!data && !err && <p className="text-sm text-gray-500">Loading…</p>}
      {data && (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
          <ScopeCard title="Traffic Analysis" scope="traffic" s={data.traffic} busy={busy} act={act} />
          <ScopeCard title="Torrent Analysis" scope="torrent" s={data.torrent} busy={busy} act={act} />
        </div>
      )}
    </div>
  )
}

function ScopeCard({ title, scope, s, busy, act, clients }: {
  title: string; scope: 'traffic' | 'torrent'; s?: Scope; busy: string
  act: (scope: 'traffic' | 'torrent', action: 'clear' | 'prepare', period?: PeriodRequest) => void
  clients?: { key: string; label: string }[]
}) {
  const [query, setQuery] = useState('')
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (s?.entries || []).filter(e => !q || e.clientName.toLowerCase().includes(q) || e.detail.toLowerCase().includes(q) || e.view.includes(q))
  }, [s, query])

  if (!s || s.error) {
    return (
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
        <h3 className="font-semibold text-[#14254A]">{title}</h3>
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-3">
          {s?.error || 'No answer from the reports API'} — the report still works, it is just computed every time.
        </p>
      </div>
    )
  }
  const c = s.counters
  const t = s.totals
  const served = (c?.fromMemory ?? 0) + (c?.fromRedis ?? 0)

  return (
    <div className="min-w-0 bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
      <div className="p-6 pb-4">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className={`w-2 h-2 rounded-full ${s.redis ? 'bg-emerald-500' : 'bg-red-400'}`} />
          <h3 className="font-semibold text-[#14254A]">{title} — {s.redis ? 'cache connected' : 'cache not connected'}</h3>
          <span className="text-xs text-gray-500 font-mono">{s.redisAddr || '— no address —'}</span>
          <div className="ml-auto flex gap-2">
            <button onClick={() => act(scope, 'prepare')} disabled={!!busy || !s.redis}
              className="text-xs px-3 py-1.5 rounded-xl bg-[#14254A] text-white disabled:opacity-40">
              {busy === scope + 'prepare' ? 'Starting…' : 'Prepare now'}
            </button>
            <button onClick={() => act(scope, 'clear')} disabled={!!busy || !s.redis}
              className="text-xs px-3 py-1.5 rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40">
              {busy === scope + 'clear' ? 'Emptying…' : 'Empty'}
            </button>
          </div>
        </div>
        {!s.redis && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-4">
            The reports API cannot reach Redis — answers are held in its memory only and lost on restart.
          </p>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            ['Hit rate', c?.hitRatePct == null ? '—' : `${c.hitRatePct.toFixed(1)}%`, 'since the reports API started'],
            ['Served from cache', served.toLocaleString(), `${(c?.fromRedis ?? 0).toLocaleString()} from Redis · ${(c?.fromMemory ?? 0).toLocaleString()} memory`],
            ['Computed', (c?.computed ?? 0).toLocaleString(), `+ ${(c?.prepared ?? 0).toLocaleString()} prepared ahead`],
            ['Cached now', (t?.entries ?? 0).toLocaleString(), `${t?.clients ?? 0} client(s) · ${kb(t?.bytes ?? 0)}`],
          ].map(([k, v, n]) => (
            <div key={k} className="rounded-xl border border-gray-100 p-3">
              <p className="text-[10px] uppercase tracking-wide text-gray-500">{k}</p>
              <p className="text-xl font-bold text-[#14254A]">{v}</p>
              <p className="text-[10px] text-gray-400">{n}</p>
            </div>
          ))}
        </div>

        <p className="text-xs text-gray-500 mt-3 leading-relaxed">
          Data version <span className="font-mono text-gray-700">{s.dataVersion || '—'}</span>
          {scope === 'traffic' && s.versionFrom
            ? <> — domains loaded to {String(s.versionFrom.inf ?? '').slice(0, 10)}, {Number(s.versionFrom.sw ?? 0).toLocaleString()} SimilarWeb rows</>
            : <> — seen {when(s.versionSeenAt)}</>}
          . Entries are kept until new data lands; the version is checked every 10 minutes.
          {' '}Prepared: {s.prepared?.at && !s.prepared.at.startsWith('0001')
            ? <>{s.prepared.clients ?? 0} client(s) at {when(s.prepared.at)}</> : 'not yet for this version'}
          {scope === 'traffic' && <> · {s.recentClients ?? 0} recently opened client(s) kept ready</>}
          {s.prepared?.running && <span className="text-[#FC934C]"> · preparing now</span>}
          {scope === 'torrent' && (s.running ?? 0) > 0 && <span className="text-[#FC934C]"> · {s.running} search(es) running</span>}
          {(t?.previousVersion ?? 0) > 0 && <> · {t!.previousVersion} from an earlier version, left for Redis to evict</>}
        </p>

        {clients && (
          <div className="mt-4 space-y-3">
            <CachePeriodForm clients={clients} busy={busy === scope + 'prepareperiod'}
              onSubmit={req => act(scope, 'prepare', req)}
              unit={scope === 'traffic' ? 'view' : 'search'} perWindow={scope === 'traffic' ? 2 : 1}
              note={scope === 'traffic'
                ? 'Overview + Domains per client, per month (or for the exact date range)'
                : 'one search per client per month — a start date covers every month it touches; a large client takes minutes a month'} />
            {s.onDemand && (
              <Progress done={s.onDemand.done} total={s.onDemand.total} ready={s.onDemand.ready} running={s.onDemand.running}
                label={`${s.onDemand.period} · ${s.onDemand.clients} client(s) · started ${when(s.onDemand.startedAt)}`} />
            )}
          </div>
        )}
      </div>

      <div className="px-6 py-3 border-t border-gray-100 flex flex-wrap items-center gap-3">
        <h4 className="text-sm font-semibold text-[#14254A]">What is cached</h4>
        <span className="text-xs text-gray-500">{entries.length} of {t?.entries ?? 0}</span>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search client or view"
          className="ml-auto w-56 max-w-full px-3 py-1.5 text-xs rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
      </div>
      {entries.length === 0 ? (
        <p className="px-6 py-8 text-sm text-gray-500 text-center">
          {query ? <>Nothing cached matches &ldquo;{query}&rdquo;.</> : <>Nothing cached yet — open the {title} page, or press <strong>Prepare now</strong>.</>}
        </p>
      ) : (
        <div className="overflow-auto" style={{ maxHeight: 420 }}>
          <table className="data-table">
            <thead><tr>{['Client', 'View', 'Scope', 'Size', 'Expires in', ''].map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.key}>
                  <td className="text-xs text-gray-700 max-w-[200px] truncate" title={e.clientId}>{e.clientName}</td>
                  <td className="text-xs text-gray-600 whitespace-nowrap capitalize">{e.view}</td>
                  <td className="text-xs text-gray-600 max-w-[240px] truncate" title={e.detail}>{e.detail}</td>
                  <td className="text-xs text-gray-600 whitespace-nowrap">{kb(e.bytes)}</td>
                  <td className="text-xs text-gray-600 whitespace-nowrap">{left(e.ttlSeconds)}</td>
                  <td className="text-xs whitespace-nowrap">
                    {e.current ? <span className="text-emerald-700">Current</span> : <span className="text-gray-400">Earlier data</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
