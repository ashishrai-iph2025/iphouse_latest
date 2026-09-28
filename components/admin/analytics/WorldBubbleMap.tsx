// A world map with one bubble per country, sized by value — the "Global Heat
// Map" of the torrent report.
//
// Country outlines are Natural Earth 1:110m from `world-atlas`, decoded with
// `topojson-client` and drawn as plain SVG in an equirectangular projection:
// no tile server, no map framework, nothing fetched from the network. The
// geometry (~100 KB) is imported dynamically so only this page pays for it.

import { useEffect, useMemo, useState } from 'react'
import { feature } from 'topojson-client'
import { useTok, BODY_FONT, ORANGE, Empty } from './ui'

export interface MapPoint { name: string; lat: number | null; lon: number | null; value: number; label?: string }

const W = 960, H = 460
const LAT_TOP = 84, LAT_BOTTOM = -58 // crop the poles: nothing is shared from Antarctica
const px = (lon: number) => ((lon + 180) / 360) * W
const py = (lat: number) => ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * H

// A ring as an SVG path, broken where it crosses the antimeridian so it does
// not streak across the whole map.
function ringPath(ring: number[][]): string {
  let d = ''
  let prev: number | null = null
  for (const [lon, lat] of ring) {
    const cmd = prev === null || Math.abs(lon - prev) > 180 ? 'M' : 'L'
    d += `${cmd}${px(lon).toFixed(1)},${py(Math.max(LAT_BOTTOM, Math.min(LAT_TOP, lat))).toFixed(1)}`
    prev = lon
  }
  return d + 'Z'
}

function geometryPath(g: any): string {
  if (!g) return ''
  if (g.type === 'Polygon') return g.coordinates.map(ringPath).join('')
  if (g.type === 'MultiPolygon') return g.coordinates.map((p: number[][][]) => p.map(ringPath).join('')).join('')
  return ''
}

export default function WorldBubbleMap({ points, fmt }: { points: MapPoint[]; fmt: (v: number) => string }) {
  const t = useTok()
  const [land, setLand] = useState<string[] | null>(null)
  const [hover, setHover] = useState<(MapPoint & { x: number; y: number }) | null>(null)

  useEffect(() => {
    let live = true
    import('world-atlas/countries-110m.json').then((m: any) => {
      const topo = m.default ?? m
      const fc: any = feature(topo, topo.objects.countries)
      if (live) setLand(fc.features.map((f: any) => geometryPath(f.geometry)))
    })
    return () => { live = false }
  }, [])

  const placed = useMemo(() => {
    const ok = points.filter(p => p.lat != null && p.lon != null && p.value > 0)
    const max = Math.max(1, ...ok.map(p => p.value))
    // Area ∝ value: radius by square root, so a country with 4× the IPs has 2× the radius.
    return ok.map((p, i) => ({ ...p, x: px(p.lon!), y: py(p.lat!), r: 3 + Math.sqrt(p.value / max) * 26, rank: i }))
      .sort((a, b) => b.r - a.r) // big first, so small bubbles stay on top and hoverable
  }, [points])

  if (!points.length) return <Empty>No countries in this selection</Empty>
  const sea = t.dark ? '#13233f' : '#eef3f8'
  const landFill = t.dark ? '#24406e' : '#d7dee8'

  return (
    <div className="relative w-full" style={BODY_FONT}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block rounded-lg" role="img" aria-label="Map of IPs by country">
        <rect width={W} height={H} fill={sea} />
        {land?.map((d, i) => <path key={i} d={d} fill={landFill} stroke={t.d.card} strokeWidth={0.5} />)}
        {placed.map(p => (
          <circle key={p.name} cx={p.x} cy={p.y} r={p.r}
            fill={p.rank < 10 ? ORANGE : t.d.series} fillOpacity={0.72}
            stroke={t.d.card} strokeWidth={1.2}
            onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)} style={{ cursor: 'default' }} />
        ))}
      </svg>
      {hover && (
        <div className="absolute pointer-events-none rounded-lg px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%`, transform: 'translate(-50%, calc(-100% - 10px))',
            background: t.d.tooltip, color: '#fff', whiteSpace: 'nowrap' }}>
          <b>{hover.label ?? hover.name}</b> · {fmt(hover.value)}
        </div>
      )}
      <div className="flex items-center gap-4 mt-2 text-[11px]" style={{ color: t.d.sub }}>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: ORANGE }} />Top 10 countries</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: t.d.series }} />Others</span>
        <span>Bubble area ∝ total IPs</span>
      </div>
    </div>
  )
}
