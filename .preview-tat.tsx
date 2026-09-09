import { createRoot } from 'react-dom/client'
import { durationMinutes, foldTatRows, TAT_BANDS } from '@/lib/tatBuckets'
import '@/app/globals.css'

// The turnaround panel's rows, exactly as the server sent them on the screenshot
// this was raised from, put through the page's own fold.
//
// Not a mock of the fold — foldTatRows below is the function orderRows calls.

const SUMMARY = [
  { label: '15-30 min', urls: 7692, removed: 7688 },
  { label: '1-2 hr', urls: 5572, removed: 5547 },
  { label: 'Pending', urls: 4676, removed: 0 },
  { label: '30 min-1 hr', urls: 3225, removed: 3203 },
  { label: '2 hr+', urls: 607, removed: 529 },
  { label: '0-15 min', urls: 5, removed: 5 },
]

// Open Web's two halves, straight off the warehouse.
const OPEN_WEB = [
  { label: '00 - 30min', urls: 7681, removed: 7678 },
  { label: '1hr - 2hr', urls: 5532, removed: 5517 },
  { label: 'Pending', urls: 5071, removed: 0 },
  { label: '30min - 1hr', urls: 3187, removed: 3169 },
  { label: '2 hrs and above', urls: 466, removed: 374 },
]

// The source/host table, whose column holds nothing but Pending.
const SOURCE_URLS = [{ label: 'Pending', urls: 4676, removed: 0 }]

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)

function Table({ title, rows }: { title: string; rows: any[] }) {
  const out = foldTatRows(rows)
  const total = out.reduce((a: number, r: any) => a + r.urls, 0)
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-5 mb-4">
      <p className="text-[14px] font-extrabold text-[#14254A] mb-1">{title}</p>
      <p className="text-[11px] text-gray-400 mb-3">
        in: {rows.map(r => r.label).join(' · ')}
      </p>
      {out.length === 0 ? (
        <p className="text-[12px] text-gray-400 py-3">No data for this period.</p>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-[10px] font-extrabold uppercase tracking-widest text-gray-400">
              <th className="text-left pb-2">Name</th>
              <th className="text-right pb-2">Identified</th>
              <th className="text-right pb-2">Removed</th>
              <th className="text-right pb-2">Removal rate</th>
              <th className="text-right pb-2">Share</th>
            </tr>
          </thead>
          <tbody>
            {out.map((r: any) => (
              <tr key={r.label} className="border-t border-gray-100">
                <td className="py-1.5 text-gray-700">{r.label}</td>
                <td className="py-1.5 text-right font-bold text-[#14254A] tabular-nums">
                  {r.urls.toLocaleString()}
                </td>
                <td className="py-1.5 text-right font-bold text-[#14254A] tabular-nums">
                  {r.removed.toLocaleString()}
                </td>
                <td className="py-1.5 text-right font-bold text-[#14254A] tabular-nums">
                  {pct(r.removed, r.urls)}%
                </td>
                <td className="py-1.5 text-right font-bold text-[#14254A] tabular-nums">
                  {pct(r.urls, total)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/* The ORDERED shapes — the donut this panel is drawn as, and the single-bar
   list — re-sort their rows into bucket order after the server sorted them by
   size. That sort read the first number in the label and ignored its unit,
   which is what put "1-2 hr" ahead of "15-30 min". Both keys, side by side. */
const leadingNum = (s: string) => {
  const hit = /(-?\d+(?:\.\d+)?)/.exec(String(s))
  return hit ? Number(hit[1]) : Number.POSITIVE_INFINITY
}
const ordinalKey = (s: string) => durationMinutes(s) ?? leadingNum(s)

const LABELS = TAT_BANDS.map(b => b.label)
const byOld = [...LABELS].sort((a, b) => leadingNum(a) - leadingNum(b))
const byNew = [...LABELS].sort((a, b) => ordinalKey(a) - ordinalKey(b))

function Order({ title, order, keyOf, bad }: {
  title: string; order: string[]; keyOf: (s: string) => number; bad?: boolean
}) {
  return (
    <div className={`rounded-2xl border p-4 mb-3 ${bad
      ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100 shadow-card'}`}>
      <p className="text-[12px] font-extrabold text-[#14254A] mb-2">{title}</p>
      <div className="flex flex-wrap gap-2">
        {order.map((l, i) => (
          <span key={l} className="inline-flex items-baseline gap-1.5 text-[12px]
            rounded-lg border border-gray-200 bg-white px-2 py-1">
            <b className="text-gray-300">{i + 1}</b>
            <span className="font-bold text-[#14254A]">{l}</span>
            <span className="text-[10px] text-gray-400 tabular-nums">key {keyOf(l)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <div className="p-6 bg-[#eef2f7] min-h-screen">
    <p className="text-[11px] font-extrabold uppercase tracking-widest text-gray-400 mb-3">
      Takedown Turnaround Time — through the page's own fold ({TAT_BANDS.length} bands)
    </p>
    <Table title="Summary" rows={SUMMARY} />
    <Table title="Open Web — linking URLs" rows={OPEN_WEB} />
    <Table title="Open Web — source / host URLs (column holds only Pending)" rows={SOURCE_URLS} />

    <p className="text-[11px] font-extrabold uppercase tracking-widest text-gray-400 mb-3 mt-6">
      The ordered donut's own sort
    </p>
    <Order title="Before — leadingNum, which ignores the unit" order={byOld} keyOf={leadingNum} bad />
    <Order title="After — ordinalKey, on the minute axis" order={byNew} keyOf={ordinalKey} />
  </div>,
)
