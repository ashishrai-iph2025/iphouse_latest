'use client'

// "Cache on demand" — the form every report section on the Cache & Redis tab
// shares: which clients, and which period — month by month, or from a start
// date — never more than a year. The API enforces the same limits; this says
// so before anything is sent.

import { useMemo, useState } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import MultiSearchableSelect from '@/components/ui/MultiSearchableSelect'
import DateRangePicker from '@/components/ui/DateRangePicker'

export interface PeriodRequest {
  clientIds: string[]
  months?: string[]      // YYYY-MM, oldest first
  from?: string          // YYYY-MM-DD
  to?: string
}

const monthKey = (d: Date) => d.toISOString().slice(0, 7)
const addMonths = (m: string, n: number) => {
  const d = new Date(m + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return monthKey(d)
}
const monthLabel = (m: string) =>
  new Date(m + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const today = () => new Date().toISOString().slice(0, 10)

export default function CachePeriodForm({
  clients, busy, onSubmit, unit = 'report', perWindow, note,
}: {
  clients: { key: string; label: string }[]
  busy?: boolean
  onSubmit: (req: PeriodRequest) => void
  unit?: string                 // what one window of one client produces, for the summary line
  perWindow?: number            // how many of `unit` one client-window is (e.g. platforms)
  note?: string
}) {
  const thisMonth = monthKey(new Date())
  const [picked, setPicked] = useState<string[]>([])
  const [mode, setMode] = useState<'month' | 'range'>('month')
  const [fromM, setFromM] = useState(addMonths(thisMonth, -2))
  const [toM, setToM] = useState(thisMonth)
  const [range, setRange] = useState({ from: '', to: '' })

  // The last 36 months to pick from; "to" is held within 12 of "from".
  const monthOpts = useMemo(() => {
    const out: { key: string; label: string }[] = []
    for (let i = 0; i < 36; i++) { const m = addMonths(thisMonth, -i); out.push({ key: m, label: monthLabel(m) }) }
    return out
  }, [thisMonth])
  const toOpts = monthOpts.filter(o => o.key >= fromM && o.key <= addMonths(fromM, 11) && o.key <= thisMonth)

  const months = useMemo(() => {
    const out: string[] = []
    for (let m = fromM; m <= toM && out.length < 13; m = addMonths(m, 1)) out.push(m)
    return out
  }, [fromM, toM])
  const days = range.from ? Math.round((Date.parse(range.to || today()) - Date.parse(range.from)) / 864e5) + 1 : 0

  const problem =
    picked.length === 0 ? 'Pick at least one client'
      : mode === 'month' && months.length > 12 ? 'At most 12 months (1 year)'
      : mode === 'month' && toM < fromM ? 'The end month is before the start month'
      : mode === 'range' && !range.from ? 'Pick a start date'
      : mode === 'range' && days > 366 ? `That is ${days} days — at most 1 year (366 days)`
      : ''
  const windows = mode === 'month' ? months.length : 1
  const count = picked.length * windows * (perWindow || 1)

  return (
    <div className="rounded-xl border border-gray-100 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-sm font-semibold text-[#14254A]">Cache on demand</h4>
        <span className="text-[11px] text-gray-500">Pick clients and a period of at most 1 year — it is built in the background.</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <label className="block lg:col-span-1">
          <span className="block text-xs font-medium text-gray-700 mb-1">Clients</span>
          <MultiSearchableSelect options={clients} values={picked} onChange={setPicked}
            placeholder={clients.length ? 'Select clients…' : 'Loading clients…'} noun={['client', 'clients']} />
        </label>
        <div className="lg:col-span-2">
          <span className="block text-xs font-medium text-gray-700 mb-1">Period</span>
          <div className="flex flex-wrap items-start gap-3">
            <div className="inline-flex rounded-xl border border-gray-200 overflow-hidden shrink-0">
              {([['month', 'Month by month'], ['range', 'From a start date']] as const).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setMode(v)}
                  className={`px-3 py-2 text-xs ${mode === v ? 'bg-[#14254A] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{l}</button>
              ))}
            </div>
            {mode === 'month' ? (
              <div className="flex items-center gap-2 flex-1 min-w-[280px]">
                <div className="flex-1"><SearchableSelect options={monthOpts} value={fromM} clearable={false}
                  onChange={v => { if (!v) return; setFromM(v); if (toM < v || toM > addMonths(v, 11)) setToM(addMonths(v, 11) > thisMonth ? thisMonth : addMonths(v, 11)) }}
                  ariaLabel="From month" /></div>
                <span className="text-xs text-gray-400">to</span>
                <div className="flex-1"><SearchableSelect options={toOpts} value={toM} clearable={false}
                  onChange={v => v && setToM(v)} ariaLabel="To month" /></div>
              </div>
            ) : (
              <div className="flex-1 min-w-[260px]">
                <DateRangePicker value={range} max={today()} onChange={r => setRange({ from: r.from, to: r.to || r.from })} />
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`text-xs ${problem ? 'text-amber-700' : 'text-gray-500'}`}>
          {problem || <>
            {picked.length} client{picked.length === 1 ? '' : 's'} ×{' '}
            {mode === 'month' ? `${months.length} month${months.length === 1 ? '' : 's'} (${monthLabel(fromM)} – ${monthLabel(toM)})` : `${days} day${days === 1 ? '' : 's'}`}
            {perWindow ? <> = <b>{count.toLocaleString()}</b> {unit}{count === 1 ? '' : 's'}</> : null}
            {' '}· already-cached, unchanged ones are skipped
          </>}
        </span>
        {note && <span className="text-[11px] text-gray-400">{note}</span>}
        <button type="button" disabled={!!problem || busy}
          onClick={() => onSubmit(mode === 'month'
            ? { clientIds: picked, months }
            : { clientIds: picked, from: range.from, to: range.to || today() })}
          className="ml-auto text-xs px-4 py-2 rounded-xl bg-[#14254A] text-white disabled:opacity-40">
          {busy ? 'Starting…' : 'Cache now'}
        </button>
      </div>
    </div>
  )
}

export function Progress({ done, total, ready, running, label }: { done: number; total: number; ready: number; running: boolean; label: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="rounded-xl border border-gray-100 p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-[#14254A]">{running ? 'Caching…' : 'Last on-demand run'}</span>
        <span className="text-gray-500">{label}</span>
        <span className="ml-auto text-gray-600">{done.toLocaleString()} of {total.toLocaleString()} done · <span className="text-emerald-700">{ready.toLocaleString()} ready</span>
          {done - ready > 0 && <> · <span className="text-gray-500">{(done - ready).toLocaleString()} with no data</span></>}</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 mt-2 overflow-hidden">
        <div className={`h-full rounded-full ${running ? 'bg-[#FC934C]' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
