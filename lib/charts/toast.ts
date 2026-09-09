// TOAST UI Chart, as one of the report's rendering engines.
//
// ── usageStatistics: false is not optional ───────────────────────────────────
//
// TOAST UI Chart pings Google Analytics on every chart it creates, unless it is
// told not to. This application draws a dozen charts per page over a CLIENT's
// infringement data, and the hostname it would send is the client portal's. The
// flag is set on every chart built here; if a new chart type is added below,
// it goes in that options object too.
//
// ── Canvas, and what it costs ────────────────────────────────────────────────
//
// Unlike ApexCharts and ECharts, TOAST UI has no SVG renderer — v4 paints to a
// <canvas>. That matters twice over, because both of this report's export paths
// work by CLONING the card body, and `cloneNode` copies a canvas element
// without its bitmap:
//
//   · the panel PNG   (lib/chartImage.ts)
//   · the whole-page PDF (lib/printReport.ts)
//
// Both were taught to flatten a canvas to a data-URL <img> before the clone is
// serialised, which is what makes this engine exportable at all. Leave those
// two passes in place, or this engine's panels come out blank in every download
// while looking perfect on screen.
//
// ── The click payload ────────────────────────────────────────────────────────
//
// `selectSeries` hands back the internal series models keyed by series type —
// `{ column: [ { data: { label } } ] }` for a bar or column, `{ pie: [ { name } ] }`
// for a ring. There is no documented index, so the category label is read out
// of whichever shape arrived and matched back to the spec by position.

import type { ChartFactory, ChartInstance } from '@/lib/charts/ChartHost'
import { axisNum, fullNum, pickValue, tipBg, type ChartSpec } from '@/lib/charts/spec'

/** Loaded once per session — the library and its stylesheet together. */
let libPromise: Promise<any> | null = null

function loadToast() {
  return (libPromise ??= (async () => {
    const [lib] = await Promise.all([
      import('@toast-ui/chart'),
      // Its own CSS. Without it the legend and tooltip are unstyled boxes;
      // imported here rather than in the app's entry so a reader who never
      // selects this engine never downloads it.
      import('@toast-ui/chart/dist/toastui-chart.min.css'),
    ])
    return lib
  })())
}

const stackedForm = (spec: ChartSpec) => spec.form === 'stack-100'

function chartClass(lib: any, spec: ChartSpec) {
  switch (spec.form) {
    case 'group-column': return lib.ColumnChart
    case 'donut':        return lib.PieChart
    case 'line':         return lib.LineChart
    case 'area':         return lib.AreaChart
    // group-bar, single-bar and stack-100 are all horizontal.
    default:             return lib.BarChart
  }
}

function toData(spec: ChartSpec) {
  if (spec.form === 'donut') {
    return {
      categories: ['Share'],
      series: (spec.series[0]?.data ?? []).map((v, i) => ({
        name: spec.categories[i] ?? '',
        data: Number(v) || 0,
      })),
    }
  }
  return {
    categories: spec.categories,
    series: spec.series.map(s => ({ name: s.name, data: s.data.map(v => Number(v) || 0) })),
  }
}

function toOptions(spec: ChartSpec, width: number): Record<string, any> {
  const { m, dark, series, suffix = '' } = spec
  const ink = dark ? '#FFFFFF' : m.ident
  const stacked = stackedForm(spec)
  const colors = spec.form === 'donut' ? (spec.sliceColors ?? m.cat) : series.map(s => s.color)
  const showLegend = series.length > 1 || spec.form === 'donut'

  const theme: Record<string, any> = {
    chart: { fontFamily: 'inherit', backgroundColor: 'transparent' },
    series: {
      colors,
      dataLabels: { color: ink, fontSize: 9, fontWeight: 700, useSeriesColor: false },
      // The report's own idea of selection: the picked row stays solid and the
      // rest dim. Toast's default is a heavy shadow on the picked mark, which
      // reads as a hover state rather than as a filter.
      select: { areaOpacity: 1, restSeries: { areaOpacity: 0.32 } },
      areaOpacity: spec.form === 'area' ? 0.2 : 1,
    },
    xAxis: { label: { color: m.axis, fontSize: 11 }, color: m.grid, width: 1 },
    yAxis: { label: { color: m.axis, fontSize: 11 }, color: m.grid, width: 1 },
    legend: { label: { color: m.axis, fontSize: 11 } },
    plot: { lineColor: m.grid, vertical: { lineColor: m.grid }, horizontal: { lineColor: m.grid } },
    tooltip: {
      background: tipBg(m, dark),
      borderColor: m.grid,
      borderWidth: 1,
      borderRadius: 10,
      header: { color: ink, fontSize: 11, fontWeight: 700 },
      body: { color: ink, fontSize: 11 },
    },
  }

  const opts: Record<string, any> = {
    chart: { width: width || 'auto', height: spec.height, animation: false },
    // See the note at the top of this file. Never remove.
    usageStatistics: false,
    exportMenu: { visible: false },
    legend: { visible: showLegend, align: 'bottom', showCheckbox: false },
    tooltip: {
      formatter: (value: any) => `${fullNum(Number(value))}${suffix}`,
    },
    series: {
      selectable: !!spec.onPick,
      dataLabels: { visible: !!spec.labels, formatter: (v: any) => (Number(v) ? `${fullNum(Number(v))}${suffix}` : '') },
    },
    theme,
  }

  if (spec.form === 'donut') {
    // A ring, not a pie — the same 62% hole every other engine draws.
    opts.series.radiusRange = { inner: '62%', outer: '92%' }
    opts.series.dataLabels = { visible: false }
    return opts
  }

  if (stacked) opts.series.stack = { type: 'normal' }
  if (spec.form === 'line' || spec.form === 'area') {
    opts.series.spline = false
    opts.series.showDot = spec.categories.length <= 14
  }

  const measure = {
    label: { formatter: (v: any) => (stacked ? `${Math.round(Number(v) || 0)}%` : axisNum(Number(v))) },
    scale: stacked ? { min: 0, max: 100 } : undefined,
  }
  // BarChart puts the measure on x and the categories on y; ColumnChart, Line
  // and Area are the other way round.
  const horizontal = spec.form === 'group-bar' || spec.form === 'single-bar' || stacked
  if (horizontal) opts.xAxis = measure
  else opts.yAxis = measure

  return opts
}

/**
 * The category a selection landed on.
 *
 * `info` is the internal series models keyed by series type, so the shape
 * differs per chart: a bar or column model carries `data.label`, a pie model
 * carries `name`. Both are read, in that order, and the first hit wins.
 */
function pickedLabel(info: any): string | null {
  for (const models of Object.values(info ?? {})) {
    if (!Array.isArray(models)) continue
    for (const model of models as any[]) {
      const label = model?.data?.label ?? model?.name ?? model?.label
      if (label != null && label !== '') return String(label)
    }
  }
  return null
}

export const toastFactory: ChartFactory = async (el, spec, width) => {
  const lib = await loadToast()
  const Chart = chartClass(lib, spec)
  const chart = new Chart({
    el,
    data: toData(spec),
    options: toOptions(spec, width || el.clientWidth || 0),
  })

  /* Held in a box: the handler is registered once and has to narrow the report
     by whatever the panel is showing NOW, not by what it showed when the chart
     was built. */
  const live = { spec }
  chart.on('selectSeries', (info: any) => {
    const label = pickedLabel(info)
    if (label == null) return
    // The axis labels are shortened to fit; the report filters on the full
    // name, so the short one is matched back by position.
    const i = live.spec.categories.indexOf(label)
    live.spec.onPick?.(i >= 0 ? pickValue(live.spec, i) : label)
  })

  const instance: ChartInstance = {
    update(next) {
      live.spec = next
      chart.setOptions(toOptions(next, el.clientWidth || width))
      chart.setData(toData(next))
    },
    resize(w, h) {
      try { chart.resize({ width: w, height: h }) } catch { /* pre-layout */ }
    },
    destroy() {
      try { chart.destroy() } catch { /* already torn down with the node */ }
    },
  }
  return instance
}
