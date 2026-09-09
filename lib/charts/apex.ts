// ApexCharts, as one of the report's rendering engines.
//
// ── Why 4.7.0 and not the current release ────────────────────────────────────
//
// ApexCharts stopped being MIT at 5.3.2. From that release the licence is
// revenue-gated: free below $2M USD of annual revenue, paid above it. 4.7.0 is
// the last MIT version, and it is pinned exactly in package.json for that
// reason and no other. Do not bump it without a licence decision — the version
// number is the licence here.
//
// ── What this file is ────────────────────────────────────────────────────────
//
// A ChartFactory: given a div and a ChartSpec, it produces an ApexCharts
// instance and the three methods ChartHost drives it with. Every colour, every
// label and every click target arrives already decided in the spec — nothing
// here knows what a "removal rate" is, and nothing here reads the report's
// palette directly.
//
// SVG, not canvas, which matters beyond looks: the panel PNG download and the
// PDF export both work by cloning the card body, and a canvas clones blank.

import type { ChartFactory, ChartInstance } from '@/lib/charts/ChartHost'
import {
  axisNum, fullNum, markColor, pickValue, pointColor, type ChartSpec,
} from '@/lib/charts/spec'

/** Loaded once per session, on the first panel that needs it. */
let libPromise: Promise<any> | null = null
const loadApex = () => (libPromise ??= import('apexcharts').then(m => m.default ?? m))

const isHorizontal = (spec: ChartSpec) =>
  spec.form === 'group-bar' || spec.form === 'single-bar' || spec.form === 'stack-100'

const apexType = (spec: ChartSpec) =>
  spec.form === 'donut' ? 'donut'
  : spec.form === 'line' ? 'line'
  : spec.form === 'area' ? 'area'
  : 'bar'

/**
 * The spec's series as Apex data points.
 *
 * Objects rather than bare numbers because a point carries its own fill: the
 * report dims every row except the one it is filtered to, and Apex has no
 * per-point opacity that survives a series-level fill — recolouring the point
 * is the only way to say it.
 */
function barData(spec: ChartSpec, color: string, values: number[]) {
  return values.map((v, i) => ({
    x: spec.categories[i] ?? '',
    y: Number(v) || 0,
    fillColor: markColor(spec, pointColor(spec, color, i), i),
  }))
}

function build(spec: ChartSpec, width: number): Record<string, any> {
  const { m, dark, series, suffix = '' } = spec
  const horizontal = isHorizontal(spec)
  const ink = dark ? '#FFFFFF' : m.ident
  const stacked = spec.form === 'stack-100'
  const numeric = {
    labels: {
      style: { colors: m.axis, fontSize: '11px' },
      formatter: (v: any) => (stacked ? `${Math.round(Number(v) || 0)}%` : axisNum(Number(v))),
    },
    axisBorder: { show: false },
    axisTicks: { show: false },
  }
  const categorical = {
    labels: { style: { colors: m.axis, fontSize: '11px' } },
    axisBorder: { show: false },
    axisTicks: { show: false },
  }

  const base: Record<string, any> = {
    chart: {
      type: apexType(spec),
      height: spec.height,
      width: width || '100%',
      background: 'transparent',
      fontFamily: 'inherit',
      toolbar: { show: false },
      /* Off, deliberately, and for the same reason the built-in charts turn it
         off: the report re-runs on every slicer change, so an entry animation
         means every filter click costs a second of marks growing out of the
         floor. */
      animations: { enabled: false },
      parentHeightOffset: 0,
      /* A plain stack, not Apex's own `stackType: '100%'`. The spec already
         carries shares that sum to 100 — the same numbers every other engine is
         handed — and letting Apex re-normalise them would rescale a row that
         rounds to 99 or 101 and put this engine a percentage point out of step
         with the rest. */
      stacked,
      events: {
        dataPointSelection: (_e: any, _ctx: any, cfg: any) => {
          const i = cfg?.dataPointIndex
          if (typeof i === 'number' && i >= 0) spec.onPick?.(pickValue(spec, i))
        },
      },
    },
    theme: { mode: dark ? 'dark' : 'light' },
    grid: {
      borderColor: m.grid,
      strokeDashArray: 0,
      // Lines across the measure only. A grid in both directions on a ten-row
      // breakdown is a table drawn in hairlines.
      xaxis: { lines: { show: horizontal } },
      yaxis: { lines: { show: !horizontal } },
      // Right gutter sized for a data label sitting past the end of the longest
      // bar; without it the figure on the widest row is clipped by the plot.
      padding: { top: 0, right: horizontal && spec.labels ? 52 : 10, bottom: 0, left: 4 },
    },
    /* No filter on the active state. Apex "darkens" a selected bar by default,
       which fights the report's own idea of selection — the picked row stays at
       full strength and everything else dims, decided in the spec. */
    states: {
      active: { filter: { type: 'none' } },
      hover: { filter: { type: 'lighten', value: 0.06 } },
    },
    legend: {
      show: series.length > 1 || spec.form === 'donut',
      position: 'bottom',
      horizontalAlign: 'center',
      fontSize: '11px',
      labels: { colors: m.axis },
      markers: { width: 8, height: 8, radius: 12 },
      itemMargin: { horizontal: 8, vertical: 2 },
    },
    /* OUTSIDE the mark, not centred on its end.
       Apex centres a bar's data label on the point it is anchored to, which on
       a horizontal bar puts half the figure inside the fill and half outside —
       navy digits on a navy bar, unreadable at either end. Anchoring the text
       to its start and pushing it clear puts the whole figure on the card, in
       the ink colour, which is where the built-in bar lists print it too.
       `grid.padding` below reserves the room it needs. */
    dataLabels: {
      enabled: !!spec.labels,
      formatter: (v: any) => (Number(v) ? `${fullNum(Number(v))}${suffix}` : ''),
      textAnchor: horizontal ? 'start' : 'middle',
      offsetX: horizontal ? 8 : 0,
      offsetY: horizontal ? 0 : -6,
      style: { fontSize: '9px', fontWeight: 700, colors: [ink] },
      background: { enabled: false },
      dropShadow: { enabled: false },
    },
    tooltip: {
      theme: dark ? 'dark' : 'light',
      // The UNSHORTENED label. Axis ticks are cut to fit; the tooltip is where
      // the reader recovers the name the tick could not carry.
      x: { formatter: (_v: any, o: any) => spec.titles[o?.dataPointIndex ?? 0] ?? '' },
      y: { formatter: (v: any) => `${fullNum(Number(v))}${suffix}` },
    },
  }

  if (spec.form === 'donut') {
    return {
      ...base,
      series: (spec.series[0]?.data ?? []).map(v => Number(v) || 0),
      labels: spec.titles,
      colors: spec.sliceColors ?? m.cat,
      // A ring, not a pie: the hole is where the total goes, and a 62% inner
      // radius is the same proportion the built-in donut uses.
      plotOptions: { pie: { donut: { size: '62%' }, expandOnClick: false } },
      // The gap between touching wedges, in the card's own colour — a stroke,
      // not a border, so it reads as space rather than as an outline.
      stroke: { width: 2, colors: [m.surface] },
      dataLabels: { ...base.dataLabels, enabled: false },
      tooltip: {
        theme: dark ? 'dark' : 'light',
        y: { formatter: (v: any) => `${fullNum(Number(v))}${suffix}` },
      },
    }
  }

  if (spec.form === 'line' || spec.form === 'area') {
    return {
      ...base,
      series: series.map(s => ({ name: s.name, data: s.data.map(v => Number(v) || 0) })),
      colors: series.map(s => s.color),
      xaxis: { ...categorical, categories: spec.categories, tickPlacement: 'on' },
      yaxis: numeric,
      stroke: { width: 2.4, curve: 'straight', lineCap: 'round' },
      /* A wash under an area, and a fully opaque nothing under a line.
         `opacity: 0` here does NOT mean "no fill" to Apex on a line chart — it
         takes the stroke's paint from the same place, so the line disappears
         entirely and the series is left as a scatter of markers. */
      fill: spec.form === 'area'
        ? { type: 'gradient', gradient: { opacityFrom: 0.28, opacityTo: 0.04, shadeIntensity: 0 } }
        : { type: 'solid', opacity: 1 },
      markers: { size: spec.categories.length <= 14 ? 3 : 0, strokeWidth: 0 },
      dataLabels: { ...base.dataLabels, enabled: false },
    }
  }

  return {
    ...base,
    series: series.map(s => ({ name: s.name, data: barData(spec, s.color, s.data) })),
    colors: series.map(s => s.color),
    plotOptions: {
      bar: {
        horizontal,
        borderRadius: 2,
        borderRadiusApplication: 'end',
        barHeight: horizontal ? '68%' : undefined,
        columnWidth: horizontal ? undefined : '62%',
        dataLabels: { position: horizontal ? 'top' : 'top' },
      },
    },
    stroke: { width: 0 },
    xaxis: horizontal
      ? { ...numeric, categories: spec.categories, max: stacked ? 100 : undefined }
      : { ...categorical, categories: spec.categories, tickPlacement: 'on' },
    yaxis: horizontal ? categorical : { ...numeric, max: stacked ? 100 : undefined },
  }
}

export const apexFactory: ChartFactory = async (el, spec, width) => {
  const ApexCharts = await loadApex()
  const chart = new ApexCharts(el, build(spec, width))
  await chart.render()

  const inst: ChartInstance = {
    update(next) {
      // Third argument false: no animation on a redraw, for the same reason
      // there is none on the first render.
      chart.updateOptions(build(next, el.clientWidth || width), true, false)
    },
    resize(w, h) {
      chart.updateOptions({ chart: { width: w, height: h } }, false, false)
    },
    destroy() {
      try { chart.destroy() } catch { /* already torn down with the node */ }
    },
  }
  return inst
}
