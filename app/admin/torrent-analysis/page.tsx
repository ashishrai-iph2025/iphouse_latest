// /admin/torrent-analysis — who is sharing a client's torrents, from where, on what.
//
// Two views, both passed through from reports_api by
// go-server/handlers/torrentanalysis.go:
//
//   Report          the whole-period report (the Power BI layout), from
//                   /v1/torrent/report/* — dashboards.Dashboard_TorrentIP_MonthlyAgg,
//                   read live through the selected client's assets. A client
//                   too large to read whole (the ESA) is asked to pick a slicer.
//   Live sightings  the raw peer sightings in mediascan.IPDetailsNew, up to
//                   seven days at a time, from /v1/torrent/*.
//
// Look and feel: the shared admin analytics blocks (components/admin/analytics/ui).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DateRangePicker from '@/components/ui/DateRangePicker'
import { downloadCsv } from '@/lib/exportCsv'
import { downloadWorkbook } from '@/lib/xlsx'
import WorldBubbleMap from '@/components/admin/analytics/WorldBubbleMap'
import CacheStatus from '@/components/admin/analytics/CacheStatus'
import { useSession } from '@/lib/auth-client'
import AnalyticsHeader from '@/components/admin/analytics/AnalyticsHeader'
import {
  ORANGE, BODY_FONT, HEAD_FONT, useTok, nf, cmp, pct, flag, Card, Stat, Empty, Loading,
  Table, Btn, TextInput, Field, type Col,
} from '@/components/admin/analytics/ui'

/* ── data ───────────────────────────────────────────────────────────────── */

interface Row { key: string | null; name: string; ips: number; distinctIps: number; infohashes: number | null; iso?: string; continent?: string; lat?: number; lon?: number }

// Requests go through a small queue: a report is ~15 panels, and when a slicer
// sends them live each is a warehouse query — four at a time is plenty.
const queue: (() => void)[] = []
let active = 0
function limited<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++
      fn().then(resolve, reject).finally(() => { active--; queue.shift()?.() })
    }
    if (active < 4) run(); else queue.push(run)
  })
}

/* Staff read the admin pass-through and pick any client; a client login
   (Business Intelligence → Torrent Analysis) reads /api/bi/torrent-analysis,
   which pins the client to the login's own. Set by the page on render. */
let API = '/api/admin/torrent-analysis'

async function getJSON(path: string, q: Record<string, string | undefined>) {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== '') as [string, string][])
  return limited(async () => {
    const res = await fetch(`${API}/${path}?${p}`, { credentials: 'include' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`)
    return body
  })
}

function useLoad<T = any>(path: string, q: Record<string, string | undefined> | null, nonce = 0) {
  const [state, setState] = useState<{ data: T | null; err: string; loading: boolean }>({ data: null, err: '', loading: false })
  const key = q ? JSON.stringify(q) : ''
  const seen = useRef(nonce)
  useEffect(() => {
    if (!q) { setState({ data: null, err: '', loading: false }); return }
    let live = true
    const refresh = nonce !== seen.current
    seen.current = nonce
    setState(s => ({ ...s, loading: true, err: '' }))
    getJSON(path, refresh ? { ...q, refresh: '1' } : q)
      .then(d => { if (live) setState({ data: d, err: '', loading: false }) })
      .catch(e => { if (live) setState({ data: null, err: e.message, loading: false }) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, nonce])
  return state
}

const bytes = (n: number | null | undefined) => {
  if (n == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`
}
const today = () => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }

/* ── panel shells ───────────────────────────────────────────────────────── */

function Panel({ title, sub, state, children, action, className = '', flush }:
  { title: string; sub?: string; state: { loading: boolean; err: string; data: any }; children: (d: any) => ReactNode; action?: ReactNode; className?: string; flush?: boolean }) {
  const { d } = useTok()
  return (
    <Card title={title} sub={sub} action={action} className={className} flush={flush}>
      {state.loading ? <div className="min-h-[240px] flex"><Loading label={null} /></div>
        : state.err ? <div className="text-xs p-4" style={{ color: d.bad, ...BODY_FONT }}>{state.err}</div>
        : state.data ? children(state.data) : null}
    </Card>
  )
}

function VBars({ rows, value = r => r.ips, fmt = cmp, height = 280, color = ORANGE, angled = false }:
  { rows: Row[]; value?: (r: Row) => number; fmt?: (v: number) => string; height?: number; color?: string; angled?: boolean }) {
  const t = useTok()
  if (!rows.length) return <Empty>No data</Empty>
  const data = rows.map(r => ({ name: r.name, v: value(r) }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: angled ? 56 : 8 }}>
        <CartesianGrid stroke={t.grid} vertical={false} />
        <XAxis dataKey="name" interval={0} tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false}
          angle={angled ? -35 : 0} textAnchor={angled ? 'end' : 'middle'} height={angled ? 70 : 30}
          tickFormatter={(v: string) => (v.length > 18 ? v.slice(0, 17) + '…' : v)} />
        <YAxis tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} width={48} tickFormatter={v => fmt(v)} />
        <Tooltip {...t.tip} cursor={{ fill: t.grid }} formatter={(v: any) => [nf(Number(v)), 'Total IPs']} />
        <Bar dataKey="v" fill={color} radius={[4, 4, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function Donut({ rows, top = 8, height = 280, pie = false }: { rows: Row[]; top?: number; height?: number; pie?: boolean }) {
  const t = useTok()
  if (!rows.length) return <Empty>No data</Empty>
  const head = rows.slice(0, top)
  const rest = rows.slice(top).reduce((s, r) => s + r.ips, 0)
  const data = [...head.map(r => ({ name: r.name, v: r.ips })), ...(rest > 0 ? [{ name: 'Other', v: rest }] : [])]
  const total = data.reduce((s, r) => s + r.v, 0) || 1
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey="v" nameKey="name" innerRadius={pie ? 0 : '55%'} outerRadius="85%" paddingAngle={pie ? 0 : 1}
          stroke={t.d.card} strokeWidth={2} isAnimationActive={false}>
          {data.map((_, i) => <Cell key={i} fill={data[i].name === 'Other' ? t.d.track : t.pal[i % t.pal.length]} />)}
        </Pie>
        <Tooltip {...t.tip} formatter={(v: any, n: any) => [`${nf(Number(v))} · ${pct((Number(v) / total) * 100)}`, n]} />
        <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" iconSize={8}
          wrapperStyle={{ fontSize: 11, color: t.d.sub, maxWidth: '45%' }}
          formatter={(v: string) => (v.length > 26 ? v.slice(0, 25) + '…' : v)} />
      </PieChart>
    </ResponsiveContainer>
  )
}

function TopTable({ rows, label, total, mono }: { rows: Row[]; label: string; total?: number; mono?: boolean }) {
  const { d } = useTok()
  const cols: Col<Row>[] = [
    { key: 'i', label: '#', width: 40, render: (_r, i) => <span className="font-mono" style={{ color: d.sub }}>{i + 1}</span> },
    { key: 'n', label, render: r => <span className={`block max-w-[520px] truncate ${mono ? 'font-mono' : ''}`} title={r.name}>{r.name}</span> },
    { key: 'v', label: 'Total IPs', align: 'right', render: r => <b style={{ color: ORANGE }}>{nf(r.ips)}</b> },
  ]
  const sum = rows.reduce((s, r) => s + r.ips, 0)
  return (
    <>
      <Table cols={cols} rows={rows} rowKey={(r, i) => (r.key ?? '') + i} maxHeight={340} />
      <div className="flex justify-between px-4 py-2.5 text-xs font-bold" style={{ color: d.text, borderTop: `1px solid ${d.divider}`, ...BODY_FONT }}>
        <span>Total (top {rows.length})</span>
        <span className="tabular-nums">{nf(sum)}{total ? <span style={{ color: d.sub, fontWeight: 500 }}> · {pct((sum / total) * 100)} of all</span> : null}</span>
      </div>
    </>
  )
}

/* ── page ───────────────────────────────────────────────────────────────── */

type Tab = 'report' | 'live'
interface Slicers { assetId: string; childTitle: string; continent: string; country: string; isp: string }
const noSlicers: Slicers = { assetId: '', childTitle: '', continent: '', country: '', isp: '' }

const monthLabel = (m: string) => { if (m === 'all') return 'All months'; const t = new Date(m + '-01T00:00:00Z'); return isNaN(+t) ? m : t.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) }

export default function TorrentAnalysisPage({ client = false }: { client?: boolean }) {
  API = client ? '/api/bi/torrent-analysis' : '/api/admin/torrent-analysis'
  const { d } = useTok()
  const { data: session } = useSession()
  // The cache badge is operational detail: Super Admins only.
  const superAdmin = !client && (session?.user as any)?.role === 2
  const clients = useLoad<any>('clients', {})
  const [clientId, setClientId] = useState('')
  const [tab, setTab] = useState<Tab>('report')
  const [nonce, setNonce] = useState(0)

  const clientOpts = useMemo(() => (clients.data?.clients || []).map((c: any) => ({
    key: String(c.id), label: String(c.name), count: c.torrents,
  })), [clients.data])
  // Staff choose; a client login has one client — its own — chosen for it.
  useEffect(() => { if (client && !clientId && clientOpts.length) setClientId(clientOpts[0].key) }, [client, clientId, clientOpts])

  return (
    <div className={`${client ? '' : 'p-6 '}fade-in space-y-5`}>
      <AnalyticsHeader client={client} title="Torrent Analysis"
        description={client ? 'Who is sharing your torrents — IPs captured per asset, infohash, network, ISP and country.'
          : "Who is sharing a client's torrents — IPs captured per asset, infohash, network, ISP and country."}
        actions={<>
          {superAdmin && <CacheStatus url="/api/admin/torrent-analysis/report/cache" kind="torrent" />}
          {([['report', 'Report'], ['live', 'Live sightings']] as [Tab, string][])
            .map(([k, l]) => <Btn key={k} active={tab === k} onClick={() => setTab(k)}>{l}</Btn>)}
          {!client && <Btn onClick={() => setNonce(n => n + 1)} title="Recompute instead of the cached answer">↻ Refresh</Btn>}
        </>} />

      {!client && <div className="rounded-xl p-4 flex flex-wrap items-end gap-4" style={{ background: d.card, border: `1px solid ${d.cardBorder}` }}>
        <Field label="Client" width={320}>
          <SearchableSelect options={clientOpts} value={clientId} clearable={false} onChange={setClientId}
            placeholder={clients.err || 'Select a client'} ariaLabel="Client" />
        </Field>
        {clients.data && clientOpts.length === 0 && <span className="text-xs" style={{ color: d.sub }}>No client has torrents under tracking.</span>}
      </div>}

      {!clientId ? (clients.loading ? <Card><Loading label="Loading clients" /></Card>
        : clients.err ? <Card><div className="text-xs" style={{ color: d.bad, ...BODY_FONT }}>{clients.err}</div></Card>
        : <Card><Empty>{client ? 'No torrents are under tracking for your account yet.' : 'Select a client to load its torrent report.'}</Empty></Card>)
        : tab === 'report' ? <Report clientId={clientId} clientName={clientOpts.find((c: any) => c.key === clientId)?.label ?? clientId} nonce={nonce} staff={!client} />
        : <Live clientId={clientId} nonce={nonce} latest={clients.data?.latestSighting} />}
    </div>
  )
}

/* ── the report ─────────────────────────────────────────────────────────── */

function Report({ clientId, clientName, nonce, staff }: { clientId: string; clientName: string; nonce: number; staff: boolean }) {
  const t = useTok()
  const { d } = t
  const [s, setS] = useState<Slicers>(noSlicers)
  const [month, setMonth] = useState('')
  useEffect(() => { setS(noSlicers); setMonth(''); setSearched(null); setJob(null) }, [clientId])
  const set = (p: Partial<Slicers>) => setS(v => ({ ...v, ...p }))

  // Slicer lists without reading the big table.
  const options = useLoad<any>('report/options', { clientId })
  const o = options.data
  const allMonths: string[] = o?.months || []
  useEffect(() => { if (allMonths.length && !month) setMonth(allMonths[allMonths.length - 1]) }, [allMonths, month])

  /* ── cache coverage ──
     Checked automatically for the client + filters: which months already have
     a cached answer. Only when every month does is "All months" offered — that
     view is folded from the cached months, never read from the warehouse.
     Re-checked every 15s while months are being cached. */
  const [cov, setCov] = useState<any>(null)
  const [covTick, setCovTick] = useState(0)
  const [caching, setCaching] = useState(false)
  const sKey = JSON.stringify(s)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const load = () => getJSON('report/coverage', { clientId, ...s })
      .then(c => { if (!live) return; setCov(c); if (!c.allCached && c.busy) timer = setTimeout(load, 15000) })
      .catch(() => { if (live) timer = setTimeout(load, 30000) })
    load()
    return () => { live = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, sKey, covTick])
  useEffect(() => { setCov(null) }, [clientId, sKey])
  const covMonths: { month: string; label: string; status: string }[] = cov?.months || []
  const missing = covMonths.filter(m => m.status === 'missing')
  const cacheMissing = async () => {
    setCaching(true)
    // Each start is one queued search; the service works through them in order.
    await Promise.allSettled(missing.map(m => getJSON('report/run', { clientId, ...s, month: m.month })))
    setCaching(false)
    setCovTick(n => n + 1)
  }
  // Filters that break "every month cached" take the All-months choice away.
  useEffect(() => { if (month === 'all' && cov && !cov.allCached && allMonths.length) setMonth(allMonths[allMonths.length - 1]) }, [cov, month, allMonths])

  const monthOpts = [
    ...(cov?.allCached ? [{ key: 'all', label: staff ? `All months (${cov.total}) — from cache` : `All months (${cov.total})` }] : []),
    ...[...allMonths].reverse().map(m => ({ key: m, label: monthLabel(m) })),
  ]
  const assetOpts = [{ key: '', label: 'All assets' }, ...(o?.assets || []).map((a: any) => ({ key: a.id, label: a.name || a.id }))]
  const childOpts = [{ key: '', label: 'All child titles' }, ...(o?.childTitles || []).map((c: string) => ({ key: c, label: c }))]
  const contOpts = [{ key: '', label: 'All continents' }, ...(o?.continents || []).map((c: string) => ({ key: c, label: c }))]
  const countryOpts = [{ key: '', label: 'All countries' }, ...(o?.countries || [])
    .filter((c: any) => !s.continent || c.continent === s.continent)
    .map((c: any) => ({ key: c.name, label: `${flag(c.iso)} ${c.name}` }))]

  /* ── the search ──
     Search starts (or re-uses) a job on the service and polls it; the answer
     carries every panel. Nothing is read until Search is pressed. */
  const [searched, setSearched] = useState<Record<string, string> | null>(null)
  const [job, setJob] = useState<any>(null)
  const [jobErr, setJobErr] = useState('')
  const [reconnecting, setReconnecting] = useState(false)
  const params = { clientId, month, ...s }
  const stale = !!searched && JSON.stringify(searched) !== JSON.stringify(params)
  const search = (refresh = false) => { setJob(null); setJobErr(''); setReconnecting(false); setSearched({ ...params, ...(refresh ? { refresh: '1' } : {}) }) }
  useEffect(() => { if (nonce && searched) search(true) }, [nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!searched) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    let first = true
    /* A dropped connection is not a failed search. The reports service is
       unreachable for a few seconds whenever it is redeployed or restarted, and
       a search runs for minutes — so a poll that cannot connect keeps trying
       (for up to ~2 minutes) instead of ending the search on the first refusal.
       If the service did restart, the search it was running is gone, and the
       next poll with the same filters simply starts it again. */
    let failures = 0
    const poll = async () => {
      try {
        if (searched.month === 'all') {
          const { month: _m, poll: _p, ...q } = searched
          const r = await getJSON('report/combined', q)
          if (!live) return
          const filters = Object.fromEntries(Object.entries(s).filter(([, v]) => v))
          setJob({ status: 'done', month: 'all', cached: true, finishedAt: new Date().toISOString(), filters, result: r })
          return
        }
        // Only the first ask may carry refresh; later asks are polls — they must
        // find the same job, and must not count as cache hits.
        const q = first ? searched : { ...searched, refresh: '', poll: '1' }
        const r = await getJSON('report/run', q)
        if (!live) return
        first = false
        failures = 0
        setReconnecting(false)
        setJob(r)
        if (r.status === 'done') setCovTick(n => n + 1) // a month just joined the cache
        if (r.status === 'failed') setJobErr(r.error || 'The search failed')
        else if (r.status !== 'done') timer = setTimeout(poll, 3000)
      } catch (e: any) {
        if (!live) return
        failures++
        const unreachable = /unreachable|connection refused|Failed to fetch|NetworkError|502|503|504/i.test(e?.message || '')
        if (unreachable && failures <= 40) {
          setReconnecting(true)
          timer = setTimeout(poll, 3000)
          return
        }
        setReconnecting(false)
        setJobErr(unreachable
          ? 'The reports service could not be reached for two minutes. It may be restarting — press Search again in a moment.'
          : e.message)
      }
    }
    poll()
    return () => { live = false; clearTimeout(timer) }
  }, [searched])

  const result = job?.status === 'done' ? job.result : null
  const P: Record<string, Row[]> = result?.panels || {}
  const sum = result?.summary || {}
  const total = sum.ips as number | undefined
  const known = (rows?: Row[]) => (rows || []).filter(r => r.key)
  const top = (rows?: Row[], n = 10) => (rows || []).slice(0, n)
  const ispOpts = [{ key: '', label: 'All ISPs' }, ...known(P.isp).slice(0, 500).map(r => ({ key: String(r.key), label: r.name, count: r.ips }))]
  const elapsed = job?.elapsedMs ? `${Math.round(job.elapsedMs / 1000)}s` : ''
  const period = job?.month === 'all' ? (result?.period || 'All months') : monthLabel(job?.month || '')

  const exportExcel = () => {
    const sheet = (name: string, rows: Row[] | undefined, withHashes = false) => ({
      name, title: `${name} — ${period}`,
      subtitle: `Client ${clientName} · ${Object.entries(job.filters || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'no filters'}`,
      head: withHashes ? [name, 'Total IPs', 'Distinct IPs (summed)', 'Infohashes'] : [name, 'Total IPs', 'Distinct IPs (summed)'],
      rows: (rows || []).map(r => (withHashes ? [r.name, r.ips, r.distinctIps, r.infohashes ?? null] : [r.name, r.ips, r.distinctIps])),
    })
    downloadWorkbook(`torrent-report-${job.month === 'all' ? 'all-months' : monthLabel(job.month)}`, [
      { name: 'Summary', title: `Torrent report — ${period}`, head: ['Measure', 'Value'],
        rows: [['Total IPs captured', sum.ips], ['Assets tracked', sum.assets], ['Infohashes tracked', sum.infohashes],
          ['Countries', sum.countries], ['ISPs', sum.isps], ['Torrents under tracking (all time)', sum.torrentsTracked]] },
      ...(P.month?.length ? [{ ...sheet('Months', P.month, true), head: ['Month', 'Total IPs', 'Distinct IPs (summed)', 'Infohashes'] }] : []),
      sheet('Members', P.member, true), sheet('Assets', P.asset, true),
      { ...sheet('Infohashes', P.infohash, true), head: ['Infohash', 'Torrent name', 'Total IPs', 'Distinct IPs (summed)'],
        rows: (P.infohash || []).map(r => [r.key, r.name, r.ips, r.distinctIps]) },
      sheet('Torrent names', P.torrentName, true), sheet('Child titles', P.childTitle, true),
      sheet('Network connection', P.userType), sheet('File size', P.fileSize, true),
      sheet('Release groups', P.releaseGroup, true), sheet('Console types', P.quality, true),
      sheet('Continents', P.continent), sheet('Countries', P.country), sheet('ISPs (top 5,000)', P.isp),
    ])
  }

  return (
    <div className="space-y-5">
      {/* Slicers — one month per search, then Search */}
      <div className="rounded-xl p-4 space-y-4" style={{ background: d.card, border: `1px solid ${d.cardBorder}` }}>
        <div className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          <Field label="Month"><SearchableSelect options={monthOpts} value={month} clearable={false} onChange={v => v && setMonth(v)} disabled={!allMonths.length} placeholder="…" ariaLabel="Month" /></Field>
          <Field label="Asset name"><SearchableSelect options={assetOpts} value={s.assetId} clearable={false} onChange={v => set({ assetId: v })} ariaLabel="Asset" /></Field>
          <Field label="Child title"><SearchableSelect options={childOpts} value={s.childTitle} clearable={false} onChange={v => set({ childTitle: v })} ariaLabel="Child title" /></Field>
          <Field label="Continent"><SearchableSelect options={contOpts} value={s.continent} clearable={false} onChange={v => set({ continent: v, country: '' })} ariaLabel="Continent" /></Field>
          <Field label="Country"><SearchableSelect options={countryOpts} value={s.country} clearable={false} onChange={v => set({ country: v })} ariaLabel="Country" /></Field>
          <Field label="ISP">
            <SearchableSelect options={ispOpts} value={s.isp} clearable={false} onChange={v => set({ isp: v })}
              disabled={!result} placeholder={result ? 'All ISPs' : 'After the first search'} ariaLabel="ISP" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3" style={BODY_FONT}>
          <Btn active onClick={() => search()} disabled={!month || (job && job.status !== 'done' && job.status !== 'failed' && !stale)}>🔍 Search</Btn>
          {Object.values(s).some(Boolean) && <button className="text-xs font-semibold hover:underline" style={{ color: ORANGE }} onClick={() => setS(noSlicers)}>Clear filters</button>}
          {result && <Btn onClick={exportExcel}>⬇ Download Excel</Btn>}
          {stale && result && <span className="text-xs font-semibold" style={{ color: ORANGE }}>Filters changed — press Search to update.</span>}
          {result && !stale && (
            <span className="text-xs" style={{ color: d.sub }}>
              {period} · {!staff ? <>data refreshed daily</> : <>{job.cached
                ? <>⚡ from cache, computed {new Date(job.finishedAt).toLocaleString()}</>
                : <>computed in {elapsed}</>} · served instantly until the next daily data refresh</>}
            </span>
          )}
        </div>
        {/* Cache coverage is operational detail — staff only. */}
        {staff && covMonths.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-3" style={{ borderTop: `1px solid ${d.divider}`, ...BODY_FONT }}>
            <span className="text-xs font-semibold" style={{ color: d.text }}>
              Cached months {cov.cached}/{cov.total}
            </span>
            {covMonths.map(m => {
              const c = m.status === 'cached', busy = m.status === 'running' || m.status === 'queued'
              return (
                <span key={m.month} title={m.status} className="text-[11px] px-2 py-0.5 rounded-full tabular-nums"
                  style={{ border: `1px solid ${c ? '#0D244B' : busy ? ORANGE : d.cardBorder}`,
                    background: c ? '#0D244B' : 'transparent', color: c ? '#fff' : busy ? ORANGE : d.sub }}>
                  {c ? '✓' : busy ? '⏳' : '○'} {m.label}
                </span>
              )
            })}
            <span className="text-xs ml-auto" style={{ color: d.sub }}>
              {cov.allCached ? <>Every month is cached — pick <b style={{ color: d.text }}>All months</b> in the Month list.</>
                : cov.busy ? <>Caching {cov.busy} month{cov.busy > 1 ? 's' : ''} — checked again automatically.</>
                : <>All months opens once every month is cached.</>}
            </span>
            {staff && missing.length > 0 && (
              <Btn onClick={cacheMissing} disabled={caching}>{caching ? 'Starting…' : `Cache ${missing.length} missing month${missing.length > 1 ? 's' : ''}`}</Btn>
            )}
          </div>
        )}
      </div>

      {!searched ? (
        <Card><Empty>{options.loading ? 'Loading the client’s filters…' : 'Choose a month (and any filters), then press Search.'}</Empty></Card>
      ) : jobErr ? (
        <Card><div className="text-xs p-2" style={{ color: d.bad, ...BODY_FONT }}>{jobErr}</div></Card>
      ) : !result ? (
        <Card>
          <div className="min-h-[360px] flex">
            <Loading label="Searching the torrent data"
              sublabel={reconnecting ? 'Reconnecting to the reports service — it may be restarting; the search carries on when it is back' : !staff ? `${job?.status === 'queued' ? 'Waiting in line' : 'Preparing your report'}${elapsed ? ` · ${elapsed}` : ''} · a large report can take a few minutes`
                : `${job?.status === 'queued' ? `Waiting for another search to finish${job.ahead ? ` (${job.ahead} ahead)` : ''}` : job?.stage || 'starting'}${elapsed ? ` · ${elapsed}` : ''} · the first search of the day for a large client takes a few minutes; after that it is instant`} />
          </div>
        </Card>
      ) : !sum.ips ? (
        <Card><Empty>No IP data for this client in {period}{Object.keys(job.filters || {}).length ? ' with these filters' : ''}.</Empty></Card>
      ) : (<>
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
          <div className="grid grid-cols-3 lg:grid-cols-1 gap-3 content-start">
            <Stat label="Total assets tracked" value={nf(sum.assets)} accent />
            <Stat label="Total IPs captured" value={cmp(sum.ips)} hint={nf(sum.ips)} accent />
            <Stat label="Total infohashes tracked" value={nf(sum.infohashes)} accent hint={`${nf(sum.countries)} countries · ${nf(sum.isps)} ISPs`} />
          </div>
          <Card title="Members by number of total IP addresses" sub="Copyright owner of each tracked title" className="lg:col-span-3">
            <VBars rows={known(P.member).slice(0, 20)} height={300} angled />
          </Card>
        </div>

        {(P.month?.length ?? 0) > 0 && (
          <Card title="Month-on-month tracking of IP addresses" sub={`${result.period} · Total IPs captured per month`}>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={P.month.map(r => ({ name: r.name, v: r.ips, h: r.infohashes }))} margin={{ top: 16, right: 24, left: 0, bottom: 8 }}>
                <CartesianGrid stroke={t.grid} vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} width={52} tickFormatter={v => cmp(v)} />
                <Tooltip {...t.tip} formatter={(v: any, _n: any, it: any) => [`${nf(Number(v))} IPs · ${nf(it?.payload?.h ?? 0)} infohashes`, 'Total IPs']} />
                <Line type="monotone" dataKey="v" stroke={ORANGE} strokeWidth={2} dot={{ r: 4, fill: ORANGE, strokeWidth: 0 }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        )}

        <div className="grid lg:grid-cols-2 gap-5">
          <Card title="Top 10 child titles by total IPs"><VBars rows={top(known(P.childTitle))} height={280} angled /></Card>
          <Card title="Top 10 assets by infohash tracked"><VBars rows={top(P.assetByInfohash)} value={r => r.infohashes ?? 0} fmt={v => nf(v)} height={280} angled /></Card>
        </div>

        <div className="grid lg:grid-cols-2 gap-5">
          <Card title="Top 10 assets by total IPs captured"><VBars rows={top(P.asset)} height={300} angled /></Card>
          <Card title="Top 10 infohashes by IP addresses" flush>
            <TopTable rows={top(P.infohash).map(r => ({ ...r, name: r.key ?? r.name }))} label="Infohash" total={total} mono />
          </Card>
        </div>

        <div className="grid lg:grid-cols-2 gap-5">
          <Card title="Top 10 torrent names by total IPs downloading the content" flush><TopTable rows={top(P.torrentName)} label="Torrent name" total={total} /></Card>
          <Card title="Number of total IPs by type of network connection"><VBars rows={P.userType || []} height={280} color={d.series} /></Card>
        </div>

        <div className="grid lg:grid-cols-2 gap-5">
          <Card title="File size distribution by total IPs"><Donut rows={P.fileSize || []} /></Card>
          <Card title="Top 10 release groups by total IPs sharing pirate content"><VBars rows={top(known(P.releaseGroup))} height={280} angled /></Card>
        </div>

        <div className="grid lg:grid-cols-2 gap-5">
          <Card title="Distribution of console types by total IPs" sub="Quality of print on the torrent"><Donut rows={P.quality || []} pie /></Card>
          <Card title="Continent"><VBars rows={known(P.continent)} height={280} color={d.series} /></Card>
        </div>

        <div className="grid lg:grid-cols-2 gap-5">
          <Card title="Top 10 ISPs by total IPs downloading the content"><Donut rows={known(P.isp)} top={10} height={300} /></Card>
          <Card title="Top 10 countries downloading pirated content via torrents"><Donut rows={known(P.country)} top={10} height={300} pie /></Card>
        </div>

        <Card title="Global heat map — country by total IPs" sub="Each bubble is a country, placed where its peers were geolocated">
          <WorldBubbleMap fmt={v => `${nf(v)} IPs`}
            points={known(P.country).map(r => ({ name: r.name, label: `${flag(r.iso)} ${r.name}`, lat: r.lat ?? null, lon: r.lon ?? null, value: r.ips }))} />
        </Card>
      </>)}
    </div>
  )
}

/* ── live sightings ─────────────────────────────────────────────────────── */

function Live({ clientId, nonce, latest }: { clientId: string; nonce: number; latest?: string }) {
  const t = useTok()
  const { d } = t
  const newest = latest ? latest.slice(0, 10) : today()
  const [range, setRange] = useState({ from: newest, to: newest })
  useEffect(() => setRange({ from: newest, to: newest }), [newest, clientId])
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 864e5) + 1
  const tooWide = days > 7

  const q = tooWide ? null : { clientId, from: range.from, to: range.to }
  const summary = useLoad<any>('summary', q, nonce)
  const inventory = useLoad<any>('inventory', { clientId }, nonce)
  const series = useLoad<any>('timeseries', q, nonce)
  const bClient = useLoad<any>('breakdown', q && { ...q, by: 'torrentClient', limit: '10' }, nonce)
  const bOrg = useLoad<any>('breakdown', q && { ...q, by: 'organization', limit: '10' }, nonce)

  const s = summary.data?.summary || {}
  const inv = inventory.data?.inventory || {}
  const share = (n?: number) => (s.sightings ? pct(((n || 0) / s.sightings) * 100) : '—')

  return (
    <div className="space-y-5">
      <div className="rounded-xl p-4 flex flex-wrap items-end gap-4" style={{ background: d.card, border: `1px solid ${d.cardBorder}` }}>
        <Field label="Sighting date (max 7 days)" width={280}>
          <DateRangePicker value={range} max={newest} anchor={newest} onChange={r => setRange({ from: r.from, to: r.to || r.from })} />
        </Field>
        <p className="text-xs max-w-xl" style={{ color: d.sub, ...BODY_FONT }}>
          Raw peer sightings from <code>mediascan.IPDetailsNew</code> — about 1.5M a day across all clients, so a window is capped at
          seven days. Newest data: <b style={{ color: d.text }}>{newest}</b>.
        </p>
        {tooWide && <span className="text-xs font-semibold" style={{ color: d.bad }}>That is {days} days — pick at most 7.</span>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        <Stat label="IP sightings" value={summary.loading ? '…' : cmp(s.sightings)} accent />
        <Stat label="Unique IPs" value={summary.loading ? '…' : cmp(s.uniqueIps)} />
        <Stat label="Torrents seen" value={summary.loading ? '…' : nf(s.torrents)} />
        <Stat label="Mobile" value={share(s.mobile)} hint={s.mobile != null ? cmp(s.mobile) : undefined} />
        <Stat label="Proxy / VPN" value={share(s.proxy)} hint={s.proxy != null ? cmp(s.proxy) : undefined} />
        <Stat label="Hosting" value={share(s.hosting)} hint={s.hosting != null ? cmp(s.hosting) : undefined} />
        <Stat label="Torrents tracked" value={inventory.loading ? '…' : nf(inv.torrents)} hint={inv.assets != null ? `${nf(inv.assets)} assets` : undefined} />
        <Stat label="Enforced / removed" value={inventory.loading ? '…' : `${nf(inv.enforced)} / ${nf(inv.removed)}`} />
      </div>
      {summary.err && <Card><div className="text-xs" style={{ color: d.bad }}>{summary.err}</div></Card>}

      <div className="grid lg:grid-cols-3 gap-5">
        <Panel title="Sightings per day" sub="IP sightings and unique IPs" state={series} className="lg:col-span-1">
          {o => (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={o.series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={t.grid} vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} width={44} tickFormatter={v => cmp(v)} />
                <Tooltip {...t.tip} cursor={{ fill: t.grid }} formatter={(v: any, n: any) => [nf(Number(v)), n]} />
                <Legend wrapperStyle={{ fontSize: 11, color: d.sub }} iconType="circle" iconSize={8} />
                <Bar dataKey="sightings" name="Sightings" fill={ORANGE} radius={[4, 4, 0, 0]} />
                <Bar dataKey="uniqueIps" name="Unique IPs" fill={d.series} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>)}
        </Panel>
        <Panel title="Torrent clients" sub="Software the peers announced" state={bClient}>
          {o => <VBars rows={o.rows.map((r: any) => ({ ...r, ips: r.sightings }))} height={260} angled color={d.series} />}
        </Panel>
        <Panel title="Organisations" sub="Network owner of the peer IP" state={bOrg}>
          {o => <Donut rows={o.rows.map((r: any) => ({ ...r, ips: r.sightings }))} top={8} height={260} />}
        </Panel>
      </div>

      {q && <Torrents q={q} nonce={nonce} />}
      {q && <Peers q={q} nonce={nonce} />}
    </div>
  )
}

function Torrents({ q, nonce }: { q: Record<string, string>; nonce: number }) {
  const { d } = useTok()
  const [sort, setSort] = useState('sightings')
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState(0)
  const size = 100
  useEffect(() => { const h = setTimeout(() => { setTerm(search); setPage(0) }, 350); return () => clearTimeout(h) }, [search])
  const st = useLoad<any>('torrents', { ...q, sort, q: term, limit: String(size), offset: String(page * size) }, nonce)
  const o = st.data
  const cols: Col<any>[] = [
    { key: 'name', label: 'Torrent', sort: 'name', render: r => <span className="block max-w-[340px] truncate font-semibold" title={r.name}>{r.name || r.infohash}</span> },
    { key: 'asset', label: 'Asset', render: r => <span className="block max-w-[180px] truncate" style={{ color: d.sub }}>{r.asset || '—'}</span> },
    { key: 'quality', label: 'Console', render: r => r.quality || '—' },
    { key: 'language', label: 'Language', render: r => r.language || '—' },
    { key: 's', label: 'Sightings', align: 'right', sort: 'sightings', render: r => <b style={{ color: ORANGE }}>{nf(r.sightings)}</b> },
    { key: 'u', label: 'Unique IPs', align: 'right', sort: 'uniqueIps', render: r => nf(r.uniqueIps) },
    { key: 'c', label: 'Countries', align: 'right', sort: 'countries', render: r => nf(r.countries) },
    { key: 'size', label: 'Size', align: 'right', sort: 'size', render: r => bytes(r.size) },
    { key: 'tr', label: 'Trackers', align: 'right', sort: 'trackers', render: r => nf(r.trackers) },
    { key: 'st', label: 'Status', render: r => (r.removedAt ? <span style={{ color: d.good }}>Removed</span>
      : r.enforcedAt ? <span style={{ color: ORANGE }}>Enforced</span> : r.dead ? 'Dead' : 'Active') },
    { key: 'h', label: 'Infohash', render: r => <span className="font-mono text-[11px]" style={{ color: d.sub }}>{r.infohash}</span> },
  ]
  return (
    <Card flush title="Torrents in the swarm" sub={o ? `${nf(o.total)} torrents with sightings in the window` : undefined}>
      <div className="px-5 py-3 flex gap-3" style={{ borderBottom: `1px solid ${d.divider}` }}>
        <TextInput value={search} onChange={setSearch} placeholder="Search torrent or asset…" />
      </div>
      {st.loading ? <Loading label="Loading torrents" /> : st.err ? <div className="p-5 text-xs" style={{ color: d.bad }}>{st.err}</div> : o && (
        <>
          <Table cols={cols} rows={o.rows} rowKey={r => r.infohash} sort={sort} onSort={v => { setSort(v); setPage(0) }} maxHeight={480} minWidth={1300} />
          <div className="flex items-center gap-2 px-5 py-3 text-xs" style={{ color: d.sub, borderTop: `1px solid ${d.divider}`, ...BODY_FONT }}>
            <span>{nf(o.total ? page * size + 1 : 0)}–{nf(Math.min((page + 1) * size, o.total))} of {nf(o.total)}</span>
            <span className="ml-auto" />
            <Btn onClick={() => setPage(p => p - 1)} disabled={page === 0}>‹ Prev</Btn>
            <Btn onClick={() => setPage(p => p + 1)} disabled={(page + 1) * size >= o.total}>Next ›</Btn>
          </div>
        </>
      )}
    </Card>
  )
}

function Peers({ q, nonce }: { q: Record<string, string>; nonce: number }) {
  const { d } = useTok()
  const [rows, setRows] = useState<any[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ip, setIp] = useState('')
  const key = JSON.stringify(q) + nonce + ip
  const load = async (cursor?: string) => {
    setBusy(true); setErr('')
    try {
      const o = await getJSON('peers', { ...q, limit: '200', cursor, ip: ip.trim() || undefined })
      setRows(r => (cursor ? [...r, ...o.rows] : o.rows)); setNext(o.next)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  useEffect(() => { setRows([]); setNext(null); load() }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const yn = (v: any) => (v == null ? '—' : v ? 'Yes' : 'No')
  const cols: Col<any>[] = [
    { key: 'ip', label: 'IP', render: r => <span className="font-mono">{r.ip}:{r.port}</span> },
    { key: 'd', label: 'Date', render: r => String(r.dateAdded).slice(0, 10) },
    { key: 'c', label: 'Country', render: r => <>{flag(r.countryCode)} {r.country || '—'}</> },
    { key: 'rg', label: 'Region / city', render: r => <span className="block max-w-[180px] truncate" style={{ color: d.sub }}>{[r.region, r.city].filter(Boolean).join(' · ') || '—'}</span> },
    { key: 'isp', label: 'ISP', render: r => <span className="block max-w-[200px] truncate">{r.isp || '—'}</span> },
    { key: 'org', label: 'Organisation', render: r => <span className="block max-w-[180px] truncate" style={{ color: d.sub }}>{r.organization || '—'}</span> },
    { key: 'm', label: 'Mobile', render: r => yn(r.mobile) },
    { key: 'p', label: 'Proxy', render: r => yn(r.proxy) },
    { key: 'h', label: 'Hosting', render: r => yn(r.hosting) },
    { key: 'tc', label: 'Client', render: r => r.torrentClient || '—' },
    { key: 't', label: 'Torrent', render: r => <span className="block max-w-[260px] truncate" title={r.torrentName}>{r.torrentName || r.infohash}</span> },
  ]
  return (
    <Card flush title="Peer sightings" sub="Newest first — every IP:port seen in the client's swarms"
      action={<Btn onClick={() => downloadCsv('torrent-peers', cols.map(c => ({ key: c.key, label: c.label, get: (r: any) => ({
        ip: `${r.ip}:${r.port}`, d: String(r.dateAdded).slice(0, 10), c: r.country, rg: [r.region, r.city].filter(Boolean).join(' · '),
        isp: r.isp, org: r.organization, m: yn(r.mobile), p: yn(r.proxy), h: yn(r.hosting), tc: r.torrentClient, t: r.torrentName,
      } as any)[c.key] })), rows)} disabled={!rows.length}>⬇ CSV</Btn>}>
      <div className="px-5 py-3 flex gap-3" style={{ borderBottom: `1px solid ${d.divider}` }}>
        <TextInput value={ip} onChange={setIp} placeholder="Filter to one IP…" width={220} />
      </div>
      {err && <div className="p-5 text-xs" style={{ color: d.bad }}>{err}</div>}
      {!rows.length && busy ? <Loading label="Loading sightings" /> : (
        <>
          <Table cols={cols} rows={rows} rowKey={(r, i) => `${r.ip}:${r.port}:${r.infohash}:${i}`} maxHeight={480} minWidth={1300} empty="No sightings" />
          <div className="flex items-center gap-2 px-5 py-3 text-xs" style={{ color: d.sub, borderTop: `1px solid ${d.divider}`, ...BODY_FONT }}>
            <span>{nf(rows.length)} loaded</span>
            <span className="ml-auto" />
            <Btn onClick={() => next && load(next)} disabled={!next || busy}>{busy ? 'Loading…' : next ? 'Load 200 more' : 'All loaded'}</Btn>
          </div>
        </>
      )}
    </Card>
  )
}
