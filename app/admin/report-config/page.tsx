'use client'

// Report configuration — which warehouse table feeds which platform report, what
// each table actually holds, and which logins may see which platform.
//
// Exists because the built-in report registry
// (go-server/handlers/reportspecs.go) carries column names copied from another
// project's SQL: they will not all match this warehouse, and correcting one
// should not need a code change and a deploy. Overrides are stored in the
// portal's own database and merged over the defaults at query time.
//
// The pickers are deliberately populated from information_schema rather than
// being free-text: choosing a table lists its real columns, so a mapping cannot
// be saved against a column that does not exist.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BackToConfiguration from '@/components/admin/BackToConfiguration'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import SearchableSelect from '@/components/ui/SearchableSelect'
import MultiSearchableSelect from '@/components/ui/MultiSearchableSelect'

const NAVY   = '#14254A'
const ORANGE = '#FC934C'

type Tab = 'sources' | 'layout' | 'inventory' | 'access' | 'clients'

/** One portal client and the warehouse client it reads. */
interface ClientMapRow {
  userId: number
  name: string
  warehouseClient?: string
  warehouseName?: string
  /** A warehouse client whose name matches this one — offered, never applied. */
  suggestion?: string
}

/* ── Layout ───────────────────────────────────────────────────────────────────
   A report page is a six-column grid, and every visual on it — the KPI tiles,
   the section rules, each chart — is a PANEL with a position and a width. This
   tab is where those are set, per platform.

   Widths are thirds of the grid, so a row holds one panel, two or three. Nothing
   forces a row to add up: leaving a half and a third together is allowed, and
   the leftover column stays empty, because the alternative is silently moving a
   panel the admin deliberately put there. The preview shows what the packing
   will actually be. */
type Span = 'full' | 'half' | 'third' | 'quarter'

const GRID_COLS = 12
const SPAN_COLS: Record<Span, number> = { full: 12, half: 6, third: 4, quarter: 3 }
const SPAN_LABEL: Record<Span, string> = {
  full: 'Full row', half: 'Half', third: 'Third', quarter: 'Quarter',
}
const SPANS: Span[] = ['full', 'half', 'third', 'quarter']

interface LayoutPanel {
  key: string
  kind: 'tile' | 'heading' | 'trend' | 'rate' | 'dim'
  name: string
  label?: string
  viz?: string
  metric?: string
  span: Span
  hidden: boolean
  defaultSpan: Span
  /** Breakdowns only: the chart the report opens with. Empty means the shape the
      registry chose for that dimension. */
  defaultViz?: string
  defaultVizLabel?: string
  /** A section rule spans the page by definition; a half-width one is a label
      floating beside a chart. */
  fixedSpan?: boolean
}

const KIND_LABEL: Record<LayoutPanel['kind'], string> = {
  tile: 'KPI card', heading: 'Section rule', trend: 'Trend', rate: 'Trend', dim: 'Chart',
}

/** Short width labels. The list is a two-column layout now, so "Full row / Half
    / Third / Quarter" spelled out four times per row is most of the row — the
    fraction says the same thing, and the long name is on the tooltip. */
const SPAN_SHORT: Record<Span, string> = {
  full: '1/1', half: '1/2', third: '1/3', quarter: '1/4',
}

/** A glyph and a tint per kind, so a panel's type is read before its name.
    Three families: figures, charts, and the rules that divide them. */
const KIND_STYLE: Record<LayoutPanel['kind'], { tint: string; glyph: React.ReactNode }> = {
  tile: {
    tint: 'bg-[#14254A]/[0.08] text-[#14254A] dark:bg-white/10 dark:text-white/80',
    glyph: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 15h4" /></>,
  },
  dim: {
    tint: 'bg-[#FC934C]/15 text-[#c2691f] dark:text-[#FDBE94]',
    glyph: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  },
  trend: {
    tint: 'bg-[#FC934C]/15 text-[#c2691f] dark:text-[#FDBE94]',
    glyph: <><path d="M3 17l5-6 4 3 6-8" /><path d="M21 20H3V4" /></>,
  },
  rate: {
    tint: 'bg-[#FC934C]/15 text-[#c2691f] dark:text-[#FDBE94]',
    glyph: <><path d="M3 17l5-6 4 3 6-8" /><path d="M21 20H3V4" /></>,
  },
  heading: {
    tint: 'bg-gray-100 text-gray-400 dark:bg-white/5 dark:text-white/40',
    glyph: <><path d="M4 8h16M4 14h10" /></>,
  },
}

function KindIcon({ kind }: { kind: LayoutPanel['kind'] }) {
  const s = KIND_STYLE[kind]
  return (
    <span className={`w-7 h-7 rounded-lg grid place-items-center flex-shrink-0 ${s.tint}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        {s.glyph}
      </svg>
    </span>
  )
}

/** Pack panels into rows, the way the CSS grid will. */
function packRows(panels: LayoutPanel[]): LayoutPanel[][] {
  const rows: LayoutPanel[][] = []
  let row: LayoutPanel[] = []
  let used = 0
  for (const p of panels) {
    const cols = SPAN_COLS[p.span] ?? 6
    if (used + cols > GRID_COLS && row.length > 0) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(p)
    used += cols
    if (used >= GRID_COLS) { rows.push(row); row = []; used = 0 }
  }
  if (row.length > 0) rows.push(row)
  return rows
}

/** What a table yields once the server has read its shape. */
interface TableDetail {
  table: string; usable: boolean
  clientCol?: string; dateCol?: string
  identExpr?: string; removedExpr?: string
  dimensions?: number; error?: string
}
/** A platform is a name plus the tables it reads — nothing else is configured;
    the client/date columns and the measures are derived per table by the server
    and reported back here so they can be checked. */
interface Platform {
  key: string; label: string; order: number; enabled: boolean
  tables: string[]
  tableDetail?: TableDetail[]
}
/** One row per platform × table: a platform reading three tables gets three. */
interface InventoryRow {
  key: string; label: string; table: string; enabled: boolean
  tableExists?: boolean
  clientCol?: string; dateCol?: string; identExpr?: string
  rows?: number; clients?: number; firstDate?: string; lastDate?: string
  error?: string
}
interface AccessUser {
  loginId: number; name: string; username: string; client: string
  isActive: boolean; restricted: boolean; allowed: string[]
}

const nf = (n: number) => Number(n || 0).toLocaleString()

/* ── Primitives, matching the rest of admin ───────────────────────────────── */

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
      dark:border-white/10 ${className}`}>
      {children}
    </div>
  )
}

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'mute'; children: React.ReactNode }) {
  const cls = {
    ok:   'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/12 dark:text-emerald-300 dark:border-emerald-400/25',
    warn: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/12 dark:text-amber-200 dark:border-amber-400/25',
    bad:  'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/12 dark:text-red-300 dark:border-red-400/25',
    mute: 'bg-gray-50 text-gray-500 border-gray-200 dark:bg-white/5 dark:text-white/45 dark:border-white/10',
  }[tone]
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide
      px-2 py-0.5 rounded-full border ${cls}`}>
      {children}
    </span>
  )
}

/** Ends a message with a full stop unless it already ends in punctuation, so a
    raw error can be followed by a sentence of our own. */
const sentence = (s: string) => /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`

/** A column or expression named inside a sentence — set apart without becoming
    a block of code, so the sentence still reads as a sentence. */
function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[10.5px] px-1 py-0.5 rounded bg-[#14254A]/[0.06]
      text-[#14254A] dark:bg-white/10 dark:text-white/80">{children}</code>
  )
}

/**
 * A checkbox with three readings: every one, some, none.
 *
 * `indeterminate` is a DOM property, not an attribute, so it cannot be set in
 * JSX — hence the ref. Worth it: a header box that looks empty when half the
 * column is ticked would be lying about what clicking it does.
 */
function TriCheck({ state, onChange, title, disabled }: {
  state: 'all' | 'some' | 'none'
  onChange: () => void
  title: string
  disabled?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some' }, [state])
  return (
    <input ref={ref} type="checkbox" checked={state === 'all'} onChange={onChange}
      disabled={disabled} title={title} aria-label={title}
      className="w-4 h-4 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ accentColor: ORANGE }} />
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-400 mt-1 truncate" title={hint}>{hint}</p>}
    </div>
  )
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function ReportConfigPage() {
  const [tab, setTab] = useState<Tab>('sources')
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [draftTables, setDraftTables] = useState<Record<string, string[]>>({})
  const [draftLabel, setDraftLabel] = useState<Record<string, string>>({})
  const [newLabel, setNewLabel] = useState('')
  const [newTables, setNewTables] = useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = useState<Platform | null>(null)
  const [tables, setTables] = useState<{ key: string; label: string }[]>([])
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [access, setAccess] = useState<{ reports: { key: string; label: string }[]; users: AccessUser[] }>({ reports: [], users: [] })
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const [err, setErr] = useState('')
  const [userQuery, setUserQuery] = useState('')
  /* Data sources tab. Platform cards open one at a time: the derived-column
     detail is diagnostic — worth reading when something is wrong, not worth
     scrolling past seven times to reach the platform you came for. */
  const [openPlatform, setOpenPlatform] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [sourceQuery, setSourceQuery] = useState('')
  // Layout tab: which platform is being arranged, its panels, and whether the
  // draft differs from what is stored.
  const [layoutKey, setLayoutKey] = useState('')
  const [layout, setLayout] = useState<LayoutPanel[]>([])
  const [layoutSaved, setLayoutSaved] = useState<LayoutPanel[]>([])
  const [layoutConfigured, setLayoutConfigured] = useState(false)
  /* '' is the layout every client gets. Pick a client and the page is arranged
     for that one alone — which is the point: two clients buying different things
     do not want the same six KPI cards. */
  const [layoutClient, setLayoutClient] = useState('')
  const [layoutClients, setLayoutClients] = useState<{ id: string; name: string }[]>([])
  const [clientsWithLayout, setClientsWithLayout] = useState<string[]>([])
  const [followsDefault, setFollowsDefault] = useState(false)
  // The chart types a breakdown can be switched to, served with the layout so
  // this screen never has to know the renderer's vocabulary.
  const [vizChoices, setVizChoices] = useState<{ key: string; label: string }[]>([])
  /* Client mapping: which warehouse client each portal client reads. Nothing
     else decides it — a client login's report is scoped by this row and only
     this row. */
  const [clientMap, setClientMap] = useState<ClientMapRow[]>([])
  const [warehouseClients, setWarehouseClients] = useState<{ key: string; label: string }[]>([])
  const [mapQuery, setMapQuery] = useState('')
  // Drag state for the preview: what is being carried, and what it is over.
  const [dragKey, setDragKey] = useState('')
  const [overKey, setOverKey] = useState('')

  const flash = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  const loadPlatforms = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/report-platforms?shape=1', { credentials: 'include' })
      if (!r.ok) throw new Error(`Could not load the platforms (${r.status})`)
      const d = await r.json()
      const list: Platform[] = d.platforms || []
      setPlatforms(list)
      // Drafts start from what is stored, so the form always shows what is live.
      setDraftTables(Object.fromEntries(list.map(p => [p.key, p.tables || []])))
      setDraftLabel(Object.fromEntries(list.map(p => [p.key, p.label])))
      setErr('')
    } catch (e: any) { setErr(e.message) }
  }, [])

  const loadTables = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/report-config/tables', { credentials: 'include' })
      const d = await r.json()
      if (d.available === false) { setErr(d.error || 'Warehouse unavailable'); return }
      setTables((d.tables || []).map((t: any) => ({
        key: String(t.name),
        label: `${t.name}${t.approxRows != null ? `  ·  ~${nf(Number(t.approxRows))} rows` : ''}`,
      })))
    } catch { /* the table picker degrades to whatever is already saved */ }
  }, [])

  const loadInventory = useCallback(async () => {
    setBusy('inventory')
    try {
      const r = await fetch('/api/admin/report-config/inventory', { credentials: 'include' })
      const d = await r.json()
      if (d.available === false) { setErr(d.error || 'Warehouse unavailable'); return }
      setInventory(d.reports || [])
    } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }, [])

  const loadAccess = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/report-access', { credentials: 'include' })
      const d = await r.json()
      setAccess({ reports: d.reports || [], users: d.users || [] })
    } catch (e: any) { setErr(e.message) }
  }, [])

  const loadLayout = useCallback(async (key: string, clientId: string) => {
    if (!key) return
    setBusy('layout')
    try {
      const q = new URLSearchParams({ platform: key })
      if (clientId) q.set('clientId', clientId)
      const r = await fetch(`/api/admin/report-layout?${q}`, { credentials: 'include' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `Could not load the layout (${r.status})`)
      const panels: LayoutPanel[] = (d.panels || []).map((p: any) => ({
        key: String(p.key), kind: p.kind, name: String(p.name || p.label || p.key),
        label: p.label, viz: p.viz, metric: p.metric,
        span: (p.span || p.defaultSpan || 'half') as Span,
        hidden: !!p.hidden,
        defaultSpan: (p.defaultSpan || 'half') as Span,
        defaultViz: p.defaultViz, defaultVizLabel: p.defaultVizLabel,
        fixedSpan: !!p.fixedSpan,
      }))
      setVizChoices(d.vizChoices || [])
      setLayout(panels)
      setLayoutSaved(panels)
      setLayoutConfigured(!!d.configured)
      setFollowsDefault(!!d.followsDefault)
      setErr('')
    } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }, [])

  /* The client list is the warehouse's, same as the report's own slicer. It
     needs a platform to scope it, and it degrades to "all clients only" when the
     analytics database is out of reach — arranging the shared layout still
     works without it. */
  const loadLayoutClients = useCallback(async (key: string) => {
    if (!key) return
    setLayoutClients([])
    setClientsWithLayout([])
    try {
      const [optRes, mineRes] = await Promise.all([
        fetch(`/api/reports/options?type=${encodeURIComponent(key)}`, { credentials: 'include' }),
        fetch(`/api/admin/report-layout/clients?platform=${encodeURIComponent(key)}`, { credentials: 'include' }),
      ])
      const opt = await optRes.json()
      if (Array.isArray(opt.clients)) {
        setLayoutClients(opt.clients.map((c: any) => ({ id: String(c.id), name: String(c.name ?? c.id) })))
      }
      const mine = await mineRes.json()
      if (Array.isArray(mine.clients)) setClientsWithLayout(mine.clients.map(String))
    } catch { /* the picker degrades to the all-clients default */ }
  }, [])

  const loadClientMap = useCallback(async () => {
    setBusy('clients')
    try {
      const r = await fetch('/api/admin/report-client-map', { credentials: 'include' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `Could not load the mapping (${r.status})`)
      setClientMap(d.clients || [])
      setWarehouseClients((d.warehouseClients || [])
        .map((c: any) => ({ key: String(c.id), label: String(c.name || c.id) }))
        .sort((a: any, b: any) => a.label.localeCompare(b.label)))
      setErr('')
    } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }, [])

  /* Saved a row at a time rather than behind a Save button: each row is an
     independent decision, and a half-finished screen of them is not a state
     anybody wants to reason about. */
  async function saveClientMap(userId: number, warehouseClient: string) {
    const name = warehouseClients.find(c => c.key === warehouseClient)?.label ?? ''
    setClientMap(cur => cur.map(c => c.userId === userId
      ? { ...c, warehouseClient, warehouseName: name, suggestion: undefined } : c))
    try {
      const r = await fetch('/api/admin/report-client-map', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, warehouseClient, warehouseName: name }),
      })
      const d = await r.json()
      if (!r.ok || d.success === false) throw new Error(d.error || 'Could not save the mapping')
      flash(warehouseClient ? 'Client linked' : 'Link removed')
    } catch (e: any) {
      flash(e.message, false)
      loadClientMap()
    }
  }

  useEffect(() => { loadPlatforms(); loadTables() }, [loadPlatforms, loadTables])
  useEffect(() => { if (tab === 'clients' && clientMap.length === 0) loadClientMap() },
    [tab, clientMap.length, loadClientMap])
  useEffect(() => { if (tab === 'inventory' && inventory.length === 0) loadInventory() }, [tab, inventory.length, loadInventory])
  useEffect(() => { if (tab === 'access' && access.users.length === 0) loadAccess() }, [tab, access.users.length, loadAccess])

  /* The Layout tab opens on the first platform in the sidebar order, which is
     the one most likely being worked on. */
  useEffect(() => {
    if (tab !== 'layout' || layoutKey || platforms.length === 0) return
    setLayoutKey(platforms[0].key)
  }, [tab, layoutKey, platforms])
  useEffect(() => { if (tab === 'layout') loadLayout(layoutKey, layoutClient) },
    [tab, layoutKey, layoutClient, loadLayout])
  /* Switching platform resets the client: a warehouse client id means something
     different per platform, and carrying one across would arrange a page for
     whoever happens to share that id. */
  useEffect(() => {
    if (tab !== 'layout' || !layoutKey) return
    setLayoutClient('')
    loadLayoutClients(layoutKey)
  }, [tab, layoutKey, loadLayoutClients])

  /* ── Layout edits ─────────────────────────────────────────────────────────
     All local until Save: arranging a page is a sequence of small moves, and
     writing each one straight through would mean a half-finished layout is what
     everyone else sees. */
  const moveLayout = (index: number, by: number) => setLayout(cur => {
    const to = index + by
    if (to < 0 || to >= cur.length) return cur
    const next = [...cur]
    const [row] = next.splice(index, 1)
    next.splice(to, 0, row)
    return next
  })
  /**
   * Move one panel to another's slot — what a drag in the preview does.
   *
   * Indices are into the WHOLE list, not the visible subset the preview draws,
   * so a hidden panel keeps its place among its neighbours instead of being
   * shuffled by a drag it took no part in. Dropping onto a panel further down
   * lands after it and further up lands before it, which is what dragging
   * something past a thing means everywhere else.
   */
  const moveByKey = (fromKey: string, toKey: string) => setLayout(cur => {
    if (fromKey === toKey) return cur
    const from = cur.findIndex(p => p.key === fromKey)
    const to = cur.findIndex(p => p.key === toKey)
    if (from < 0 || to < 0) return cur
    const next = [...cur]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row)
    return next
  })

  const setSpan = (key: string, span: Span) =>
    setLayout(cur => cur.map(p => p.key === key ? { ...p, span } : p))
  /* '' puts a panel back on the shape the registry chose for that dimension —
     which is why "default" is a value in the list rather than a reset button. */
  const setViz = (key: string, viz: string) =>
    setLayout(cur => cur.map(p => p.key === key ? { ...p, viz } : p))
  const toggleHidden = (key: string) =>
    setLayout(cur => cur.map(p => p.key === key ? { ...p, hidden: !p.hidden } : p))

  const layoutDirty = useMemo(
    () => JSON.stringify(layout.map(p => [p.key, p.span, p.viz ?? '', p.hidden])) !==
          JSON.stringify(layoutSaved.map(p => [p.key, p.span, p.viz ?? '', p.hidden])),
    [layout, layoutSaved])

  async function saveLayout() {
    setBusy('layout-save')
    try {
      const r = await fetch('/api/admin/report-layout', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: layoutKey,
          clientId: layoutClient,
          panels: layout.map(p => ({
            key: p.key, span: p.span, hidden: p.hidden,
            // Only a breakdown has a chart type; sending one for a tile would
            // store a row the server ignores.
            viz: p.kind === 'dim' ? (p.viz ?? '') : '',
          })),
        }),
      })
      const d = await r.json()
      if (!r.ok || d.success === false) throw new Error(d.error || 'Could not save the layout')
      setLayoutSaved(layout)
      setLayoutConfigured(true)
      setFollowsDefault(false)
      if (layoutClient && !clientsWithLayout.includes(layoutClient)) {
        setClientsWithLayout(cur => [...cur, layoutClient])
      }
      flash(layoutClient ? 'Layout saved for this client' : 'Layout saved')
    } catch (e: any) { flash(e.message, false) } finally { setBusy('') }
  }

  async function resetLayout() {
    setBusy('layout-save')
    try {
      const q = new URLSearchParams({ platform: layoutKey })
      if (layoutClient) q.set('clientId', layoutClient)
      const r = await fetch(`/api/admin/report-layout?${q}`, { method: 'DELETE', credentials: 'include' })
      const d = await r.json()
      if (!r.ok || d.success === false) throw new Error(d.error || 'Could not reset the layout')
      setClientsWithLayout(cur => cur.filter(c => c !== layoutClient))
      flash(layoutClient ? 'This client follows the shared layout again' : 'Layout back to its default')
      await loadLayout(layoutKey, layoutClient)
    } catch (e: any) { flash(e.message, false) } finally { setBusy('') }
  }

  async function savePlatform(key: string, label: string, tables: string[], enabled = true) {
    setBusy(key || 'new')
    try {
      const r = await fetch('/api/admin/report-platforms', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, label, tables, enabled }),
      })
      const d = await r.json()
      if (!d.success) throw new Error(d.error || 'Save failed')
      flash(key ? 'Platform saved' : `Platform "${label}" added`)
      setNewLabel(''); setNewTables([])
      await loadPlatforms()
      setInventory([])   // stale once the mapping changed
    } catch (e: any) { flash(e.message, false) } finally { setBusy('') }
  }

  /** Move a platform up or down, then persist the whole order. */
  async function move(index: number, delta: number) {
    const next = [...platforms]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setPlatforms(next)              // optimistic: the list reorders immediately
    setBusy('reorder')
    try {
      const r = await fetch('/api/admin/report-platforms/reorder', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: next.map(p => p.key) }),
      })
      const d = await r.json()
      if (!d.success) throw new Error(d.error || 'Could not save the order')
      await loadPlatforms()
    } catch (e: any) {
      flash(e.message, false)
      await loadPlatforms()         // put it back the way the server has it
    } finally { setBusy('') }
  }

  async function deletePlatform(p: Platform) {
    setBusy(p.key)
    try {
      const r = await fetch(`/api/admin/report-platforms?key=${encodeURIComponent(p.key)}`, {
        method: 'DELETE', credentials: 'include',
      })
      const d = await r.json()
      if (!d.success) throw new Error(d.error || 'Delete failed')
      flash(`Platform "${p.label}" deleted`)
      setConfirmDelete(null)
      await loadPlatforms()
      setInventory([])
    } catch (e: any) { flash(e.message, false) } finally { setBusy('') }
  }

  async function saveAccess(u: AccessUser, allowed: string[] | null) {
    setBusy(`access-${u.loginId}`)
    try {
      const r = await fetch('/api/admin/report-access', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: u.loginId, allowed }),
      })
      const d = await r.json()
      if (!d.success) throw new Error(d.error || 'Save failed')
      setAccess(a => ({
        ...a,
        users: a.users.map(x => x.loginId === u.loginId
          ? { ...x, restricted: allowed !== null, allowed: allowed ?? [] }
          : x),
      }))
    } catch (e: any) { flash(e.message, false) } finally { setBusy('') }
  }

  /** Every platform key, in column order. */
  const everyReport = useMemo(() => access.reports.map(r => r.key), [access.reports])

  /** What a login can actually see right now — an unrestricted one sees all. */
  const effective = useCallback(
    (u: AccessUser) => (u.restricted ? u.allowed : everyReport), [everyReport])

  /**
   * A set of keys as it should be STORED: everything becomes `null`, so
   * "unrestricted" stays the default state in the data rather than a saved list
   * that silently stops covering a platform added later.
   */
  const normalize = useCallback((keys: string[]): string[] | null => {
    const kept = everyReport.filter(k => keys.includes(k))
    return kept.length === everyReport.length ? null : kept
  }, [everyReport])

  /** Toggle one platform for one login, converting "all" into an explicit list. */
  function togglePlatform(u: AccessUser, key: string) {
    const current = effective(u)
    const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key]
    saveAccess(u, normalize(next))
  }

  /**
   * Apply a change to many logins at once, for the row and column controls.
   *
   * ONE request carrying every change, not one per login. A column tick across
   * forty logins used to be forty round trips — each of which re-read the
   * platform list on the server — and it was the reason this screen felt slow.
   *
   * Logins already in the target state are dropped first, so ticking a column
   * that is nearly full sends only the few rows that actually change.
   */
  async function applyAccess(changes: { user: AccessUser; allowed: string[] | null }[]) {
    const same = (u: AccessUser, allowed: string[] | null) =>
      allowed === null
        ? !u.restricted
        : u.restricted && u.allowed.length === allowed.length &&
          allowed.every(k => u.allowed.includes(k))
    const real = changes.filter(c => !same(c.user, c.allowed))
    if (real.length === 0) return

    setBusy('access-bulk')
    try {
      const r = await fetch('/api/admin/report-access', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: real.map(c => ({ loginId: c.user.loginId, allowed: c.allowed })),
        }),
      })
      const d = await r.json()
      if (!d.success) throw new Error(d.error || 'Could not update access')
      setAccess(a => ({
        ...a,
        users: a.users.map(x => {
          const hit = real.find(c => c.user.loginId === x.loginId)
          return hit
            ? { ...x, restricted: hit.allowed !== null, allowed: hit.allowed ?? [] }
            : x
        }),
      }))
      flash(`Access updated for ${real.length} login${real.length === 1 ? '' : 's'}`)
    } catch (e: any) {
      flash(e.message, false)
      loadAccess()      // a partial failure leaves the table lying; re-read it
    } finally { setBusy('') }
  }

  const visibleUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase()
    if (!q) return access.users
    return access.users.filter(u =>
      u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) ||
      (u.client || '').toLowerCase().includes(q))
  }, [access.users, userQuery])

  /* Whether a bulk write is in flight — every tri-state box is disabled during
     one, so a second click cannot race the first. */
  const busyAccess = busy === 'access-bulk'

  /** How much of one login's row is ticked. */
  const rowState = useCallback((u: AccessUser): 'all' | 'some' | 'none' => {
    if (!u.restricted) return 'all'
    if (u.allowed.length === 0) return 'none'
    return u.allowed.length >= everyReport.length ? 'all' : 'some'
  }, [everyReport.length])

  /** How much of one platform's column is ticked, across the logins SHOWN —
      the search box is therefore also the scope selector for a bulk tick. */
  const columnState = useCallback((key: string): 'all' | 'some' | 'none' => {
    if (visibleUsers.length === 0) return 'none'
    const on = visibleUsers.filter(u => effective(u).includes(key)).length
    return on === 0 ? 'none' : on === visibleUsers.length ? 'all' : 'some'
  }, [visibleUsers, effective])

  /** The whole grid: every platform for every login shown. */
  const gridState = useMemo((): 'all' | 'some' | 'none' => {
    if (visibleUsers.length === 0) return 'none'
    const states = visibleUsers.map(rowState)
    if (states.every(x => x === 'all')) return 'all'
    if (states.every(x => x === 'none')) return 'none'
    return 'some'
  }, [visibleUsers, rowState])

  /**
   * One panel in the layout editor.
   *
   * Everything a panel has is on one line, in the order it is asked about: what
   * it is, what it is called, how wide, and whether it is on the page at all.
   * The row is a drag source and a drop target, so the list reorders the same
   * way the preview does; the arrows stay because a drag has no keyboard or
   * touch equivalent.
   */
  const renderPanelRow = (p: LayoutPanel) => {
    const i = layout.findIndex(x => x.key === p.key)
    const dropping = overKey === p.key && !!dragKey && dragKey !== p.key
    return (
      <div key={p.key}
        draggable
        onDragStart={e => {
          setDragKey(p.key)
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', p.key)
        }}
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverKey(p.key) }}
        onDragLeave={() => setOverKey(cur => cur === p.key ? '' : cur)}
        onDrop={e => {
          e.preventDefault()
          const from = dragKey || e.dataTransfer.getData('text/plain')
          if (from) moveByKey(from, p.key)
          setDragKey(''); setOverKey('')
        }}
        onDragEnd={() => { setDragKey(''); setOverKey('') }}
        className={`group flex items-center gap-2.5 px-3 py-2 transition-colors ${
          dragKey === p.key ? 'opacity-35' : ''} ${
          dropping ? 'bg-[#FC934C]/10' : 'hover:bg-[#14254A]/[0.025] dark:hover:bg-white/[0.04]'} ${
          p.hidden ? 'opacity-55' : ''}`}>

        <span title="Drag to move" aria-hidden
          className="cursor-grab active:cursor-grabbing text-gray-200 group-hover:text-gray-400
            dark:text-white/15 dark:group-hover:text-white/40 flex-shrink-0">
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="2.5" cy="3" r="1.4" /><circle cx="7.5" cy="3" r="1.4" />
            <circle cx="2.5" cy="8" r="1.4" /><circle cx="7.5" cy="8" r="1.4" />
            <circle cx="2.5" cy="13" r="1.4" /><circle cx="7.5" cy="13" r="1.4" />
          </svg>
        </span>

        <KindIcon kind={p.kind} />

        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-semibold text-[#14254A] dark:text-white truncate"
            title={p.name}>
            {p.name}
          </span>
          {p.kind === 'dim' ? (
            /* The chart a breakdown OPENS on. It is a default, not a lock — the
               report's own Table toggle still switches a reader's view, and this
               only decides what they see first. */
            <span className="mt-1 flex items-center gap-1.5">
              <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 flex-shrink-0">
                Chart
              </span>
              <span className="w-[178px] max-w-full">
                <SearchableSelect
                  options={vizChoices}
                  value={p.viz ?? ''}
                  onChange={v => setViz(p.key, v)}
                  placeholder={`Default · ${p.defaultVizLabel ?? p.defaultViz ?? '—'}`}
                  emptyLabel={`Default · ${p.defaultVizLabel ?? p.defaultViz ?? '—'}`} />
              </span>
            </span>
          ) : (
            <span className="block text-[10px] text-gray-400 truncate">
              {KIND_LABEL[p.kind]}
              {p.span !== p.defaultSpan ? ` · default ${SPAN_LABEL[p.defaultSpan]?.toLowerCase()}` : ''}
            </span>
          )}
        </span>

        {/* Width. A section rule always spans the page — a half-width one is a
            label floating beside a chart — so its control is shown but inert
            rather than missing, and the row still reads the same way. */}
        <span className="flex gap-0.5 p-0.5 rounded-lg bg-[#14254A]/[0.05] dark:bg-white/[0.07] flex-shrink-0">
          {SPANS.map(s => (
            <button key={s} onClick={() => setSpan(p.key, s)}
              disabled={!!p.fixedSpan && s !== 'full'}
              title={p.fixedSpan ? 'This panel always spans the row' : SPAN_LABEL[s]}
              className={`px-2 py-1 rounded-md text-[10px] font-bold tabular-nums transition-all ${
                p.span === s
                  ? 'bg-white shadow-sm text-[#14254A] dark:bg-[#14254A] dark:text-white'
                  : 'text-[#14254A]/40 hover:text-[#14254A] dark:text-white/40 dark:hover:text-white'
              } disabled:opacity-20 disabled:hover:text-[#14254A]/40`}>
              {SPAN_SHORT[s]}
            </button>
          ))}
        </span>

        {/* An eye, not a word: this is a switch, and a button reading "Visible"
            looks like a statement of fact rather than something to press. */}
        <button onClick={() => toggleHidden(p.key)}
          title={p.hidden ? 'Show on the report' : 'Hide from the report'}
          aria-pressed={!p.hidden}
          className={`w-8 h-8 grid place-items-center rounded-lg border transition-colors flex-shrink-0 ${
            p.hidden
              ? 'border-gray-200 text-gray-300 hover:text-gray-500 dark:border-white/15 dark:text-white/30'
              : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-400/25 dark:text-emerald-300'
          }`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            {p.hidden
              ? <><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.16 3.19M6.6 6.6A18 18 0 0 0 2 12s3 8 10 8a9 9 0 0 0 5.4-1.6" /><path d="M2 2l20 20" /></>
              : <><path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z" /><circle cx="12" cy="12" r="3" /></>}
          </svg>
        </button>

        <span className="flex flex-col flex-shrink-0">
          <button onClick={() => moveLayout(i, -1)} disabled={i <= 0}
            title="Move up" aria-label={`Move ${p.name} up`}
            className="w-5 h-4 grid place-items-center rounded text-[8px] text-gray-300
              hover:text-[#14254A] hover:bg-[#14254A]/[0.06] disabled:opacity-25
              dark:hover:text-white dark:hover:bg-white/10">▲</button>
          <button onClick={() => moveLayout(i, 1)} disabled={i < 0 || i === layout.length - 1}
            title="Move down" aria-label={`Move ${p.name} down`}
            className="w-5 h-4 grid place-items-center rounded text-[8px] text-gray-300
              hover:text-[#14254A] hover:bg-[#14254A]/[0.06] disabled:opacity-25
              dark:hover:text-white dark:hover:bg-white/10">▼</button>
        </span>
      </div>
    )
  }

  const TABS: { key: Tab; label: string; hint: string }[] = [
    { key: 'sources',   label: 'Data sources',    hint: 'Which table feeds which platform report' },
    { key: 'layout',    label: 'Page layout',     hint: 'Where each visual sits on a report, and how wide it is' },
    { key: 'inventory', label: 'Database report',  hint: 'What each mapped table actually holds' },
    { key: 'clients',   label: 'Client mapping',  hint: 'Which reporting client each portal client reads' },
    { key: 'access',    label: 'User access',      hint: 'Which logins may see which platform' },
  ]

  return (
    <div className="p-6 fade-in">
      <BackToConfiguration />
      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration', href: '/admin/configuration' }, { label: 'Report Configuration' }]}
        title="Report Configuration"
        description="Point each platform report at a warehouse table, check what that table holds, and control who can see it."
      />

      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${
          toast.ok ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.ok ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {err && (
        <div className="mb-4 rounded-2xl px-4 py-3 text-sm border bg-red-50 border-red-200 text-red-700
          dark:bg-red-500/10 dark:border-red-400/25 dark:text-red-300">
          <strong>Error:</strong> {err}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-fit mb-4 bg-[#14254A]/[0.06] dark:bg-white/[0.06]">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} title={t.hint}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              tab === t.key
                ? 'bg-white shadow-sm text-[#14254A] dark:bg-[#14254A] dark:text-white'
                : 'text-[#14254A]/50 hover:text-[#14254A] dark:text-white/50 dark:hover:text-white'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Data sources ────────────────────────────────────────────────────── */}
      {tab === 'sources' && (() => {
        /* Counts for the strip at the top. A configuration screen should say
           what state it is in before it says what you can change. */
        const broken = platforms.filter(p => (p.tableDetail ?? []).some(t => !t.usable))
        const hidden = platforms.filter(p => !p.enabled)
        const q = sourceQuery.trim().toLowerCase()
        const shown = q
          ? platforms.filter(p =>
              p.label.toLowerCase().includes(q) ||
              p.key.toLowerCase().includes(q) ||
              p.tables.some(t => t.toLowerCase().includes(q)))
          : platforms

        return (
        <div className="space-y-3">
          {/* ── Summary and controls ────────────────────────────────────────
              One row answering "is anything wrong?", "how do I find one?" and
              "how do I add one?" — the three things you arrive with. */}
          <Card className="p-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-4 text-xs">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-base font-extrabold text-[#14254A] dark:text-white tabular-nums">
                    {platforms.length}
                  </span>
                  <span className="text-gray-500 dark:text-white/45">
                    platform{platforms.length === 1 ? '' : 's'}
                  </span>
                </span>
                {hidden.length > 0 && (
                  <span className="text-gray-500 dark:text-white/45">
                    <b className="text-[#14254A] dark:text-white tabular-nums">{hidden.length}</b> hidden
                  </span>
                )}
                {broken.length > 0 ? (
                  <span className="flex items-center gap-1.5 text-[#b45309] dark:text-amber-300 font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    {broken.length} need{broken.length === 1 ? 's' : ''} attention
                  </span>
                ) : platforms.length > 0 && (
                  <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    All tables readable
                  </span>
                )}
              </div>

              <div className="ml-auto flex items-center gap-2">
                {platforms.length > 4 && (
                  <input value={sourceQuery} onChange={e => setSourceQuery(e.target.value)}
                    placeholder="Search platforms or tables…"
                    className="w-52 rounded-lg px-3 py-1.5 text-xs border transition-colors
                      bg-white border-gray-200 text-[#14254A] placeholder-gray-400
                      focus:outline-none focus:border-[#14254A]
                      dark:bg-white/5 dark:border-white/15 dark:text-white dark:placeholder-white/30" />
                )}
                <button onClick={() => setAddOpen(o => !o)}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-white transition-all"
                  style={{ background: NAVY }}>
                  {addOpen ? 'Cancel' : '+ Add platform'}
                </button>
              </div>
            </div>
          </Card>

          {/* ── Add a platform, only when asked for ─────────────────────── */}
          {addOpen && (
            <Card className="p-4">
              <div className="text-sm font-bold text-[#14254A] dark:text-white mb-1">Add a platform</div>
              <p className="text-xs text-gray-500 dark:text-white/45 mb-3 max-w-2xl leading-relaxed">
                A platform is a name and the warehouse tables behind it. Pick more than one and their
                numbers are added together. Everything else — which column holds the client, which holds
                the date, how rows are counted — is worked out from the tables themselves.
              </p>
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,240px)_1fr_auto] gap-3 lg:items-end">
                <Field label="Platform name" hint="This is the name shown in the Reports sidebar">
                  <input value={newLabel} onChange={e => setNewLabel(e.target.value)}
                    placeholder="e.g. Marketplace" autoFocus
                    className="w-full rounded-xl px-3 py-2.5 text-sm border transition-colors
                      bg-white border-gray-200 text-[#14254A] placeholder-gray-400
                      focus:outline-none focus:border-[#14254A]
                      dark:bg-white/5 dark:border-white/15 dark:text-white dark:placeholder-white/30" />
                </Field>
                <Field label="Warehouse tables">
                  <MultiSearchableSelect options={tables} values={newTables} onChange={setNewTables}
                    noun={['table', 'tables']} placeholder="Search warehouse tables…" />
                </Field>
                <button onClick={async () => { await savePlatform('', newLabel.trim(), newTables); setAddOpen(false) }}
                  disabled={!newLabel.trim() || newTables.length === 0 || busy === 'new'}
                  className="px-5 py-2.5 rounded-xl text-xs font-bold text-white transition-all
                    disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                  style={{ background: NAVY }}>
                  {busy === 'new' ? 'Adding…' : 'Add platform'}
                </button>
              </div>
            </Card>
          )}

          {platforms.length === 0 && (
            <Card className="p-10 text-center">
              <p className="font-bold text-[#14254A] dark:text-white mb-1">No platforms yet</p>
              <p className="text-sm text-gray-500 dark:text-white/45">
                Add one above. Each platform becomes an entry in the Reports sidebar.
              </p>
            </Card>
          )}

          {platforms.length > 0 && shown.length === 0 && (
            <Card className="p-8 text-center">
              <p className="text-sm text-gray-500 dark:text-white/45">
                No platform or table matches &ldquo;{sourceQuery}&rdquo;.
              </p>
            </Card>
          )}

          {/* ── The list ────────────────────────────────────────────────────
              Collapsed by default. The row carries what you need to decide
              whether to open it; opening it is for changing something, or for
              reading why it is broken. Seven platforms of derived SQL expanded
              at once is a wall nobody reads. */}
          {shown.map(p => {
            const idx = platforms.indexOf(p)
            const tablesDraft = draftTables[p.key] ?? p.tables
            const labelDraft = draftLabel[p.key] ?? p.label
            const dirty = labelDraft !== p.label ||
              JSON.stringify(tablesDraft) !== JSON.stringify(p.tables)
            const unusable = (p.tableDetail ?? []).filter(t => !t.usable)
            // An edited card stays open whatever else is clicked: a half-made
            // change must never be hidden behind a collapsed row.
            const open = openPlatform === p.key || dirty

            return (
              <Card key={p.key} className={unusable.length > 0
                ? 'overflow-hidden ring-1 ring-amber-300/70 dark:ring-amber-400/30'
                : 'overflow-hidden'}>

                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span className="flex flex-col -my-1">
                    <button onClick={() => move(idx, -1)} disabled={idx === 0 || busy === 'reorder'}
                      title="Move up in the Reports sidebar" aria-label={`Move ${p.label} up`}
                      className="w-5 h-4 grid place-items-center rounded transition-colors
                        text-gray-300 hover:text-[#14254A] dark:text-white/25 dark:hover:text-white
                        disabled:opacity-20 disabled:cursor-not-allowed">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
                    </button>
                    <button onClick={() => move(idx, 1)}
                      disabled={idx === platforms.length - 1 || busy === 'reorder'}
                      title="Move down in the Reports sidebar" aria-label={`Move ${p.label} down`}
                      className="w-5 h-4 grid place-items-center rounded transition-colors
                        text-gray-300 hover:text-[#14254A] dark:text-white/25 dark:hover:text-white
                        disabled:opacity-20 disabled:cursor-not-allowed">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                  </span>
                  <span className="text-[10px] font-bold text-gray-300 dark:text-white/25 tabular-nums w-4 text-right">
                    {idx + 1}
                  </span>

                  <button onClick={() => setOpenPlatform(open && !dirty ? '' : p.key)}
                    aria-expanded={open}
                    className="flex-1 min-w-0 flex items-center gap-2 text-left py-0.5 rounded-lg
                      hover:bg-[#14254A]/[0.03] dark:hover:bg-white/[0.04] transition-colors">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"
                      className={`flex-shrink-0 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}>
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                    <span className="text-sm font-bold text-[#14254A] dark:text-white truncate">{p.label}</span>
                    <span className="text-[11px] text-gray-400 truncate hidden sm:inline">
                      {p.tables.length === 1
                        ? p.tables[0].split('.').pop()
                        : `${p.tables.length} tables`}
                    </span>
                    {dirty && <Pill tone="warn">Unsaved</Pill>}
                    {unusable.length > 0 && (
                      <Pill tone="warn">
                        {unusable.length} table{unusable.length === 1 ? '' : 's'} cannot be read
                      </Pill>
                    )}
                    {!p.enabled && <Pill tone="mute">Hidden from Reports</Pill>}
                  </button>

                  {/* Visibility without opening anything: the commonest change
                      on this screen is "take that one off the sidebar". */}
                  <button onClick={() => savePlatform(p.key, p.label, p.tables, !p.enabled)}
                    disabled={busy === p.key}
                    title={p.enabled ? 'Hide from the Reports sidebar' : 'Show in the Reports sidebar'}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors
                      disabled:opacity-50 ${p.enabled
                        ? 'border-gray-200 text-gray-500 hover:text-[#14254A] hover:border-gray-300 dark:border-white/15 dark:text-white/50 dark:hover:text-white'
                        : 'border-transparent text-white'}`}
                    style={p.enabled ? undefined : { background: NAVY }}>
                    {p.enabled ? 'Hide' : 'Show'}
                  </button>
                </div>

                {open && (
                  <div className="px-3 pb-3 border-t border-gray-100 dark:border-white/10">
                    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,240px)_1fr] gap-3 mt-3">
                      <Field label="Name shown in Reports">
                        <input value={labelDraft}
                          onChange={e => setDraftLabel(d => ({ ...d, [p.key]: e.target.value }))}
                          className="w-full rounded-xl px-3 py-2.5 text-sm border transition-colors
                            bg-white border-gray-200 text-[#14254A]
                            focus:outline-none focus:border-[#14254A]
                            dark:bg-white/5 dark:border-white/15 dark:text-white" />
                      </Field>
                      <Field label="Warehouse tables it reads"
                        hint={tablesDraft.length > 1 ? 'Numbers from these tables are added together' : undefined}>
                        <MultiSearchableSelect options={tables} values={tablesDraft}
                          onChange={v => setDraftTables(d => ({ ...d, [p.key]: v }))}
                          noun={['table', 'tables']} placeholder="Search warehouse tables…" />
                      </Field>
                    </div>

                    {/* What the server worked out, in words first and
                        expressions second. An admin needs to know a table is
                        understood; the SQL is for the day it is not. */}
                    {(p.tableDetail ?? []).length > 0 && (
                      <div className="mt-3 space-y-2">
                        {(p.tableDetail ?? []).map(t => (
                          <div key={t.table}
                            className={`rounded-xl border p-3 ${t.usable
                              ? 'border-gray-100 dark:border-white/10'
                              : 'border-amber-300/70 bg-amber-50/50 dark:border-amber-400/30 dark:bg-amber-500/[0.07]'}`}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <code className="text-[11px] font-mono text-[#14254A] dark:text-white break-all">
                                {t.table}
                              </code>
                              {t.usable
                                ? <Pill tone="ok">Understood</Pill>
                                : <Pill tone="bad">Cannot be read</Pill>}
                            </div>

                            {t.usable ? (
                              <>
                                <p className="text-[11px] text-gray-500 dark:text-white/45 mt-1.5 leading-relaxed">
                                  Rows are matched to a client by <Mono>{t.clientCol}</Mono> and dated by{' '}
                                  <Mono>{t.dateCol}</Mono>.{' '}
                                  It can fill <b className="text-[#14254A] dark:text-white">{t.dimensions}</b>{' '}
                                  breakdown panel{t.dimensions === 1 ? '' : 's'}.
                                </p>
                                <details className="mt-1.5">
                                  <summary className="text-[10px] font-bold uppercase tracking-widest
                                    text-gray-400 cursor-pointer hover:text-[#14254A] dark:hover:text-white w-fit">
                                    How it counts
                                  </summary>
                                  <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                    <p className="text-[11px] text-gray-500 dark:text-white/45">
                                      Identified: <Mono>{t.identExpr}</Mono>
                                    </p>
                                    <p className="text-[11px] text-gray-500 dark:text-white/45">
                                      Removed: <Mono>{t.removedExpr}</Mono>
                                    </p>
                                  </div>
                                </details>
                              </>
                            ) : (
                              <p className="text-[11px] text-[#b45309] dark:text-amber-300 mt-1.5 leading-relaxed">
                                {/* The server's message is a raw driver error and does not
                                    reliably end in a full stop; one is added so the
                                    sentence that follows does not run into it. */}
                                {sentence(t.error || 'The warehouse did not return this table')}{' '}
                                Its numbers are left out of this platform until it can be read.{' '}
                                {/* The advice has to match the cause. "Correct the name in
                                    the warehouse" is right for a table that is genuinely
                                    missing, and sends someone the wrong way entirely when
                                    the real fault is a rejected key or an unreachable
                                    service — every table on the page fails then, and none
                                    of their names is wrong. */}
                                {/(unauthor|forbidden|cannot reach|connection refused|timeout|no such host|certificate)/i
                                  .test(t.error || '')
                                  ? 'This affects every table here, so it is the connection to reports_api rather than this table — check REPORTS_API_URL and REPORTS_API_KEY.'
                                  : 'Remove it above, or correct the name in the warehouse.'}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100 dark:border-white/10">
                      <code className="text-[10px] px-1.5 py-0.5 rounded bg-[#14254A]/[0.06] text-[#14254A]/60
                        dark:bg-white/10 dark:text-white/50" title="Used in links and in per-login access">
                        {p.key}
                      </code>
                      <div className="ml-auto flex items-center gap-2">
                        {dirty && (
                          <button onClick={() => {
                            setDraftLabel(d => ({ ...d, [p.key]: p.label }))
                            setDraftTables(d => ({ ...d, [p.key]: p.tables }))
                          }}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors
                              border-gray-200 text-gray-500 hover:text-[#14254A] hover:border-gray-300
                              dark:border-white/15 dark:text-white/50 dark:hover:text-white">
                            Discard
                          </button>
                        )}
                        <button onClick={() => setConfirmDelete(p)} disabled={busy === p.key}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors
                            border-gray-200 text-red-600 hover:bg-red-50 hover:border-red-300
                            dark:border-white/15 dark:text-red-300 dark:hover:bg-red-500/15 disabled:opacity-50">
                          Delete
                        </button>
                        {dirty ? (
                          <button onClick={() => savePlatform(p.key, labelDraft.trim(), tablesDraft, p.enabled)}
                            disabled={!labelDraft.trim() || tablesDraft.length === 0 || busy === p.key}
                            className="px-4 py-1.5 rounded-lg text-[11px] font-bold text-white transition-all
                              disabled:opacity-40 disabled:cursor-not-allowed"
                            style={{ background: NAVY }}>
                            {busy === p.key ? 'Saving…' : 'Save changes'}
                          </button>
                        ) : (
                          <span className="text-[11px] font-semibold text-gray-400">All changes saved</span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            )
          })}

          {/* Delete confirmation — a platform carries per-login grants with it. */}
          {confirmDelete && (
            <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
              style={{ background: 'rgba(20,37,74,0.55)' }} onClick={() => setConfirmDelete(null)}>
              <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-2xl w-full max-w-md p-6"
                onClick={e => e.stopPropagation()}>
                <p className="font-bold text-[#14254A] dark:text-white mb-1.5">
                  Delete “{confirmDelete.label}”?
                </p>
                <p className="text-sm text-gray-500 dark:text-white/45 leading-relaxed">
                  It disappears from the Reports sidebar and any per-login access grants for it are
                  removed. The warehouse tables themselves are untouched.
                </p>
                <div className="flex gap-2 mt-5">
                  <button onClick={() => setConfirmDelete(null)}
                    className="flex-1 py-2.5 rounded-xl text-sm font-semibold border
                      border-gray-200 text-gray-600 hover:bg-gray-50
                      dark:border-white/15 dark:text-white/70 dark:hover:bg-white/10">
                    Cancel
                  </button>
                  <button onClick={() => deletePlatform(confirmDelete)}
                    disabled={busy === confirmDelete.key}
                    className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white bg-red-600
                      hover:bg-red-700 disabled:opacity-50">
                    {busy === confirmDelete.key ? 'Deleting…' : 'Delete platform'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        )
      })()}

      {/* ── Page layout ─────────────────────────────────────────────────────── */}
      {tab === 'layout' && (
        <div className="space-y-4">
          <p className="text-xs text-gray-500 dark:text-white/45 max-w-3xl leading-relaxed">
            Every visual on a report — each KPI card, the section rules and each chart — has a
            position and a width here. A row is twelve columns, so a panel set to{' '}
            <strong>Full row</strong> takes the row on its own, <strong>Half</strong> puts two side
            by side, <strong>Third</strong> puts three and <strong>Quarter</strong> puts four.
            Panels flow in the order below and wrap when a row fills, which the preview shows
            exactly. Hidden panels are not sent to the report at all, so switching KPI cards off is
            how you show fewer of them.
          </p>

          {/* Which platform is being arranged. The summary is here too — it is a
              real page with real panels, even though it has no stored tables. */}
          <div className="flex flex-wrap gap-1.5">
            {[
              // The built-in summary is a real page with real panels even though
              // it has no stored tables — unless a configured platform has taken
              // its key, in which case that one is the summary.
              ...(platforms.some(p => p.key === 'summary') ? [] : [{ key: 'summary', label: 'Summary' }]),
              ...platforms.map(p => ({ key: p.key, label: p.label })),
            ].map(p => (
                <button key={p.key} onClick={() => setLayoutKey(p.key)}
                  className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition-colors ${
                    layoutKey === p.key
                      ? 'bg-[#14254A] text-white border-[#14254A] dark:bg-white/15 dark:border-white/25'
                      : 'border-gray-200 text-gray-500 hover:text-[#14254A] dark:border-white/15 dark:text-white/60 dark:hover:text-white'
                  }`}>
                  {p.label}
                </button>
              ))}
          </div>

          {/* Whose page is being arranged. The shared layout is what every client
              sees unless one of them has been given its own; a client with its own
              takes it whole, so a later change to the shared one does not reshuffle
              a page somebody arranged deliberately. */}
          {layoutKey && (
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
                Arranging for
              </label>
              {/* The same searchable list every other filter uses, rather than a
                  native <select>: this one is the warehouse's whole client list,
                  which is hundreds of names nobody scrolls to find. */}
              <span className="w-[280px] max-w-full">
                <SearchableSelect
                  options={layoutClients.map(c => ({
                    key: c.id,
                    label: clientsWithLayout.includes(c.id) ? `${c.name}  ·  has its own layout` : c.name,
                  }))}
                  value={layoutClient}
                  onChange={setLayoutClient}
                  placeholder="All clients (shared layout)"
                  emptyLabel="All clients (shared layout)" />
              </span>
              {layoutClients.length === 0 && (
                <span className="text-[11px] text-gray-400">
                  Client list unavailable — the shared layout can still be arranged.
                </span>
              )}
              {followsDefault && (
                <Pill tone="warn">Following the shared layout — saving creates one for this client</Pill>
              )}
            </div>
          )}

          {busy === 'layout' ? (
            <Card className="p-8 text-center text-sm text-gray-400">Loading the panels…</Card>
          ) : layout.length === 0 ? (
            <Card className="p-8 text-center text-sm text-gray-400">
              This platform has no panels yet — map it to a warehouse table under Data sources first.
            </Card>
          ) : (
            <>
              {/* Preview: the rows exactly as the grid will pack them, so the
                  effect of a width change is visible without leaving the page —
                  and the place the order is actually edited. Dragging a block
                  onto another moves it to that slot; the rows repack as you go,
                  so what you drop is what the report renders.

                  The ▲▼ buttons on the list below do the same thing and stay:
                  HTML5 drag has no touch equivalent, and a keyboard cannot drag
                  at all. */}
            {/* Preview and editor side by side: the wireframe answers "what will
                this look like", the list answers "what is in it" — and on a wide
                screen one 2000px-wide list of narrow rows answers neither. The
                preview stays put while the list scrolls, so a width change is
                visible without hunting for it. */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
              <Card className="p-4 xl:sticky xl:top-4">
                <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                  <h3 className="text-[13px] font-bold text-[#14254A] dark:text-white">
                    Preview
                    <span className="ml-2 font-normal text-[10px] text-gray-400">
                      drag a panel to move it
                    </span>
                  </h3>
                  <span className="text-[10px] text-gray-400">
                    {layout.filter(p => !p.hidden && p.kind === 'tile').length} KPI cards ·{' '}
                    {layout.filter(p => !p.hidden && p.kind === 'dim').length} charts ·{' '}
                    {packRows(layout.filter(p => !p.hidden)).length} rows
                  </span>
                </div>
                <div className="space-y-1.5">
                  {packRows(layout.filter(p => !p.hidden)).map((row, i) => (
                    <div key={i} className="grid grid-cols-12 gap-1.5">
                      {row.map(p => (
                        <div key={p.key}
                          draggable
                          onDragStart={e => {
                            setDragKey(p.key)
                            e.dataTransfer.effectAllowed = 'move'
                            // Firefox will not start a drag without payload.
                            e.dataTransfer.setData('text/plain', p.key)
                          }}
                          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverKey(p.key) }}
                          onDragLeave={() => setOverKey(cur => cur === p.key ? '' : cur)}
                          onDrop={e => {
                            e.preventDefault()
                            const from = dragKey || e.dataTransfer.getData('text/plain')
                            if (from) moveByKey(from, p.key)
                            setDragKey(''); setOverKey('')
                          }}
                          onDragEnd={() => { setDragKey(''); setOverKey('') }}
                          className={`rounded-md px-2 py-2 text-[10px] font-semibold truncate border
                            cursor-move select-none transition-all
                            ${p.kind === 'heading'
                              ? 'bg-[#14254A]/[0.04] border-dashed border-[#14254A]/20 text-[#14254A]/60 dark:bg-white/[0.04] dark:border-white/20 dark:text-white/50'
                              : p.kind === 'tile'
                                ? 'bg-[#14254A]/[0.07] border-[#14254A]/20 text-[#14254A] dark:bg-white/10 dark:border-white/20 dark:text-white/80'
                                : 'bg-[#FC934C]/10 border-[#FC934C]/30 text-[#c2691f] dark:text-[#FDBE94]'}
                            ${dragKey === p.key ? 'opacity-35' : ''}
                            ${overKey === p.key && dragKey && dragKey !== p.key
                              ? 'ring-2 ring-[#FC934C] ring-offset-1 dark:ring-offset-[#1a2d55]' : ''}`}
                          style={{ gridColumn: `span ${SPAN_COLS[p.span]} / span ${SPAN_COLS[p.span]}` }}
                          title={`${p.name} — drag to move`}>
                          {p.name}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </Card>

              <div className="space-y-3">
              {/* The editor, GROUPED BY THE ROW EACH PANEL LANDS IN.
                  A flat list of twenty identical bands says nothing about the
                  page it describes — the thing being edited is which panels
                  share a row, so that is what the list is cut into. Each group
                  states how much of its twelve columns is used, because a row
                  that does not add up is allowed and should be visible rather
                  than silently corrected. */}
              {packRows(layout.filter(p => !p.hidden)).map((row, i) => {
                const used = row.reduce((a, p) => a + (SPAN_COLS[p.span] ?? 0), 0)
                return (
                  <Card key={`row${i}`} className="overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-[#14254A]/[0.025] dark:bg-white/[0.03]">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                        Row {i + 1}
                      </span>
                      <span className="h-px flex-1 bg-gray-100 dark:bg-white/10" />
                      <span className={`text-[10px] font-semibold tabular-nums ${
                        used === GRID_COLS ? 'text-gray-300' : 'text-amber-600 dark:text-amber-400'}`}>
                        {used}/{GRID_COLS} columns
                      </span>
                    </div>
                    <div className="divide-y divide-gray-50 dark:divide-white/[0.06]">
                      {row.map(renderPanelRow)}
                    </div>
                  </Card>
                )
              })}

              {/* Hidden panels keep their place in the order — they are only a
                  save away from being back on the page — so they are listed,
                  not dropped. */}
              {layout.some(p => p.hidden) && (
                <Card className="overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-[#14254A]/[0.025] dark:bg-white/[0.03]">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                      Hidden
                    </span>
                    <span className="h-px flex-1 bg-gray-100 dark:bg-white/10" />
                    <span className="text-[10px] text-gray-300">
                      not sent to the report
                    </span>
                  </div>
                  <div className="divide-y divide-gray-50 dark:divide-white/[0.06]">
                    {layout.filter(p => p.hidden).map(renderPanelRow)}
                  </div>
                </Card>
              )}
              </div>
            </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={saveLayout} disabled={!layoutDirty || busy === 'layout-save'}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-[#14254A]
                    hover:bg-[#1d3563] disabled:opacity-40 transition-colors">
                  {busy === 'layout-save' ? 'Saving…' : 'Save layout'}
                </button>
                {layoutDirty && (
                  <button onClick={() => setLayout(layoutSaved)}
                    className="px-3.5 py-2 rounded-xl text-xs font-bold border border-gray-200
                      text-gray-500 hover:text-[#14254A] dark:border-white/15 dark:text-white/60">
                    Discard changes
                  </button>
                )}
                <span className="flex-1" />
                {layoutConfigured && (
                  <button onClick={resetLayout} disabled={busy === 'layout-save'}
                    title="Delete the stored layout — the report goes back to the order and widths it is built with"
                    className="px-3.5 py-2 rounded-xl text-xs font-bold border border-red-200 text-red-600
                      hover:bg-red-50 dark:border-red-400/25 dark:text-red-300 dark:hover:bg-red-500/10">
                    Reset to default
                  </button>
                )}
              </div>
              <p className="text-[11px] text-gray-400">
                {layoutClient
                  ? layoutConfigured
                    ? 'This client has a layout of its own. Changes to the shared layout will not touch it.'
                    : 'This client follows the shared layout. Saving here gives it one of its own.'
                  : layoutConfigured
                    ? 'Saved. This is what every client sees unless they have a layout of their own.'
                    : 'No saved layout yet — what you see is the default the report is built with.'}
              </p>
            </>
          )}
        </div>
      )}

      {/* ── Client mapping ──────────────────────────────────────────────────── */}
      {tab === 'clients' && (
        <div className="space-y-4">
          <p className="text-xs text-gray-500 dark:text-white/45 max-w-3xl leading-relaxed">
            A client login sees its own report and nothing else — and this is what decides which
            one. The warehouse keys its data on an analytics client id, which is not the portal
            account, so the two are linked here by a person rather than guessed. Until a client is
            linked, its logins are told the report is not set up yet; they are never shown an empty
            report, which reads as “no infringements found”.
          </p>

          <div className="flex items-center gap-2 flex-wrap">
            <input value={mapQuery} onChange={e => setMapQuery(e.target.value)}
              placeholder="Search clients…"
              className="px-3 py-2 rounded-xl text-xs border bg-white text-[#14254A] border-gray-200
                dark:bg-[#14254A] dark:text-white dark:border-white/15 min-w-[220px]" />
            <span className="text-[11px] text-gray-400">
              {clientMap.filter(c => c.warehouseClient).length} of {clientMap.length} linked
            </span>
            <span className="flex-1" />
            <button onClick={loadClientMap} disabled={busy === 'clients'}
              className="px-3.5 py-2 rounded-xl text-xs font-bold border transition-colors
                border-gray-200 text-gray-500 hover:text-[#14254A]
                dark:border-white/15 dark:text-white/60 disabled:opacity-50">
              {busy === 'clients' ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>

          {warehouseClients.length === 0 && busy !== 'clients' && (
            <Card className="p-4">
              <Pill tone="warn">Warehouse client list unavailable</Pill>
              <p className="text-[11px] text-gray-400 mt-2">
                The analytics database has to be reachable to offer real client ids. Check the
                Data sources tab first.
              </p>
            </Card>
          )}

          <Card className="overflow-hidden">
            <div className="divide-y divide-gray-100 dark:divide-white/10">
              {clientMap
                .filter(c => !mapQuery || c.name.toLowerCase().includes(mapQuery.trim().toLowerCase()))
                .map(c => (
                  <div key={c.userId} className="flex items-center gap-3 px-4 py-2.5 flex-wrap">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-[#14254A] dark:text-white truncate">
                        {c.name}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {c.warehouseClient
                          ? `Reads ${c.warehouseName || c.warehouseClient}`
                          : 'Not linked — its logins cannot open the report'}
                      </span>
                    </span>

                    {/* Offered, never applied: a name match is a strong hint and a
                        bad authority. Two clients both starting "Star" would map
                        one company onto another's data. */}
                    {!c.warehouseClient && c.suggestion && (
                      <button onClick={() => saveClientMap(c.userId, c.suggestion!)}
                        title="Link to the warehouse client with a matching name"
                        className="px-2.5 py-1 rounded-lg text-[10px] font-bold border border-[#FC934C]/40
                          text-[#c2691f] hover:bg-[#FC934C]/10 flex-shrink-0">
                        Use name match
                      </button>
                    )}

                    <span className="w-[280px] max-w-full flex-shrink-0">
                      <SearchableSelect
                        options={warehouseClients}
                        value={c.warehouseClient ?? ''}
                        onChange={v => saveClientMap(c.userId, v)}
                        placeholder="Not linked"
                        emptyLabel="Not linked" />
                    </span>

                    {c.warehouseClient
                      ? <Pill tone="ok">Linked</Pill>
                      : <Pill tone="mute">Off</Pill>}
                  </div>
                ))}
              {clientMap.length === 0 && busy !== 'clients' && (
                <p className="px-4 py-8 text-center text-sm text-gray-400">No clients found.</p>
              )}
            </div>
          </Card>

          <p className="text-[11px] text-gray-400 leading-relaxed max-w-3xl">
            Linking a client is not the same as giving it the page. Grant the{' '}
            <b className="text-[#14254A] dark:text-white">Reports</b> module to the individual
            logins that should see it, the same way every other client page is granted.
          </p>
        </div>
      )}

      {/* ── Database report ─────────────────────────────────────────────────── */}
      {tab === 'inventory' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs text-gray-500 dark:text-white/45 max-w-2xl leading-relaxed">
              What each platform is actually attached to. A platform reading several tables appears
              once per table, with the client and date columns that were derived from it, its row and
              client counts, and the span of its dates.
            </p>
            <button onClick={loadInventory} disabled={busy === 'inventory'}
              className="px-3.5 py-2 rounded-xl text-xs font-bold border transition-colors
                border-gray-200 text-gray-500 hover:text-[#14254A]
                dark:border-white/15 dark:text-white/60 dark:hover:text-white disabled:opacity-50">
              {busy === 'inventory' ? 'Checking…' : '↻ Re-check'}
            </button>
          </div>

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr style={{ background: NAVY }}>
                    {['Platform', 'Table', 'Status', 'Derived columns', 'Rows', 'Clients', 'Date span'].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-white/70">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {inventory.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400">
                      {busy === 'inventory' ? 'Checking the warehouse…' : 'No results yet.'}
                    </td></tr>
                  )}
                  {inventory.map((row, i) => (
                    <tr key={`${row.key}-${row.table}-${i}`}
                      className={`border-b border-[#14254A]/[0.07] dark:border-white/[0.07] ${
                        i % 2 ? 'bg-[#14254A]/[0.02] dark:bg-white/[0.02]' : ''}`}>
                      <td className="px-4 py-3 font-semibold text-[#14254A] dark:text-white whitespace-nowrap">
                        {row.label}
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-[11px] text-[#14254A]/70 dark:text-white/60">{row.table || '—'}</code>
                      </td>
                      <td className="px-4 py-3">
                        {row.error ? <Pill tone="bad">Problem</Pill>
                          : row.tableExists === false ? <Pill tone="bad">Table missing</Pill>
                          : <Pill tone="ok">Ready</Pill>}
                        {row.error && (
                          <p className="text-[10px] text-gray-400 mt-1 font-mono break-all max-w-[260px]"
                            title={row.error}>{row.error}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[11px] font-mono text-gray-500 dark:text-white/45 whitespace-nowrap">
                        {row.clientCol ? `${row.clientCol} · ${row.dateCol}` : '—'}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[#14254A] dark:text-white">
                        {row.rows != null ? nf(row.rows) : '—'}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[#14254A] dark:text-white">
                        {row.clients != null ? nf(row.clients) : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-white/45 whitespace-nowrap">
                        {row.firstDate ? `${row.firstDate} → ${row.lastDate}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ── User access ─────────────────────────────────────────────────────── */}
      {tab === 'access' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs text-gray-500 dark:text-white/45 max-w-2xl leading-relaxed">
              Every login sees every platform by default. Untick one to take it away — the row then
              shows as restricted. Ticking all of them back restores the default rather than storing
              a full list.
              <br />
              The box beside a name covers that login; the one under a column heading covers that
              platform for every login <b>currently shown</b>, so searching first narrows what a
              bulk tick will touch.
            </p>
            <input value={userQuery} onChange={e => setUserQuery(e.target.value)}
              placeholder="Search name, email or client…"
              className="text-xs rounded-xl px-3 py-2 w-full sm:w-[280px] border
                bg-white border-gray-200 text-[#14254A] placeholder-gray-400 focus:outline-none focus:border-[#14254A]
                dark:bg-white/5 dark:border-white/15 dark:text-white dark:placeholder-white/30" />
          </div>

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[820px]">
                <thead>
                  <tr style={{ background: NAVY }}>
                    <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-white/70">
                      User
                    </th>
                    {/* The corner box is the whole grid: every platform for
                        every login the search is currently showing. */}
                    <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-white/70">
                      <span className="flex items-center gap-2">
                        <TriCheck state={gridState}
                          disabled={busyAccess || visibleUsers.length === 0}
                          title={gridState === 'all'
                            ? `Remove every platform from all ${visibleUsers.length} logins shown`
                            : `Give every platform to all ${visibleUsers.length} logins shown`}
                          onChange={() => applyAccess(visibleUsers.map(u => ({
                            user: u, allowed: gridState === 'all' ? [] : null,
                          })))} />
                        Scope
                      </span>
                    </th>
                    {access.reports.map(r => {
                      const st = columnState(r.key)
                      return (
                        <th key={r.key} className="px-3 py-3 text-[10px] font-bold uppercase tracking-widest
                          text-white/70 whitespace-nowrap align-middle">
                          <span className="flex flex-col items-center gap-1.5">
                            <span>{r.label}</span>
                            {/* Down the column: this platform, every login shown. */}
                            <TriCheck state={st}
                              disabled={busyAccess || visibleUsers.length === 0}
                              title={st === 'all'
                                ? `Remove ${r.label} from all ${visibleUsers.length} logins shown`
                                : `Give ${r.label} to all ${visibleUsers.length} logins shown`}
                              onChange={() => applyAccess(visibleUsers.map(u => {
                                const cur = effective(u)
                                const next = st === 'all'
                                  ? cur.filter(k => k !== r.key)
                                  : (cur.includes(r.key) ? cur : [...cur, r.key])
                                return { user: u, allowed: normalize(next) }
                              }))} />
                          </span>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.length === 0 && (
                    <tr><td colSpan={access.reports.length + 2} className="px-4 py-12 text-center text-sm text-gray-400">
                      No logins match.
                    </td></tr>
                  )}
                  {visibleUsers.map((u, i) => (
                    <tr key={u.loginId} className={`border-b border-[#14254A]/[0.07] dark:border-white/[0.07] ${
                      i % 2 ? 'bg-[#14254A]/[0.02] dark:bg-white/[0.02]' : ''}`}>
                      <td className="px-4 py-2.5">
                        <div className="font-semibold text-[#14254A] dark:text-white text-xs">{u.name || u.username}</div>
                        <div className="text-[10px] text-gray-400 font-mono truncate max-w-[220px]" title={u.username}>
                          {u.username}{u.client ? ` · ${u.client}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2">
                          {/* Across the row: every platform, this login. */}
                          <TriCheck state={rowState(u)}
                            disabled={busy === `access-${u.loginId}` || busyAccess}
                            title={rowState(u) === 'all'
                              ? `Remove every platform from ${u.name || u.username}`
                              : `Give every platform to ${u.name || u.username}`}
                            onChange={() => saveAccess(u, rowState(u) === 'all' ? [] : null)} />
                          {!u.restricted
                            ? <Pill tone="ok">All platforms</Pill>
                            : u.allowed.length === 0
                              ? <Pill tone="bad">No reports</Pill>
                              : <Pill tone="warn">{u.allowed.length} of {access.reports.length}</Pill>}
                        </span>
                      </td>
                      {access.reports.map(r => {
                        const on = !u.restricted || u.allowed.includes(r.key)
                        return (
                          <td key={r.key} className="px-3 py-2.5 text-center">
                            <input type="checkbox" checked={on}
                              disabled={busy === `access-${u.loginId}`}
                              onChange={() => togglePlatform(u, r.key)}
                              className="w-4 h-4 rounded cursor-pointer"
                              style={{ accentColor: ORANGE }} />
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
