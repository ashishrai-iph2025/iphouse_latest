'use client'

// "Keep the most-used clients ready" — the top-clients auto-cache, on the
// Cache & Redis tab (handlers/admin/autotop.go).
//
// Every open of a client's Reports, Traffic Analysis or Torrent Analysis is
// counted; on a schedule the top N clients by those opens have their reports
// and analytics views built ahead, so the people who use the portal most never
// wait. Sits beside the tab's existing options and changes none of them.

import { useEffect, useState } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DatePicker from '@/components/ui/DatePicker'

interface Settings {
  enabled: boolean; topN: number; lookbackDays: number; everyMinutes: number
  reports: boolean; traffic: boolean; torrent: boolean
  // The period kept ready — at most a year, rolling with the schedule.
  periodMode: 'days' | 'months' | 'start'; reportDays: number; months: number; startDate: string
}
interface RankRow {
  rank: number; clientId: string; clientName?: string
  counts: Record<string, number>; total: number; lastDay: string; inTopN: boolean
  cached: { reports: number; traffic: boolean; torrent: boolean }
}
interface RunClient {
  clientId: string; clientName?: string
  reports?: { ready: number; attempted: number; error?: string }
}
interface Run {
  trigger: string; startedAt: string; finishedAt: string; stage: string
  period?: { label: string; note?: string }
  clients?: RunClient[]; trafficSent: boolean; torrentSent: boolean; error?: string
}

const opt = (vals: [number, string][]) => vals.map(([v, l]) => ({ key: String(v), label: l }))
const TOPS = opt([[5, 'Top 5'], [10, 'Top 10'], [15, 'Top 15'], [20, 'Top 20'], [30, 'Top 30'], [50, 'Top 50']])
const LOOKBACKS = opt([[1, 'Today'], [7, 'Last 7 days'], [14, 'Last 14 days'], [30, 'Last 30 days']])
const EVERY = opt([[30, 'Every 30 minutes'], [60, 'Every hour'], [120, 'Every 2 hours'], [360, 'Every 6 hours'],
  [720, 'Every 12 hours'], [1440, 'Once a day']])
const WINDOWS = opt([[7, 'Last 7 days'], [15, 'Last 15 days'], [30, 'Last 30 days'], [90, 'Last 90 days'],
  [180, 'Last 180 days'], [365, 'Last 365 days (1 year)']])
const MONTHS = opt([[1, 'This month'], [2, 'Last 2 months'], [3, 'Last 3 months'], [6, 'Last 6 months'],
  [9, 'Last 9 months'], [12, 'Last 12 months (1 year)']])
const MODES = [{ key: 'days', label: 'Last N days' }, { key: 'months', label: 'Month by month' }, { key: 'start', label: 'From a start date' }]
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const yearAgo = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 365); return isoDay(d) }
const when = (v?: string) => (!v || v.startsWith('0001') ? '—' : new Date(v).toLocaleString())
const took = (a?: string, b?: string) => {
  if (!a || !b || b.startsWith('0001')) return ''
  const s = Math.max(0, Math.round((+new Date(b) - +new Date(a)) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export default function AutoTopPanel() {
  const [data, setData] = useState<any>(null)
  const [form, setForm] = useState<Settings | null>(null)
  // Older saved settings predate the period: fill what they lack.
  const withPeriod = (x: any): Settings => ({ periodMode: 'days', months: 3, startDate: '', ...x })
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')

  async function load() {
    try {
      const r = await fetch('/api/admin/report-cache/autotop', { credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not load'); return }
      setErr(''); setData(j); setForm(f => f ?? withPeriod(j.settings))
    } catch (e: any) { setErr(e?.message || 'Network error') }
  }
  useEffect(() => { load() }, [])
  const running = !!data?.status?.running
  useEffect(() => {
    if (!running) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [running])

  async function save(next: Settings) {
    setBusy('save'); setMsg('')
    try {
      const r = await fetch('/api/admin/report-cache/autotop', {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not save'); return }
      setData(j); setForm(withPeriod(j.settings)); setMsg('Saved.')
    } catch (e: any) { setErr(e?.message || 'Network error') } finally { setBusy('') }
  }
  async function runNow() {
    setBusy('run'); setMsg('')
    try {
      const r = await fetch('/api/admin/report-cache/autotop/run', { method: 'POST', credentials: 'include' })
      const j = await r.json()
      if (!j.success) setErr(j.error || 'Could not start')
      else setMsg(j.started ? 'Started — the list below fills in as it goes.' : (j.detail || 'Already running.'))
      await load()
    } catch (e: any) { setErr(e?.message || 'Network error') } finally { setBusy('') }
  }

  if (!form) {
    return (
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 mt-6">
        <p className="text-sm text-gray-500">{err || 'Loading…'}</p>
      </div>
    )
  }
  const set = (p: Partial<Settings>) => setForm(f => (f ? { ...f, ...p } : f))
  const dirty = JSON.stringify(form) !== JSON.stringify(withPeriod(data?.settings || {}))
  const last: Run | undefined = data?.status?.last
  const ranking: RankRow[] = data?.ranking || []

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden mt-6">
      <div className="p-6 space-y-4">
        {/* The switch — the same shape as "Keep every client's reports ready" */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className="mt-1 w-4 h-4 accent-[#14254A]" checked={form.enabled}
            onChange={e => save({ ...form, enabled: e.target.checked })} disabled={busy !== ''} />
          <span>
            <span className="block font-semibold text-[#14254A]">Keep the most-used clients ready</span>
            <span className="block text-xs text-gray-500 mt-0.5 max-w-3xl">
              Counts every time someone opens a client&rsquo;s Reports, Traffic Analysis or Torrent Analysis, and on a schedule
              builds ahead the reports and views of the clients opened most — so they open instantly. Works beside the options
              above and changes none of them; reports whose data has not moved since they were cached are left as they are.
            </span>
          </span>
          <span className="ml-auto shrink-0 text-xs whitespace-nowrap">
            {running
              ? <span className="text-[#FC934C] font-medium">● running — {last?.stage || 'working'}</span>
              : form.enabled
                ? <span className="text-emerald-700">● on{data?.status?.nextRun && !String(data.status.nextRun).startsWith('0001') ? ` · next ${when(data.status.nextRun)}` : ' · first pass within a minute'}</span>
                : <span className="text-gray-400">○ off</span>}
          </span>
        </label>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="How many clients">
            <SearchableSelect options={TOPS} value={String(form.topN)} clearable={false} onChange={v => v && set({ topN: +v })} ariaLabel="How many clients" />
          </Field>
          <Field label="Ranked by opens in">
            <SearchableSelect options={LOOKBACKS} value={String(form.lookbackDays)} clearable={false} onChange={v => v && set({ lookbackDays: +v })} ariaLabel="Look back" />
          </Field>
          <Field label="Refresh">
            <SearchableSelect options={EVERY} value={String(form.everyMinutes)} clearable={false} onChange={v => v && set({ everyMinutes: +v })} ariaLabel="Refresh every" />
          </Field>
        </div>

        {/* The period kept ready — for Reports, Traffic and Torrent alike, at most a year */}
        <div className="rounded-xl border border-gray-100 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Period kept ready (max 1 year)">
              <div className="inline-flex rounded-xl border border-gray-200 overflow-hidden">
                {MODES.map(m => (
                  <button key={m.key} type="button" onClick={() => set({ periodMode: m.key as Settings['periodMode'],
                    ...(m.key === 'start' && !form.startDate ? { startDate: isoDay(new Date(Date.now() - 90 * 864e5)) } : {}) })}
                    className={`px-3 py-2 text-xs ${form.periodMode === m.key ? 'bg-[#14254A] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                    {m.label}
                  </button>
                ))}
              </div>
            </Field>
            <div className="min-w-[220px] flex-1 max-w-sm">
              {form.periodMode === 'days' && (
                <SearchableSelect options={WINDOWS} value={String(form.reportDays)} clearable={false}
                  onChange={v => v && set({ reportDays: +v })} ariaLabel="Last N days" />
              )}
              {form.periodMode === 'months' && (
                <SearchableSelect options={MONTHS} value={String(form.months)} clearable={false}
                  onChange={v => v && set({ months: +v })} ariaLabel="Months" />
              )}
              {form.periodMode === 'start' && (
                <DatePicker value={form.startDate} min={yearAgo()} max={isoDay(new Date())}
                  onChange={(v: string) => set({ startDate: v })} placeholder="Start date" />
              )}
            </div>
            <p className="text-xs text-gray-500 flex-1 min-w-[240px]">
              {form.periodMode === 'days' && 'A rolling window ending today — Reports and Traffic for that range, Torrent for every month it touches.'}
              {form.periodMode === 'months' && 'Each month kept on its own — the current month up to today — for Reports, Traffic and Torrent.'}
              {form.periodMode === 'start' && 'From the start date to today. Once that passes a year, the oldest days drop off.'}
              {' '}Default views are always kept ready too.
            </p>
          </div>
          {data?.period && !dirty && (
            <p className="text-xs text-[#14254A] mt-2">
              Next pass keeps ready: <b>{data.period.label}</b>
              {data.period.windows?.length > 1 && <> · {data.period.windows.length} windows</>}
              {data.period.note && <span className="text-amber-700"> · {data.period.note}</span>}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-xs font-medium text-gray-700">Keep ready:</span>
          {([['reports', 'Reports (every platform)'], ['traffic', 'Traffic Analysis'], ['torrent', 'Torrent Analysis']] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 accent-[#14254A]" checked={form[k]} onChange={e => set({ [k]: e.target.checked } as any)} />
              {l}
            </label>
          ))}
          <div className="ml-auto flex gap-2">
            <button onClick={() => save(form)} disabled={!dirty || busy !== ''}
              className="text-xs px-4 py-2 rounded-xl bg-[#14254A] text-white disabled:opacity-40">
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button onClick={runNow} disabled={running || busy !== '' || !data?.cacheConnected}
              className="text-xs px-4 py-2 rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40">
              {busy === 'run' ? 'Starting…' : 'Run now'}
            </button>
          </div>
        </div>
        {err && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">{err}</p>}
        {msg && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">{msg}</p>}
        {data?.updatedBy && <p className="text-[10px] text-gray-400">Settings last saved by {data.updatedBy} · {data.updatedAt}</p>}

        {last && (
          <p className="text-xs text-gray-500">
            Last pass ({last.trigger === 'manual' ? 'run by hand' : 'scheduled'}): started {when(last.startedAt)}
            {last.period?.label && <> · {last.period.label}</>}
            {last.finishedAt && !last.finishedAt.startsWith('0001') && <> · took {took(last.startedAt, last.finishedAt)}</>}
            {' '}· {last.clients?.length ?? 0} client(s)
            {last.trafficSent && ' · Traffic views requested'}{last.torrentSent && ' · Torrent views requested'}
            {last.error && <span className="text-amber-700"> · {last.error}</span>}
          </p>
        )}
      </div>

      {/* Who is used most — what the next pass picks, and what is already ready */}
      <div className="px-6 py-3 border-t border-gray-100 flex flex-wrap items-center gap-3">
        <h4 className="text-sm font-semibold text-[#14254A]">Most-opened clients</h4>
        <span className="text-xs text-gray-500">
          {ranking.length ? `the top ${form.topN} are kept ready` : 'nothing recorded yet — the list starts filling as people open reports'}
        </span>
        <button onClick={load} className="ml-auto text-xs text-[#14254A] hover:underline">Refresh list</button>
      </div>
      {ranking.length > 0 && (
        <div className="overflow-auto" style={{ maxHeight: 440 }}>
          <table className="data-table">
            <thead><tr>{['#', 'Client', 'Reports', 'Traffic', 'Torrent', 'Total opens', 'Last opened', 'Ready now', 'Last pass'].map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {ranking.map(r => {
                const passed = last?.clients?.find(c => c.clientId.toLowerCase() === r.clientId.toLowerCase())
                return (
                  <tr key={r.clientId} className={r.inTopN ? '' : 'opacity-50'}>
                    <td className="text-xs text-gray-500">{r.rank}</td>
                    <td className="text-xs text-gray-700 max-w-[220px] truncate" title={r.clientId}>{r.clientName || r.clientId}</td>
                    <td className="text-xs text-gray-600">{r.counts.reports ?? 0}</td>
                    <td className="text-xs text-gray-600">{r.counts.traffic ?? 0}</td>
                    <td className="text-xs text-gray-600">{r.counts.torrent ?? 0}</td>
                    <td className="text-xs font-semibold text-[#14254A]">{r.total}</td>
                    <td className="text-xs text-gray-600 whitespace-nowrap">{r.lastDay}</td>
                    <td className="text-xs whitespace-nowrap">
                      <Badge on={r.cached.reports > 0} label={`Reports${r.cached.reports ? ` ${r.cached.reports}` : ''}`} />
                      <Badge on={r.cached.traffic} label="Traffic" />
                      <Badge on={r.cached.torrent} label="Torrent" />
                    </td>
                    <td className="text-xs text-gray-600 whitespace-nowrap">
                      {!r.inTopN ? <span className="text-gray-400">outside top {form.topN}</span>
                        : !passed ? <span className="text-gray-400">not in the last pass</span>
                        : passed.reports
                          ? passed.reports.error && passed.reports.ready === 0
                            ? <span className="text-amber-700" title={passed.reports.error}>reports failed</span>
                            : <span className="text-emerald-700">{passed.reports.ready} of {passed.reports.attempted} reports ready</span>
                          : running ? <span className="text-[#FC934C]">building…</span> : <span className="text-emerald-700">views requested</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Badge({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`inline-block mr-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold ${on
      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-50 text-gray-400 border border-gray-200'}`}>
      {label}
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-700 mb-1">{label}</span>
      {children}
    </label>
  )
}
