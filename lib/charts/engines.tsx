// Which engines the report offers, what each one can draw, and the one
// component that puts a panel through whichever is selected.
//
// ── Why every engine has a `forms` set ───────────────────────────────────────
//
// None of them can draw the whole report, and pretending otherwise is how a
// panel ends up blank. The world map, the heat grid, the ranked table and the
// repeat-offender list have no equivalent in a general charting library — three
// of the four are not charts — and the sparkline engine deliberately refuses
// anything it cannot say in one strip.
//
// So support is declared rather than assumed, and a form an engine does not
// claim falls straight through to the built-in rendering. The consequence is
// worth stating plainly: SELECTING AN ENGINE RE-DRAWS THE PANELS IT CAN AND
// LEAVES THE REST ALONE. A report on ECharts still has the built-in world map
// in it, because there is no ECharts version of that panel worth having.
//
// ── Why the adapters are imported statically ─────────────────────────────────
//
// They look like they should be lazy, and they are — one level down. Each
// adapter module is a few hundred bytes of option-building that reaches its
// library through a dynamic `import()`, so importing all four here costs
// nothing and the libraries themselves are still four separate chunks fetched
// on first use. Making the adapters lazy as well would buy nothing and put a
// suspense boundary around every panel on the page.

import type { ChartFactory } from '@/lib/charts/ChartHost'
import { ChartHost } from '@/lib/charts/ChartHost'
import type { ChartForm, ChartSpec } from '@/lib/charts/spec'
import { apexFactory } from '@/lib/charts/apex'
import { echartsFactory } from '@/lib/charts/echarts'
import { toastFactory } from '@/lib/charts/toast'
import Spark from '@/lib/charts/Spark'

export interface EngineDef {
  key: string
  label: string
  hint: string
  /** The forms this engine draws. Everything else falls back to the built-in. */
  forms: ReadonlySet<ChartForm>
  /** An imperative library, mounted into a div by ChartHost. */
  factory?: ChartFactory
  /** A renderer that is just React, with no library and no lifecycle. */
  Component?: React.ComponentType<{ spec: ChartSpec }>
  /** A caveat the reader should see before choosing it. */
  note?: string
}

/** Everything the neutral spec can express. */
const ALL_FORMS: ReadonlySet<ChartForm> = new Set<ChartForm>([
  'group-bar', 'group-column', 'single-bar', 'stack-100', 'donut', 'line', 'area',
])

export const NATIVE = 'native'

export const ENGINES: EngineDef[] = [
  {
    key: NATIVE,
    label: 'Built-in',
    hint: 'The charts this report was designed around — every panel, including the map',
    // Empty on purpose: nothing is delegated, so every panel takes its
    // fallback, which IS the built-in rendering.
    forms: new Set<ChartForm>(),
  },
  {
    key: 'apex',
    label: 'ApexCharts',
    hint: 'Rounded marks, a floating tooltip, SVG output',
    forms: ALL_FORMS,
    factory: apexFactory,
  },
  {
    key: 'echarts',
    label: 'ECharts',
    hint: 'Dense and precise, with a shared cross-series tooltip',
    forms: ALL_FORMS,
    factory: echartsFactory,
  },
  {
    key: 'toast',
    label: 'Toast UI Charts',
    hint: 'Flat marks and a boxed tooltip',
    forms: ALL_FORMS,
    factory: toastFactory,
    // Said out loud in the picker, because the reader finds out otherwise by
    // opening a downloaded PNG.
    note: 'Draws to canvas — exports are rasterised rather than vector',
  },
  {
    key: 'spark',
    label: 'Sparklines',
    hint: 'No axes, no legend — one dense strip per panel, numbers beside the marks',
    forms: ALL_FORMS,
    Component: Spark,
    note: 'Compresses every panel; the map, heat grid and tables are unchanged',
  },
]

const BY_KEY = new Map(ENGINES.map(e => [e.key, e]))

export function engineFor(key: string | undefined): EngineDef {
  return BY_KEY.get(key || '') ?? BY_KEY.get(NATIVE)!
}

export const isEngine = (key: string) => BY_KEY.has(key)

/** Would this engine take this panel, or does it fall through to the built-in? */
export const engineDraws = (key: string | undefined, form: ChartForm) =>
  engineFor(key).forms.has(form)

/**
 * One panel, drawn by the selected engine — or by the report's own renderer.
 *
 * `fallback` is that renderer, already built. It is used in three cases and all
 * three are normal: the reader is on the built-in engine, the engine does not
 * claim this form, or the engine's library would not load.
 */
export function EngineChart({ engine, spec, fallback }: {
  engine: string | undefined
  spec: ChartSpec
  fallback: React.ReactNode
}) {
  const def = engineFor(engine)
  if (!def.forms.has(spec.form)) return <>{fallback}</>
  if (def.Component) return <def.Component spec={spec} />
  if (!def.factory) return <>{fallback}</>
  return (
    /* Keyed on the form as well as the engine. None of these libraries can turn
       a donut into a column chart in place — Toast picks its class at
       construction — so a shape change has to be a new instance, not an
       update. */
    <ChartHost key={`${def.key}:${spec.form}`} spec={spec}
      factory={def.factory} fallback={fallback} />
  )
}
