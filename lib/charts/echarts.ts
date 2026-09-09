// Apache ECharts, as one of the report's rendering engines.
//
// ── Why the tree-shaken entry ────────────────────────────────────────────────
//
// `import * as echarts from 'echarts'` pulls the whole library — every chart
// type, every component, the canvas renderer and the SVG one — for the four
// forms this report actually asks for. Registering only what is used through
// `echarts/core` is the difference between a ~1MB lazy chunk and a small one,
// and the reader downloading it is one who clicked a menu item, not one opening
// the page.
//
// ── Why the SVG renderer ─────────────────────────────────────────────────────
//
// ECharts paints to canvas by default and it is the faster of the two. It is
// also the wrong one here: the panel PNG download and the PDF export both work
// by cloning the card body into a <foreignObject>, and a cloned <canvas> is
// blank — the bitmap does not come with the node. lib/chartImage.ts flattens
// canvases as a safety net, but SVG means there is nothing to flatten, and the
// exported picture is vector rather than a screenshot of one.
//
// Nothing in this file reads the report's palette. Colours, labels and the
// click target arrive decided, in the ChartSpec.

import type { ChartFactory, ChartInstance } from '@/lib/charts/ChartHost'
import {
  axisNum, fullNum, markColor, pickValue, pointColor, tipBg, type ChartSpec,
} from '@/lib/charts/spec'

/** Loaded and registered once per session, on the first panel that needs it. */
let libPromise: Promise<any> | null = null

function loadECharts() {
  return (libPromise ??= (async () => {
    const [core, charts, components, renderers] = await Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers'),
    ])
    core.use([
      charts.BarChart, charts.LineChart, charts.PieChart,
      components.GridComponent, components.TooltipComponent,
      components.LegendComponent, components.DatasetComponent,
      renderers.SVGRenderer,
    ])
    return core
  })())
}

const isHorizontal = (spec: ChartSpec) =>
  spec.form === 'group-bar' || spec.form === 'single-bar' || spec.form === 'stack-100'

function build(spec: ChartSpec): Record<string, any> {
  const { m, dark, series, suffix = '' } = spec
  const ink = dark ? '#FFFFFF' : m.ident
  const horizontal = isHorizontal(spec)
  const stacked = spec.form === 'stack-100'
  const multi = series.length > 1

  const tooltip = {
    backgroundColor: tipBg(m, dark),
    borderColor: m.grid,
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: ink, fontSize: 11 },
    extraCssText: 'box-shadow:0 8px 24px rgba(20,37,74,0.12);border-radius:10px;',
  }

  const legend = {
    show: multi || spec.form === 'donut',
    bottom: 0,
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
    itemGap: 14,
    textStyle: { color: m.axis, fontSize: 11 },
  }

  if (spec.form === 'donut') {
    const colors = spec.sliceColors ?? m.cat
    return {
      color: colors,
      tooltip: {
        ...tooltip,
        trigger: 'item',
        formatter: (p: any) => `${p.name}<br/><b>${fullNum(p.value)}${suffix}</b> · ${p.percent}%`,
      },
      legend: { ...legend, type: 'scroll' },
      series: [{
        type: 'pie',
        // A ring, not a pie — the same 62% hole the built-in donut uses, so a
        // reader switching engine sees the same object.
        radius: ['62%', '92%'],
        center: ['50%', '46%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        // The 2px gap between touching wedges, drawn in the card's own colour.
        itemStyle: { borderColor: m.surface, borderWidth: 2 },
        emphasis: { scale: false, itemStyle: { opacity: 0.88 } },
        data: (series[0]?.data ?? []).map((v, i) => ({
          name: spec.titles[i] ?? '',
          value: Number(v) || 0,
          itemStyle: { color: markColor(spec, colors[i % colors.length], i) },
        })),
      }],
    }
  }

  const categoryAxis = {
    type: 'category',
    data: spec.categories,
    // Horizontal bars read top-down; ECharts numbers a category axis from the
    // origin, which puts the biggest row at the bottom without this.
    inverse: horizontal,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { color: m.axis, fontSize: 11, hideOverlap: true },
  }

  const valueAxis = {
    type: 'value',
    max: stacked ? 100 : undefined,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: m.grid, width: 1 } },
    axisLabel: {
      color: m.axis,
      fontSize: 11,
      formatter: (v: number) => (stacked ? `${v}%` : axisNum(v)),
    },
  }

  const label = {
    show: !!spec.labels,
    position: horizontal ? 'right' : 'top',
    color: ink,
    fontSize: 9,
    fontWeight: 700,
    formatter: (p: any) => (Number(p.value) ? `${fullNum(Number(p.value))}${suffix}` : ''),
  }

  const cartesianSeries = series.map(s => {
    const isLine = spec.form === 'line' || spec.form === 'area'
    if (isLine) {
      return {
        name: s.name,
        type: 'line',
        smooth: false,
        symbol: spec.categories.length <= 14 ? 'circle' : 'none',
        symbolSize: 6,
        lineStyle: { width: 2.4, color: s.color },
        itemStyle: { color: s.color },
        // A wash under the line rather than a block of colour: the second
        // series has to stay readable through the first.
        areaStyle: spec.form === 'area' ? { color: s.color, opacity: 0.18 } : undefined,
        data: s.data.map(v => Number(v) || 0),
        label: { ...label, show: false },
      }
    }
    return {
      name: s.name,
      type: 'bar',
      stack: stacked ? 'total' : undefined,
      barMaxWidth: horizontal ? 22 : 64,
      itemStyle: { borderRadius: stacked ? 0 : (horizontal ? [0, 2, 2, 0] : [2, 2, 0, 0]) },
      label,
      data: s.data.map((v, i) => ({
        value: Number(v) || 0,
        itemStyle: { color: markColor(spec, pointColor(spec, s.color, i), i) },
      })),
    }
  })

  return {
    color: series.map(s => s.color),
    /* Room for the legend at the bottom and for a data label at the end of the
       longest mark. containLabel lets ECharts measure the axis text itself —
       a fixed left gutter truncates a five-digit axis on one panel and wastes
       forty pixels on the next. */
    grid: { left: 2, right: 14, top: 14, bottom: legend.show ? 26 : 4, containLabel: true },
    tooltip: {
      ...tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: dark ? 'rgba(255,255,255,0.05)' : 'rgba(20,37,74,0.04)' } },
      formatter: (ps: any) => {
        const arr = Array.isArray(ps) ? ps : [ps]
        const i = arr[0]?.dataIndex ?? 0
        const head = spec.titles[i] ?? arr[0]?.name ?? ''
        const lines = arr.map((p: any) =>
          `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${p.color};margin-right:6px"></span>` +
          `${p.seriesName} <b>${fullNum(Number(p.value))}${suffix}</b>`).join('<br/>')
        return `<div style="font-weight:700;margin-bottom:3px">${head}</div>${lines}`
      },
    },
    legend,
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series: cartesianSeries,
    animation: false,
  }
}

export const echartsFactory: ChartFactory = async (el, spec, width) => {
  const echarts = await loadECharts()
  const inst = echarts.init(el, undefined, {
    renderer: 'svg',
    width: width || undefined,
    height: spec.height,
  })
  inst.setOption(build(spec))

  /* Held in a box rather than closed over: the click handler is registered
     once, and it has to narrow the report by whatever the panel is showing NOW
     rather than by what it was showing when the chart was created. */
  const live = { spec }
  inst.on('click', (p: any) => {
    const i = typeof p?.dataIndex === 'number' ? p.dataIndex : -1
    if (i >= 0) live.spec.onPick?.(pickValue(live.spec, i))
  })

  const instance: ChartInstance = {
    update(next) {
      live.spec = next
      // notMerge: a breakdown that drops from ten rows to three leaves three
      // ghost bars behind if the old option is merged rather than replaced.
      inst.setOption(build(next), true)
    },
    resize(w, h) { inst.resize({ width: w, height: h }) },
    destroy() {
      try { inst.dispose() } catch { /* already torn down with the node */ }
    },
  }
  return instance
}
