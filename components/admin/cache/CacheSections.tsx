'use client'

// The Cache & Redis tab, split by WHICH Redis a report is cached in:
//
//   1. Portal Redis (iphouse_Latest, on the application server) — Sports and
//      VOD report cache, War Room data, top-client usage counts. The portal
//      connects to it directly; ReportCachePanel configures it.
//   2. Reports API Redis (reports_api's own `reports_redis`, on the reports API
//      server) — Traffic and Torrent Analysis. The portal never connects to it:
//      status, contents and cache on demand go through the reports API.
//
// Each group has its own tabs, one per report, and each tab offers cache on
// demand by client and period (≤ 1 year).

import { useEffect, useState, type ReactNode } from 'react'
import SectionCachePanel from './SectionCachePanel'
import { AnalyticsSection } from '../AnalyticsCachePanel'

type Key = 'sports' | 'vod' | 'traffic' | 'torrent'
const LABEL: Record<Key, string> = { sports: 'Sports', vod: 'VOD', traffic: 'Traffic Analysis', torrent: 'Torrent Analysis' }

/** One Redis: a heading that says where it lives and what it holds, then its contents. */
export function RedisGroup({ n, title, where, holds, status, children }: {
  n: number; title: string; where: string; holds: string; status?: ReactNode; children: ReactNode
}) {
  return (
    <section className="mt-8 first:mt-2 rounded-2xl border border-[#14254A]/15 bg-[#14254A]/[0.02] p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="w-7 h-7 rounded-lg bg-[#14254A] text-white text-sm font-bold grid place-items-center shrink-0">{n}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-[#14254A]">{title}</h2>
          <p className="text-xs text-gray-500">{where}</p>
          <p className="text-xs text-gray-600 mt-0.5"><span className="font-semibold">Holds:</span> {holds}</p>
        </div>
        {status}
      </div>
      {children}
    </section>
  )
}

/** A group's reports, one tab each; the tab last used is remembered per group. */
export default function CacheSections({ keys, storageKey }: { keys: Key[]; storageKey: string }) {
  const [tab, setTab] = useState<Key>(() => {
    try {
      const v = localStorage.getItem(storageKey) as Key
      return keys.includes(v) ? v : keys[0]
    } catch { return keys[0] }
  })
  useEffect(() => { try { localStorage.setItem(storageKey, tab) } catch { /* private mode */ } }, [tab, storageKey])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-bold text-[#14254A]">Cache by report</h3>
        <p className="text-xs text-gray-500">What each report holds, and caching on demand by client and period (at most 1 year).</p>
      </div>
      <div className="inline-flex flex-wrap rounded-xl border border-gray-200 overflow-hidden bg-white">
        {keys.map(k => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium ${tab === k ? 'bg-[#14254A] text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
            {LABEL[k]}
          </button>
        ))}
      </div>
      {tab === 'sports' && <SectionCachePanel name="sports" label="Sports" />}
      {tab === 'vod' && <SectionCachePanel name="vod" label="VOD" />}
      {tab === 'traffic' && <AnalyticsSection scope="traffic" />}
      {tab === 'torrent' && <AnalyticsSection scope="torrent" />}
    </div>
  )
}

/**
 * The reports API's Redis, as the reports API sees it — connected or not, at
 * what address, and how much Traffic and Torrent hold between them.
 */
export function ReportsApiRedisStatus() {
  const [s, setS] = useState<{ ok: boolean; addr: string; entries: number; bytes: number } | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    const load = () => fetch('/api/admin/report-cache/analytics', { credentials: 'include' })
      .then(r => r.json())
      .then(j => {
        if (!live) return
        if (!j?.success) { setErr(j?.error || 'Reports API unreachable'); return }
        const t = j.traffic || {}, o = j.torrent || {}
        setErr('')
        setS({
          ok: !!(t.redis || o.redis),
          addr: t.redisAddr || o.redisAddr || '',
          entries: (t.totals?.entries ?? 0) + (o.totals?.entries ?? 0),
          bytes: (t.totals?.bytes ?? 0) + (o.totals?.bytes ?? 0),
        })
      })
      .catch(e => { if (live) setErr(e?.message || 'Network error') })
    load()
    const t = setInterval(load, 30000)
    return () => { live = false; clearInterval(t) }
  }, [])
  const kb = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(0, Math.round(b / 1024))} KB`)
  if (err) return <span className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1">{err}</span>
  if (!s) return <span className="text-xs text-gray-400">Checking…</span>
  return (
    <div className="flex items-center gap-2 text-xs rounded-lg border border-gray-200 bg-white px-3 py-1.5">
      <span className={`w-2 h-2 rounded-full ${s.ok ? 'bg-emerald-500' : 'bg-red-400'}`} />
      <span className="font-semibold text-[#14254A]">{s.ok ? 'Connected' : 'Not connected'}</span>
      <span className="font-mono text-gray-500">{s.addr || '— no address —'}</span>
      <span className="text-gray-400">·</span>
      <span className="text-gray-600">{s.entries.toLocaleString()} entries · {kb(s.bytes)}</span>
    </div>
  )
}
