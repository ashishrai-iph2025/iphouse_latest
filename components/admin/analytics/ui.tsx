// Shared building blocks for the admin analytics pages (Traffic Analysis,
// Torrent Analysis): the admin home page's palette and dark-mode lifts, its
// cards and KPI tiles, the navy-headed zebra table that scrolls inside its own
// frame, ranked bar lists, trend charts, and the app's one loader.

import { type ReactNode } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts'
import ReportLoader from '@/components/shared/ReportLoader'
import { useTheme } from '@/lib/ThemeContext'

/* ── brand palette (same values as the admin home page) ─────────────────── */

export const NAVY = '#0D244B', ORANGE = '#FC934C', YELLOW = '#FFC82B', NAVY_50 = '#7C899C'
export const NAVY_25 = '#C6CDD7', NAVY_10 = '#E9ECEF', NAVY_5 = '#F4F5F7', NAVY_3 = '#F7F8F9'
export const RED = '#80020d', GREEN = '#2b7c38', TEAL = '#114a54', LILAC = '#60325f', BROWN = '#4c2e05', SEA = '#9fc2cc'
export const NAVY_DK = '#6C9BEF', NAVY_50_DK = '#A8B8D0', TEAL_DK = '#3FA6B8', LILAC_DK = '#C08BBE'
export const BROWN_DK = '#D0A05A', GREEN_DK = '#5BC46B', RED_DK = '#F2637A'

export const PALETTE_LIGHT = [ORANGE, NAVY, YELLOW, NAVY_50, TEAL, LILAC, BROWN, SEA, GREEN, RED]
export const PALETTE_DARK = [ORANGE, NAVY_DK, YELLOW, NAVY_50_DK, TEAL_DK, LILAC_DK, BROWN_DK, SEA, GREEN_DK, RED_DK]

// The portal's own typeface (app/globals.css) — the same on every page.
const HOUSE_FONT = "'Poppins', 'Segoe UI', system-ui, -apple-system, sans-serif"
export const BODY_FONT = { fontFamily: HOUSE_FONT }
export const HEAD_FONT = { fontFamily: HOUSE_FONT }

export function dk(dark: boolean) {
  return {
    card: dark ? '#1a2d4e' : '#fff',
    cardBorder: dark ? '#2a3f66' : NAVY_25,
    kpiBg: dark ? '#162038' : NAVY_5,
    text: dark ? '#e2e8f5' : NAVY,
    sub: dark ? '#8ba3c9' : NAVY_50,
    rowEven: dark ? '#1a2d4e' : '#fff',
    rowOdd: dark ? '#162038' : NAVY_3,
    rowBorder: dark ? '#2a3f66' : NAVY_3,
    rowSel: dark ? '#24406e' : NAVY_10,
    track: dark ? '#2a3f66' : NAVY_10,
    divider: dark ? '#2a3f66' : NAVY_25,
    series: dark ? NAVY_DK : NAVY,
    thead: dark ? '#24406e' : NAVY,
    tooltip: dark ? '#24406e' : NAVY,
    good: dark ? GREEN_DK : GREEN,
    bad: dark ? RED_DK : RED,
  }
}

export function useTok() {
  const { theme } = useTheme()
  const dark = theme === 'dark'
  const d = dk(dark)
  const pal = dark ? PALETTE_DARK : PALETTE_LIGHT
  return {
    dark, d, pal,
    grid: dark ? '#2a3f66' : NAVY_10,
    axis: d.sub,
    tip: {
      contentStyle: { background: d.tooltip, border: 'none', borderRadius: 8, fontSize: 12, color: '#fff', ...BODY_FONT },
      labelStyle: { fontWeight: 700, color: '#fff' },
      itemStyle: { color: '#fff' },
    },
  }
}

export type Num = number | null
export interface Share { key?: string; name?: string; label?: string; share: Num; visits?: Num; domains?: number; change?: Num; iso?: string | null; avgValue?: Num }

/* ── format ───────────────────────────────────────────────────────────── */

export const nf = (n: Num | undefined) => (n == null ? '—' : Math.round(n).toLocaleString())
export const cmp = (n: Num | undefined) => (n == null ? '—'
  : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n))
export const pct = (n: Num | undefined, dgt = 1) => (n == null ? '—' : `${n.toFixed(dgt)}%`)
export const flag = (iso?: string | null) => (!iso || iso.length !== 2 ? '' :
  String.fromCodePoint(...[...iso.toUpperCase()].map(c => 0x1f1a5 + c.charCodeAt(0))))
export const change = (cur: Num | undefined, prev: Num | undefined): Num =>
  cur == null || prev == null || prev === 0 ? null : ((cur - prev) / prev) * 100

/* ── building blocks ────────────────────────────────────────────────────── */

// The home page's card: header strip with title + subtitle, divider, body.
export function Card({ title, sub, action, children, className = '', flush = false }:
  { title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  const { d } = useTok()
  return (
    <section className={`rounded-xl overflow-hidden min-w-0 flex flex-col ${className}`} style={{ background: d.card, border: `1px solid ${d.cardBorder}` }}>
      {(title || action) && (
        <header className="px-5 py-3.5 flex items-start gap-3" style={{ borderBottom: `1px solid ${d.divider}` }}>
          <div className="min-w-0">
            {title && <p style={{ ...HEAD_FONT, color: d.text, fontWeight: 600, fontSize: 14 }}>{title}</p>}
            {sub && <p style={{ ...BODY_FONT, color: d.sub, fontSize: 11 }}>{sub}</p>}
          </div>
          {action && <div className="ml-auto shrink-0 flex items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={flush ? 'flex-1 min-h-0' : 'p-4 flex-1 min-h-0'}>{children}</div>
    </section>
  )
}

export function Delta({ v, invert = false }: { v: Num | undefined; invert?: boolean }) {
  const { d } = useTok()
  if (v == null) return null
  const up = v > 0, good = invert ? !up : up
  return (
    <span className="text-[11px] font-semibold inline-flex items-center gap-0.5 whitespace-nowrap"
      style={{ color: v === 0 ? d.sub : good ? d.good : d.bad, ...BODY_FONT }}>
      {v === 0 ? '±' : up ? '▲' : '▼'} {Math.abs(v).toFixed(1)}%
    </span>
  )
}

export function Stat({ label, value, delta, invert, hint, accent }:
  { label: string; value: ReactNode; delta?: Num; invert?: boolean; hint?: ReactNode; accent?: boolean }) {
  const { d } = useTok()
  return (
    <div className="rounded-xl px-4 py-3 min-w-0" style={{ background: d.card, border: `1px solid ${d.cardBorder}` }}>
      <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: d.sub, ...BODY_FONT }}>{label}</div>
      <div className="text-xl font-bold mt-1 truncate" style={{ color: accent ? ORANGE : d.text, ...HEAD_FONT }}>{value}</div>
      <div className="flex items-center gap-2 mt-0.5 min-h-[16px]">
        <Delta v={delta} invert={invert} />
        {hint && <span className="text-[11px] truncate" style={{ color: d.sub, ...BODY_FONT }}>{hint}</span>}
      </div>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  const { d } = useTok()
  return <div className="text-xs py-8 text-center" style={{ color: d.sub, ...BODY_FONT }}>{children}</div>
}

// The app's one loader, used exactly as the Reports page uses it: full size,
// filling its panel, with a label naming the wait and a sublabel for detail.
export function Loading({ label = 'Loading', sublabel }: { label?: string | null; sublabel?: string }) {
  return (
    <div className="min-h-[360px] flex flex-1 w-full items-center justify-center">
      <ReportLoader fill label={label} sublabel={sublabel} />
    </div>
  )
}

/*
Table — the home page's table: navy header row, zebra body, and a fixed-height
frame that scrolls on its own (header pinned), so a 5,000-domain list never
stretches the page.
*/
export interface Col<T> { key: string; label: string; align?: 'left' | 'right'; render: (r: T, i: number) => ReactNode; sort?: string; width?: number }

export function Table<T>({ cols, rows, rowKey, maxHeight = 420, sort, onSort, empty = 'No rows', selected, minWidth }:
  { cols: Col<T>[]; rows: T[]; rowKey: (r: T, i: number) => string; maxHeight?: number; sort?: string
    onSort?: (s: string) => void; empty?: string; selected?: (r: T) => boolean; minWidth?: number }) {
  const { d } = useTok()
  return (
    <div className="overflow-auto" style={{ maxHeight }}>
      <table className="w-full text-sm" style={{ ...BODY_FONT, minWidth }}>
        <thead className="sticky top-0 z-[1]">
          <tr style={{ background: d.thead }}>
            {cols.map(c => (
              <th key={c.key} className={`px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                style={{ color: 'rgba(255,255,255,0.85)', background: d.thead, width: c.width }}>
                {c.sort && onSort ? (
                  <button className="uppercase tracking-wide hover:text-white" onClick={() => onSort(c.sort!)}
                    style={{ color: sort === c.sort ? ORANGE : undefined }}>
                    {c.label}{sort === c.sort ? ' ▾' : ''}
                  </button>
                ) : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols.length} className="text-center py-8 text-xs" style={{ color: d.sub }}>{empty}</td></tr>
          ) : rows.map((r, i) => (
            <tr key={rowKey(r, i)} style={{
              background: selected?.(r) ? d.rowSel : i % 2 === 0 ? d.rowEven : d.rowOdd,
              borderBottom: `1px solid ${d.rowBorder}`,
            }}>
              {cols.map(c => (
                <td key={c.key} className={`px-4 py-2.5 text-xs whitespace-nowrap ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}
                  style={{ color: d.text }}>{c.render(r, i)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Ranked bars in the home page's style, scrolling inside a fixed frame.
export function BarList({ rows, color, value, sub, maxHeight = 300, empty = 'No data for this month' }:
  { rows: Share[]; color: string; value: (r: Share) => string; sub?: (r: Share) => ReactNode; maxHeight?: number; empty?: string }) {
  const { d } = useTok()
  if (!rows?.length) return <Empty>{empty}</Empty>
  const max = Math.max(...rows.map(r => r.share ?? 0), 0.0001)
  return (
    <ul className="space-y-2.5 overflow-y-auto pr-1" style={{ maxHeight, ...BODY_FONT }}>
      {rows.map((r, i) => (
        <li key={(r.name || r.label || r.key || '') + i} title={`${r.name ?? r.label}: ${value(r)}`}>
          <div className="flex items-baseline gap-2 text-xs">
            <span className="font-medium truncate" style={{ color: d.text }}>{flag(r.iso)} {r.name ?? r.label}</span>
            <span className="ml-auto tabular-nums font-semibold" style={{ color: d.text }}>{value(r)}</span>
          </div>
          <div className="h-1.5 rounded-sm mt-1" style={{ background: d.track }}>
            <div className="h-1.5 rounded-sm" style={{ width: `${Math.max(3, ((r.share ?? 0) / max) * 100)}%`, background: color }} />
          </div>
          {sub && <div className="text-[10.5px] mt-0.5" style={{ color: d.sub }}>{sub(r)}</div>}
        </li>
      ))}
    </ul>
  )
}

export function TrendArea({ data, dataKey, fmt, name, height = 220, color, mark }:
  { data: any[]; dataKey: string; fmt: (v: number) => string; name: string; height?: number; color?: string; mark?: string }) {
  const t = useTok()
  const stroke = color || t.d.series
  if (!data.length) return <Empty>No months to plot</Empty>
  const id = `ta-grad-${dataKey}-${stroke.slice(1)}`
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={t.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tick={{ fontSize: 10, fill: t.axis }} tickLine={false} axisLine={false} width={48} tickFormatter={v => fmt(v)} />
        <Tooltip {...t.tip} formatter={(v: any) => [fmt(Number(v)), name]} />
        <Area type="monotone" dataKey={dataKey} name={name} stroke={stroke} strokeWidth={2} fill={`url(#${id})`}
          dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: t.d.card }} connectNulls />
        {mark && <ReferenceLine x={mark} stroke={ORANGE} strokeDasharray="4 3" strokeWidth={1.5} />}
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function Btn({ children, onClick, active, disabled, title, type = 'button' }:
  { children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean; title?: string; type?: 'button' | 'submit' }) {
  const { d } = useTok()
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className="text-xs font-semibold px-3.5 py-2 rounded-lg transition-colors disabled:opacity-40 whitespace-nowrap"
      style={{
        ...BODY_FONT,
        background: active ? d.thead : d.card, color: active ? '#fff' : d.text,
        border: `1px solid ${active ? d.thead : d.cardBorder}`,
      }}>
      {children}
    </button>
  )
}

export function TextInput({ value, onChange, placeholder, width = 260 }:
  { value: string; onChange: (v: string) => void; placeholder?: string; width?: number }) {
  const { d } = useTok()
  return (
    <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
      className="text-xs px-3 py-2 rounded-lg focus:outline-none"
      style={{ ...BODY_FONT, width, background: d.card, color: d.text, border: `1px solid ${d.cardBorder}` }} />
  )
}

export function Field({ label, children, width }: { label: string; children: ReactNode; width?: number | string }) {
  const { d } = useTok()
  return (
    <div className="flex flex-col min-w-0" style={{ width }}>
      <span className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: d.sub, ...BODY_FONT }}>{label}</span>
      {children}
    </div>
  )
}

