'use client'

// One report section (Sports or VOD) of the Cache & Redis tab: what the cache
// holds for that section's platforms, per client, and cache on demand for
// chosen clients over a period of at most a year. Backed by
// handlers/admin/sectioncache.go.

import { useEffect, useMemo, useState } from 'react'
import CachePeriodForm, { Progress, type PeriodRequest } from './CachePeriodForm'

const kb = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
const when = (v?: string) => (!v || v.startsWith('0001') ? '—' : new Date(v).toLocaleString())
const dur = (s?: number) => (s == null ? '' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`)

export default function SectionCachePanel({ name, label }: { name: 'sports' | 'vod'; label: string }) {
  const [d, setD] = useState<any>(null)
  const [clients, setClients] = useState<{ key: string; label: string }[]>([])
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')

  async function load() {
    try {
      const r = await fetch(`/api/admin/report-cache/section?name=${name}`, { credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not load'); return }
      setErr(''); setD(j)
    } catch (e: any) { setErr(e?.message || 'Network error') }
  }
  useEffect(() => {
    setD(null); load()
    // The warehouse's client list — the same one "cache these clients now" offers.
    fetch('/api/admin/report-cache/clients', { credentials: 'include' }).then(r => r.json())
      .then(j => setClients((j.clients || []).map((c: any) => ({ key: String(c.id), label: String(c.name || c.id) }))))
      .catch(() => {})
  }, [name]) // eslint-disable-line react-hooks/exhaustive-deps
  const running = !!d?.run?.running
  useEffect(() => {
    if (!running) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  async function start(req: PeriodRequest) {
    setBusy(true); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/admin/report-cache/section/warm', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...req }),
      })
      const j = await r.json()
      if (!j.success) setErr(j.error || 'Could not start')
      else setMsg(`Started — ${Number(j.reports).toLocaleString()} ${label} report(s) across ${j.windows} window(s). Progress below.`)
      await load()
    } catch (e: any) { setErr(e?.message || 'Network error') } finally { setBusy(false) }
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (d?.clients || []).filter((c: any) => !q || String(c.clientName).toLowerCase().includes(q))
  }, [d, query])

  if (!d) return <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 text-sm text-gray-500">{err || 'Loading…'}</div>
  const t = d.totals || {}
  const run = d.run

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${d.connected ? 'bg-emerald-500' : 'bg-red-400'}`} />
          <h3 className="font-semibold text-[#14254A]">{label} reports — {d.connected ? 'cache connected' : 'cache not connected'}</h3>
          <span className="text-xs text-gray-500">{(d.platforms || []).length} platform(s): {(d.platforms || []).map((p: any) => p.label).join(', ') || '—'}</span>
          <button onClick={load} className="ml-auto text-xs text-[#14254A] hover:underline">Refresh</button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            ['Cached reports', (t.reports ?? 0).toLocaleString(), `${label} platforms only`],
            ['Clients', (t.clients ?? 0).toLocaleString(), 'with something cached'],
            ['Size', kb(t.bytes ?? 0), 'in Redis'],
            ['Newest', when(t.newest), 'last report stored'],
          ].map(([k, v, n]) => (
            <div key={k} className="rounded-xl border border-gray-100 p-3">
              <p className="text-[10px] uppercase tracking-wide text-gray-500">{k}</p>
              <p className="text-lg font-bold text-[#14254A] truncate">{v}</p>
              <p className="text-[10px] text-gray-400">{n}</p>
            </div>
          ))}
        </div>

        <CachePeriodForm clients={clients} busy={busy} onSubmit={start} unit="report"
          perWindow={(d.platforms || []).length} note={`one report per ${label} platform, per client, per window`} />
        {err && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">{err}</p>}
        {msg && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">{msg}</p>}

        {run && (
          <div className="space-y-2">
            <Progress done={run.done} total={run.total} ready={run.ready} running={run.running}
              label={`${run.period} · ${run.windows?.length ?? 0} window(s) · by ${run.by}${run.running
                ? ` · ${dur(run.elapsedSeconds)} so far${run.etaSeconds != null ? ` · about ${dur(run.etaSeconds)} left` : ''}`
                : ` · finished ${when(run.finishedAt)}`}`} />
            {(run.clients || []).length > 0 && (
              <div className="overflow-auto rounded-xl border border-gray-100" style={{ maxHeight: 200 }}>
                <table className="data-table">
                  <thead><tr>{['Client', 'Done', 'Ready', 'Note'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {run.clients.map((c: any) => (
                      <tr key={c.clientId}>
                        <td className="text-xs text-gray-700 max-w-[240px] truncate" title={c.clientId}>{c.clientName || c.clientId}</td>
                        <td className="text-xs text-gray-600">{c.done} of {(run.platforms || 0) * (run.windows?.length || 0)}</td>
                        <td className="text-xs text-emerald-700">{c.ready}</td>
                        <td className="text-xs text-amber-700 max-w-[260px] truncate" title={c.error || ''}>{c.error || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-6 py-3 border-t border-gray-100 flex flex-wrap items-center gap-3">
        <h4 className="text-sm font-semibold text-[#14254A]">What is cached</h4>
        <span className="text-xs text-gray-500">{rows.length} client(s)</span>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search client"
          className="ml-auto w-56 max-w-full px-3 py-1.5 text-xs rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
      </div>
      {rows.length === 0 ? (
        <p className="px-6 py-8 text-sm text-gray-500 text-center">
          {query ? <>No client matches &ldquo;{query}&rdquo;.</> : <>Nothing cached for {label} yet — open a {label} report, or use <strong>Cache on demand</strong> above.</>}
        </p>
      ) : (
        <div className="overflow-auto" style={{ maxHeight: 420 }}>
          <table className="data-table">
            <thead><tr>{['Client', 'Reports', 'Platforms', 'Newest', 'Oldest', 'Size'].map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((c: any) => (
                <tr key={c.clientId}>
                  <td className="text-xs text-gray-700 max-w-[240px] truncate" title={c.clientId}>{c.clientName}</td>
                  <td className="text-xs text-gray-600">{c.reports}</td>
                  <td className="text-xs text-gray-600">{c.platforms}</td>
                  <td className="text-xs text-gray-600 whitespace-nowrap">{when(c.newest)}</td>
                  <td className="text-xs text-gray-600 whitespace-nowrap">{when(c.oldest)}</td>
                  <td className="text-xs text-gray-600 whitespace-nowrap">{kb(c.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
