'use client'

/*
The War Room's configurable panels — the pieces WarRoomReport lays out.

  WR_PANELS      the registry: every panel, its default title, size and the chart
                 shapes it can be drawn as. The page draws these; the saved layout
                 (go-server/handlers/warroomlayout.go) only overrides them.
  PanelFrame     one panel's header — title, description, chart type, Top-N,
                 CSV and PNG download — above its body.
  CatChart …     the alternative shapes a panel can be switched to.
  ArrangeDrawer  order, show/hide, size, title, description, default chart type
                 and default Top-N — for staff, Client Admins and logins with
                 report layout access.

The same rules as the Sports report: any reader may switch a card's chart type or
Top-N for the visit, and it changes that card only; the DEFAULT is set only by
someone allowed to shape the client's report.
*/

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { downloadChartPng } from '@/lib/chartImage'

export const NAVY = '#14254A'
export const ORANGE = '#FC934C'
const NAVY_TEXT = 'var(--wr-navy-text)'
const ORANGE_TEXT = 'var(--wr-orange-text)'
const nf = (n: number) => n.toLocaleString()
const compact = (n: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/* ── registry ─────────────────────────────────────────────────────────────── */

export type WrSpan = 'full' | 'twothirds' | 'half' | 'third' | 'quarter'
export type WrViz = 'bars' | 'hbar' | 'column' | 'donut' | 'table' | 'area' | 'line' | 'combo' | 'list'

export interface WrPanelDef {
  key: string
  title: string
  span: WrSpan
  /** Shapes it can be drawn as — the first is the built-in default. None: a fixed card. */
  viz?: WrViz[]
  /** Whether the reader picks how many rows it lists. */
  topN?: boolean
  /** When it appears at all, said in the Arrange drawer. */
  when?: string
}

const SEG: WrViz[] = ['bars', 'hbar', 'column', 'donut', 'table']
const TAT: WrViz[] = ['hbar', 'column', 'donut', 'table']

export const WR_PANELS: WrPanelDef[] = [
  { key: 'kpis', title: 'Headline KPIs', span: 'full' },
  { key: 'openWebStats', title: 'Open Web — hosts & linking URLs', span: 'full', when: 'Open Web selected' },
  { key: 'newDomains', title: 'Date-wise newly identified domains', span: 'half', viz: ['column', 'line', 'area', 'table'], when: 'Open Web selected' },
  { key: 'searchEngine', title: 'Linking URLs by search engine', span: 'half', viz: SEG, topN: true, when: 'Open Web selected' },
  { key: 'ugcPlatforms', title: 'UGC platforms — identification, removal & removal %', span: 'full', viz: ['combo', 'column', 'hbar', 'table'], when: 'UGC & Other selected' },
  { key: 'trend', title: 'Date-wise trend — identified vs removed', span: 'full', viz: ['area', 'line', 'column', 'table'] },
  { key: 'assetCompare', title: 'Asset comparison — identification vs removal', span: 'full', viz: ['column', 'hbar', 'table'], when: 'several assets selected' },
  { key: 'hostDonut', title: 'Host URLs / Media Files', span: 'third' },
  { key: 'channelsDonut', title: 'Channels / profiles', span: 'third', when: 'not on Open Web' },
  { key: 'removalRate', title: 'Removal rate', span: 'third' },
  { key: 'tatUrlEnf', title: 'TAT: URL → Enforcement', span: 'half', viz: TAT },
  { key: 'tatEnfRem', title: 'TAT: Enforcement → Removal', span: 'half', viz: TAT },
  { key: 'repeatOffenders', title: 'Repeat offenders — profiles re-uploading after removal', span: 'full', viz: ['list', 'table'], topN: true, when: 'there are repeat offenders' },
  { key: 'byReason', title: 'Infringement type', span: 'quarter', viz: SEG, topN: true },
  { key: 'byQuality', title: 'Quality of print', span: 'quarter', viz: SEG, topN: true },
  { key: 'byLanguage', title: 'Language', span: 'quarter', viz: SEG, topN: true },
  { key: 'byCountry', title: 'Country', span: 'quarter', viz: SEG, topN: true, when: 'not on Telegram' },
]

export const VIZ_LABEL: Record<WrViz, string> = {
  bars: 'Paired bars', hbar: 'Horizontal bars', column: 'Columns', donut: 'Donut', table: 'Table',
  area: 'Area', line: 'Line', combo: 'Bars + rate line', list: 'Ranked list',
}
export const SPAN_LABEL: Record<WrSpan, string> = {
  full: 'Full width', twothirds: 'Two thirds', half: 'Half', third: 'One third', quarter: 'Quarter',
}
export const SPAN_CLASS: Record<WrSpan, string> = {
  full: 'col-span-12',
  twothirds: 'col-span-12 xl:col-span-8',
  half: 'col-span-12 lg:col-span-6',
  third: 'col-span-12 md:col-span-6 xl:col-span-4',
  quarter: 'col-span-12 md:col-span-6 xl:col-span-3',
}
export const TOP_CHOICES = [10, 15, 20, 25]

export interface WrPanelConf {
  key: string; hidden?: boolean; span?: WrSpan | ''; title?: string; desc?: string; viz?: string; limit?: number
}
export interface WrLayout { panels: WrPanelConf[] }

/** The registry with a saved layout laid over it, in display order. */
export function resolvePanels(layout: WrLayout | null) {
  const byKey = new Map((layout?.panels ?? []).map(p => [p.key, p]))
  const known = new Map(WR_PANELS.map(d => [d.key, d]))
  const order = [
    ...(layout?.panels ?? []).map(p => p.key).filter(k => known.has(k)),
    ...WR_PANELS.map(d => d.key).filter(k => !byKey.has(k)),
  ]
  return order.map(k => {
    const def = known.get(k)!
    const c = byKey.get(k) ?? { key: k }
    const viz = def.viz ? (def.viz.includes(c.viz as WrViz) ? (c.viz as WrViz) : def.viz[0]) : undefined
    return {
      def,
      key: k,
      hidden: !!c.hidden,
      span: (c.span && SPAN_CLASS[c.span as WrSpan] ? c.span : def.span) as WrSpan,
      title: c.title || def.title,
      desc: c.desc || '',
      viz,
      limit: def.topN ? (c.limit && c.limit > 0 ? c.limit : 10) : 0,
      conf: c,
    }
  })
}
export type ResolvedPanel = ReturnType<typeof resolvePanels>[number]

/* ── small menu ───────────────────────────────────────────────────────────── */

function useMenu() {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    setRect(btn.current?.getBoundingClientRect() ?? null)
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!btn.current?.contains(t) && !menu.current?.contains(t)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const gone = () => setOpen(false)
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', gone, true)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', gone, true)
    }
  }, [open])
  return { open, setOpen, rect, btn, menu }
}

const btnCls = (changed: boolean) => `h-6 px-1.5 inline-flex items-center gap-1 rounded-md border text-[10px] font-bold normal-case tracking-normal transition-colors ${
  changed
    ? 'border-[#14254A] text-[#14254A] dark:border-white/40 dark:text-white'
    : 'border-gray-200 text-gray-400 hover:text-[#14254A] hover:border-gray-300 dark:border-white/15 dark:text-white/50 dark:hover:text-white'}`

/**
 * Pick from a few options: view now (anyone), or — for an editor — set the
 * default everyone on the client opens at.
 */
function ChoiceMenu<T extends string | number>({ label, icon, heading, options, value, resting, canSetDefault, onPick, onSetDefault }: {
  label: ReactNode; icon?: ReactNode; heading: string
  options: { key: T; label: string }[]
  value: T; resting: T; canSetDefault: boolean
  onPick: (v: T | null) => void
  onSetDefault: (v: T) => Promise<string | null>
}) {
  const m = useMenu()
  const [busy, setBusy] = useState<T | null>(null)
  const [err, setErr] = useState('')
  const keep = async (v: T) => {
    setBusy(v); setErr('')
    const e = await onSetDefault(v)
    setBusy(null)
    if (e) { setErr(e); return }
    m.setOpen(false)
  }
  return (
    <>
      <button ref={m.btn} type="button" onClick={e => { e.stopPropagation(); m.setOpen(o => !o) }}
        className={btnCls(value !== resting)} aria-haspopup="menu" aria-expanded={m.open} title={heading}>
        {icon}{label}
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {m.open && m.rect && createPortal(
        <div ref={m.menu} role="menu"
          className="fixed z-[9999] w-[230px] rounded-xl border shadow-2xl overflow-hidden py-1 bg-white border-gray-200 dark:bg-[#1a2d55] dark:border-white/15"
          style={{ top: Math.min(m.rect.bottom + 6, window.innerHeight - 320), left: Math.max(8, Math.min(m.rect.right - 230, window.innerWidth - 238)) }}>
          <p className="px-3 pt-1.5 pb-1 text-[9px] font-bold uppercase tracking-widest text-gray-400">{heading}</p>
          {options.map(o => {
            const on = o.key === value
            return (
              <div key={String(o.key)} className={`group flex items-stretch ${on ? 'bg-[#14254A]/[0.06] dark:bg-white/10' : 'hover:bg-gray-50 dark:hover:bg-white/5'}`}>
                <button type="button" role="menuitem" onClick={() => { onPick(o.key === resting ? null : o.key); m.setOpen(false) }}
                  className="flex-1 min-w-0 text-left px-3 py-1.5 flex items-center gap-1.5">
                  <span className={`text-xs ${on ? 'font-bold text-[#14254A] dark:text-white' : 'text-gray-600 dark:text-gray-300'}`}>{o.label}</span>
                  {o.key === resting && <span className="text-[9px] font-bold uppercase tracking-wide text-gray-400">default</span>}
                  {on && <span className="ml-auto text-[#FC934C] font-bold">✓</span>}
                </button>
                {canSetDefault && o.key !== resting && (
                  <button type="button" disabled={busy !== null} onClick={() => keep(o.key)}
                    title="Make this what everyone on this client opens at"
                    className="shrink-0 self-center mr-2 px-1.5 py-1 rounded-md text-[9px] font-bold uppercase tracking-wide border border-transparent text-gray-300 group-hover:border-gray-200 group-hover:text-gray-500 disabled:opacity-40">
                    {busy === o.key ? '…' : 'Set default'}
                  </button>
                )}
              </div>
            )
          })}
          {err && <p className="px-3 py-1.5 text-[10px] text-red-500 border-t border-gray-100">{err}</p>}
        </div>,
        document.body,
      )}
    </>
  )
}

/* ── the panel frame ─────────────────────────────────────────────────────── */

function DescDot({ text }: { text: string }) {
  const m = useMenu()
  return (
    <>
      <button ref={m.btn} type="button" onClick={e => { e.stopPropagation(); m.setOpen(o => !o) }} title="About this panel"
        className="w-3.5 h-3.5 grid place-items-center rounded-full text-gray-300 hover:text-[#14254A] hover:bg-[#14254A]/10 transition-colors">
        <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 8h.01M12 11v5" />
        </svg>
      </button>
      {m.open && m.rect && createPortal(
        <div ref={m.menu} className="fixed z-[9999] w-72 bg-white dark:bg-[#1a2d55] border border-gray-200 dark:border-white/15 text-gray-600 dark:text-gray-200 text-[12px] leading-relaxed rounded-xl shadow-xl p-3 whitespace-pre-line"
          style={{ top: m.rect.bottom + 6, left: Math.max(8, Math.min(m.rect.left, window.innerWidth - 296)) }}>
          {text}
        </div>,
        document.body,
      )}
    </>
  )
}

export function PanelFrame({ panel, adminInfo, csv, viz, onViz, topN, onTopN, canSetDefault, onSetDefault, children }: {
  panel: ResolvedPanel
  adminInfo?: ReactNode
  csv?: ReactNode
  viz?: WrViz; onViz: (v: WrViz | null) => void
  topN: number; onTopN: (n: number | null) => void
  canSetDefault: boolean
  onSetDefault: (patch: { viz?: WrViz; limit?: number }) => Promise<string | null>
  children: ReactNode
}) {
  const body = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const png = async () => {
    if (!body.current) return
    setBusy(true)
    try {
      await downloadChartPng(body.current, `war_room_${panel.title}`, {
        title: panel.title, subtitle: panel.desc || undefined,
        dark: document.documentElement.classList.contains('dark'),
      })
    } catch { /* nothing to show */ } finally { setBusy(false) }
  }
  const tops = [...new Set([...TOP_CHOICES, panel.limit])].sort((a, b) => a - b)
  return (
    <div className={`${SPAN_CLASS[panel.span]} flex flex-col min-w-0`}>
      <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-1.5 min-h-[24px]">
        <span className="truncate" title={panel.title}>{panel.title}</span>
        {panel.desc && <DescDot text={panel.desc} />}
        {adminInfo}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {panel.def.topN && (
            <ChoiceMenu heading="Show top" label={`Top ${topN}`}
              options={tops.map(n => ({ key: n, label: `Top ${n}` }))}
              value={topN} resting={panel.limit} canSetDefault={canSetDefault}
              onPick={n => onTopN(n)} onSetDefault={n => onSetDefault({ limit: n })} />
          )}
          {panel.def.viz && panel.def.viz.length > 1 && viz && (
            <ChoiceMenu heading="Show this as"
              icon={<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>}
              label="" options={panel.def.viz.map(v => ({ key: v, label: VIZ_LABEL[v] }))}
              value={viz} resting={panel.viz!} canSetDefault={canSetDefault}
              onPick={v => onViz(v)} onSetDefault={v => onSetDefault({ viz: v })} />
          )}
          {csv}
          <button type="button" onClick={e => { e.stopPropagation(); png() }} disabled={busy} title="Download this panel as a PNG image"
            className="w-4 h-4 grid place-items-center rounded text-gray-300 hover:text-[#FC934C] hover:bg-[#FC934C]/10 disabled:opacity-40">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 15l-5-5L5 20" />
            </svg>
          </button>
        </span>
      </div>
      <div ref={body} className="flex-1 flex flex-col">{children}</div>
    </div>
  )
}

/* ── alternative shapes ─────────────────────────────────────────────────── */

export function WrCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl shadow-card border border-gray-100 ${className}`}>{children}</div>
}

const tipStyle = { borderRadius: 10, border: '1px solid #e4e8f0', fontSize: 13 }
const axisTick = { fill: '#8592a6', fontSize: 11 }

export interface CatRow { key: string; label: string; identified: number; removed: number }

/** Identified vs removed per category, as horizontal bars, columns, a donut or a table. */
export function CatChart({ viz, rows, active, onSelect, firstName = 'Identification', secondName = 'Removed' }: {
  viz: WrViz; rows: CatRow[]; active?: string; onSelect?: (key: string) => void
  firstName?: string; secondName?: string
}) {
  if (!rows.length) return <WrCard className="p-4 flex-1"><div className="text-sm text-gray-400 py-3">No data.</div></WrCard>
  const has = !!active
  const click = (d: any) => { const k = d?.payload?.key ?? d?.key; if (k && onSelect) onSelect(k) }
  const cells = rows.map(r => <Cell key={r.key} opacity={has && r.key !== active ? 0.25 : 1} style={{ cursor: onSelect ? 'pointer' : undefined }} />)
  if (viz === 'table') {
    return (
      <WrCard className="p-2 flex-1 overflow-auto max-h-[420px]">
        <table className="w-full text-xs">
          <thead><tr className="text-[10px] uppercase tracking-wider text-gray-400 border-b border-gray-100">
            <th className="text-left py-2 px-2">Name</th><th className="text-right py-2 px-2">{firstName}</th>
            <th className="text-right py-2 px-2">{secondName}</th><th className="text-right py-2 px-2">Rate</th>
          </tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.key} onClick={() => onSelect?.(r.key)}
              className={`border-b border-gray-50 ${onSelect ? 'cursor-pointer hover:bg-[#14254A]/5' : ''} ${r.key === active ? 'bg-[#14254A]/5' : ''} ${has && r.key !== active ? 'opacity-40' : ''}`}>
              <td className="py-1.5 px-2 text-gray-600 truncate max-w-[260px]" title={r.label}>{r.label}</td>
              <td className="py-1.5 px-2 text-right font-bold" style={{ color: NAVY_TEXT }}>{nf(r.identified)}</td>
              <td className="py-1.5 px-2 text-right font-bold" style={{ color: ORANGE_TEXT }}>{nf(r.removed)}</td>
              <td className="py-1.5 px-2 text-right text-gray-500">{r.identified > 0 ? Math.round((r.removed / r.identified) * 100) : 0}%</td>
            </tr>
          ))}</tbody>
        </table>
      </WrCard>
    )
  }
  if (viz === 'donut') {
    const head = rows.slice(0, 8)
    const rest = rows.slice(8).reduce((a, r) => a + r.identified, 0)
    const data = [...head.map(r => ({ key: r.key, name: r.label, v: r.identified })), ...(rest > 0 ? [{ key: '', name: `Other (${rows.length - 8})`, v: rest }] : [])]
    const pal = [NAVY, ORANGE, '#3b6fb6', '#f6b47f', '#5b7bb0', '#c96f2c', '#8fa7cf', '#e9a36d']
    return (
      <WrCard className="p-4 flex-1">
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={data} dataKey="v" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={1} stroke="#fff" strokeWidth={2}
              isAnimationActive={false} onClick={(d: any) => d?.key && onSelect?.(d.key)}>
              {data.map((d, i) => <Cell key={i} fill={d.key ? pal[i % pal.length] : '#cbd5e1'} opacity={has && d.key !== active ? 0.3 : 1} style={{ cursor: d.key && onSelect ? 'pointer' : undefined }} />)}
            </Pie>
            <Tooltip contentStyle={tipStyle} formatter={(v: any) => [nf(Number(v)), firstName]} />
            <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" iconSize={8}
              wrapperStyle={{ fontSize: 11, maxWidth: '48%' }} formatter={(v: string) => cut(v, 22)} />
          </PieChart>
        </ResponsiveContainer>
      </WrCard>
    )
  }
  if (viz === 'column') {
    return (
      <WrCard className="p-4 flex-1">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} tick={{ ...axisTick, fill: '#64748b' }}
              tickFormatter={(v: string) => cut(v, 12)} angle={rows.length > 6 ? -30 : 0} textAnchor={rows.length > 6 ? 'end' : 'middle'} height={rows.length > 6 ? 56 : 30} />
            <YAxis tickLine={false} axisLine={false} tick={axisTick} width={44} tickFormatter={compact} allowDecimals={false} />
            <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={tipStyle} formatter={(v: any, n: any) => [nf(Number(v)), n]} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="identified" name={firstName} fill={NAVY} radius={[5, 5, 0, 0]} maxBarSize={34} onClick={click}>{cells}</Bar>
            <Bar dataKey="removed" name={secondName} fill={ORANGE} radius={[5, 5, 0, 0]} maxBarSize={34} onClick={click}>{cells}</Bar>
          </BarChart>
        </ResponsiveContainer>
      </WrCard>
    )
  }
  // hbar
  return (
    <WrCard className="p-4 flex-1">
      <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 34 + 50)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
          <XAxis type="number" tickLine={false} axisLine={false} tick={axisTick} tickFormatter={compact} allowDecimals={false} />
          <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={120} tick={{ ...axisTick, fill: '#64748b' }}
            tickFormatter={(v: string) => cut(v, 18)} />
          <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={tipStyle} formatter={(v: any, n: any) => [nf(Number(v)), n]} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="identified" name={firstName} fill={NAVY} radius={[0, 4, 4, 0]} barSize={10} onClick={click}>{cells}</Bar>
          <Bar dataKey="removed" name={secondName} fill={ORANGE} radius={[0, 4, 4, 0]} barSize={10} onClick={click}>{cells}</Bar>
        </BarChart>
      </ResponsiveContainer>
    </WrCard>
  )
}

/** The paired thin bars the War Room always drew, as a body (title lives in the frame). */
export function SegBars({ rows, active, onSelect }: { rows: CatRow[]; active?: string; onSelect?: (key: string) => void }) {
  if (!rows.length) return <WrCard className="p-4 flex-1"><div className="text-sm text-gray-400 py-3">No data.</div></WrCard>
  const max = Math.max(1, ...rows.map(s => s.identified))
  const has = !!active
  return (
    <WrCard className="p-4 flex-1">
      <div className="flex flex-col gap-2">
        {rows.map(sg => {
          const on = sg.key === active
          return (
            <button key={sg.key} onClick={() => onSelect?.(sg.key)}
              className={`grid items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-all hover:bg-[#14254A]/5 dark:hover:bg-white/5 ${
                on ? 'bg-[#14254A]/5 ring-1 ring-[#14254A]/40 dark:bg-white/5 dark:ring-white/20' : ''} ${has && !on ? 'opacity-40' : ''}`}
              style={{ gridTemplateColumns: '96px 1fr auto' }}>
              <span className="text-xs text-gray-600 truncate" title={sg.label}>{sg.label}</span>
              <span className="flex flex-col gap-1">
                <span className="h-1.5 rounded" style={{ width: `${(sg.identified / max) * 100}%`, minWidth: 2, background: NAVY }} />
                <span className="h-1.5 rounded" style={{ width: `${(sg.removed / max) * 100}%`, minWidth: 2, background: ORANGE }} />
              </span>
              <span className="flex flex-col items-end text-[11px] font-bold leading-tight min-w-[42px]">
                <span style={{ color: NAVY_TEXT }}>{nf(sg.identified)}</span>
                <span style={{ color: ORANGE_TEXT }}>{nf(sg.removed)}</span>
              </span>
            </button>
          )
        })}
        <div className="flex gap-4 mt-1 text-[11px] text-gray-400">
          <span className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: NAVY }} />Identification</span>
          <span className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: ORANGE }} />Removed</span>
        </div>
      </div>
    </WrCard>
  )
}

/** One count per bucket (TAT), as columns, a donut or a table. */
export function CountChart({ viz, rows, active, onSelect, name = 'URLs' }: {
  viz: WrViz; rows: { label: string; count: number }[]; active?: string; onSelect?: (label: string) => void; name?: string
}) {
  if (!rows.length || rows.every(r => r.count === 0)) {
    return <WrCard className="p-4 flex-1"><div className="text-sm text-gray-400 py-8 text-center">No TAT data available.</div></WrCard>
  }
  const has = !!active
  if (viz === 'table') {
    const total = rows.reduce((a, r) => a + r.count, 0) || 1
    return (
      <WrCard className="p-2 flex-1">
        <table className="w-full text-xs">
          <thead><tr className="text-[10px] uppercase tracking-wider text-gray-400 border-b border-gray-100">
            <th className="text-left py-2 px-2">Band</th><th className="text-right py-2 px-2">{name}</th><th className="text-right py-2 px-2">Share</th>
          </tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.label} onClick={() => onSelect?.(r.label)}
              className={`border-b border-gray-50 cursor-pointer hover:bg-[#14254A]/5 ${r.label === active ? 'bg-[#14254A]/5' : ''} ${has && r.label !== active ? 'opacity-40' : ''}`}>
              <td className="py-1.5 px-2 text-gray-600">{r.label}</td>
              <td className="py-1.5 px-2 text-right font-bold" style={{ color: NAVY_TEXT }}>{nf(r.count)}</td>
              <td className="py-1.5 px-2 text-right text-gray-500">{Math.round((r.count / total) * 100)}%</td>
            </tr>
          ))}</tbody>
        </table>
      </WrCard>
    )
  }
  if (viz === 'donut') {
    const pal = [NAVY, ORANGE, '#3b6fb6', '#f6b47f', '#5b7bb0', '#c96f2c']
    return (
      <WrCard className="p-4 flex-1">
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={rows} dataKey="count" nameKey="label" innerRadius="55%" outerRadius="85%" paddingAngle={1} stroke="#fff" strokeWidth={2}
              isAnimationActive={false} onClick={(d: any) => d?.label && onSelect?.(d.label)}>
              {rows.map((r, i) => <Cell key={r.label} fill={pal[i % pal.length]} opacity={has && r.label !== active ? 0.3 : 1} style={{ cursor: 'pointer' }} />)}
            </Pie>
            <Tooltip contentStyle={tipStyle} formatter={(v: any) => [nf(Number(v)), name]} />
            <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </WrCard>
    )
  }
  // column
  return (
    <WrCard className="p-4 flex-1">
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} tick={{ ...axisTick, fill: '#64748b' }} />
          <YAxis tickLine={false} axisLine={false} tick={axisTick} width={44} tickFormatter={compact} allowDecimals={false} />
          <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={tipStyle} formatter={(v: any) => [nf(Number(v)), name]} />
          <Bar dataKey="count" name={name} radius={[6, 6, 0, 0]} maxBarSize={48} onClick={(d: any) => d?.label && onSelect?.(d.label)}>
            {rows.map((r, i) => <Cell key={r.label} fill={r.label === active ? ORANGE : (i % 2 === 0 ? NAVY : ORANGE)} opacity={has && r.label !== active ? 0.25 : 1} style={{ cursor: 'pointer' }} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </WrCard>
  )
}

/** A dated series — area, line, columns or a table. */
export function SeriesChart({ viz, data, series, height = 220 }: {
  viz: WrViz; data: any[]
  series: { key: string; name: string; color: string }[]
  height?: number
}) {
  if (!data.length) return <WrCard className="p-4 flex-1"><div className="text-sm text-gray-400 py-10 text-center">No dated data.</div></WrCard>
  if (viz === 'table') {
    return (
      <WrCard className="p-2 flex-1 overflow-auto max-h-[420px]">
        <table className="w-full text-xs">
          <thead><tr className="text-[10px] uppercase tracking-wider text-gray-400 border-b border-gray-100">
            <th className="text-left py-2 px-2">Date</th>
            {series.map(s => <th key={s.key} className="text-right py-2 px-2">{s.name}</th>)}
          </tr></thead>
          <tbody>{[...data].reverse().map((d, i) => (
            <tr key={i} className="border-b border-gray-50">
              <td className="py-1.5 px-2 text-gray-600">{d.date}</td>
              {series.map(s => <td key={s.key} className="py-1.5 px-2 text-right font-bold" style={{ color: s.color === ORANGE ? ORANGE_TEXT : NAVY_TEXT }}>{nf(Number(d[s.key]) || 0)}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </WrCard>
    )
  }
  const common = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
      <XAxis dataKey="date" tickLine={false} axisLine={false} tick={axisTick} minTickGap={24} />
      <YAxis tickLine={false} axisLine={false} tick={axisTick} width={40} tickFormatter={compact} allowDecimals={false} />
      <Tooltip contentStyle={tipStyle} />
      {series.length > 1 && <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />}
    </>
  )
  return (
    <WrCard className="p-4 flex-1">
      <ResponsiveContainer width="100%" height={height}>
        {viz === 'column' ? (
          <BarChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
            {common}
            {series.map(s => <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={26} />)}
          </BarChart>
        ) : viz === 'line' ? (
          <LineChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
            {common}
            {series.map(s => <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2.2} dot={false} />)}
          </LineChart>
        ) : (
          <AreaChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
            <defs>
              {series.map(s => (
                <linearGradient key={s.key} id={`wrg-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={s.color} stopOpacity={0.3} /><stop offset="95%" stopColor={s.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {common}
            {series.map(s => <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} fill={`url(#wrg-${s.key})`} strokeWidth={2.2} dot={false} />)}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </WrCard>
  )
}

/* ── Arrange drawer ─────────────────────────────────────────────────────── */

export function ArrangeDrawer({ layout, onClose, onSave, onReset, canEditDefault, hasClient }: {
  layout: WrLayout | null
  onClose: () => void
  onSave: (panels: WrPanelConf[], scope: 'client' | 'default') => Promise<string | null>
  onReset?: () => Promise<string | null>
  canEditDefault: boolean
  /** Staff: whether a client is selected (else only the default can be edited). */
  hasClient: boolean
}) {
  const start = useMemo(() => resolvePanels(layout).map(p => ({
    key: p.key, def: p.def, hidden: p.hidden, span: p.span,
    title: p.conf.title || '', desc: p.conf.desc || '', viz: (p.conf.viz || '') as string, limit: p.conf.limit || 0,
  })), [layout])
  const [rows, setRows] = useState(start)
  const [scope, setScope] = useState<'client' | 'default'>(hasClient ? 'client' : 'default')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const move = (i: number, d: -1 | 1) => setRows(rs => {
    const j = i + d
    if (j < 0 || j >= rs.length) return rs
    const next = [...rs]; [next[i], next[j]] = [next[j], next[i]]; return next
  })
  const save = async () => {
    setBusy(true); setMsg('')
    const panels: WrPanelConf[] = rows.map(r => ({
      key: r.key, hidden: r.hidden || undefined,
      span: r.span !== r.def.span ? r.span : undefined,
      title: r.title.trim() || undefined, desc: r.desc.trim() || undefined,
      viz: r.viz || undefined, limit: r.limit || undefined,
    }))
    const err = await onSave(panels, scope)
    setBusy(false)
    if (err) setMsg(err); else onClose()
  }
  const reset = async () => {
    if (!onReset || !confirm('Reset this layout to the default? This cannot be undone.')) return
    setBusy(true); setMsg('')
    const err = await onReset()
    setBusy(false)
    if (err) setMsg(err); else onClose()
  }
  const inp = 'w-full rounded-lg border border-gray-200 dark:border-white/15 bg-white dark:bg-[#0f1f3d] px-2 py-1 text-xs text-[#14254A] dark:text-white'
  return createPortal(
    <div className="fixed inset-0 z-[80] flex justify-end bg-black/30" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="h-full w-full max-w-[560px] bg-[#f5f7fb] dark:bg-[#10203f] shadow-2xl flex flex-col">
        <div className="px-5 py-4 bg-[#14254A] text-white flex items-center">
          <div>
            <div className="text-sm font-bold">Arrange the War Room</div>
            <div className="text-[11px] text-white/70">Order, show or hide, size, title, description and the default chart type / Top-N.</div>
          </div>
          <button onClick={onClose} className="ml-auto w-7 h-7 rounded-full hover:bg-white/10">✕</button>
        </div>
        {canEditDefault && (
          <div className="px-5 py-2.5 border-b border-gray-200 dark:border-white/10 flex items-center gap-3 text-xs">
            <span className="font-semibold text-gray-500">Save for</span>
            {hasClient && (
              <label className="flex items-center gap-1.5"><input type="radio" checked={scope === 'client'} onChange={() => setScope('client')} /> This client</label>
            )}
            <label className="flex items-center gap-1.5"><input type="radio" checked={scope === 'default'} onChange={() => setScope('default')} /> Default for all clients</label>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {rows.map((r, i) => (
            <div key={r.key} className={`rounded-xl border bg-white dark:bg-[#1a2d55] p-3 ${r.hidden ? 'opacity-60 border-dashed border-gray-300' : 'border-gray-200 dark:border-white/10'}`}>
              <div className="flex items-center gap-2">
                <div className="flex flex-col">
                  <button disabled={i === 0} onClick={() => move(i, -1)} className="text-gray-400 hover:text-[#14254A] disabled:opacity-20 leading-none" title="Move up">▲</button>
                  <button disabled={i === rows.length - 1} onClick={() => move(i, 1)} className="text-gray-400 hover:text-[#14254A] disabled:opacity-20 leading-none" title="Move down">▼</button>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-[#14254A] dark:text-white truncate">{r.title || r.def.title}</div>
                  {r.def.when && <div className="text-[10px] text-gray-400">Shown when {r.def.when}</div>}
                </div>
                <select value={r.span} onChange={e => set(i, { span: e.target.value as WrSpan })} className={`${inp} !w-auto`} title="Size">
                  {(Object.keys(SPAN_LABEL) as WrSpan[]).map(s => <option key={s} value={s}>{SPAN_LABEL[s]}</option>)}
                </select>
                <button onClick={() => set(i, { hidden: !r.hidden })}
                  className={`text-[10px] font-bold uppercase px-2 py-1 rounded-md border ${r.hidden ? 'border-gray-300 text-gray-400' : 'border-[#14254A] text-[#14254A] dark:border-white/40 dark:text-white'}`}>
                  {r.hidden ? 'Hidden' : 'Shown'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <input className={`${inp} col-span-2`} placeholder={`Title — ${r.def.title}`} value={r.title} onChange={e => set(i, { title: e.target.value })} maxLength={160} />
                <textarea className={`${inp} col-span-2`} rows={2} placeholder="Description (shown behind an ⓘ beside the title)" value={r.desc} onChange={e => set(i, { desc: e.target.value })} maxLength={1000} />
                {r.def.viz && r.def.viz.length > 1 && (
                  <select className={inp} value={r.viz} onChange={e => set(i, { viz: e.target.value })} title="Default chart type">
                    <option value="">Chart: {VIZ_LABEL[r.def.viz[0]]} (built-in)</option>
                    {r.def.viz.map(v => <option key={v} value={v}>Chart: {VIZ_LABEL[v]}</option>)}
                  </select>
                )}
                {r.def.topN && (
                  <select className={inp} value={r.limit || ''} onChange={e => set(i, { limit: Number(e.target.value) || 0 })} title="Default Top-N">
                    <option value="">Top 10 (built-in)</option>
                    {TOP_CHOICES.map(n => <option key={n} value={n}>Top {n}</option>)}
                  </select>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-gray-200 dark:border-white/10 flex items-center gap-2">
          {msg && <span className="text-xs text-red-500 mr-auto">{msg}</span>}
          {onReset && <button onClick={reset} disabled={busy} className="text-xs font-semibold text-gray-400 hover:text-red-500 mr-auto">Reset to default</button>}
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600">Cancel</button>
          <button onClick={save} disabled={busy} className="px-4 py-1.5 rounded-lg bg-[#14254A] text-white text-xs font-bold disabled:opacity-50">
            {busy ? 'Saving…' : 'Save layout'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
