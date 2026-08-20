'use client'

// The Redis report cache, as something an operator can see and steer.
//
// Four questions, in the order they get asked: is it connected, is it doing any
// good, what is in it, and how do I make it refresh now.

import { useEffect, useRef, useState } from 'react'

interface Settings {
  addr: string; hasPassword: boolean; dbIndex: number; ttlMinutes: number
  warmEnabled: boolean; warmMinutes: number; warmDays: number; warmConc: number
  maxMemoryMb: number
  warmWindows: string
  /* Also precompute this month, last month and this year. The picker offers
     those three and no days-back range ever lands on their dates. */
  warmCalendar: boolean
  skipUnchanged: boolean
  /* How long a served entry may go unchecked. Distinct from ttlMinutes: that is
     how long an entry is KEPT, this is how stale it may get before a reader's
     own request triggers a check against the warehouse. */
  recheckMinutes: number
}
interface Memory {
  usedBytes: number; maxBytes: number; systemBytes: number; policy: string
}

/* Offered sizes. 0 means "leave whatever Redis was started with alone", which
   has to be an option — an operator on a managed Redis cannot change it at all
   and should not be forced to pick a number that will be refused. */
const SIZES = [
  { mb: 0, label: 'Leave as configured' },
  { mb: 256, label: '256 MB' },
  { mb: 512, label: '512 MB' },
  { mb: 1024, label: '1 GB' },
  { mb: 2048, label: '2 GB' },
  { mb: 3072, label: '3 GB' },
  { mb: 4096, label: '4 GB' },
  { mb: 5120, label: '5 GB' },
  { mb: 8192, label: '8 GB' },
]

/* Offered retentions. A day is the default: a report opened this afternoon
   should still be a read tomorrow morning, and it is only safe to keep one that
   long because staleness is handled separately — the entry is CHECKED every few
   minutes and rebuilt when the warehouse has moved under it. */
const LIFETIMES = [
  { min: 360,   label: '6 hours' },
  { min: 720,   label: '12 hours' },
  { min: 1440,  label: '24 hours' },
  { min: 4320,  label: '3 days' },
  { min: 10080, label: '7 days' },
]

/* How often a served entry is re-checked. 0 is offered because it is a real
   choice on a warehouse loaded once a night — the scheduled pass then does all
   the refreshing and no reader ever triggers a probe. */
const RECHECKS = [
  { min: 0,   label: 'Never — rely on the scheduled refresh' },
  { min: 2,   label: 'Every 2 minutes' },
  { min: 5,   label: 'Every 5 minutes' },
  { min: 10,  label: 'Every 10 minutes' },
  { min: 30,  label: 'Every 30 minutes' },
  { min: 60,  label: 'Every hour' },
  { min: 240, label: 'Every 4 hours' },
]

/* Short enough for a column, exact on hover.

   "8/19/2026, 2:38:04 AM" is twenty-one characters in a table with six columns,
   and two of them were dates — between them they were most of the width the
   table was overflowing by. The reader here is answering "was this refreshed
   recently", which a date and a minute answer. */
const when = (iso: string) => {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/* A duration someone reads to decide whether to wait or come back. Hours and
   minutes, never seconds past the first minute — "4h 12m" is the answer; "4h
   12m 07s" is the same answer with noise on it. */
const dur = (secs: number) => {
  if (secs < 60) return `${Math.max(0, Math.round(secs))}s`
  const m = Math.round(secs / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const hours = (m: number) =>
  m >= 1440 ? `${Math.round(m / 1440)} day${m >= 2880 ? 's' : ''}` : `${Math.round(m / 60)} hours`

// Shared by the summary line and the advanced field, so the two can never
// disagree about what was typed.
const windowList = (s: string) =>
  s.split(',').map(x => parseInt(x.trim(), 10)).filter(n => n > 0)

const gb = (b: number) => b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : Math.round(b / (1 << 20)) + ' MB'
interface Payload {
  settings: Settings
  connection: { connected: boolean; addr: string; dbIndex: number; ttlMinutes: number; error: string }
  stats: { hits: number; misses: number; writes: number; errors: number }
  warmer: {
    running: boolean; inFlight: boolean; intervalMin: number; windowDays: number
    concurrency: number; lastRun: string | null; lastCount: number; lastSkipped: number
    lastMs: number; lastError: string
    calendar?: boolean; windowCount?: number
  }
  server?: Record<string, string>
  memory?: Memory
  /* The last "cache these clients" request, per client. Without it a client
     still queued behind the concurrency cap and a client whose report produced
     nothing look identical — both simply absent from the list below. */
  onDemand?: OnDemand
  /* Which build's reports are in the cache. Entries are keyed to it, so a
     deploy invalidates them on its own — see reportcache/version.go. */
  engine?: { tag: string; source: string; otherBuilds?: number }
}
interface OnDemand {
  ran: boolean; running?: boolean; startedAt?: string; finishedAt?: string
  days?: number; from?: string; to?: string
  total?: number; done?: number; built?: number
  /* Measured, not estimated from a per-report cost — see OnDemandWarmStatus.
     What a report costs here is mostly waiting for the reports API request
     budget, which no fixed figure can predict. */
  etaSeconds?: number; elapsedSeconds?: number
  clients?: { clientId: string; clientName?: string; built: number; attempted: number; error: string }[]
}
interface Entry {
  platform: string; clientId: string; clientName: string; from: string; to: string
  storedAt: string; buildMs: number; bytes: number
}
/** One client's whole footprint in the cache. Sent for EVERY client the cache
    holds anything for, never truncated — see the entries handler. */
interface CacheClient {
  clientId: string; clientName: string; entries: number; platforms: number
  bytes: number; newest: string; oldest: string
}
/** A client the on-demand form can warm. `mapped` marks the ones the scheduled
    pass already covers, so the list says which choices add something. */
interface PickClient { id: string; name: string; mapped: boolean }

export default function ReportCachePanel() {
  const [d, setD]             = useState<Payload | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [query, setQuery]     = useState('')
  /* What is cached, what the search matched, and how many rows were sent. The
     header used to report the last of the three as though it were the first. */
  const [counts, setCounts]   = useState({ total: 0, matched: 0, shown: 0 })
  /* Every client the cache holds something for. Separate from `entries` because
     the row list is cut at a few hundred and this is not: the question "is this
     client cached" must not be answered by how far down the row list it fell. */
  const [cacheClients, setCacheClients] = useState<CacheClient[]>([])
  const [view, setView] = useState<'clients' | 'reports'>('clients')
  const [form, setForm]       = useState<Settings | null>(null)
  const [password, setPassword] = useState('')
  const [clientCount, setClientCount] = useState(0)
  /* The on-demand form. Its client list is the WAREHOUSE's, not the mapping's —
     the whole point is to reach a client the scheduled pass does not. */
  const [pickClients, setPickClients] = useState<PickClient[]>([])
  const [pickIds, setPickIds] = useState<string[]>([])
  const [pickDays, setPickDays] = useState(365)
  const [platformCount, setPlatformCount] = useState(0)
  const [busy, setBusy]       = useState('')
  const [msg, setMsg]         = useState('')
  const [err, setErr]         = useState('')

  async function load() {
    setErr('')
    try {
      const r = await fetch('/api/admin/report-cache', { credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not load'); return }
      setD(j); setForm(j.settings)
    } catch (e: any) { setErr(e?.message || 'Network error') }
  }
  /* Searched on the server, over everything cached — see the entries handler.
     Filtering here would only ever search the page it was sent, and answer "no
     such client" about a client that is cached. */
  async function loadEntries(q = query) {
    try {
      const r = await fetch(`/api/admin/report-cache/entries?q=${encodeURIComponent(q.trim())}`,
        { credentials: 'include' })
      const j = await r.json()
      setEntries(j.entries || [])
      setCacheClients(j.clients || [])
      setCounts({ total: j.total ?? 0, matched: j.matched ?? 0, shown: j.shown ?? 0 })
      if (typeof j.clientCount === 'number') setClientCount(j.clientCount)
    } catch { /* the panel above already says whether it is connected */ }
  }
  useEffect(() => { load() }, [])

  /* Debounced, so typing a company name is one request rather than one per
     keystroke against a read of the whole keyspace. This also does the first
     load — an empty box is the unfiltered list. */
  useEffect(() => {
    const t = setTimeout(() => loadEntries(query), query ? 250 : 0)
    return () => clearTimeout(t)
  }, [query])

  /* Polled while a pass is actually running.

     Both buttons here answer instantly and the work takes minutes, and nothing
     used to refresh the table afterwards — so "watch the list on the right
     fill" was an instruction the screen did not honour, and a client warmed a
     minute ago was genuinely missing from the list until someone reloaded the
     page. That absence is what reads as "the refresh is not running". */
  const warming = !!d?.onDemand?.running || !!d?.warmer?.inFlight
  useEffect(() => {
    if (!warming) return
    const t = setInterval(() => { load(); loadEntries(query) }, 5000)
    return () => clearInterval(t)
  }, [warming, query])

  // One last read once it stops, so the final few entries are not left out of
  // the table until the next thing happens to reload it.
  const wasWarming = useRef(false)
  useEffect(() => {
    if (wasWarming.current && !warming) { load(); loadEntries(query) }
    wasWarming.current = warming
  }, [warming])

  async function save() {
    if (!form) return
    setBusy('save'); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/admin/report-cache', {
        credentials: 'include', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, password }),
      })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not save'); return }
      setPassword('')
      /* The limit is reported separately from the save: the row stores either
         way, and a Redis that forbids CONFIG SET must not leave the screen
         implying a cap that is not in force. */
      if (j.memoryNote) setErr(j.memoryNote)
      setMsg(j.connected ? 'Saved and connected.' : `Saved, but not connected: ${j.error || 'unknown'}`)
      await load(); await loadEntries()
    } finally { setBusy('') }
  }

  /* Fetched when the form is first opened rather than on page load: it reads
     the warehouse's whole client directory, which is a request nobody visiting
     this screen to check a hit rate should pay for. */
  async function loadPickClients() {
    setBusy('clients')
    try {
      const r = await fetch('/api/admin/report-cache/clients', { credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not read the client list'); return }
      setPickClients(j.clients || [])
      if (typeof j.platformCount === 'number') setPlatformCount(j.platformCount)
    } catch (e: any) {
      setErr(e?.message || 'Could not read the client list')
    } finally { setBusy('') }
  }

  async function warmPicked() {
    if (pickIds.length === 0) return
    setBusy('warmClient'); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/admin/report-cache/warm-client', {
        credentials: 'include', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientIds: pickIds, days: pickDays }),
      })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not start'); return }
      // The button returns instantly and the work does not, so this says so
      // rather than leaving the screen looking as though nothing happened.
      setMsg(`Caching ${j.reports} report(s) in the background over the last ${pickDays} days. `
        + 'Progress is below; the list refreshes itself until it finishes.')
      // Read straight back so the progress block appears at once and the poll
      // above starts, rather than after whatever the operator does next.
      setView('clients')
      await load(); await loadEntries(query)
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally { setBusy('') }
  }

  async function sweep() {
    setBusy('sweep'); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/admin/report-cache/sweep', { credentials: 'include', method: 'POST' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not sweep'); return }
      setMsg(j.removed > 0
        ? `Freed ${j.removed} entrie(s) left by earlier builds.`
        : 'Nothing left by earlier builds.')
      await load(); await loadEntries(query)
    } catch (e: any) { setErr(e?.message || 'Network error') }
    finally { setBusy('') }
  }

  async function act(path: string, label: string) {
    setBusy(label); setMsg(''); setErr('')
    try {
      const r = await fetch(`/api/admin/report-cache/${path}`, { credentials: 'include', method: 'POST' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Failed'); return }
      setMsg(path === 'warm'
        // Said explicitly, because the button returns instantly and the work
        // does not — without this it reads as "nothing happened".
        ? 'Refresh started in the background. It runs through every client and platform; watch "last pass" below.'
        : `Removed ${j.removed} cached report(s).`)
      await load(); await loadEntries()
    } finally { setBusy('') }
  }

  if (!d || !form) return <p className="text-sm text-gray-500 p-6">{err || 'Loading…'}</p>

  const st = d.stats
  const total = st.hits + st.misses
  const hitRate = total > 0 ? ((st.hits / total) * 100).toFixed(1) + '%' : '—'
  /* What a pass actually covers: the rolling ranges plus the three calendar
     ones. Derived in one place because it is quoted in three, and the three
     disagreeing is how a screen stops being believed. */
  const rangeCount = (windowList(form.warmWindows).length || 1) + (form.warmCalendar ? 3 : 0)
  // How many reports one client costs in the pass being reported on.
  const perClient = Math.round((d.onDemand?.total || 0) / (d.onDemand?.clients?.length || 1))

  return (
    /* Full width, unlike the form-only panels. A fixed cap left dead space on a
       wide monitor while the entry table beside it was still clipping its last
       two columns — the width was there, it was just not being given to the
       thing that needed it. */
    <div className="w-full space-y-4">
      {err && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{err}</p>}
      {msg && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">{msg}</p>}

      {/* Connection + effect */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
        <div className="flex items-center gap-2 mb-4">
          <span className={`w-2 h-2 rounded-full ${d.connection.connected ? 'bg-emerald-500' : 'bg-red-400'}`} />
          <h3 className="font-semibold text-[#14254A]">
            {d.connection.connected ? 'Cache connected' : 'Cache not connected'}
          </h3>
          <span className="text-xs text-gray-500 font-mono">
            {d.connection.addr || '— no address —'}{d.connection.connected ? ` · db ${d.connection.dbIndex}` : ''}
          </span>
        </div>
        {!d.connection.connected && d.connection.error && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-4">
            {d.connection.error} — reports still work, they are just computed every time.
          </p>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            ['Hit rate', hitRate, 'since this server started'],
            ['Served from cache', st.hits.toLocaleString(), 'reports not recomputed'],
            ['Computed', st.misses.toLocaleString(), 'cache miss or disabled'],
            // The cache's own total, not the filtered page below it — a search
            // must not look like the cache emptied.
            ['Cached now', counts.total.toLocaleString(), 'reports held'],
          ].map(([k, v, n]) => (
            <div key={k} className="rounded-xl border border-gray-100 p-3">
              <p className="text-[10px] uppercase tracking-wide text-gray-500">{k}</p>
              <p className="text-xl font-bold text-[#14254A]">{v}</p>
              <p className="text-[10px] text-gray-400">{n}</p>
            </div>
          ))}
        </div>

        {d.server && (
          <p className="text-[11px] text-gray-500 mt-4">
            Redis {d.server.redis_version} · {d.server.used_memory_human} used
            {d.server.maxmemory_human && d.server.maxmemory_human !== '0B' ? ` of ${d.server.maxmemory_human}` : ''}
            {d.server.maxmemory_policy ? ` · policy ${d.server.maxmemory_policy}` : ''}
            {d.server.connected_clients ? ` · ${d.server.connected_clients} clients` : ''}
            {d.server.evicted_keys && d.server.evicted_keys !== '0' ? ` · ${d.server.evicted_keys} evicted` : ''}
          </p>
        )}
      </div>

      {/* Settings on the left, what they act on beside them — so pressing
          Refresh now and watching the list fill is one view rather than a
          scroll. `items-start` keeps each card its own height.

          NOT an even split. The left card is a form and stops being better past
          about 560px; the right one is a six-column table that was losing its
          last two columns to a scrollbar. The extra width goes where it is
          read. */}
      {/* `min-w-0` on the children is load-bearing, not decoration.

          A grid item's default min-width is `auto`, which means it may not
          shrink below its own content — so a table of nowrap cells widened its
          track, the track widened the grid, and the grid widened the PAGE. The
          card's own `overflow-hidden` could not help: nothing was overflowing,
          everything had simply grown. That is why the tables ran out past the
          white cards and the whole screen scrolled sideways.

          With `min-w-0` the track is free to be the width it was given, and the
          scroll happens where it was meant to — inside the table's own box. */}
      <div className="grid grid-cols-1 gap-4 items-start
                      xl:grid-cols-[minmax(420px,0.8fr)_1.2fr]">

      {/* Settings */}
      <div className="min-w-0 bg-white rounded-2xl shadow-card border border-gray-100 p-6">
        <h3 className="font-semibold text-[#14254A] mb-1">Connection</h3>
        <p className="text-xs text-gray-500 mb-4">
          Leave the address empty to switch the cache off — reports then compute on every request,
          exactly as they did before.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Address (host:port)">
            <input value={form.addr} onChange={e => setForm({ ...form, addr: e.target.value })}
              placeholder="redis:6379" className={inputCls} />
          </Field>
          <Field label="Password">
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={form.hasPassword ? 'Stored · leave blank to keep' : 'None'} className={inputCls} />
          </Field>
          <Field label="Database index">
            <input type="number" min={0} max={15} value={form.dbIndex}
              onChange={e => setForm({ ...form, dbIndex: +e.target.value })} className={inputCls} />
          </Field>
          {/* A list rather than a minute count. This is a retention policy, not
              a tuning knob, and "1440" is a number someone has to divide before
              they know what they are looking at. A value saved elsewhere that is
              not on the list is still shown and still kept. */}
          <Field label="Keep entries for"
            hint="How long a report stays servable. It is re-checked far sooner — see below.">
            <select value={form.ttlMinutes} className={inputCls}
              onChange={e => setForm({ ...form, ttlMinutes: +e.target.value })}>
              {LIFETIMES.some(l => l.min === form.ttlMinutes) ||
                <option value={form.ttlMinutes}>{form.ttlMinutes} minutes</option>}
              {LIFETIMES.map(l => <option key={l.min} value={l.min}>{l.label}</option>)}
            </select>
          </Field>
          <Field label="Memory limit" hint="Applied to the running Redis on save">
            <select value={form.maxMemoryMb} className={inputCls}
              onChange={e => setForm({ ...form, maxMemoryMb: +e.target.value })}>
              {SIZES.map(s => <option key={s.mb} value={s.mb}>{s.label}</option>)}
            </select>
          </Field>
        </div>

        {/* How full it is, against what the machine has. A cap is a number
            nobody can judge without both. */}
        {d.memory && (
          <div className="mt-3">
            <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, d.memory.maxBytes > 0
                    ? (d.memory.usedBytes / d.memory.maxBytes) * 100 : 2)}%`,
                  background: d.memory.maxBytes > 0 && d.memory.usedBytes / d.memory.maxBytes > 0.9
                    ? '#dc2626' : '#14254A',
                }} />
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              {gb(d.memory.usedBytes)} used of {d.memory.maxBytes > 0 ? gb(d.memory.maxBytes) : 'no limit'}
              {d.memory.systemBytes > 0 && <> · machine has {gb(d.memory.systemBytes)}</>}
              {/* Said explicitly, because this figure is REDIS's, not this
                  build's — it includes entries written by earlier builds, which
                  Empty the cache deliberately does not touch. Without this line
                  a purge that worked perfectly looks like one that did nothing. */}
              {!!d.engine?.otherBuilds && d.engine.otherBuilds > 0 && (
                <span className="block text-gray-400">
                  This is all of Redis. {d.engine.otherBuilds.toLocaleString()} of the keys
                  belong to earlier builds and are not cleared by Empty the cache — use
                  Free that memory below.
                </span>
              )}
              {d.memory.policy && d.memory.policy !== 'allkeys-lru' && (
                <span className="text-amber-700"> · policy {d.memory.policy} — with a cap and no eviction,
                  Redis refuses writes when full instead of discarding old entries. Saving a limit here also sets allkeys-lru.</span>
              )}
            </p>
            {/* Sized against the machine, because the failure is not gradual:
                a Redis allowed more than the host has is killed outright. */}
            {form.maxMemoryMb > 0 && d.memory.systemBytes > 0 &&
              form.maxMemoryMb * 1024 * 1024 > d.memory.systemBytes * 0.5 && (
              <p className="text-[11px] text-amber-700 mt-1">
                That is more than half of the machine&rsquo;s {gb(d.memory.systemBytes)}. Redis is killed outright
                if it is allowed more memory than the host can give it — leave room for everything else running here.
              </p>
            )}
            <p className="text-[11px] text-gray-400 mt-1">
              Applied to the running server. It does not survive a restart of Redis itself — this portal re-applies
              it on reconnect; to make it permanent set it where Redis is started
              (<code>--maxmemory</code> in docker-compose).
            </p>
          </div>
        )}

        {/* ── The one control that matters ──────────────────────────────
            Everything below it is a knob with a sensible default. This is the
            decision: keep every client ready, or do not. It says what it will
            do in plain numbers rather than making someone infer it from three
            fields. */}
        <div className="mt-6 pt-5 border-t border-gray-100">
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={form.warmEnabled} className="accent-[#14254A] mt-1 w-4 h-4"
              onChange={e => setForm({ ...form, warmEnabled: e.target.checked })} />
            <span>
              <span className="font-semibold text-[#14254A]">Keep every client&rsquo;s reports ready</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Precomputes each platform for {clientCount > 0 ? `all ${clientCount} mapped clients` : 'every mapped client'},
                so a report opens instantly instead of being built on the spot.
              </span>
            </span>
          </label>

          {form.warmEnabled && (
            <div className="mt-3 ml-7 rounded-xl bg-gray-50 border border-gray-100 p-3">
              <p className="text-xs text-gray-700">
                <strong>{rangeCount}</strong> date range{rangeCount === 1 ? '' : 's'} ·
                {' '}<strong>{clientCount || '—'}</strong> clients ·
                {' '}refreshed every <strong>{form.warmMinutes}</strong> min
              </p>
              <p className="text-[11px] text-gray-500 mt-1">
                Ranges: {windowList(form.warmWindows).map(d => `${d} days`).join(', ') || '30 days'}
                {form.warmCalendar && ', this month, last month, this year'}.
                {form.skipUnchanged
                  ? ' Only clients whose data has changed are rebuilt.'
                  : ' Everything is rebuilt every pass — slower, and rarely needed.'}
              </p>
            </div>
          )}
        </div>

        {/* ── Staleness, which is not the same question as retention ──────
            The field above says how long an entry is KEPT. This says how old it
            may get before it is CHECKED. Keeping a report for a day is only
            reasonable alongside this: without it, a day of retention is a day of
            stale numbers, which is the objection to caching at all. */}
        <div className="mt-6 pt-5 border-t border-gray-100">
          <h4 className="font-semibold text-[#14254A] text-sm">Picking up new data</h4>
          <p className="text-xs text-gray-500 mt-0.5 mb-3">
            A cached report is served immediately, then checked behind the answer: one cheap query asks
            whether the warehouse has more rows than it had when the report was built. If it has, the
            report is rebuilt in the background and the next reader gets the new numbers.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Re-check a report at most"
              hint="Per report, not per request — a report opened forty times an hour is checked a handful of times.">
              <select value={form.recheckMinutes} className={inputCls}
                onChange={e => setForm({ ...form, recheckMinutes: +e.target.value })}>
                {RECHECKS.some(x => x.min === form.recheckMinutes) ||
                  <option value={form.recheckMinutes}>Every {form.recheckMinutes} minutes</option>}
                {RECHECKS.map(x => <option key={x.min} value={x.min}>{x.label}</option>)}
              </select>
            </Field>
            <div className="self-end pb-1">
              <p className="text-[11px] text-gray-500">
                {form.recheckMinutes > 0
                  ? <>Numbers can be at most <strong>{form.recheckMinutes} min</strong> behind the warehouse
                      for someone reading the same report repeatedly, and are kept for {hours(form.ttlMinutes)}.</>
                  : <span className="text-amber-700">Off — a report will not change until the scheduled
                      refresh rebuilds it, or until it is {hours(form.ttlMinutes)} old.</span>}
              </p>
            </div>
          </div>
        </div>

        {/* Everything an operator sets once and then leaves alone. Folded away
            so the decision above is not buried in seven inputs. */}
        <details className="mt-4 group">
          <summary className="text-xs font-semibold text-[#14254A] cursor-pointer select-none">
            Advanced refresh settings
          </summary>
          <div className="mt-3 pl-1">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Every (minutes)">
                <input type="number" min={5} value={form.warmMinutes}
                  onChange={e => setForm({ ...form, warmMinutes: +e.target.value })} className={inputCls} />
              </Field>
              {/* Clamped as it is typed, not only on the server. `max` on a
                  number input binds the spinner and nothing else, so a typed
                  100 was stored as 100, shown as 100, and run as 4 — a setting
                  that reads as if it took effect is worse than one that refuses
                  the value.

                  This is how many reports are BUILT AT ONCE, not how many
                  clients the pass covers: every mapped client is refreshed on
                  every pass regardless of what this says. */}
              <Field label="Reports built at once"
                hint="Capped at 4 — the live page needs the warehouse too. This is not the number of clients.">
                <input type="number" min={1} max={4} value={form.warmConc}
                  onChange={e => setForm({
                    ...form,
                    warmConc: Math.min(4, Math.max(1, +e.target.value || 1)),
                  })} className={inputCls} />
              </Field>
            </div>

            <div className="mt-3">
              <Field label="Date ranges (days)"
                hint="Comma separated. 30, 90, 400 covers the month, the quarter and the year.">
                <input value={form.warmWindows} placeholder="30, 90, 400" className={inputCls}
                  onChange={e => setForm({ ...form, warmWindows: e.target.value })} />
              </Field>
              {/* The multiplier said out loud: ranges x platforms x clients is
                  the size of a pass, and it is what turns a small edit here into
                  an hour of warehouse time. */}
              <p className="text-[11px] text-gray-500 mt-1">
                {rangeCount > 1
                  ? `${rangeCount} ranges — each pass builds that many times as many reports.`
                  : 'One range. Add more to make other periods instant too.'}
              </p>
            </div>

            {/* The three presets no days-back number can express. A report is
                cached against its exact from/to, so warming "last 30 days" does
                nothing at all for a reader who picks "this month". */}
            <label className="flex items-start gap-2 text-sm mt-3">
              <input type="checkbox" checked={form.warmCalendar} className="accent-[#14254A] mt-0.5"
                onChange={e => setForm({ ...form, warmCalendar: e.target.checked })} />
              <span>
                Also this month, last month and this year
                <span className="block text-[11px] text-gray-500">
                  Calendar ranges from the date picker. Last month stops changing once the month ends,
                  so it costs one query a pass after that.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-sm mt-3">
              <input type="checkbox" checked={form.skipUnchanged} className="accent-[#14254A] mt-0.5"
                onChange={e => setForm({ ...form, skipUnchanged: e.target.checked })} />
              <span>
                Only rebuild what changed
                <span className="block text-[11px] text-gray-500">
                  Asks for a row count and the latest change time first — one query — and skips the other
                  eighteen when nothing has moved. Leave this on.
                </span>
              </span>
            </label>
          </div>
        </details>

        {/* ── Cache one client on demand ──────────────────────────────────────
            The scheduled pass covers the clients the portal has a mapping for,
            which is the right default and leaves a gap: a client being onboarded
            has no portal users yet, so its first report is the slow one. This
            reaches any client the warehouse knows, over any window, and does
            every platform for it without being asked platform by platform. */}
        <details className="mt-4 group">
          <summary className="text-xs font-semibold text-[#14254A] cursor-pointer select-none"
            onClick={() => { if (pickClients.length === 0) loadPickClients() }}>
            Cache a specific client
          </summary>
          <div className="mt-3 pl-1">
            <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">
              Builds every platform for the clients you pick, over the window you give — including
              clients the scheduled refresh does not cover because nothing is mapped to them yet.
              It runs alongside the scheduled pass rather than waiting for it.
            </p>

            <Field label="Clients">
              {pickClients.length === 0 ? (
                <p className="text-xs text-gray-500 py-2">
                  {busy === 'clients' ? 'Reading the client list…' : 'No client list available yet.'}
                </p>
              ) : (
                <div className="max-h-48 overflow-y-auto rounded-xl border border-gray-200 divide-y divide-gray-100">
                  {/* Sticky so it stays reachable in a list of several hundred,
                      and half-ticked when the selection is partial — the state
                      of the box then matches what is actually selected. */}
                  <label className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 text-sm
                                    bg-gray-50 border-b border-gray-200 cursor-pointer">
                    <input type="checkbox" className="accent-[#14254A]"
                      checked={pickIds.length === pickClients.length}
                      ref={el => { if (el) el.indeterminate = pickIds.length > 0 && pickIds.length < pickClients.length }}
                      onChange={e => setPickIds(e.target.checked ? pickClients.map(c => c.id) : [])} />
                    <span className="flex-1 font-medium text-gray-700">Select all</span>
                    <span className="text-[10px] text-gray-500">
                      {pickIds.length} of {pickClients.length}
                    </span>
                  </label>
                  {pickClients.map(c => (
                    <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                      <input type="checkbox" className="accent-[#14254A]"
                        checked={pickIds.includes(c.id)}
                        onChange={e => setPickIds(ids =>
                          e.target.checked ? [...ids, c.id] : ids.filter(x => x !== c.id))} />
                      <span className="flex-1 truncate">{c.name}</span>
                      {/* Says which choices add something the pass does not
                          already do, rather than leaving it to be guessed. */}
                      {c.mapped && <span className="text-[10px] text-gray-400">already scheduled</span>}
                    </label>
                  ))}
                </div>
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3 mt-3">
              <Field label="Days" hint="How far back to cache. 365 covers the year.">
                <input type="number" min={1} max={550} value={pickDays}
                  onChange={e => setPickDays(+e.target.value || 1)} className={inputCls} />
              </Field>
              <div className="flex items-end">
                <button onClick={warmPicked}
                  disabled={!!busy || !d.connection.connected || pickIds.length === 0}
                  className="px-4 py-2 text-sm rounded-xl border border-gray-200 hover:bg-gray-50 disabled:opacity-50 w-full">
                  {busy === 'warmClient'
                    ? 'Starting…'
                    : `Cache ${pickIds.length || ''} client${pickIds.length === 1 ? '' : 's'}`.replace('  ', ' ')}
                </button>
              </div>
            </div>
            {pickIds.length > 0 && platformCount > 0 && (
              <p className="text-[11px] text-gray-500 mt-2">
                {pickIds.length * platformCount} report{pickIds.length * platformCount === 1 ? '' : 's'} to
                build — {platformCount} platform{platformCount === 1 ? '' : 's'} × {pickIds.length} client
                {pickIds.length === 1 ? '' : 's'}.
              </p>
            )}
          </div>
        </details>

        <div className="flex items-center gap-3 mt-5 pt-5 border-t border-gray-100">
          <button onClick={save} disabled={!!busy}
            className="px-5 py-2 text-sm font-semibold text-white rounded-xl disabled:opacity-50"
            style={{ background: '#14254A' }}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => act('warm', 'warm')} disabled={!!busy || !d.connection.connected}
            className="px-4 py-2 text-sm rounded-xl border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
            {busy === 'warm' ? 'Starting…' : 'Refresh now'}
          </button>
          <button onClick={() => act('purge', 'purge')} disabled={!!busy || !d.connection.connected}
            className="px-4 py-2 text-sm rounded-xl text-red-600 hover:bg-red-50 disabled:opacity-50">
            Empty the cache
          </button>
          <span className="text-xs text-gray-500 ml-auto">
            {d.warmer.running
              ? <>Refresh is on{d.warmer.inFlight ? ' · running now' : ` · every ${d.warmer.intervalMin} min`}</>
              : 'Refresh is off'}
          </span>
        </div>

        {/* Which build these entries belong to.

            Here because the question it answers — "why is my fix not showing" —
            used to have no answer on this screen at all. Entries are keyed to
            the build that wrote them, so a deploy invalidates them without
            anyone pressing anything; what is left over is only memory. */}
        <div className="mt-4 pt-3 border-t border-gray-100 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[11px] text-gray-500">
            Cached reports are scoped to build <strong className="font-mono">{d.engine?.tag || '—'}</strong>
            {d.engine?.source && <> · identified by {d.engine.source}</>}
          </span>
          {d.engine?.source === 'the payload constant only' && (
            <span className="text-[11px] text-amber-700">
              Build identity unavailable — a change to how reports are computed will not clear the cache on its own.
            </span>
          )}
          {!!d.engine?.otherBuilds && d.engine.otherBuilds > 0 && (
            <>
              <span className="text-[11px] text-gray-500">
                · {d.engine.otherBuilds.toLocaleString()} entrie(s) left by earlier builds
              </span>
              <button onClick={sweep} disabled={busy === 'sweep'}
                className="text-[11px] text-[#14254A] hover:underline">
                {busy === 'sweep' ? 'Freeing…' : 'Free that memory'}
              </button>
            </>
          )}
        </div>

        {d.warmer.lastRun && (
          <p className="text-[11px] text-gray-500 mt-3">
            Last pass {new Date(d.warmer.lastRun).toLocaleString()} — {d.warmer.lastCount} rebuilt
            {d.warmer.lastSkipped > 0 && <>, {d.warmer.lastSkipped} unchanged</>}
            {' '}in {(d.warmer.lastMs / 1000).toFixed(1)}s
            {d.warmer.lastError ? <span className="text-amber-700"> · last error: {d.warmer.lastError}</span> : ''}
          </p>
        )}
      </div>

      {/* One COLUMN beside the settings, not two more cells in the grid.

         Auto-placement puts a third grid item back on row two, column one — so
         "What is cached" landed under the settings form rather than under the
         progress table it belongs with, and the two halves of the same story
         were in different columns. Stacking them here makes the grid two items
         wide, which is what the two-column template was describing. */}
      <div className="min-w-0 flex flex-col gap-4">

      {/* The last on-demand warm, while it runs and after it finishes.

          Shown because "this client is not in the list" has three different
          causes — still queued, produced nothing, or errored — and the list
          itself cannot tell them apart. */}
      {d.onDemand?.ran && (
        <div className="min-w-0 bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="font-semibold text-[#14254A]">Last on-demand caching</h3>
            <span className="text-xs text-gray-500">
              {d.onDemand.running
                ? `running — ${d.onDemand.done ?? 0} of ${d.onDemand.total ?? 0} report(s)`
                : `finished — ${d.onDemand.built ?? 0} of ${d.onDemand.total ?? 0} report(s) cached`}
              {typeof d.onDemand.elapsedSeconds === 'number' && ` · ${dur(d.onDemand.elapsedSeconds)} so far`}
              {/* Said out loud, because a pass of this size is hours and the
                  screen otherwise leaves someone watching a table that looks
                  stuck. */}
              {typeof d.onDemand.etaSeconds === 'number' &&
                ` · about ${dur(d.onDemand.etaSeconds)} left`}
              {d.onDemand.from && ` · ${d.onDemand.from} → ${d.onDemand.to}`}
            </span>
            {d.onDemand.running && (
              <span className="text-[11px] text-[#FC934C] font-medium">refreshing automatically</span>
            )}
          </div>
          <div className="overflow-auto" style={{ maxHeight: 260 }}>
            <table className="data-table">
              <thead><tr>{['Client', 'Cached', 'Result'].map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {(d.onDemand.clients || []).map(c => {
                  const queued = c.attempted === 0
                  return (
                    <tr key={c.clientId}>
                      <td className="text-xs text-gray-700 max-w-[220px] truncate" title={c.clientId}>
                        {c.clientName || c.clientId}
                      </td>
                      {/* The denominator comes from the pass itself — total
                          reports over clients asked for — rather than from the
                          picker's platform count, which is only loaded if
                          somebody opened that form this visit. After a reload it
                          was 0, and every queued row read "0 of —". */}
                      <td className="text-xs text-gray-600 whitespace-nowrap">
                        {c.built} of {perClient || c.attempted || '—'}
                      </td>
                      {/* Named outcomes, not a blank cell. A client that built
                          nothing is the whole reason someone is reading this. */}
                      <td className="text-xs whitespace-nowrap max-w-[260px] truncate"
                          title={c.error || ''}>
                        {queued
                          ? <span className="text-gray-400">Queued…</span>
                          : c.error
                            ? <span className="text-amber-700">{c.error}</span>
                            : c.built > 0
                              ? <span className="text-emerald-700">Cached</span>
                              : <span className="text-gray-500">No data for this window</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* What is in it */}
      <div className="min-w-0 bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="font-semibold text-[#14254A]">What is cached</h3>
          <span className="text-xs text-gray-500">
            {/* The client count leads, because that is the question actually
                being asked of this table. */}
            <strong>{cacheClients.length}</strong> client(s) ·{' '}
            {query
              ? `${counts.matched} of ${counts.total} report(s) match`
              : `${counts.total} report(s) held`}
          </span>
          {/* Wraps too. This group is a toggle, a search box and a link — some
              450px of controls in a card whose narrow layout is 420px, so
              without this it was the row that pushed the header wider than the
              card it sits in. */}
          <div className="ml-auto flex flex-wrap items-center gap-3 min-w-0">
            {/* Two views of the same data. "By client" is the default and is
                never truncated; "By report" is the detail behind it and is. */}
            <div className="inline-flex rounded-xl border border-gray-200 overflow-hidden">
              {([['clients', 'By client'], ['reports', 'By report']] as const).map(([v, label]) => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-3 py-1.5 text-xs ${view === v
                    ? 'bg-[#14254A] text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="relative">
              <input value={query} onChange={e => setQuery(e.target.value)}
                placeholder="Search client or platform"
                className="w-56 max-w-full pl-3 pr-7 py-1.5 text-xs rounded-xl border border-gray-200
                           focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
              {query && (
                <button onClick={() => setQuery('')} aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm leading-none">
                  ×
                </button>
              )}
            </div>
            <button onClick={() => loadEntries()} className="text-xs text-[#14254A] hover:underline whitespace-nowrap">
              Refresh list
            </button>
          </div>
        </div>

        {entries.length === 0 ? (
          <p className="px-6 py-8 text-sm text-gray-500 text-center">
            {query
              /* A search that found nothing is not an empty cache, and telling
                 someone to press Refresh now would be answering a question they
                 did not ask. */
              ? <>Nothing cached matches &ldquo;{query}&rdquo;{counts.total > 0 && <> — {counts.total} report(s) are cached under other names</>}.</>
              : <>Nothing cached yet. Open a report, or press <strong>Refresh now</strong>.</>}
          </p>
        ) : view === 'clients' ? (
          /* Every client with anything in the cache — the complete list, which
             is what "is this one being refreshed" needs and what the report
             rows below, cut at a few hundred, could not give. */
          <div className="overflow-auto" style={{ maxHeight: 560 }}>
            <table className="data-table">
              <thead><tr>{['Client', 'Reports', 'Platforms', 'Newest', 'Oldest', 'Size'].map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {cacheClients.map(c => (
                  <tr key={c.clientId}>
                    {/* The name, with the id on hover. A GUID identifies a row
                        to a machine and nothing to a reader. */}
                    {/* The one column allowed to be long, and the one that
                        gives way: everything beside it is a short number or a
                        short date, so the company name is where a narrow card
                        should take its space from. */}
                    <td className="text-sm font-medium text-gray-800 max-w-[220px] truncate" title={c.clientId}>
                      {c.clientName || c.clientId}
                    </td>
                    <td className="text-xs text-gray-600 whitespace-nowrap">{c.entries}</td>
                    <td className="text-xs text-gray-600 whitespace-nowrap">{c.platforms}</td>
                    {/* Newest is the freshness answer; oldest says whether part
                        of this client is about to fall out on its TTL. The full
                        timestamp is on hover — see `when`. */}
                    <td className="text-xs text-gray-600 whitespace-nowrap"
                        title={new Date(c.newest).toLocaleString()}>{when(c.newest)}</td>
                    <td className="text-xs text-gray-500 whitespace-nowrap"
                        title={new Date(c.oldest).toLocaleString()}>{when(c.oldest)}</td>
                    <td className="text-xs text-gray-600 whitespace-nowrap">{(c.bytes / 1024).toFixed(0)} KB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          /* Scrolls inside itself rather than growing the page: with several
             hundred entries this column would otherwise run far past the
             settings it sits beside. */
          <div className="overflow-auto" style={{ maxHeight: 560 }}>
            {/* Said out loud, where the cut actually happens, rather than in a
                header someone has already scrolled past. */}
            {counts.shown < counts.matched && (
              <p className="px-6 py-2 text-[11px] text-amber-700 bg-amber-50 border-b border-amber-100">
                Showing the newest {counts.shown} of {counts.matched} report(s). Every client is
                listed in full under <strong>By client</strong>, or search for one by name.
              </p>
            )}
            <table className="data-table">
              <thead><tr>{['Platform', 'Client', 'Window', 'Cached', 'Built in', 'Size'].map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i}>
                    <td className="text-sm font-medium text-gray-800 whitespace-nowrap">{e.platform}</td>
                    {/* The name, with the id on hover. A GUID identifies a row
                        to a machine and nothing to a reader. */}
                    <td className="text-xs text-gray-700 max-w-[200px] truncate" title={e.clientId}>
                      {e.clientName || e.clientId}
                    </td>
                    <td className="text-xs text-gray-600 whitespace-nowrap">{e.from} → {e.to}</td>
                    <td className="text-xs text-gray-600 whitespace-nowrap"
                        title={new Date(e.storedAt).toLocaleString()}>{when(e.storedAt)}</td>
                    {/* The saving, per entry: what a reader would have waited. */}
                    <td className="text-xs text-gray-600 whitespace-nowrap">{(e.buildMs / 1000).toFixed(1)}s</td>
                    <td className="text-xs text-gray-600 whitespace-nowrap">{(e.bytes / 1024).toFixed(0)} KB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      </div>{/* right-hand stack */}

      </div>
    </div>
  )
}

const inputCls = 'w-full px-3 py-2 text-sm rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-700 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-gray-400 mt-0.5">{hint}</span>}
    </label>
  )
}
