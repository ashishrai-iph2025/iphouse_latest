// The lifecycle every third-party chart engine needs, written once.
//
// ApexCharts, ECharts and Toast UI are all IMPERATIVE: you hand them a div and
// they take it over. Three things then have to be true, and each one is a bug
// the first time it is written by hand —
//
//   · the library is fetched LAZILY. A reader who never changes engine must not
//     pay for four charting libraries in the initial bundle, so the import is a
//     dynamic one inside the factory and Vite splits it into its own chunk.
//
//   · the instance is destroyed EXACTLY once, even when the effect that created
//     it never finished. React 18's StrictMode mounts, unmounts and remounts
//     every effect in development; without the cancelled flag below, the second
//     mount runs against a div the first mount is still writing into, and what
//     you get is two charts stacked in one card.
//
//   · a failure DRAWS SOMETHING. A dynamic import fails on a stale deploy, an
//     offline reader, and a blocked chunk — and the panel it fails in is one of
//     twelve on a page, so an exception takes the whole report down with it.
//     The fallback prop is the built-in rendering of the same panel; a chart the
//     reader did not ask for is a far better outcome than a blank report.
//
// Resizing is handled here too, and it is not optional: these engines measure
// their container ONCE, and the report's rails collapse, its cards reflow at
// three breakpoints, and its panels can be printed at a width nobody was
// looking at.

import { useEffect, useRef, useState } from 'react'
import type { ChartSpec } from '@/lib/charts/spec'

/** What a mounted engine gives back, so the host can drive it. */
export interface ChartInstance {
  /** New data, same instance — engines redraw far faster than they construct. */
  update(spec: ChartSpec): void
  resize(width: number, height: number): void
  destroy(): void
}

/**
 * Mounts one engine into one div.
 *
 * Async because it owns the dynamic import. Given the element, the spec and the
 * width the element actually has — engines that measure at construction get it
 * wrong when the card is still laying out, so the measurement is made here and
 * passed in.
 */
export type ChartFactory =
  (el: HTMLDivElement, spec: ChartSpec, width: number) => Promise<ChartInstance>

export function ChartHost({ spec, factory, fallback }: {
  spec: ChartSpec
  factory: ChartFactory
  /** Drawn instead if the engine will not load. */
  fallback: React.ReactNode
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const instRef = useRef<ChartInstance | null>(null)
  /* The newest spec, readable from a callback that closed over an older one.
     The factory's promise can settle after two more renders on a slow first
     load, and the chart it creates has to show what the page shows NOW. */
  const specRef = useRef(spec)
  specRef.current = spec

  const [failed, setFailed] = useState(false)
  /* Bumped on every failure so a later engine change re-arms the host: without
     it, one engine that failed to load leaves the panel on its fallback for the
     life of the page even after the reader switches to one that works. */
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let cancelled = false
    setFailed(false)
    setReady(false)

    factory(el, specRef.current, el.clientWidth || 0)
      .then(inst => {
        // Created after the effect was torn down — nothing will ever drive it,
        // so it is destroyed here rather than leaked into the DOM.
        if (cancelled) { inst.destroy(); return }
        instRef.current = inst
        setReady(true)
      })
      .catch(err => {
        if (cancelled) return
        // Named, because "the chart is missing" is otherwise unattributable in
        // a report of twelve panels.
        console.warn('[reports] chart engine failed to load', err)
        setFailed(true)
      })

    return () => {
      cancelled = true
      instRef.current?.destroy()
      instRef.current = null
    }
    // Only the factory. A spec change is an update, not a rebuild — see below.
  }, [factory])

  /* Data, colours and height, into the instance that already exists. Skipped
     until `ready`, because the factory was handed the first spec itself. */
  useEffect(() => {
    if (!ready) return
    instRef.current?.update(spec)
  }, [ready, spec])

  useEffect(() => {
    const el = hostRef.current
    if (!el || !ready || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (w) instRef.current?.resize(Math.round(w), specRef.current.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready])

  if (failed) return <>{fallback}</>

  return (
    <div ref={hostRef} className="w-full"
      style={{ height: spec.height, cursor: spec.onPick ? 'pointer' : undefined }} />
  )
}
