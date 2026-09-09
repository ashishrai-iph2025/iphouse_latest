// What a report panel is, said in a way four different charting libraries can
// all draw.
//
// ── Why there is a neutral shape at all ──────────────────────────────────────
//
// The report offers a choice of rendering ENGINE — the built-in Recharts and
// hand-drawn SVG, ApexCharts, ECharts, Toast UI Charts, or sparklines. Without
// something in the middle, that choice costs one adapter per (engine × panel
// shape): five engines times a dozen shapes, each one re-deciding what the
// series are called and which colour removal wears.
//
// So a panel does not hand an engine its rows. It builds a ChartSpec — the
// categories, the series, the palette, the click target — and the engine's only
// job is to draw that. Adding a sixth engine is one file; adding a thirteenth
// panel shape is one `buildSpec` case.
//
// ── Why FORM and not the panel's own viz key ─────────────────────────────────
//
// The page's viz vocabulary is about INTENT: `share` and `donut` are both a
// ring, and differ only in whether the slices step through the categorical
// identity or a one-hue ramp. `bars` and `hbar` are both a horizontal pair per
// row, drawn differently only because one was born as HTML. An engine does not
// care about any of that — it needs to know what geometry to draw, and the
// colour decisions arrive already made, in the spec.
//
// Seven forms cover every panel an engine is offered. Everything else — the
// world map, the heat grid, the ranked table, the repeat-offender list — stays
// with the built-in renderers, because there is no version of those an engine
// swap improves and three of the four are not charts at all.

import type { MarkTheme } from '@/lib/reportTheme'

export type ChartForm =
  /** Categories down the side, identified and removed as a pair per row. */
  | 'group-bar'
  /** Categories along the bottom, identified and removed as a pair per column. */
  | 'group-column'
  /** One measure only, ranked, horizontal. */
  | 'single-bar'
  /** Removed against what is still active, as a share of each row. */
  | 'stack-100'
  /** Share of a total. */
  | 'donut'
  | 'line'
  | 'area'

export interface ChartSeries {
  name: string
  color: string
  data: number[]
}

export interface ChartSpec {
  form: ChartForm
  /** Axis / slice labels, already shortened for the space they have. */
  categories: string[]
  /** The same labels UNSHORTENED, for tooltips and for the row's own title. */
  titles: string[]
  /**
   * What clicking a row filters the report BY, index-aligned with `titles`.
   *
   * Not the same string as the label wherever a dimension is a lookup: those
   * rows carry an id in `value` and a name in `label`, and the report narrows
   * by the id while the reader reads the name. Absent means the two are the
   * same, which is the common case.
   */
  picks?: string[]
  series: ChartSeries[]
  /**
   * Per-POINT colours, index-aligned with `categories`.
   *
   * A donut's slices, and also a single-series bar list whose rows step through
   * a ramp — an ordered bucket split, where the colour carries the sequence
   * rather than an identity. Ignored where there is more than one series: two
   * series that both varied by row would have nothing left to tell them apart.
   */
  sliceColors?: string[]
  /** The palette the whole page is drawn in — grid, axis, surface, ink. */
  m: MarkTheme
  dark: boolean
  /** Plot height in CSS pixels. The card gives the width; this decides the rest. */
  height: number
  /** '%' on the rate card, empty everywhere else. */
  suffix?: string
  /** The value the report is currently narrowed to, drawn as the picked mark. */
  activeVal?: string
  /** Clicking a category narrows the whole report to it. */
  onPick?: (label: string) => void
  /** Print the figure at the mark. Off where the marks are too close to carry one. */
  labels?: boolean
}

/** A number an axis can show without running out of room: 12.4k, 3.1M. */
export function axisNum(v: number): string {
  const n = Number(v) || 0
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}

/** The full figure, grouped — what a tooltip and a data label show. */
export const fullNum = (v: number) => Number(v || 0).toLocaleString()

/**
 * A label short enough to sit on an axis, cut in the MIDDLE.
 *
 * The ends of these labels are where the information is — "Manchester United vs
 * Arsenal" and "Manchester United vs Chelsea" are told apart by their last
 * word, so a trailing ellipsis turns two distinct rows into two identical ones.
 */
export function midCut(s: string, max: number): string {
  const t = String(s ?? '')
  if (t.length <= max) return t
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${t.slice(0, head)}…${t.slice(t.length - tail)}`
}

/** What clicking row `i` narrows the report to. */
export const pickValue = (spec: ChartSpec, i: number) =>
  spec.picks?.[i] ?? spec.titles[i] ?? ''

/**
 * Is this row the one the report is currently filtered to?
 *
 * Either side counts, because the two are not always the same string and the
 * filter can have been set from a panel that used the other one — the built-in
 * renderers make the same allowance.
 */
export const isActive = (spec: ChartSpec, i: number) =>
  !!spec.activeVal
  && (spec.activeVal === pickValue(spec, i) || spec.activeVal === spec.titles[i])

/**
 * The opacity a mark is drawn at.
 *
 * With no filter every mark is solid. With one, the picked row stays solid and
 * the rest fade — the same "dimmed, not hidden" the built-in renderers use, so
 * switching engine does not change what a filtered panel MEANS.
 */
export const markOpacity = (spec: ChartSpec, i: number) =>
  !spec.activeVal || isActive(spec, i) ? 1 : 0.32

/** Ink that reads on this theme's card. */
export const inkOn = (m: MarkTheme, dark: boolean) => (dark ? '#FFFFFF' : m.ident)

/** A tooltip's ground, matched to the card it floats over. */
export const tipBg = (m: MarkTheme, dark: boolean) => (dark ? '#0F1D33' : '#FFFFFF')

/**
 * A hex colour at a given opacity, as rgba().
 *
 * Needed because two of the engines dim a mark by RECOLOURING it rather than by
 * setting an opacity on it: ApexCharts takes per-point `fillColor` strings and
 * ECharts takes an itemStyle colour, and neither has a per-point opacity that
 * survives a series-level fill. Non-hex input is returned untouched — the
 * palettes carry a few `rgba(255,255,255,0.1)` grid values, and re-parsing
 * those would turn a grid line into `NaN`.
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!hex) return color
  const n = parseInt(hex[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * The colour one point is drawn in, before the filter is applied.
 *
 * A single-series panel may carry a per-row ramp in `sliceColors`; anything
 * with two series takes its colour from the series, because that is the only
 * thing separating identification from removal.
 */
export const pointColor = (spec: ChartSpec, seriesColor: string, i: number) =>
  spec.series.length === 1 && spec.sliceColors?.length
    ? spec.sliceColors[i % spec.sliceColors.length]
    : seriesColor

/** The mark's colour once the report's current filter is taken into account. */
export const markColor = (spec: ChartSpec, base: string, i: number) =>
  !spec.activeVal || isActive(spec, i) ? base : withAlpha(base, 0.3)
