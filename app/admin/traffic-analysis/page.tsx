// /admin/traffic-analysis — SimilarWeb traffic for one client's domains.
//
// Every figure comes from reports_api's /v1/traffic/* (passed through by
// go-server/handlers/trafficanalysis.go). A client's domains are the linking
// and host hostnames its Open Web reports found; the service joins them to
// mediascan.InternetTrafficSimilarWeb and its six child tables.
//
// Four views over one scope (client · month · side · upload window):
//   Overview — the whole portfolio for a month, visit-weighted
//   Domains  — one row per domain, sortable, exportable
//   Domain   — one domain's full report, every month
//   Compare  — up to five domains side by side
//
// Visual language is the admin home page's (components/admin/AdminHomeClient):
// its brand palette and dark-mode lifts, its cards, and its navy-headed zebra
// tables that scroll inside their own frame. Pickers are the report's own —
// SearchableSelect and DateRangePicker.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, Cell, ReferenceLine, PieChart, Pie,
} from 'recharts'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DateRangePicker from '@/components/ui/DateRangePicker'
import {
  ORANGE, BODY_FONT, HEAD_FONT, useTok, nf, cmp, pct, flag, change, Card, Delta, Stat, Empty, Loading,
  Table, BarList, TrendArea, Btn, TextInput, Field, type Col, type Num, type Share,
} from '@/components/admin/analytics/ui'
import { downloadCsv, type CsvColumn } from '@/lib/exportCsv'
import CacheStatus from '@/components/admin/analytics/CacheStatus'
import { useSession } from '@/lib/auth-client'
import AnalyticsHeader from '@/components/admin/analytics/AnalyticsHeader'

/* ── types (loose: the service documents the shape) ───────────────────── */

interface Month { month: string; label: string; domains: number; visits: number; avgTimeOnSite: Num; pagesPerVisit: Num; bounceRate: Num }
interface DomainRow {
  domain: string; infringingUrls: number; sourceUrls: number; visits: Num; visitsPrev: Num; visitsChangePct: Num
  globalRank: Num; globalRankPrev: Num; countryRank: Num; country: string | null; countryIso: string | null
  categoryRank: Num; category: string | null; avgTimeOnSite: Num; pagesPerVisit: Num; bounceRate: Num
}
interface Scope { clientId: string; month: string; source: string; from: string; to: string }

/* ── format ─────────────────────────────────────────────────────────────── */

const dur = (s: Num | undefined) => {
  if (s == null) return '—'
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(h)}:${p(m)}:${p(sec)}`
}
const rank = (n: Num | undefined) => (n == null ? '—' : n.toLocaleString())
const catName = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ').replace(/\//g, ' › ') : '—')

/* The date range bounds the SimilarWeb months as well as choosing the client's
   domains — the same rule the service applies (a month is in when any day of it
   falls inside the range). The domain and compare views window client-side,
   because their endpoints return a domain's whole history. */
const inWindow = (month: string, from: string, to: string) =>
  (!from || month >= from.slice(0, 7)) && (!to || month <= to.slice(0, 7))
const fmtDay = (s: string) => {
  const d = new Date(s + 'T00:00:00')
  return isNaN(+d) ? s : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/* Where the page reads from. Staff use the admin pass-through and pick any
   client; a client login (Business Intelligence → Traffic Analysis) uses
   /api/bi/traffic-analysis, which pins the client to the login's own and
   refuses the cache controls. Set by the page on render — one page at a time. */
let API = '/api/admin/traffic-analysis'
// A client login: no cache wording anywhere on the page.
let CLIENT = false

async function getJSON(path: string, q: Record<string, string>) {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null))
  const res = await fetch(`${API}/${path}?${p}`, { credentials: 'include' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(neutral(body?.error || `Request failed (${res.status})`))
  return body
}

// The data source is never named on the page — its own wording included.
const neutral = (t: string) => t.replace(/similar\s*web/gi, 'traffic')

// Channels keep one palette slot everywhere they appear.
const CHANNELS = [
  { key: 'direct', label: 'Direct' }, { key: 'search', label: 'Search' },
  { key: 'referrals', label: 'Referrals' }, { key: 'social', label: 'Social' },
  { key: 'paidReferrals', label: 'Paid Referrals (Display)' }, { key: 'mail', label: 'Mail' },
]

function ChannelsStack({ data }: { data: any[] }) {
  const t = useTok()
  if (!data.length) return <Empty>No channel data</Empty>
  return (
    <ResponsiveContainer width="100%" height={250}>
      <AreaChart data={data} stackOffset="expand" margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={t.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} width={40} tickFormatter={v => `${Math.round(v * 100)}%`} />
        <Tooltip {...t.tip} formatter={(v: any, n: any) => [pct(Number(v)), n]} />
        <Legend wrapperStyle={{ fontSize: 11, color: t.d.sub }} iconType="circle" iconSize={8} />
        {CHANNELS.map((c, i) => (
          <Area key={c.key} type="monotone" dataKey={c.key} name={c.label} stackId="1"
            stroke={t.d.card} strokeWidth={1} fill={t.pal[i]} fillOpacity={0.95} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}

function ChannelMix({ rows }: { rows: Share[] }) {
  const t = useTok()
  if (!rows?.length) return <Empty>No channel data for this month</Empty>
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]))
  return (
    <div style={BODY_FONT}>
      <div className="flex h-4 rounded-sm overflow-hidden gap-[2px]">
        {CHANNELS.map((c, i) => {
          const s = byKey[c.key]?.share ?? 0
          return s > 0 ? <div key={c.key} title={`${c.label}: ${pct(s)}`} style={{ width: `${s}%`, background: t.pal[i] }} /> : null
        })}
      </div>
      <ul className="space-y-2 mt-4">
        {CHANNELS.map((c, i) => {
          const r = byKey[c.key]
          return (
            <li key={c.key} className="flex items-center gap-2 text-xs min-w-0">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: t.pal[i] }} />
              <span className="truncate" style={{ color: t.d.sub }}>{c.label}</span>
              <span className="ml-auto font-semibold tabular-nums" style={{ color: t.d.text }}>{pct(r?.share)}</span>
              {r?.visits != null && <span className="text-[10.5px] tabular-nums w-12 text-right" style={{ color: t.d.sub }}>{cmp(r.visits)}</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ── top-N charts ─────────────────────────────────────────────────────────
   The short "top" lists (≤10 shown) are drawn as charts. A list the service
   returns longer than ten keeps its full scrolling list one click away. */

type ChartKind = 'bar' | 'column' | 'donut' | 'pie'
const nameOf = (r: Share) => `${r.iso ? flag(r.iso) + ' ' : ''}${r.name ?? r.label ?? '—'}`
const clip = (v: string, n: number) => (v.length > n ? v.slice(0, n - 1) + '…' : v)

function TopChart({ rows, kind, color, value = r => r.share ?? 0, fmt = v => pct(v), tip, top = 10, height, list }:
  { rows: Share[]; kind: ChartKind; color?: string; value?: (r: Share) => number; fmt?: (v: number) => string
    tip?: (r: Share) => string; top?: number; height?: number; list?: ReactNode }) {
  const t = useTok()
  const { d } = t
  const [all, setAll] = useState(false)
  if (!rows?.length) return <Empty>No data for this month</Empty>
  const head = rows.slice(0, top)
  const more = rows.length > top && list
  const toggle = more && (
    <div className="flex justify-end mt-1" style={BODY_FONT}>
      <button className="text-[11px] font-semibold hover:underline" style={{ color: ORANGE }} onClick={() => setAll(v => !v)}>
        {all ? '← Back to chart' : `All ${rows.length} →`}
      </button>
    </div>
  )
  if (all && more) return <>{list}{toggle}</>

  const data = head.map(r => ({ name: nameOf(r), v: value(r), r }))
  const tipFmt = (v: any, _n: any, it: any) => [tip && it?.payload?.r ? tip(it.payload.r) : fmt(Number(v)), it?.payload?.name]

  if (kind === 'donut' || kind === 'pie') {
    // Shares are of 100%; what the top slices leave is "Other".
    const rest = Math.round((100 - data.reduce((a, x) => a + (x.v || 0), 0)) * 100) / 100
    const slices = [...data, ...(rest > 0.5 ? [{ name: 'Other', v: rest, r: null as any }] : [])]
    return (
      <>
        <ResponsiveContainer width="100%" height={height ?? 280}>
          <PieChart>
            <Pie data={slices} dataKey="v" nameKey="name" innerRadius={kind === 'donut' ? '55%' : 0} outerRadius="85%"
              paddingAngle={kind === 'donut' ? 1 : 0} stroke={d.card} strokeWidth={2} isAnimationActive={false}>
              {slices.map((x, i) => <Cell key={i} fill={x.name === 'Other' ? d.track : t.pal[i % t.pal.length]} />)}
            </Pie>
            <Tooltip {...t.tip} formatter={(v: any, n: any, it: any) => [it?.payload?.r && tip ? tip(it.payload.r) : pct(Number(v)), n]} />
            <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" iconSize={8}
              wrapperStyle={{ fontSize: 11, color: d.sub, maxWidth: '48%' }}
              formatter={(v: string, e: any) => `${clip(v, 24)} · ${pct(e?.payload?.v)}`} />
          </PieChart>
        </ResponsiveContainer>
        {toggle}
      </>
    )
  }

  if (kind === 'column') return (
    <>
      <ResponsiveContainer width="100%" height={height ?? 280}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid stroke={t.grid} vertical={false} />
          <XAxis dataKey="name" interval={0} tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false}
            angle={-35} textAnchor="end" height={72} tickFormatter={(v: string) => clip(v, 16)} />
          <YAxis tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} width={44} tickFormatter={v => fmt(v)} />
          <Tooltip {...t.tip} cursor={{ fill: t.grid }} formatter={tipFmt} labelFormatter={() => ''} />
          <Bar dataKey="v" fill={color || d.series} radius={[4, 4, 0, 0]} maxBarSize={40} />
        </BarChart>
      </ResponsiveContainer>
      {toggle}
    </>
  )

  return (
    <>
      <ResponsiveContainer width="100%" height={height ?? Math.max(160, data.length * 28 + 24)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={t.grid} horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} tickFormatter={v => fmt(v)} />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={false} width={130}
            tickFormatter={(v: string) => clip(v, 20)} />
          <Tooltip {...t.tip} cursor={{ fill: t.grid }} formatter={tipFmt} labelFormatter={() => ''} />
          <Bar dataKey="v" fill={color || d.series} radius={[0, 4, 4, 0]} barSize={16} />
        </BarChart>
      </ResponsiveContainer>
      {toggle}
    </>
  )
}

const SOURCE_OPTIONS = [
  { key: 'all', label: 'Linking + hosting sites' },
  { key: 'infringing', label: 'Linking (infringing) sites' },
  { key: 'source', label: 'Hosting (source) sites' },
]
const today = () => new Date().toISOString().slice(0, 10)

/* ── page ───────────────────────────────────────────────────────────────── */

type Tab = 'overview' | 'domains' | 'domain' | 'compare'

export default function TrafficAnalysisPage({ client = false }: { client?: boolean }) {
  API = client ? '/api/bi/traffic-analysis' : '/api/admin/traffic-analysis'
  CLIENT = client
  const { data: session } = useSession()
  // The cache badge is operational detail: Super Admins only.
  const superAdmin = !client && (session?.user as any)?.role === 2
  const { d } = useTok()
  const [clients, setClients] = useState<{ key: string; label: string }[]>([])
  const [clientsErr, setClientsErr] = useState('')
  const [scope, setScope] = useState<Scope>({ clientId: '', month: '', source: 'all', from: '', to: '' })
  const [tab, setTab] = useState<Tab>('overview')
  const [months, setMonths] = useState<Month[]>([])
  const [domain, setDomain] = useState('')
  const [compareList, setCompareList] = useState<string[]>([])
  const [nonce, setNonce] = useState(0) // bumps on Refresh

  useEffect(() => {
    fetch(`${API}/clients`, { credentials: 'include' })
      .then(r => r.json())
      .then(b => {
        if (!b?.clients) throw new Error(b?.error || 'Could not load clients')
        const list = b.clients.map((c: any) => ({ key: String(c.id), label: String(c.name || c.id) }))
        setClients(list)
        // A client login has exactly one client — its own — chosen for it.
        if (client && list.length) setScope(s => ({ ...s, clientId: list[0].key }))
      })
      .catch(e => setClientsErr(e.message))
  }, [])

  const set = (patch: Partial<Scope>) => setScope(s => ({ ...s, ...patch }))
  const openDomain = useCallback((dn: string) => { setDomain(dn); setTab('domain') }, [])
  const addCompare = useCallback((dn: string) => {
    setCompareList(l => (l.includes(dn) || l.length >= 5 ? l : [...l, dn])); setTab('compare')
  }, [])
  const monthOptions = useMemo(() => [
    { key: '', label: 'Latest complete month' },
    ...[...months].reverse().map(m => ({ key: m.month, label: m.label, count: m.domains })),
  ], [months])

  return (
    <div className={`${client ? '' : 'p-6 '}fade-in space-y-5`}>
      <AnalyticsHeader client={client} title="Traffic Analysis"
        description={client ? 'Traffic, engagement, channels and audience of the sites carrying your content.'
          : "Traffic, engagement, channels and audience for the domains in a client's Open Web reports."}
        actions={superAdmin ? <CacheStatus url="/api/admin/traffic-analysis/cache" kind="traffic" /> : undefined} />

      {/* Scope bar — the report's own pickers */}
      <div className="rounded-xl p-4 flex flex-wrap items-end gap-4" style={{ background: d.card, border: `1px solid ${d.cardBorder}` }}>
        {!client && (
          <Field label="Client" width={300}>
            <SearchableSelect options={clients} value={scope.clientId} clearable={false}
              onChange={v => { setScope(s => ({ ...s, clientId: v, month: '' })); setMonths([]); setDomain(''); setCompareList([]) }}
              placeholder={clientsErr || 'Select a client'} ariaLabel="Client" />
          </Field>
        )}
        <Field label="Traffic month" width={210}>
          <SearchableSelect options={monthOptions} value={scope.month} clearable={false}
            onChange={v => set({ month: v })} disabled={!months.length} placeholder="Latest complete month" ariaLabel="Month" />
        </Field>
        <Field label="Domains from" width={220}>
          <SearchableSelect options={SOURCE_OPTIONS} value={scope.source} clearable={false}
            onChange={v => set({ source: v || 'all' })} ariaLabel="Domains from" />
        </Field>
        <Field label="URL upload date" width={260}>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <DateRangePicker value={{ from: scope.from, to: scope.to }} max={today()}
                onChange={r => set({ from: r.from, to: r.to, month: '' })} />
            </div>
            {(scope.from || scope.to) && (
              <button className="text-[11px] font-semibold whitespace-nowrap hover:underline" style={{ color: ORANGE, ...BODY_FONT }}
                onClick={() => set({ from: '', to: '', month: '' })} title="Every upload date">All dates</button>
            )}
          </div>
        </Field>
        {!client && (
          <div className="ml-auto">
            <Btn onClick={() => setNonce(n => n + 1)} disabled={!scope.clientId} title="Recompute instead of using the 10-minute cache">↻ Refresh</Btn>
          </div>
        )}
      </div>

      <nav className="flex flex-wrap gap-2" aria-label="Views">
        {([['overview', 'Portfolio overview'], ['domains', 'Domains'], ['domain', 'Domain report'], ['compare', 'Compare']] as [Tab, string][])
          .map(([k, l]) => <Btn key={k} active={tab === k} onClick={() => setTab(k)}>{l}{k === 'compare' && compareList.length ? ` (${compareList.length})` : ''}</Btn>)}
      </nav>

      {!scope.clientId ? (
        <Card>{client
          ? (clientsErr ? <div className="text-xs" style={{ color: d.bad, ...BODY_FONT }}>{clientsErr}</div> : <Loading label="Loading your traffic analysis" />)
          : <Empty>Select a client to analyse the traffic of the sites carrying its content.</Empty>}</Card>
      ) : tab === 'overview' ? (
        <Overview scope={scope} nonce={nonce} onMonths={setMonths} onDomain={openDomain} />
      ) : tab === 'domains' ? (
        <Domains scope={scope} nonce={nonce} onDomain={openDomain} onCompare={addCompare} compareList={compareList} />
      ) : tab === 'domain' ? (
        <DomainReport scope={scope} nonce={nonce} domain={domain} setDomain={setDomain} onCompare={addCompare} />
      ) : (
        <Compare scope={scope} nonce={nonce} list={compareList} setList={setCompareList} onDomain={openDomain} />
      )}
    </div>
  )
}

function useLoad<T>(path: string, q: Record<string, string> | null, nonce: number) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const key = q ? JSON.stringify(q) : ''
  const [seenNonce, setSeenNonce] = useState(nonce)
  useEffect(() => {
    if (!q) { setData(null); return }
    let live = true
    const refresh = nonce !== seenNonce
    setSeenNonce(nonce)
    setLoading(true); setErr('')
    const started = performance.now()
    getJSON(path, refresh ? { ...q, refresh: '1' } : q)
      .then(b => { if (live) setData({ ...b, _loadMs: performance.now() - started }) })
      .catch(e => { if (live) { setErr(e.message); setData(null) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, nonce])
  return { data, err, loading }
}

function Status({ loading, err, label, sublabel }: { loading: boolean; err: string; label?: string; sublabel?: string }) {
  const { d } = useTok()
  if (err) return <Card><div className="text-xs" style={{ color: d.bad, ...BODY_FONT }}>{err}</div></Card>
  if (loading) return <Card><Loading label={label} sublabel={sublabel} /></Card>
  return null
}

const scopeQ = (s: Scope) => ({ clientId: s.clientId, month: s.month, source: s.source, from: s.from, to: s.to })

function DomainLink({ dn, onDomain }: { dn: string; onDomain: (d: string) => void }) {
  const { d } = useTok()
  return (
    <button className="font-semibold hover:underline text-left truncate max-w-[260px] block" style={{ color: d.text }}
      onClick={() => onDomain(dn)} title={dn}>{dn}</button>
  )
}

/* ── overview ───────────────────────────────────────────────────────────── */

function Overview({ scope, nonce, onMonths, onDomain }:
  { scope: Scope; nonce: number; onMonths: (m: Month[]) => void; onDomain: (d: string) => void }) {
  const { data: o, err, loading } = useLoad<any>('overview', scopeQ(scope), nonce)
  const t = useTok()
  const { d } = t
  useEffect(() => { if (o?.months) onMonths(o.months) }, [o, onMonths])

  if (loading || err) return <Status loading={loading} err={err} label="Running the traffic analysis"
    sublabel={CLIENT ? 'Reading traffic data for every domain · this can take up to 20 seconds'
      : 'Reading traffic data for every domain of this client · first load ~20s, then cached for 10 minutes'} />
  if (!o) return null
  const c = o.counts || {}
  if (!o.month) return (
    <Card><Empty>{o.note ? neutral(o.note) : 'No traffic data yet.'} {c.domains ? `${nf(c.domains)} domains found in this client's reports, ${nf(c.trackedDomains)} with traffic data.` : ''}</Empty></Card>
  )
  const k = o.kpis || {}
  const months: Month[] = o.months || []

  return (
    <div className="space-y-5">
      <p className="text-xs" style={{ color: d.sub, ...BODY_FONT }}>
        <b style={{ color: d.text }}>{o.monthLabel}</b>{o.previousMonthLabel ? ` compared with ${o.previousMonthLabel}` : ''} ·
        {' '}trends {months.length ? `${months[0].label} – ${months[months.length - 1].label}` : '—'}
        {!CLIENT && o._loadMs != null && <> · <b style={{ color: o._loadMs < 1500 ? d.good : d.text }}>loaded in {(o._loadMs / 1000).toFixed(1)}s{o._loadMs < 1500 ? ' (cached)' : ''}</b></>}
        {scope.from || scope.to
          ? <> · domains with URLs uploaded <b style={{ color: d.text }}>{scope.from ? fmtDay(scope.from) : 'any date'} – {scope.to ? fmtDay(scope.to) : 'today'}</b></>
          : ' · every upload date'}
        {' '}· {nf(c.domains)} domains in this client's reports · {nf(c.knownDomains)} in the domain master · {nf(c.trackedDomains)} with traffic data ·
        {' '}{nf(c.infringingUrls)} linking URLs · {nf(c.sourceUrls)} hosting URLs
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <Stat label="Monthly visits" value={cmp(k.visits)} delta={k.visitsChangePct} invert hint={k.visitsPrev != null ? `prev ${cmp(k.visitsPrev)}` : undefined} accent />
        <Stat label="Domains with data" value={nf(k.domains)} delta={change(k.domains, k.domainsPrev)} invert hint={`of ${nf(c.domains)}`} />
        <Stat label="Visits / domain" value={cmp(k.visitsPerDomain)} />
        <Stat label="Avg visit duration" value={dur(k.avgTimeOnSite)} delta={change(k.avgTimeOnSite, k.avgTimeOnSitePrev)} invert />
        <Stat label="Pages / visit" value={k.pagesPerVisit?.toFixed(2) ?? '—'} delta={change(k.pagesPerVisit, k.pagesPerVisitPrev)} invert />
        <Stat label="Bounce rate" value={pct(k.bounceRate)} delta={change(k.bounceRate, k.bounceRatePrev)} />
        <Stat label="Best global rank" value={rank(k.bestGlobalRank)} hint={k.medianGlobalRank ? `median ${rank(k.medianGlobalRank)}` : undefined} />
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <Card title="Total visits over time" sub="Sum of monthly visits across the client's domains" className="lg:col-span-2">
          <TrendArea data={months} dataKey="visits" fmt={v => cmp(v)} name="Visits" height={260} mark={o.monthLabel} />
        </Card>
        <Card title="Domains measured per month" sub="How many of the client's domains have traffic figures each month">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={months} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={t.grid} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} width={40} />
              <Tooltip {...t.tip} cursor={{ fill: t.grid }} formatter={(v: any) => [nf(Number(v)), 'Domains']} />
              <Bar dataKey="domains" radius={[4, 4, 0, 0]}>
                {months.map(m => <Cell key={m.month} fill={m.month === o.month ? ORANGE : d.series} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div className="grid md:grid-cols-3 gap-5">
        <Card title="Avg visit duration" sub="Visit-weighted, per month"><TrendArea data={months} dataKey="avgTimeOnSite" fmt={v => dur(v)} name="Duration" height={170} color={t.pal[4]} mark={o.monthLabel} /></Card>
        <Card title="Pages per visit" sub="Visit-weighted, per month"><TrendArea data={months} dataKey="pagesPerVisit" fmt={v => v.toFixed(2)} name="Pages / visit" height={170} color={t.pal[5]} mark={o.monthLabel} /></Card>
        <Card title="Bounce rate" sub="Visit-weighted, per month"><TrendArea data={months} dataKey="bounceRate" fmt={v => pct(v, 0)} name="Bounce rate" height={170} color={ORANGE} mark={o.monthLabel} /></Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <Card title="Marketing channels" sub={`Traffic sources, ${o.monthLabel} · visit-weighted`}>
          <ChannelMix rows={o.channels || []} />
        </Card>
        <Card title="Channel mix over time" sub="Share of visits by source, each month" className="lg:col-span-2">
          <ChannelsStack data={o.channelsTrend || []} />
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <Card title="Geography" sub="Top countries by estimated visits (Σ domain visits × country share)">
          <TopChart kind="bar" rows={o.countries || []} color={d.series} value={r => r.visits ?? 0} fmt={v => cmp(v)}
            tip={r => `${cmp(r.visits)} visits · ${pct(r.share)} · ${r.domains} domains`}
            list={<BarList rows={o.countries || []} color={d.series}
              value={r => `${pct(r.share)} · ${cmp(r.visits)}`} sub={r => `${r.domains} domains`} />} />
        </Card>
        <Card title="Website categories" sub="Category of each domain, by visits">
          <TopChart kind="donut" top={8} rows={(o.categories || []).map((r: any) => ({ ...r, name: catName(r.name) }))}
            tip={r => `${pct(r.share)} · ${cmp(r.visits)} visits · ${r.domains} domains`}
            list={<BarList rows={(o.categories || []).map((r: any) => ({ ...r, name: catName(r.name) }))} color={ORANGE}
              value={r => `${pct(r.share)} · ${cmp(r.visits)}`} sub={r => `${r.domains} domains`} />} />
        </Card>
        <Card title="Global rank distribution" sub="Domains per global-rank band">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={o.rankBuckets || []} layout="vertical" margin={{ top: 0, right: 24, left: 8, bottom: 0 }}>
              <CartesianGrid stroke={t.grid} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={false} width={80} />
              <Tooltip {...t.tip} cursor={{ fill: t.grid }} formatter={(v: any, _n: any, p: any) => [`${nf(Number(v))} domains · ${cmp(p.payload.visits)} visits`, 'Band']} />
              <Bar dataKey="domains" fill={d.series} radius={[0, 4, 4, 0]} barSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <Card title="Social networks" sub="Top social referrers, weighted by domain visits">
          <TopChart kind="donut" top={8} rows={o.social || []}
            tip={r => `${pct(r.share)} · ${r.domains} domains · avg ${pct(r.avgValue)} of social traffic`}
            list={<BarList rows={o.social || []} color={t.pal[4]} value={r => pct(r.share)} sub={r => `${r.domains} domains · avg ${pct(r.avgValue)} of social traffic`} />} />
        </Card>
        <Card title="Display ad networks" sub="Top ad networks, weighted by domain visits">
          <TopChart kind="column" rows={o.adNetworks || []} color={d.series} tip={r => `${pct(r.share)} · ${r.domains} domains`}
            list={<BarList rows={o.adNetworks || []} color={t.pal[5]} value={r => pct(r.share)} sub={r => `${r.domains} domains`} />} />
        </Card>
        <Card title="Display publishers / referrers" sub="Top publishers sending display traffic">
          <TopChart kind="bar" rows={o.publishers || []} color={ORANGE} tip={r => `${pct(r.share)} · ${r.domains} domains`}
            list={<BarList rows={o.publishers || []} color={t.pal[6]} value={r => pct(r.share)} sub={r => `${r.domains} domains`} />} />
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <Movers title="▼ Biggest traffic drops" rows={o.decliners || []} onDomain={onDomain} />
        <Movers title="▲ Biggest traffic increases" rows={o.gainers || []} onDomain={onDomain} rising />
      </div>

      <Card title={`Top ${(o.topDomains || []).length} domains by visits — ${o.monthLabel}`} sub="Click a domain for its full report" flush>
        <DomainTable rows={o.topDomains || []} onDomain={onDomain} />
      </Card>
    </div>
  )
}

/* These are infringing sites, so the colours read from the rights-holder's
   side: traffic FALLING is the good news (green ▼), rising is the bad (red ▲). */
function Movers({ title, rows, onDomain, rising }: { title: string; rows: any[]; onDomain: (d: string) => void; rising?: boolean }) {
  const t = useTok()
  const { d } = t
  const [asTable, setAsTable] = useState(false)
  const cols: Col<any>[] = [
    { key: 'i', label: '#', render: (_r, i) => <span className="font-mono" style={{ color: d.sub }}>{i + 1}</span>, width: 40 },
    { key: 'domain', label: 'Domain', render: r => <DomainLink dn={r.domain} onDomain={onDomain} /> },
    { key: 'prev', label: 'Previous', align: 'right', render: r => <span style={{ color: d.sub }}>{cmp(r.visitsPrev)}</span> },
    { key: 'cur', label: 'Visits', align: 'right', render: r => <b>{cmp(r.visits)}</b> },
    { key: 'delta', label: 'Change', align: 'right', render: r => <b style={{ color: rising ? d.bad : d.good }}>{r.delta > 0 ? '▲ +' : '▼ '}{cmp(r.delta)}</b> },
  ]
  return (
    <Card title={title} sub="Change in monthly visits against the previous month · click a bar for the domain" flush={asTable}
      action={rows.length ? <button className="text-[11px] font-semibold hover:underline" style={{ color: ORANGE }} onClick={() => setAsTable(v => !v)}>{asTable ? 'Chart' : 'Table'}</button> : undefined}>
      {asTable || !rows.length ? <Table cols={cols} rows={rows} rowKey={r => r.domain} maxHeight={330} empty="No movers" /> : (
        <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 28 + 24)}>
          <BarChart data={rows.map(r => ({ ...r, v: Math.abs(r.delta) }))} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={t.grid} horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} tickFormatter={v => `${rising ? '+' : '−'}${cmp(v)}`} />
            <YAxis type="category" dataKey="domain" tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={false} width={150}
              tickFormatter={(v: string) => clip(v, 24)} />
            <Tooltip {...t.tip} cursor={{ fill: t.grid }} labelFormatter={() => ''}
              formatter={(_v: any, _n: any, it: any) => [`${cmp(it.payload.visitsPrev)} → ${cmp(it.payload.visits)} (${it.payload.delta > 0 ? '+' : ''}${cmp(it.payload.delta)})`, it.payload.domain]} />
            <Bar dataKey="v" fill={rising ? d.bad : d.good} radius={[0, 4, 4, 0]} barSize={16} cursor="pointer"
              onClick={(x: any) => x?.domain && onDomain(x.domain)} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  )
}

const DOMAIN_COLS: CsvColumn<DomainRow>[] = [
  { key: 'domain', label: 'Domain' }, { key: 'visits', label: 'Visits' }, { key: 'visitsPrev', label: 'Visits (prev month)' },
  { key: 'visitsChangePct', label: 'Visits change %' }, { key: 'globalRank', label: 'Global rank' },
  { key: 'countryRank', label: 'Country rank' }, { key: 'country', label: 'Main country' },
  { key: 'categoryRank', label: 'Category rank' }, { key: 'category', label: 'Category' },
  { key: 'avgTimeOnSite', label: 'Avg visit duration (s)' }, { key: 'pagesPerVisit', label: 'Pages / visit' },
  { key: 'bounceRate', label: 'Bounce rate %' }, { key: 'infringingUrls', label: 'Linking URLs' }, { key: 'sourceUrls', label: 'Hosting URLs' },
]

function DomainTable({ rows, onDomain, onCompare, compareList, sort, onSort, maxHeight = 460, offset = 0 }:
  { rows: DomainRow[]; onDomain: (d: string) => void; onCompare?: (d: string) => void; compareList?: string[]
    sort?: string; onSort?: (s: string) => void; maxHeight?: number; offset?: number }) {
  const { d } = useTok()
  const cols: Col<DomainRow>[] = [
    { key: 'i', label: '#', render: (_r, i) => <span className="font-mono" style={{ color: d.sub }}>{offset + i + 1}</span>, width: 48 },
    { key: 'domain', label: 'Domain', sort: 'domain', render: r => <DomainLink dn={r.domain} onDomain={onDomain} /> },
    { key: 'visits', label: 'Visits', align: 'right', sort: 'visits', render: r => <b style={{ color: ORANGE }}>{nf(r.visits)}</b> },
    { key: 'mom', label: 'MoM', align: 'right', sort: 'change', render: r => <Delta v={r.visitsChangePct} invert /> },
    { key: 'grank', label: 'Global rank', align: 'right', sort: 'rank', render: r => rank(r.globalRank) },
    { key: 'crank', label: 'Country rank', align: 'right', render: r => <>{rank(r.countryRank)} <span title={r.country ?? ''}>{flag(r.countryIso)}</span></> },
    { key: 'cat', label: 'Category', render: r => <span className="block max-w-[220px] truncate" style={{ color: d.sub }} title={catName(r.category)}>{catName(r.category)}{r.categoryRank ? ` (${rank(r.categoryRank)})` : ''}</span> },
    { key: 'dur', label: 'Duration', align: 'right', sort: 'duration', render: r => dur(r.avgTimeOnSite) },
    { key: 'ppv', label: 'Pages / visit', align: 'right', render: r => r.pagesPerVisit?.toFixed(2) ?? '—' },
    { key: 'bounce', label: 'Bounce', align: 'right', sort: 'bounce', render: r => pct(r.bounceRate) },
    { key: 'inf', label: 'Linking URLs', align: 'right', sort: 'urls', render: r => nf(r.infringingUrls) },
    { key: 'src', label: 'Hosting URLs', align: 'right', render: r => nf(r.sourceUrls) },
  ]
  if (onCompare) cols.push({
    key: 'cmp', label: '', align: 'right', render: r => {
      const added = compareList?.includes(r.domain)
      return (
        <button className="text-[11px] font-semibold disabled:opacity-40 hover:underline" style={{ color: added ? d.sub : ORANGE }}
          disabled={added || (compareList?.length ?? 0) >= 5} onClick={() => onCompare(r.domain)}>{added ? '✓ added' : '+ Compare'}</button>
      )
    },
  })
  return <Table cols={cols} rows={rows} rowKey={r => r.domain} sort={sort} onSort={onSort} maxHeight={maxHeight} minWidth={1100} empty="No domains" />
}

/* ── domains ────────────────────────────────────────────────────────────── */

function Domains({ scope, nonce, onDomain, onCompare, compareList }:
  { scope: Scope; nonce: number; onDomain: (d: string) => void; onCompare: (d: string) => void; compareList: string[] }) {
  const { d } = useTok()
  const [sort, setSort] = useState('visits')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [tracked, setTracked] = useState(true)
  const [page, setPage] = useState(0)
  const size = 100
  useEffect(() => { const h = setTimeout(() => { setQ(search); setPage(0) }, 350); return () => clearTimeout(h) }, [search])
  const query = { ...scopeQ(scope), sort, q, tracked: tracked ? '1' : '', limit: String(size), offset: String(page * size) }
  const { data: o, err, loading } = useLoad<any>('domains', query, nonce)
  const [exporting, setExporting] = useState(false)

  const exportAll = async () => {
    setExporting(true)
    try {
      const b = await getJSON('domains', { ...query, limit: 'all', offset: '0' })
      downloadCsv(`traffic-domains-${b.month || 'all'}`, DOMAIN_COLS, b.rows || [])
    } finally { setExporting(false) }
  }

  return (
    <Card flush title={o?.monthLabel ? `Domains — ${o.monthLabel}` : 'Domains'}
      sub={o ? `${nf(o.total)} domains${tracked ? ' with traffic data this month' : ' in the client\'s reports'} · sorted by ${sort}` : undefined}
      action={<Btn onClick={exportAll} disabled={exporting || !o?.total}>{exporting ? 'Exporting…' : '⬇ CSV'}</Btn>}>
      <div className="flex flex-wrap items-center gap-4 px-5 py-3" style={{ borderBottom: `1px solid ${d.divider}` }}>
        <TextInput value={search} onChange={setSearch} placeholder="Search domain…" />
        <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: d.sub, ...BODY_FONT }}>
          <input type="checkbox" checked={tracked} style={{ accentColor: ORANGE }} onChange={e => { setTracked(e.target.checked); setPage(0) }} />
          Only domains with traffic data
        </label>
      </div>
      {loading ? <Loading label="Loading domains" sublabel={o?.monthLabel ? `Traffic · ${o.monthLabel}` : 'Traffic per domain'} /> : err ? <div className="p-5 text-xs" style={{ color: d.bad }}>{err}</div> : o && (
        <>
          <DomainTable rows={o.rows || []} onDomain={onDomain} onCompare={onCompare} compareList={compareList}
            sort={sort} onSort={s => { setSort(s); setPage(0) }} offset={page * size} maxHeight={520} />
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

/* ── one domain ─────────────────────────────────────────────────────────── */

function DomainReport({ scope, nonce, domain, setDomain, onCompare }:
  { scope: Scope; nonce: number; domain: string; setDomain: (d: string) => void; onCompare: (d: string) => void }) {
  const t = useTok()
  const { d } = t
  const [input, setInput] = useState(domain)
  useEffect(() => setInput(domain), [domain])
  const { data: o, err, loading } = useLoad<any>('domain',
    domain ? { clientId: scope.clientId, domain, source: scope.source, from: scope.from, to: scope.to } : null, nonce)
  const [sel, setSel] = useState('')
  const allMonths: any[] = o?.months || []
  const months: any[] = useMemo(() => allMonths.filter(m => inWindow(m.month, scope.from, scope.to)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [o, scope.from, scope.to])
  useEffect(() => {
    if (!months.length) return
    setSel(scope.month && months.find(m => m.month === scope.month) ? scope.month : months[months.length - 1].month)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months, scope.month])
  const cur = months.find(m => m.month === sel) || months[months.length - 1]
  // Previous month from the full history, so MoM still works at the window's edge.
  const idx = cur ? allMonths.indexOf(cur) : -1
  const prev = idx > 0 ? allMonths[idx - 1] : null
  const monthOpts = useMemo(() => [...months].reverse().map(m => ({ key: m.month, label: m.label })), [months])

  const monthCols: Col<any>[] = [
    { key: 'm', label: 'Month', render: m => <b>{m.label}</b> },
    { key: 'v', label: 'Visits', align: 'right', render: m => <b style={{ color: ORANGE }}>{nf(m.visits)}</b> },
    { key: 'mom', label: 'MoM', align: 'right', render: m => <Delta v={m.visitsChangePct} invert /> },
    { key: 'g', label: 'Global rank', align: 'right', render: m => rank(m.globalRank) },
    { key: 'c', label: 'Country rank', align: 'right', render: m => <>{rank(m.countryRank)} {flag(m.countryIso)}</> },
    { key: 'k', label: 'Category rank', align: 'right', render: m => rank(m.categoryRank) },
    { key: 'dur', label: 'Duration', align: 'right', render: m => dur(m.avgTimeOnSite) },
    { key: 'ppv', label: 'Pages / visit', align: 'right', render: m => m.pagesPerVisit?.toFixed(2) ?? '—' },
    { key: 'b', label: 'Bounce', align: 'right', render: m => pct(m.bounceRate) },
  ]
  const countryCols: Col<any>[] = [
    { key: 'n', label: 'Country', render: r => <span>{flag(r.iso)} {r.name}</span> },
    { key: 's', label: 'Share', align: 'right', render: r => <b>{pct(r.share)}</b> },
    { key: 'v', label: 'Visits', align: 'right', render: r => cmp(r.visits) },
    { key: 'c', label: 'Change', align: 'right', render: r => <Delta v={r.change} /> },
  ]

  return (
    <div className="space-y-5">
      <div className="rounded-xl p-4 flex flex-wrap items-end gap-4" style={{ background: d.card, border: `1px solid ${d.cardBorder}` }}>
        <Field label="Domain">
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setDomain(input.trim().toLowerCase()) }}>
            <TextInput value={input} onChange={setInput} placeholder="example.com" width={280} />
            <Btn type="submit" active>Analyse</Btn>
          </form>
        </Field>
        {months.length > 0 && (
          <Field label="Month" width={180}>
            <SearchableSelect options={monthOpts} value={sel} clearable={false} onChange={v => v && setSel(v)} ariaLabel="Domain month" />
          </Field>
        )}
        {o?.domain && (
          <div className="ml-auto flex items-center gap-3">
            <a className="text-xs font-semibold hover:underline" style={{ color: ORANGE, ...BODY_FONT }} href={`https://${o.domain}`} target="_blank" rel="noopener noreferrer nofollow">Open site ↗</a>
            <Btn onClick={() => onCompare(o.domain)}>+ Compare</Btn>
          </div>
        )}
      </div>

      {!domain ? <Card><Empty>Enter a domain, or open one from the Overview or Domains view.</Empty></Card>
        : loading || err ? <Status loading={loading} err={err} label="Opening the domain report" sublabel={domain} />
        : !o ? null
        : !months.length ? <Card><Empty>{allMonths.length ? `No traffic month for ${domain} inside the chosen date range (data covers ${allMonths[0].label} – ${allMonths[allMonths.length - 1].label}).` : `No traffic data for ${domain} yet.`}</Empty></Card>
        : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1" style={BODY_FONT}>
              <h2 style={{ ...HEAD_FONT, color: d.text, fontWeight: 700, fontSize: 18 }}>{o.domain}</h2>
              {o.rootDomain && o.rootDomain !== o.domain && <span className="text-xs" style={{ color: d.sub }}>root {o.rootDomain}</span>}
              <span className="text-xs" style={{ color: d.sub }}>{catName(cur?.category)}</span>
              {o.client && (
                <span className="text-xs" style={{ color: d.sub }}>
                  {o.client.inScope ? <>In this client's reports: <b style={{ color: d.text }}>{nf(o.client.infringingUrls)}</b> linking · <b style={{ color: d.text }}>{nf(o.client.sourceUrls)}</b> hosting URLs</> : 'Not in this client\'s reports for the chosen scope'}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
              <Stat label="Global rank" value={rank(cur?.globalRank)} delta={prev ? change(prev.globalRank, cur?.globalRank) : null} invert hint={prev?.globalRank ? `prev ${rank(prev.globalRank)}` : undefined} />
              <Stat label="Country rank" value={rank(cur?.countryRank)} hint={cur?.country ? `${flag(cur.countryIso)} ${cur.country}` : undefined} />
              <Stat label="Category rank" value={rank(cur?.categoryRank)} hint={catName(cur?.category)} />
              <Stat label="Total visits" value={cmp(cur?.visits)} delta={cur?.visitsChangePct} invert accent />
              <Stat label="Avg visit duration" value={dur(cur?.avgTimeOnSite)} delta={change(cur?.avgTimeOnSite, prev?.avgTimeOnSite)} invert />
              <Stat label="Pages / visit" value={cur?.pagesPerVisit?.toFixed(2) ?? '—'} delta={change(cur?.pagesPerVisit, prev?.pagesPerVisit)} invert />
              <Stat label="Bounce rate" value={pct(cur?.bounceRate)} delta={change(cur?.bounceRate, prev?.bounceRate)} />
            </div>

            <div className="grid lg:grid-cols-3 gap-5">
              <Card title="Visits over time" sub="Monthly visits, every month on record" className="lg:col-span-2">
                <TrendArea data={months} dataKey="visits" fmt={v => cmp(v)} name="Visits" height={260} mark={cur?.label} />
              </Card>
              <Card title="Global rank over time" sub="Lower is better">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={months} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={t.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis reversed tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} width={52} tickFormatter={v => cmp(v)} domain={['auto', 'auto']} />
                    <Tooltip {...t.tip} formatter={(v: any) => [rank(Number(v)), 'Global rank']} />
                    <Line type="monotone" dataKey="globalRank" stroke={ORANGE} strokeWidth={2} dot={false} connectNulls activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </Card>
            </div>

            <div className="grid md:grid-cols-3 gap-5">
              <Card title="Avg visit duration"><TrendArea data={months} dataKey="avgTimeOnSite" fmt={v => dur(v)} name="Duration" height={170} color={t.pal[4]} /></Card>
              <Card title="Pages per visit"><TrendArea data={months} dataKey="pagesPerVisit" fmt={v => v.toFixed(2)} name="Pages / visit" height={170} color={t.pal[5]} /></Card>
              <Card title="Bounce rate"><TrendArea data={months} dataKey="bounceRate" fmt={v => pct(v, 0)} name="Bounce rate" height={170} color={ORANGE} /></Card>
            </div>

            <div className="grid lg:grid-cols-3 gap-5">
              <Card title="Marketing channels" sub={`Traffic sources, ${cur?.label}`}><ChannelMix rows={cur?.channels || []} /></Card>
              <Card title="Channel mix over time" className="lg:col-span-2">
                <ChannelsStack data={months.filter(m => m.channels?.length).map(m => ({
                  label: m.label, ...Object.fromEntries(m.channels.map((c: any) => [c.key, c.share])),
                }))} />
              </Card>
            </div>

            <div className="grid lg:grid-cols-2 gap-5">
              <Card title="Top countries" sub={`Share of ${cur?.label} visits`}>
                <TopChart kind="pie" rows={cur?.countries || []} tip={r => `${pct(r.share)} · ${cmp(r.visits)} visits`}
                  list={<Table cols={countryCols} rows={cur?.countries || []} rowKey={(r, i) => (r.id || r.name) + i} maxHeight={300} empty="No country data for this month" />} />
              </Card>
              <Card title="Social networks" sub="Share of social traffic">
                <TopChart kind="donut" rows={cur?.social || []}
                  tip={r => `${pct(r.share)}${r.change ? ` · change ${r.change > 0 ? '+' : ''}${pct(r.change)}` : ''}`}
                  list={<BarList rows={cur?.social || []} color={t.pal[4]} value={r => pct(r.share)}
                    sub={r => (r.change == null || r.change === 0 ? null : <>change <Delta v={r.change} /></>)} />} />
              </Card>
              <Card title="Display ad networks" sub="Share of display traffic">
                <TopChart kind="column" rows={cur?.adNetworks || []} color={t.d.series}
                  list={<BarList rows={cur?.adNetworks || []} color={t.pal[5]} value={r => pct(r.share)} />} />
              </Card>
              <Card title="Display publishers / referrers" sub="Share of display traffic">
                <TopChart kind="bar" rows={cur?.publishers || []} color={ORANGE}
                  list={<BarList rows={cur?.publishers || []} color={t.pal[6]} value={r => pct(r.share)} />} />
              </Card>
            </div>

            <Card title="Month by month" sub="Every month on record for this domain" flush action={
              <Btn onClick={() => downloadCsv(`traffic-${o.domain}`, [
                { key: 'label', label: 'Month' }, { key: 'visits', label: 'Visits' }, { key: 'visitsChangePct', label: 'Change %' },
                { key: 'globalRank', label: 'Global rank' }, { key: 'countryRank', label: 'Country rank' }, { key: 'country', label: 'Country' },
                { key: 'categoryRank', label: 'Category rank' }, { key: 'category', label: 'Category' },
                { key: 'avgTimeOnSite', label: 'Avg duration (s)' }, { key: 'pagesPerVisit', label: 'Pages / visit' }, { key: 'bounceRate', label: 'Bounce %' },
              ], months)}>⬇ CSV</Btn>}>
              <Table cols={monthCols} rows={[...months].reverse()} rowKey={m => m.month} maxHeight={360} minWidth={820}
                selected={m => m.month === cur?.month} />
            </Card>
          </>
        )}
    </div>
  )
}

/* ── compare ────────────────────────────────────────────────────────────── */

function Compare({ scope, nonce, list, setList, onDomain }:
  { scope: Scope; nonce: number; list: string[]; setList: (l: string[]) => void; onDomain: (d: string) => void }) {
  const t = useTok()
  const { d } = t
  const [input, setInput] = useState('')
  const { data: o, err, loading } = useLoad<any>('compare',
    list.length ? { clientId: scope.clientId, domains: list.join(','), source: scope.source, from: scope.from, to: scope.to } : null, nonce)
  const doms: any[] = useMemo(() => (o?.domains || []).map((x: any) => ({
    ...x, months: (x.months || []).filter((m: any) => inWindow(m.month, scope.from, scope.to)),
  })), [o, scope.from, scope.to])
  // Compared domains keep one palette slot each, in the order they were added.
  const colorOf = (i: number) => t.pal[i]

  const merged = useMemo(() => {
    const by: Record<string, any> = {}
    doms.forEach((x, i) => (x.months || []).forEach((m: any) => {
      by[m.month] ??= { month: m.month, label: m.label }
      by[m.month][`v${i}`] = m.visits
    }))
    return Object.values(by).sort((a: any, b: any) => a.month.localeCompare(b.month))
  }, [doms])
  const common = useMemo(() => {
    if (!doms.length) return ''
    const sets = doms.map(x => new Set((x.months || []).map((m: any) => m.month)))
    const all = [...(sets[0] || [])].sort().reverse() as string[]
    return all.find(m => sets.every(s => s.has(m))) || ''
  }, [doms])
  const at = (x: any) => (x.months || []).find((m: any) => m.month === common) || null
  const add = () => {
    const v = input.trim().toLowerCase()
    if (v && !list.includes(v) && list.length < 5) setList([...list, v])
    setInput('')
  }

  const cols: Col<any>[] = [
    { key: 'dom', label: 'Domain', render: (x, i) => (
      <span className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colorOf(i) }} />
        <DomainLink dn={x.domain} onDomain={onDomain} />
        {!x.tracked && <span className="text-[11px]" style={{ color: d.sub }}>no data</span>}
      </span>) },
    { key: 'v', label: 'Visits', align: 'right', render: x => <b style={{ color: ORANGE }}>{nf(at(x)?.visits)}</b> },
    { key: 'mom', label: 'MoM', align: 'right', render: x => <Delta v={at(x)?.visitsChangePct} invert /> },
    { key: 'g', label: 'Global rank', align: 'right', render: x => rank(at(x)?.globalRank) },
    { key: 'c', label: 'Country rank', align: 'right', render: x => <>{rank(at(x)?.countryRank)} {flag(at(x)?.countryIso)}</> },
    { key: 'cat', label: 'Category', render: x => <span className="block max-w-[200px] truncate" style={{ color: d.sub }}>{catName(at(x)?.category)}</span> },
    { key: 'dur', label: 'Duration', align: 'right', render: x => dur(at(x)?.avgTimeOnSite) },
    { key: 'ppv', label: 'Pages / visit', align: 'right', render: x => at(x)?.pagesPerVisit?.toFixed(2) ?? '—' },
    { key: 'b', label: 'Bounce', align: 'right', render: x => pct(at(x)?.bounceRate) },
    { key: 'ch', label: 'Top channel', render: x => {
      const top = [...(at(x)?.channels || [])].sort((a: any, b: any) => b.share - a.share)[0]
      return top ? `${top.label} ${pct(top.share, 0)}` : '—'
    } },
    { key: 'co', label: 'Top country', render: x => {
      const top = at(x)?.countries?.[0]
      return top ? `${flag(top.iso)} ${top.name} ${pct(top.share, 0)}` : '—'
    } },
  ]

  return (
    <div className="space-y-5">
      <div className="rounded-xl p-4 flex flex-wrap items-center gap-2" style={{ background: d.card, border: `1px solid ${d.cardBorder}`, ...BODY_FONT }}>
        {list.map((x, i) => (
          <span key={x} className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg"
            style={{ color: d.text, background: d.kpiBg, border: `1px solid ${d.cardBorder}` }}>
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: colorOf(i) }} />{x}
            <button className="ml-1 hover:opacity-70" style={{ color: d.sub }} aria-label={`Remove ${x}`} onClick={() => setList(list.filter(y => y !== x))}>×</button>
          </span>
        ))}
        {list.length < 5 && (
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); add() }}>
            <TextInput value={input} onChange={setInput} placeholder="Add a domain…" width={220} />
            <Btn type="submit" active>Add</Btn>
          </form>
        )}
        <span className="text-[11px] ml-auto" style={{ color: d.sub }}>Up to 5 domains · add from the Domains table or a domain report</span>
      </div>

      {!list.length ? <Card><Empty>Add domains to compare their traffic side by side.</Empty></Card>
        : loading || err ? <Status loading={loading} err={err} label="Comparing domains" sublabel={list.join(' · ')} />
        : (
          <>
            <Card title="Visits over time" sub="Monthly visits per domain">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={merged} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={t.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} width={48} tickFormatter={v => cmp(v)} />
                  <Tooltip {...t.tip} formatter={(v: any, n: any) => [cmp(Number(v)), n]} />
                  <Legend wrapperStyle={{ fontSize: 11, color: d.sub }} iconType="circle" iconSize={8} />
                  {doms.map((x, i) => (
                    <Line key={x.domain} type="monotone" dataKey={`v${i}`} name={x.domain} stroke={colorOf(i)} strokeWidth={2} dot={false} connectNulls activeDot={{ r: 4 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </Card>

            <Card flush title={`Side by side${common ? ` — ${doms.map(at).find(Boolean)?.label}` : ''}`}
              sub={common ? 'Latest month every compared domain has data for' : 'These domains share no month of data'}>
              <Table cols={cols} rows={doms} rowKey={x => x.domain} maxHeight={360} minWidth={1100} />
            </Card>

            <Card title="Marketing channels compared" sub="Share of each domain's visits by source, in the side-by-side month">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={CHANNELS.map(c => ({
                  label: c.label,
                  ...Object.fromEntries(doms.map((x, i) => [`v${i}`, at(x)?.channels?.find((y: any) => y.key === c.key)?.share ?? null])),
                }))} margin={{ top: 6, right: 8, left: 0, bottom: 0 }} barGap={2}>
                  <CartesianGrid stroke={t.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} width={40} tickFormatter={v => `${v}%`} />
                  <Tooltip {...t.tip} cursor={{ fill: t.grid }} formatter={(v: any, n: any) => [pct(Number(v)), n]} />
                  <Legend wrapperStyle={{ fontSize: 11, color: d.sub }} iconType="circle" iconSize={8} />
                  {doms.map((x, i) => <Bar key={x.domain} dataKey={`v${i}`} name={x.domain} fill={colorOf(i)} radius={[4, 4, 0, 0]} />)}
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </>
        )}
    </div>
  )
}
