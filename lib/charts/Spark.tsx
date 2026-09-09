// Sparklines — the report at a glance, with no chart furniture at all.
//
// ── Why this one has no library behind it ────────────────────────────────────
//
// The other three engines are third-party renderers this report ADAPTS to. A
// sparkline is the opposite: it is defined by everything it leaves out — no
// axes, no gridlines, no legend, no tick labels, no plot frame — so a charting
// library is almost entirely overhead, and every one of them has to be talked
// out of drawing the parts that make a chart a chart. Two hundred lines of SVG
// is smaller than the configuration would be, and it is the only engine here
// that costs nothing to load.
//
// ── What a panel becomes ─────────────────────────────────────────────────────
//
//   a trend or a rate   → the classic sparkline: one line per series across the
//                         full width, the last figure printed at the end
//   a dated run of
//   columns             → one strip of hairline bars, the silhouette of the run
//   a breakdown         → one 18px row per category: the name, a hairline bar,
//                         the number. A bullet list, not a bar chart.
//   a 100% split        → the same row, as a single ribbon
//   a share             → one ribbon for the whole split, with a compact key
//
// The rule underneath all four: EVERY MARK IS BESIDE ITS NUMBER. A sparkline
// has no axis to read a value off, so the value has to be printed, and that is
// what makes this shape usable for a report rather than merely small.
//
// ── preserveAspectRatio="none" ───────────────────────────────────────────────
//
// The line charts are drawn in a fixed 100×30 user space and stretched to
// whatever width the card has, so nothing here has to measure the container.
// The distortion that would normally cause is undone by `vector-effect:
// non-scaling-stroke`, which keeps the line 1.6px wherever it lands.

import {
  fullNum, isActive, markOpacity, pickValue, pointColor, type ChartSpec,
} from '@/lib/charts/spec'

const VB_W = 100
const VB_H = 30

/**
 * The band a sparkline is drawn against.
 *
 * MIN to MAX across every series, not zero to max. A sparkline is thirty pixels
 * tall and is read for its SHAPE; anchored at zero, a run that moves between
 * 900 and 1,500 becomes a flat line halfway up the box and says nothing. The
 * band is shared between the series so the two stay comparable — separate
 * bands would draw a smaller series as though it were the larger one.
 *
 * A run with no variation at all gets a band of 1, which parks its flat line
 * on the baseline rather than dividing by zero.
 */
function band(series: { data: number[] }[]): { lo: number; hi: number } {
  const all = series.flatMap(s => s.data.map(v => Number(v) || 0))
  if (all.length === 0) return { lo: 0, hi: 1 }
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  return hi > lo ? { lo, hi } : { lo, hi: lo + 1 }
}

/** The polyline through one series, in the fixed 100×30 user space. */
function linePath(values: number[], lo: number, hi: number): string {
  const n = values.length
  if (n === 0) return ''
  // Half a stroke of headroom top and bottom, so a peak or a trough is not
  // sliced in half by the edge of the box.
  const top = 1.2
  const bottom = VB_H - 1.2
  const span = hi - lo || 1
  const x = (i: number) => (n <= 1 ? VB_W / 2 : (i / (n - 1)) * VB_W)
  const y = (v: number) => bottom - (((Number(v) || 0) - lo) / span) * (bottom - top)
  return values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ')
}

function LineSpark({ spec }: { spec: ChartSpec }) {
  const { m, series, suffix = '' } = spec
  const filled = spec.form === 'area'
  const { lo, hi } = band(series)
  const first = spec.titles[0] ?? ''
  const last = spec.titles[spec.titles.length - 1] ?? ''

  return (
    <div className="flex flex-col justify-center h-full gap-2.5">
      {series.map((s, si) => {
        const d = linePath(s.data, lo, hi)
        const end = s.data[s.data.length - 1] ?? 0
        return (
          <div key={s.name} className="flex items-center gap-2.5">
            <span className="w-[76px] shrink-0 truncate text-[10px] font-semibold uppercase
              tracking-wide" style={{ color: m.axis }} title={s.name}>
              {s.name}
            </span>
            <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none"
              className="flex-1 min-w-0" height={30} role="img" aria-label={`${s.name} trend`}>
              {filled && (
                <path d={`${d} L${VB_W},${VB_H} L0,${VB_H} Z`} fill={s.color} opacity={0.16} />
              )}
              <path d={d} fill="none" stroke={s.color} strokeWidth={1.6}
                strokeLinecap="round" strokeLinejoin="round"
                // Keeps the line 1.6px after the box is stretched to the card.
                vectorEffect="non-scaling-stroke" />
            </svg>
            <span className="w-[62px] shrink-0 text-right text-[11.5px] font-bold tabular-nums"
              style={{ color: si === 0 ? m.ident : m.removed }}>
              {fullNum(Number(end))}{suffix}
            </span>
          </div>
        )
      })}
      {/* The only axis a sparkline gets: where the run starts and where it ends. */}
      <div className="flex justify-between text-[9.5px] pl-[86px] pr-[70px]" style={{ color: m.axis }}>
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  )
}

/** One category: the name, its marks, its numbers. */
function BarRow({ spec, i, max }: { spec: ChartSpec; i: number; max: number }) {
  const { m, series, suffix = '' } = spec
  const stacked = spec.form === 'stack-100'
  const on = isActive(spec, i)
  const opacity = markOpacity(spec, i)
  const title = spec.titles[i] ?? ''

  const body = stacked ? (
    // A single ribbon: removed against what is still active, as a share of this row.
    <span className="flex-1 min-w-0 flex h-[7px] rounded-full overflow-hidden"
      style={{ background: m.grid, opacity }}>
      {series.map(s => (
        <span key={s.name} style={{
          width: `${Math.max(0, Math.min(100, Number(s.data[i]) || 0))}%`,
          background: s.color,
        }} />
      ))}
    </span>
  ) : (
    <span className="flex-1 min-w-0 flex flex-col gap-[2px]" style={{ opacity }}>
      {series.map(s => (
        <span key={s.name} className="block h-[5px] rounded-sm" style={{
          width: `${max > 0 ? Math.max(1.5, ((Number(s.data[i]) || 0) / max) * 100) : 0}%`,
          background: pointColor(spec, s.color, i),
        }} />
      ))}
    </span>
  )

  const figures = series
    .map(s => `${fullNum(Number(s.data[i]) || 0)}${suffix}`)
    .join(' · ')

  const Row = spec.onPick ? 'button' : 'div'
  return (
    <Row
      {...(spec.onPick ? { type: 'button' as const, onClick: () => spec.onPick?.(pickValue(spec, i)) } : {})}
      title={`${title} — ${figures}`}
      className={`w-full flex items-center gap-2.5 text-left rounded-md px-1 py-[3px] transition-colors ${
        spec.onPick ? 'hover:bg-black/[0.035] dark:hover:bg-white/[0.06]' : ''}`}>
      <span className={`w-[38%] shrink-0 truncate text-[11px] ${on ? 'font-bold' : ''}`}
        style={{ color: on ? m.removed : m.axis }}>
        {spec.categories[i]}
      </span>
      {body}
      <span className="shrink-0 text-right text-[10.5px] font-bold tabular-nums whitespace-nowrap"
        style={{ color: m.ident, opacity }}>
        {figures}
      </span>
    </Row>
  )
}

/**
 * A column sparkline — the whole run as one strip of hairline bars.
 *
 * This is what `group-column` becomes here, rather than the row-per-category
 * bullet list below. A dated run is the case that shape is for, and fourteen
 * days as fourteen stacked rows is a table, not a sparkline: the thing a reader
 * wants off a trend at this size is the silhouette, which only exists when the
 * periods sit side by side.
 *
 * Drawn in CSS rather than SVG because each period is a flex column of two
 * stacked bars, and flex gets the gap between the pair and the gap between
 * periods right at any width without measuring anything.
 */
function ColumnSpark({ spec }: { spec: ChartSpec }) {
  const { m, series, suffix = '' } = spec
  const max = Math.max(1, ...series.flatMap(s => s.data.map(v => Number(v) || 0)))
  const H = 54

  return (
    <div className="flex flex-col justify-center h-full gap-2">
      <div className="flex items-end gap-[3px]" style={{ height: H }}>
        {spec.categories.map((_, i) => (
          <button key={i} type="button" disabled={!spec.onPick}
            onClick={() => spec.onPick?.(pickValue(spec, i))}
            title={`${spec.titles[i]} — ${series.map(s => `${s.name} ${fullNum(Number(s.data[i]) || 0)}${suffix}`).join(' · ')}`}
            className="flex-1 min-w-0 flex items-end justify-center gap-[1px] h-full"
            style={{ opacity: markOpacity(spec, i), cursor: spec.onPick ? 'pointer' : 'default' }}>
            {series.map(s => (
              <span key={s.name} className="flex-1 rounded-t-[1px]" style={{
                height: `${Math.max(2, ((Number(s.data[i]) || 0) / max) * H)}px`,
                background: s.color,
              }} />
            ))}
          </button>
        ))}
      </div>
      {/* Where the run starts and where it ends, plus each series' last figure —
          the only numbers a strip this dense has room for. */}
      <div className="flex items-baseline justify-between text-[9.5px]" style={{ color: m.axis }}>
        <span>{spec.titles[0] ?? ''}</span>
        <span className="flex gap-2.5">
          {series.map(s => (
            <span key={s.name} className="font-bold tabular-nums" style={{ color: s.color }}>
              {fullNum(Number(s.data[s.data.length - 1]) || 0)}{suffix}
            </span>
          ))}
        </span>
        <span>{spec.titles[spec.titles.length - 1] ?? ''}</span>
      </div>
    </div>
  )
}

function BarSpark({ spec }: { spec: ChartSpec }) {
  const max = spec.form === 'stack-100'
    ? 100
    : Math.max(1, ...spec.series.flatMap(s => s.data.map(v => Number(v) || 0)))
  return (
    <div className="flex flex-col gap-[1px] overflow-y-auto"
      style={{ maxHeight: Math.max(spec.height, 140) }}>
      {spec.categories.map((_, i) => <BarRow key={i} spec={spec} i={i} max={max} />)}
    </div>
  )
}

/** A share, as one ribbon and a key — the sparkline answer to a donut. */
function ShareSpark({ spec }: { spec: ChartSpec }) {
  const { m } = spec
  const values = (spec.series[0]?.data ?? []).map(v => Number(v) || 0)
  const total = values.reduce((a, b) => a + b, 0)
  const colors = spec.sliceColors ?? m.cat

  if (total <= 0) {
    return <p className="text-[11.5px] py-6 text-center" style={{ color: m.axis }}>No share to draw.</p>
  }

  return (
    <div className="flex flex-col gap-3 justify-center h-full">
      <div className="flex h-3 rounded-full overflow-hidden" style={{ background: m.grid }}>
        {values.map((v, i) => (
          <button key={i} type="button"
            onClick={spec.onPick ? () => spec.onPick?.(pickValue(spec, i)) : undefined}
            title={`${spec.titles[i]} — ${fullNum(v)} (${Math.round((v / total) * 100)}%)`}
            style={{
              width: `${(v / total) * 100}%`,
              background: colors[i % colors.length],
              opacity: markOpacity(spec, i),
              cursor: spec.onPick ? 'pointer' : 'default',
            }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {values.map((v, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 text-[10.5px]"
            style={{ color: m.axis, opacity: markOpacity(spec, i) }}>
            <span className="w-2 h-2 rounded-full shrink-0"
              style={{ background: colors[i % colors.length] }} />
            <span className="truncate max-w-[130px]" title={spec.titles[i]}>{spec.categories[i]}</span>
            <b className="tabular-nums" style={{ color: m.ident }}>{Math.round((v / total) * 100)}%</b>
          </span>
        ))}
      </div>
    </div>
  )
}

export default function Spark({ spec }: { spec: ChartSpec }) {
  if (spec.form === 'line' || spec.form === 'area') return <LineSpark spec={spec} />
  if (spec.form === 'group-column') return <ColumnSpark spec={spec} />
  if (spec.form === 'donut') return <ShareSpark spec={spec} />
  return <BarSpark spec={spec} />
}
