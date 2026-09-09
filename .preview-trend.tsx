import { createRoot } from 'react-dom/client'
import '@/app/globals.css'
import { Trend } from '@/app/admin/reports/page'
import { themeFor } from '@/lib/reportTheme'

/* The trend card's END LABELS, in the four cases that decide where they go.
 *
 * The bug this previews: each label used to be positioned at its own series'
 * last point, so when the two lines converge at the right edge the two figures
 * printed through each other. The reported case is the first panel below —
 * 1.9K found against 1.4K removed on a 15K axis, four pixels apart.
 *
 * The component is the real one, imported from the reports page.
 */

const dark = new URLSearchParams(location.search).get('dark') === '1'
const m = themeFor('iphouse', dark)

/** A month of days with the reported shape: four spikes over a low baseline. */
function run(endUrls: number, endRemoved: number, n = 39) {
  const peaks = [8, 15, 22, 28, 36]
  const out: any[] = []
  for (let i = 0; i < n; i++) {
    const near = peaks.reduce((a, p) => Math.max(a, Math.exp(-((i - p) ** 2) / 6)), 0)
    const base = 1400 + 900 * Math.sin(i / 3)
    const urls = Math.round(base + near * 11500)
    const removed = Math.round(urls * (0.72 + 0.06 * Math.sin(i / 5)))
    const d = new Date(Date.UTC(2026, 7, 1 + i))
    out.push({ label: d.toISOString().slice(0, 10), urls, removed, rate: Math.round(removed / urls * 100) })
  }
  // The last day is the one under test.
  const last = out[out.length - 1]
  last.urls = endUrls
  last.removed = endRemoved
  last.rate = endUrls > 0 ? Math.round((endRemoved / endUrls) * 100) : 0
  return out
}

const CASES: Array<{ title: string; note: string; data: any[]; single?: boolean }> = [
  {
    title: 'Converging — the reported case',
    note: '1,900 found against 1,400 removed on a 15K axis: the two labels are four pixels apart at their natural positions.',
    data: run(1900, 1400),
  },
  {
    title: 'Far apart',
    note: 'Nothing to resolve — each label must stay at its own line rather than being stacked for the sake of it.',
    data: run(12800, 2100),
  },
  {
    title: 'Both on the floor',
    note: 'A quiet last day. Separating downward would put a figure in among the date ticks, so the stack lifts instead.',
    data: run(120, 40),
  },
  {
    title: 'One series',
    note: 'An enforcement count has no counterpart. Nothing to collide with, and the label sits at its line.',
    data: run(1900, 0),
    single: true,
  },
]

createRoot(document.getElementById('root')!).render(
  <div className={`p-6 min-h-screen ${dark ? 'dark' : ''}`}
    style={{ background: dark ? '#0f1b33' : '#eef2f7' }}>
    {CASES.map(c => (
      <div key={c.title} className="rounded-2xl shadow-card border overflow-hidden max-w-[980px] mb-5"
        style={{ background: m.surface, borderColor: dark ? 'rgba(255,255,255,.08)' : '#f1f3f6' }}>
        <div className="px-4 py-3 border-b" style={{ borderColor: dark ? 'rgba(255,255,255,.08)' : '#f1f3f6' }}>
          <h3 className="text-[14px] font-bold" style={{ color: dark ? '#fff' : '#14254A' }}>{c.title}</h3>
          <p className="text-[11px] text-gray-400 mt-0.5">{c.note}</p>
        </div>
        <div className="p-4 pt-3">
          <Trend data={c.data} m={m} mode="area" single={c.single} />
        </div>
      </div>
    ))}
  </div>
)
