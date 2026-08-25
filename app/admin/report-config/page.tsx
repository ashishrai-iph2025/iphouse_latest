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
import ReportsApiConnectionPanel from '@/components/admin/ReportsApiConnectionPanel'
import ReportCachePanel from '@/components/admin/ReportCachePanel'
import SportsPeriodPanel from '@/components/admin/SportsPeriodPanel'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import SearchableSelect from '@/components/ui/SearchableSelect'
import MultiSearchableSelect from '@/components/ui/MultiSearchableSelect'

const NAVY   = '#14254A'
const ORANGE = '#FC934C'

type Tab = 'warehouse' | 'sources' | 'layout' | 'inventory' | 'access' | 'clients' | 'sports' | 'connection' | 'cache'

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
  kind: 'tile' | 'heading' | 'trend' | 'rate' | 'dim' | 'filter'
  name: string
  label?: string
  viz?: string
  metric?: string
  /** Filters only: the query parameter this slicer sets. */
  param?: string
  span: Span
  hidden: boolean
  /** The admin's rename. Empty keeps the panel's own name (`name` above). */
  title: string
  /** Shown behind an ⓘ icon on the report card. Empty means the built-in note
      below is used instead. */
  desc: string
  /** The built-in note this panel carries when nobody has written one. Offered
      as the editor's placeholder, so clearing the box visibly means "back to
      this" rather than leaving a field blank to no stated effect. */
  defaultDesc: string
  /** Filters only: whether the pane leaves this slicer out before anyone
      configures it, so an overridden one can be marked as such. */
  defaultHidden?: boolean
  defaultSpan: Span
  /** Breakdowns only: the chart the report opens with. Empty means the shape the
      registry chose for that dimension. */
  defaultViz?: string
  defaultVizLabel?: string
  /** Top-N breakdowns only: how many rows the panel keeps. `rowLimit` is the
      admin's override and 0 means unset; `defaultRowLimit` is the registry's own
      number, kept beside it so the field can say what clearing it goes back to.
      Both absent on a panel that is not a top-N — a closed list such as a
      per-day trend or a TAT band must never be cut, so it is offered no
      control. */
  rowLimit?: number
  defaultRowLimit?: number
  /** A section rule spans the page by definition; a half-width one is a label
      floating beside a chart. A slicer sits in a one-column rail, so it has no
      width either. */
  fixedSpan?: boolean
}

const KIND_LABEL: Record<LayoutPanel['kind'], string> = {
  tile: 'KPI card', heading: 'Section rule', trend: 'Trend', rate: 'Trend', dim: 'Chart',
  filter: 'Filter',
}

/* ── The filter pane ──────────────────────────────────────────────────────────
   The slicers down the right of a report are panels too — arranged here, stored
   the same way, and following the same per-client rule. They live in a rail
   rather than the grid, so they are ordered and switched on or off but never
   given a width, and they are kept in their own list rather than folded into the
   rows: a slicer does not take columns from a chart, and pretending it does
   would make the preview lie. */
const isPaneFilter = (p: LayoutPanel) => p.kind === 'filter'

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
  // A funnel: the one control on the page that narrows what every other panel
  // is drawn from, which is why it gets its own colour rather than a chart's.
  filter: {
    tint: 'bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-200',
    glyph: <><path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" /></>,
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
/** One source as it is described to a login that may not see warehouse names.
    An alias to tell it apart, a reference to quote, and its state — no table,
    no columns, no SQL. Served by go-server/handlers/reportsources.go. */
interface SourceSummary {
  alias: string; ref: string
  usable: boolean; dimensions?: number; error?: string
}
/** A platform is a name plus the tables it reads — nothing else is configured;
    the client/date columns and the measures are derived per table by the server
    and reported back here so they can be checked.

    `tables` and `tableDetail` arrive for a Super Admin only. Everyone else gets
    `sources` and `tableCount` instead: the server decides, and the difference is
    in the payload rather than in what this page chooses to draw. */
interface Platform {
  key: string; label: string; order: number; enabled: boolean
  tables?: string[]
  tableDetail?: TableDetail[]
  sources?: SourceSummary[]
  tableCount?: number
}
/** One row per platform × table: a platform reading three tables gets three. */
interface InventoryRow {
  key: string; label: string; enabled: boolean
  /** Present only when the warehouse names have been revealed; otherwise the
      row carries `alias` and `ref` instead. */
  table?: string
  alias?: string; ref?: string
  tableExists?: boolean
  clientCol?: string; dateCol?: string; identExpr?: string
  /** How many breakdown panels this table can fill — from the catalogue, so it
      survives when the row counts below cannot be read. */
  dimensions?: number
  rows?: number; clients?: number; firstDate?: string; lastDate?: string
  error?: string
}
/** One table in the warehouse, as the Warehouse tab shows it. `served` is
    whether reports_api will answer for it; `usedBy` names the platforms already
    reading it, which is what makes hiding one a decision rather than a click. */
interface WarehouseTable {
  table: string; name: string; type: string; engine: string
  rows: number; bytes: number; comment: string
  hidden: boolean; served: boolean; usedBy: string
  /** False when a platform reads this table. The SERVER decides it and the save
      enforces the same rule — the switch must not have its own opinion. */
  canHide: boolean
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

/**
 * The footer under a long table.
 *
 * Renders NOTHING for a single page — a pager under nine rows is furniture. The
 * page numbers are a window around the current one rather than the whole run:
 * four hundred rows is sixteen pages, and a strip of sixteen buttons is harder
 * to use than two arrows.
 *
 * `noun` so the count reads as what it is counting. "1–25 of 340 logins" tells
 * somebody where they are; "1–25 of 340" makes them work it out.
 */
function Pager({ page, totalPages, perPage, total, onPage, noun, suffix }: {
  page: number; totalPages: number; perPage: number; total: number
  onPage: (p: number) => void
  noun: [string, string]
  suffix?: string
}) {
  if (totalPages <= 1) return null
  const btn = 'px-2 py-1 rounded border border-gray-200 dark:border-white/15 ' +
    'disabled:opacity-30 hover:bg-gray-50 dark:hover:bg-white/5'
  const windowed = Array.from({ length: totalPages }, (_, i) => i + 1)
    .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 1)

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3
      border-t border-gray-100 dark:border-white/10">
      <span className="text-[11px] text-gray-500 dark:text-white/45">
        {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of{' '}
        <b className="text-[#14254A] dark:text-white">{total}</b>{' '}
        {total === 1 ? noun[0] : noun[1]}{suffix}
      </span>

      <div className="flex items-center gap-1 text-xs">
        <button onClick={() => onPage(1)} disabled={page === 1} aria-label="First page" className={btn}>«</button>
        <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page === 1}
          aria-label="Previous page" className={btn}>‹</button>

        {windowed.map((p, idx, arr) => (
          <span key={p} className="flex items-center gap-1">
            {/* A gap in the sequence gets an ellipsis, so 1 … 7 8 9 … 16 reads
                as a range rather than as a numbering mistake. */}
            {idx > 0 && arr[idx - 1] !== p - 1 && <span className="text-gray-300 px-0.5">…</span>}
            <button onClick={() => onPage(p)}
              aria-current={page === p ? 'page' : undefined}
              className={`px-2.5 py-1 rounded border text-xs font-medium transition-colors ${
                page === p
                  ? 'text-white border-transparent'
                  : 'border-gray-200 hover:bg-gray-50 dark:border-white/15 dark:hover:bg-white/5'}`}
              style={page === p ? { background: NAVY } : undefined}>
              {p}
            </button>
          </span>
        ))}

        <button onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}
          aria-label="Next page" className={btn}>›</button>
        <button onClick={() => onPage(totalPages)} disabled={page === totalPages}
          aria-label="Last page" className={btn}>»</button>
      </div>
    </div>
  )
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function ReportConfigPage() {
  const [tab, setTab] = useState<Tab>('sources')
  /* Super Admin only. Starts false so a slow or failed load errs towards
     showing less rather than briefly showing table names and then hiding
     them — a redaction that flickers has already happened. */
  const [canEditSources, setCanEditSources] = useState(false)
  /* Whether the reader has ASKED for the warehouse names. Off on every visit —
     it is a deliberate act, not a saved preference, for the same reason a
     revealed API key does not stay revealed. `revealed` is the server's
     confirmation that the response actually carries them. */
  const [revealNames, setRevealNames] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [draftTables, setDraftTables] = useState<Record<string, string[]>>({})
  const [draftLabel, setDraftLabel] = useState<Record<string, string>>({})
  const [newLabel, setNewLabel] = useState('')
  const [newTables, setNewTables] = useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = useState<Platform | null>(null)
  const [tables, setTables] = useState<{ key: string; label: string }[]>([])
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [inventoryProfiled, setInventoryProfiled] = useState(true)
  /* The warehouse listing. Fetched only when its tab is opened — it enumerates
     the whole database and nobody arriving to reorder a report should pay for
     that. */
  const [whTables, setWhTables] = useState<WarehouseTable[]>([])
  const [whQuery, setWhQuery] = useState('')
  const [whSchema, setWhSchema] = useState('')
  const [whNote, setWhNote] = useState('')
  const [whPage, setWhPage] = useState(1)
  const [whOnly, setWhOnly] = useState<'all' | 'served' | 'hidden'>('all')
  const [access, setAccess] = useState<{ reports: { key: string; label: string }[]; users: AccessUser[] }>({ reports: [], users: [] })
  const [accessPage, setAccessPage] = useState(1)
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
  const [mapPage, setMapPage] = useState(1)
  // Drag state for the preview: what is being carried, and what it is over.
  const [dragKey, setDragKey] = useState('')
  const [overKey, setOverKey] = useState('')
  /* Which panel's rename/description editor is open. One at a time: the two
     inputs take a row of their own, and a list with five open editors is a form
     pretending to be a list. */
  const [editKey, setEditKey] = useState('')

  const flash = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  const loadPlatforms = useCallback(async () => {
    try {
      /* `reveal` is asked for, never assumed. Being a Super Admin is permission
         to see the warehouse names; it is not a reason to be shown them on
         every visit, and the routine work on this screen — rename a report,
         hide one, reorder them — does not need them at all. */
      const r = await fetch(`/api/admin/report-platforms?shape=1${revealNames ? '&reveal=1' : ''}`,
        { credentials: 'include' })
      if (!r.ok) throw new Error(`Could not load the platforms (${r.status})`)
      const d = await r.json()
      const list: Platform[] = d.platforms || []
      setPlatforms(list)
      /* Whether this login may see and change the warehouse sources. Taken from
         the response rather than from the session, because it is the SERVER's
         decision and the response is already shaped by it: reading it here
         cannot disagree with what was actually sent. */
      setCanEditSources(d.canEditSources === true)
      // Whether THIS response carries the names, so nothing has to infer which
      // of the two shapes it is holding.
      setRevealed(d.revealed === true)
      // Drafts start from what is stored, so the form always shows what is live.
      setDraftTables(Object.fromEntries(list.map(p => [p.key, p.tables || []])))
      setDraftLabel(Object.fromEntries(list.map(p => [p.key, p.label])))
      setErr('')
    } catch (e: any) { setErr(e.message) }
  }, [revealNames])

  const loadTables = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/report-config/tables', { credentials: 'include' })
      const d = await r.json()
      if (d.available === false) { setErr(d.error || 'Warehouse unavailable'); return }
      /* The list is the WAREHOUSE's, curated on the Warehouse tab — so it now
         contains tables reports_api does not serve, and a platform pointed at
         one of those saves cleanly and then fails at read time. Said in the
         option itself, which is the last place it can be said cheaply. */
      setTables((d.tables || []).map((t: any) => ({
        key: String(t.name),
        label: `${t.name}${t.served === false ? '  ·  not served by the reports service' : ''}`,
      })))
    } catch { /* the table picker degrades to whatever is already saved */ }
  }, [])

  const loadInventory = useCallback(async () => {
    setBusy('inventory')
    try {
      const r = await fetch(`/api/admin/report-config/inventory${revealNames ? '?reveal=1' : ''}`,
        { credentials: 'include' })
      const d = await r.json()
      if (d.available === false) { setErr(d.error || 'Warehouse unavailable'); return }
      setInventory(d.reports || [])
      // Whether the row/client/date columns could be filled at all. Reading
      // through reports_api they cannot, and the table has to say so rather
      // than showing blanks that look like empty tables.
      setInventoryProfiled(d.profiled !== false)
      setErr('')
    } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }, [revealNames])

  const loadWarehouse = useCallback(async () => {
    setBusy('warehouse')
    try {
      const p = new URLSearchParams()
      if (whQuery.trim()) p.set('q', whQuery.trim())
      if (whSchema.trim()) p.set('schema', whSchema.trim())
      const r = await fetch(`/api/admin/warehouse-tables?${p}`, { credentials: 'include' })
      const d = await r.json()
      if (d.available === false || !d.success) {
        setErr(d.error || 'Could not read the warehouse table list')
        setWhTables([])
        return
      }
      setWhTables(d.tables || [])
      setWhNote(d.rowsNote || '')
      setErr('')
    } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }, [whQuery, whSchema])

  /* Optimistic, then reconciled. The switch is the whole interaction on this
     screen and a round trip before it moves makes the list feel broken; a
     failure puts it back and says so. */
  async function setTableHidden(t: WarehouseTable, hidden: boolean) {
    setWhTables(list => list.map(x => x.table === t.table ? { ...x, hidden } : x))
    try {
      const r = await fetch('/api/admin/warehouse-tables', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: t.table, hidden }),
      })
      const d = await r.json()
      if (!d.success) throw new Error(d.error || 'Could not save')
      // The picker's contents just changed, so anything holding the old list
      // has to be re-read rather than left to go stale.
      loadTables()
    } catch (e: any) {
      setWhTables(list => list.map(x => x.table === t.table ? { ...x, hidden: !hidden } : x))
      flash(e.message, false)
    }
  }

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
        label: p.label, viz: p.viz, metric: p.metric, param: p.param,
        span: (p.span || p.defaultSpan || 'half') as Span,
        hidden: !!p.hidden,
        title: String(p.customLabel || ''),
        desc: String(p.desc || ''),
        defaultDesc: String(p.defaultDesc || ''),
        defaultHidden: p.defaultHidden,
        defaultSpan: (p.defaultSpan || 'half') as Span,
        defaultViz: p.defaultViz, defaultVizLabel: p.defaultVizLabel,
        rowLimit: typeof p.rowLimit === 'number' ? p.rowLimit : undefined,
        defaultRowLimit: typeof p.defaultRowLimit === 'number' ? p.defaultRowLimit : undefined,
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

  useEffect(() => { loadPlatforms() }, [loadPlatforms])
  /* The table picker is a list of every warehouse table, so it is fetched only
     once the server has said this login may have one. Asking unconditionally
     would be a guaranteed 403 on every load for everyone else. */
  useEffect(() => { if (revealed) loadTables() }, [revealed, loadTables])
  useEffect(() => { if (tab === 'clients' && clientMap.length === 0) loadClientMap() },
    [tab, clientMap.length, loadClientMap])
  useEffect(() => { if (tab === 'inventory' && canEditSources) loadInventory() },
    [tab, canEditSources, loadInventory])
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
  /* The grid and the filter pane are two lists in one array, so a move that
     crossed between them would put a slicer among the charts — where the server
     would still store it, and the report would still draw it in the rail, at a
     position nobody could see. Refused rather than clamped: the arrows are
     disabled at each group's edge, so this only ever fires on a drag. */
  const moveLayout = (index: number, by: number) => setLayout(cur => {
    const to = index + by
    if (index < 0 || to < 0 || to >= cur.length) return cur
    if (isPaneFilter(cur[index]) !== isPaneFilter(cur[to])) return cur
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
    if (isPaneFilter(cur[from]) !== isPaneFilter(cur[to])) return cur
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
  /* How many rows a top-N panel keeps.

     Held as a NUMBER OR ZERO rather than as the raw text: an empty box means
     "the registry's own number", which is the same way the chart picker and the
     rename go back to their defaults. Anything unparseable is treated as empty
     for the same reason — a half-typed value must not be read as a limit of
     nothing. The ceiling matches the server's, which clamps rather than
     refuses, so a pasted 500 saves as 100 instead of bouncing the layout. */
  const setRowLimit = (key: string, raw: string) => {
    const n = Math.floor(Number(raw))
    const next = !raw.trim() || !isFinite(n) || n < 1 ? 0 : Math.min(n, 100)
    setLayout(cur => cur.map(p => p.key === key ? { ...p, rowLimit: next } : p))
  }
  const toggleHidden = (key: string) =>
    setLayout(cur => cur.map(p => p.key === key ? { ...p, hidden: !p.hidden } : p))
  /* The rename and the ⓘ description. Clearing either puts the panel back on
     its own name / no icon, so there is no separate reset for them. */
  const setTitle = (key: string, title: string) =>
    setLayout(cur => cur.map(p => p.key === key ? { ...p, title } : p))
  const setDesc = (key: string, desc: string) =>
    setLayout(cur => cur.map(p => p.key === key ? { ...p, desc } : p))

  /* Two lists in one array: the grid the report draws, and the rail beside it.
     They are edited on the same screen and saved in the same call — one layout,
     one order — but they are never packed into the same rows, because a slicer
     takes no columns from a chart. */
  const gridPanels = useMemo(() => layout.filter(p => !isPaneFilter(p)), [layout])
  const panePanels = useMemo(() => layout.filter(isPaneFilter), [layout])

  /* Every field the save sends is compared here, `rowLimit` included. A field
     the editor can change but this cannot see is a change the Save button stays
     disabled for — the edit is visible on screen and unsaveable, with nothing
     to say why. */
  const layoutFingerprint = (ps: LayoutPanel[]) =>
    JSON.stringify(ps.map(p => [p.key, p.span, p.viz ?? '', p.hidden, p.title, p.desc, p.rowLimit ?? 0]))

  const layoutDirty = useMemo(
    () => layoutFingerprint(layout) !== layoutFingerprint(layoutSaved),
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
            title: p.title.trim(), desc: p.desc.trim(),
            // 0 means "the registry's own number". Only sent for a panel that
            // actually has a top-N to set.
            rowLimit: p.defaultRowLimit ? (p.rowLimit || 0) : 0,
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

  /* Every login the search matches. This — NOT the current page — is what a
     bulk tick acts on, and what the header boxes report the state of.

     That is a deliberate choice now that the two can differ. The scope of a
     bulk change is the thing the operator defined by typing in the search box;
     making it silently mean "the 25 of them I happen to be looking at" would let
     someone search for a client, tick a column, and leave eleven pages of that
     same client untouched with nothing on screen to say so. Pagination is a
     viewing concern, not a scope one — and before it existed these were the same
     set, so this preserves the behaviour rather than changing it. */
  const visibleUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase()
    if (!q) return access.users
    return access.users.filter(u =>
      u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) ||
      (u.client || '').toLowerCase().includes(q))
  }, [access.users, userQuery])

  /* ── Paging over the matches ──────────────────────────────────────────────
     The grid is one row per login and one column per platform, so a few hundred
     logins is a few thousand checkboxes in one table — slow to render and
     impossible to read. */
  const ACCESS_PER_PAGE = 25
  const accessTotalPages = Math.max(1, Math.ceil(visibleUsers.length / ACCESS_PER_PAGE))
  // Clamped rather than stored blindly: narrowing the search while on page 7
  // would otherwise show an empty table with no rows and no explanation.
  const accessSafePage = Math.min(accessPage, accessTotalPages)
  const pagedUsers = useMemo(
    () => visibleUsers.slice((accessSafePage - 1) * ACCESS_PER_PAGE, accessSafePage * ACCESS_PER_PAGE),
    [visibleUsers, accessSafePage])

  // Back to the first page whenever the result set changes underneath.
  useEffect(() => { setAccessPage(1) }, [userQuery, access.users.length])

  /* ── The client mapping list, paged the same way ─────────────────────────
     Each row carries a searchable select over the whole warehouse client list,
     so a few hundred rows is a few hundred of those mounted at once. */
  const MAP_PER_PAGE = 25
  const visibleClientMap = useMemo(() => {
    const q = mapQuery.trim().toLowerCase()
    if (!q) return clientMap
    return clientMap.filter(c => c.name.toLowerCase().includes(q))
  }, [clientMap, mapQuery])

  const mapTotalPages = Math.max(1, Math.ceil(visibleClientMap.length / MAP_PER_PAGE))
  const mapSafePage = Math.min(mapPage, mapTotalPages)
  const pagedClientMap = useMemo(
    () => visibleClientMap.slice((mapSafePage - 1) * MAP_PER_PAGE, mapSafePage * MAP_PER_PAGE),
    [visibleClientMap, mapSafePage])

  useEffect(() => { setMapPage(1) }, [mapQuery, clientMap.length])

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
    /* A slicer moves within the pane and a chart within the grid, never between
       the two — so the arrows stop at each group's edge rather than at the end
       of the array they happen to share. */
    const pane = isPaneFilter(p)
    const atTop = i <= 0 || isPaneFilter(layout[i - 1]) !== pane
    const atEnd = i < 0 || i === layout.length - 1 || isPaneFilter(layout[i + 1]) !== pane
    /* Everything but a section rule can be renamed and described — slicers
       included, since the rail is where a reader most often needs telling what
       a control narrows. A rule already IS a title and carries its own
       subtitle, so it has nothing to add. */
    const canAnnotate = p.kind !== 'heading'
    const editing = editKey === p.key
    const annotated = p.title.trim() !== '' || p.desc.trim() !== ''
    return (
      <div key={p.key}>
      <div
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
            title={p.title ? `Renamed — its own name is “${p.name}”` : p.name}>
            {p.title || p.name}
            {/* Amber where somebody wrote the note, grey where it is the
                built-in one — so "described by hand" is visible at a glance
                without opening every row. */}
            {(p.desc.trim() || p.defaultDesc.trim()) !== '' && (
              <span className={`ml-1.5 align-middle inline-grid place-items-center ${
                p.desc.trim() !== ''
                  ? 'text-amber-500 dark:text-amber-300'
                  : 'text-gray-300 dark:text-white/25'}`}
                title={p.desc.trim() || p.defaultDesc} aria-label="Has a description">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth={2} strokeLinecap="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 11v5" /><path d="M12 7.5h.01" />
                </svg>
              </span>
            )}
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

              {/* How many rows the panel keeps.

                  Only on a panel the registry already cuts. A closed list — a
                  per-day trend, the TAT bands, the search engines — sends back
                  no defaultRowLimit, and a top-N over one of those would not
                  shorten a long tail, it would drop days off a calendar.

                  Empty means the default rather than zero, matching the Chart
                  control beside it: every field in this row goes back to the
                  registry by being cleared. */}
              {!!p.defaultRowLimit && (
                <>
                  <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 flex-shrink-0 ml-1">
                    Rows
                  </span>
                  <input
                    type="number" min={1} max={100} inputMode="numeric"
                    value={p.rowLimit ? String(p.rowLimit) : ''}
                    onChange={e => setRowLimit(p.key, e.target.value)}
                    placeholder={`Top ${p.defaultRowLimit}`}
                    title={`How many rows this panel keeps. Empty is the default, Top ${p.defaultRowLimit}.`}
                    className="w-[74px] px-2 py-1 text-[11px] rounded-lg border border-gray-200
                      dark:border-white/15 dark:bg-[#14254A] dark:text-white tabular-nums
                      focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                </>
              )}
            </span>
          ) : pane ? (
            /* What the slicer FILTERS is already its name, so the second line
               says the one thing the name cannot: whether it is here because
               nobody changed anything, or because somebody did. */
            <span className="block text-[10px] text-gray-400 truncate">
              Slicer in the filter pane
              {p.defaultHidden === true ? ' · off unless switched on' : ''}
              {p.defaultHidden === false && p.hidden ? ' · normally shown' : ''}
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
            rather than missing, and the row still reads the same way.

            A slicer gets no control at all: the pane is one column, so there is
            no width to be wrong about, and an inert row of fractions would imply
            there was. */}
        {!pane && (
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
        )}

        {/* A pencil: rename the card and give it an ⓘ description, both shown
            on the report exactly as written here. Amber once either is set, so
            an annotated panel is visible in the list without opening it. */}
        {canAnnotate && (
          <button onClick={() => setEditKey(cur => cur === p.key ? '' : p.key)}
            title={annotated ? 'Edit the custom title / description' : 'Rename or add a description'}
            aria-expanded={editing}
            className={`w-8 h-8 grid place-items-center rounded-lg border transition-colors flex-shrink-0 ${
              editing
                ? 'border-[#FC934C] text-[#FC934C] bg-[#FC934C]/10'
                : annotated
                  ? 'border-amber-300 text-amber-600 hover:bg-amber-50 dark:border-amber-400/30 dark:text-amber-300'
                  : 'border-gray-200 text-gray-300 hover:text-gray-500 dark:border-white/15 dark:text-white/30'
            }`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
          </button>
        )}

        {/* An eye, not a word: this is a switch, and a button reading "Visible"
            looks like a statement of fact rather than something to press. */}
        <button onClick={() => toggleHidden(p.key)}
          title={p.hidden
            ? (pane ? 'Show this slicer in the filter pane' : 'Show on the report')
            : (pane ? 'Take this slicer out of the filter pane' : 'Hide from the report')}
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
          <button onClick={() => moveLayout(i, -1)} disabled={atTop}
            title="Move up" aria-label={`Move ${p.name} up`}
            className="w-5 h-4 grid place-items-center rounded text-[8px] text-gray-300
              hover:text-[#14254A] hover:bg-[#14254A]/[0.06] disabled:opacity-25
              dark:hover:text-white dark:hover:bg-white/10">▲</button>
          <button onClick={() => moveLayout(i, 1)} disabled={atEnd}
            title="Move down" aria-label={`Move ${p.name} down`}
            className="w-5 h-4 grid place-items-center rounded text-[8px] text-gray-300
              hover:text-[#14254A] hover:bg-[#14254A]/[0.06] disabled:opacity-25
              dark:hover:text-white dark:hover:bg-white/10">▼</button>
        </span>
      </div>

      {/* The rename / description editor. Local until Save like every other
          layout edit — the report keeps its current titles until the whole
          layout is written. */}
      {editing && (
        <div className="px-3 pb-3 pt-1 bg-[#FC934C]/[0.04] dark:bg-white/[0.02] space-y-2">
          <label className="block">
            <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 block mb-1">
              Custom title
            </span>
            <input type="text" value={p.title} maxLength={191}
              onChange={e => setTitle(p.key, e.target.value)}
              placeholder={p.name}
              className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-white/15
                bg-white dark:bg-white/[0.06] text-[12px] text-[#14254A] dark:text-white
                placeholder:text-gray-300 dark:placeholder:text-white/25
                focus:outline-none focus:border-[#FC934C]" />
            <span className="text-[10px] text-gray-400 block mt-0.5">
              Shown as the card&apos;s title on the report. Leave empty to keep &ldquo;{p.name}&rdquo;.
            </span>
          </label>
          <label className="block">
            <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 block mb-1">
              Description
            </span>
            <textarea value={p.desc} maxLength={1000} rows={3}
              onChange={e => setDesc(p.key, e.target.value)}
              placeholder={p.defaultDesc || 'What this figure means, how it is counted, or what to read it against…'}
              className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-white/15
                bg-white dark:bg-white/[0.06] text-[12px] text-[#14254A] dark:text-white resize-y
                placeholder:text-gray-300 dark:placeholder:text-white/25
                focus:outline-none focus:border-[#FC934C]" />
            <span className="text-[10px] text-gray-400 block mt-0.5">
              {p.defaultDesc
                ? 'Appears behind an ⓘ on the card. Leave empty to keep the built-in note shown above in grey.'
                : 'Appears behind an ⓘ on the card. Leave empty for no icon.'}
            </span>
          </label>
        </div>
      )}
      </div>
    )
  }

  const TABS: { key: Tab; label: string; hint: string }[] = [
    /* First, because it is upstream of everything else here: what the picker on
       the next tab is allowed to offer is decided on this one. Super Admin only
       — it enumerates the whole database. */
    ...(canEditSources
      ? [{ key: 'warehouse' as Tab, label: 'Warehouse',
           hint: 'Every table in the database, and which of them a platform may be pointed at' }]
      : []),
    { key: 'sources',   label: 'Data sources',
      hint: canEditSources
        ? 'Which table feeds which platform report'
        : 'Which source feeds which platform report' },
    { key: 'layout',    label: 'Page layout',     hint: 'Where each visual sits on a report, and how wide it is' },
    // The Database report is the fullest disclosure on this screen — every
    // mapped table, its columns and its row counts — so it is not offered at
    // all to a login that may not see them.
    ...(canEditSources
      ? [{ key: 'inventory' as Tab, label: 'Database report', hint: 'What each mapped table actually holds' }]
      : []),
    { key: 'clients',   label: 'Client mapping',  hint: 'Which reporting client each portal client reads' },
    { key: 'access',    label: 'User access',      hint: 'Which logins may see which platform' },
    /* Beside the tabs that decide what a report CONTAINS, because that is what
       it decides: not which rows exist, but which of them a sports report is
       allowed to reach. */
    { key: 'sports',    label: 'Sports period',    hint: 'The date window every sports report is held inside' },
    // Last, because it is the thing you set once and the others are the daily
    // work — but on this screen rather than a separate page, since "which table
    // feeds this report" and "which service serves those tables" are one question.
    { key: 'connection', label: 'API connection', hint: 'Which reports service this portal reads from' },
    { key: 'cache',      label: 'Cache & Redis',   hint: 'Reports kept ready in Redis, and the refresh that fills it' },
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

      {/* ── Tabs ──────────────────────────────────────────────────────────
          The brand's own colours, and the SAME treatment the reports rail uses
          for the platform it is on: an orange gradient pill, white text, and a
          soft orange cast under it. Borrowed rather than invented because these
          two controls do the same job — they are the primary switch for the
          screen they sit on — and this one was a white pill on a grey track,
          which is the product's minor filter toggle (All / Active / Inactive).
          A page's main navigation and a list's status filter should not look
          alike.

          The track stays navy at 6%: it is what makes the pill read as sitting
          IN a group of nine rather than floating on the page. */}
      <div className="flex gap-1 p-1 rounded-xl w-fit mb-4 bg-[#14254A]/[0.06] dark:bg-white/[0.06]">
        {TABS.map(t => {
          const on = tab === t.key
          return (
            <button key={t.key} onClick={() => setTab(t.key)} title={t.hint}
              aria-current={on ? 'page' : undefined}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                on
                  ? 'text-white shadow-[0_4px_12px_-4px_rgba(252,147,76,0.7)]'
                  : 'text-[#14254A]/65 hover:bg-[#14254A]/[0.05] hover:text-[#14254A] dark:text-white/65 dark:hover:bg-white/5 dark:hover:text-white'
              }`}
              style={on ? { background: 'linear-gradient(135deg,#FDA65A,#FC934C)' } : undefined}>
              {t.label}
            </button>
          )
        })}
      </div>

      {/* ── Data sources ────────────────────────────────────────────────────── */}
      {/* ── Warehouse ───────────────────────────────────────────────────────── */}
      {tab === 'warehouse' && canEditSources && (() => {
        const q = whQuery.trim().toLowerCase()
        const shown = whTables.filter(t => {
          if (whOnly === 'served' && !t.served) return false
          if (whOnly === 'hidden' && !t.hidden) return false
          // The server already applied `q`; this keeps the list responsive while
          // somebody is still typing, before the fetch has come back.
          return !q || t.table.toLowerCase().includes(q)
        })
        const PER = 25
        const pages = Math.max(1, Math.ceil(shown.length / PER))
        const page = Math.min(whPage, pages)
        const paged = shown.slice((page - 1) * PER, page * PER)
        const hiddenNow = whTables.filter(t => t.hidden).length

        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs text-gray-500 dark:text-white/45 max-w-2xl leading-relaxed">
                Every table the warehouse holds. Hiding one takes it out of the picker on
                <b className="text-[#14254A] dark:text-white"> Data sources</b> — it is a tidy-up of the
                choices, not a permission.
                <br />
                A table a platform already reads is <b className="text-[#14254A] dark:text-white">locked</b>{' '}
                and cannot be hidden. Point that platform at something else first.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <input value={whQuery} onChange={e => { setWhQuery(e.target.value); setWhPage(1) }}
                  onKeyDown={e => { if (e.key === 'Enter') loadWarehouse() }}
                  placeholder="Search table name…"
                  className="text-xs rounded-xl px-3 py-2 w-full sm:w-[220px] border
                    bg-white border-gray-200 text-[#14254A] placeholder-gray-400 focus:outline-none focus:border-[#14254A]
                    dark:bg-white/5 dark:border-white/15 dark:text-white dark:placeholder-white/30" />
                <input value={whSchema} onChange={e => setWhSchema(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') loadWarehouse() }}
                  placeholder="schema (default)"
                  title="Leave empty for the warehouse this service reads. `mediascan` holds the master tables."
                  className="text-xs rounded-xl px-3 py-2 w-full sm:w-[150px] border
                    bg-white border-gray-200 text-[#14254A] placeholder-gray-400 focus:outline-none focus:border-[#14254A]
                    dark:bg-white/5 dark:border-white/15 dark:text-white dark:placeholder-white/30" />
                <button onClick={loadWarehouse} disabled={busy === 'warehouse'}
                  className="px-3.5 py-2 rounded-xl text-xs font-bold border transition-colors
                    border-gray-200 text-gray-500 hover:text-[#14254A]
                    dark:border-white/15 dark:text-white/60 disabled:opacity-50">
                  {busy === 'warehouse' ? 'Reading…' : '↻ Read warehouse'}
                </button>
              </div>
            </div>

            <Card className="p-3">
              <div className="flex items-center gap-4 text-xs flex-wrap">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-base font-extrabold text-[#14254A] dark:text-white tabular-nums">
                    {whTables.length}
                  </span>
                  <span className="text-gray-500 dark:text-white/45">tables</span>
                </span>
                <span className="text-gray-500 dark:text-white/45">
                  <b className="text-[#14254A] dark:text-white tabular-nums">
                    {whTables.filter(t => t.served).length}
                  </b> served by the reports service
                </span>
                <span className="text-gray-500 dark:text-white/45">
                  <b className="text-[#14254A] dark:text-white tabular-nums">{hiddenNow}</b> hidden
                </span>

                <span className="ml-auto flex items-center gap-1">
                  {([['all', 'All'], ['served', 'Served'], ['hidden', 'Hidden']] as const).map(([k, l]) => (
                    <button key={k} onClick={() => { setWhOnly(k); setWhPage(1) }}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors ${
                        whOnly === k
                          ? 'text-white border-transparent'
                          : 'border-gray-200 text-gray-500 hover:text-[#14254A] dark:border-white/15 dark:text-white/60'}`}
                      style={whOnly === k ? { background: NAVY } : undefined}>
                      {l}
                    </button>
                  ))}
                </span>
              </div>
            </Card>

            {whTables.length === 0 && busy !== 'warehouse' && (
              <Card className="p-10 text-center">
                <p className="font-bold text-[#14254A] dark:text-white mb-1">Nothing read yet</p>
                <p className="text-sm text-gray-500 dark:text-white/45">
                  Press <b>Read warehouse</b> to list the tables. This asks the reports service, which
                  restricts the call by address as well as by key — if it refuses, the message will say so.
                </p>
              </Card>
            )}

            {whTables.length > 0 && (
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[760px]">
                    <thead>
                      <tr style={{ background: NAVY }}>
                        {['Table', 'Rows (approx)', 'Size', 'Served', 'Used by', 'In the picker'].map(h => (
                          <th key={h} className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-white/70">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {paged.length === 0 && (
                        <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-gray-400">
                          No table matches.
                        </td></tr>
                      )}
                      {paged.map((t, i) => (
                        <tr key={t.table} className={`border-b border-[#14254A]/[0.07] dark:border-white/[0.07] ${
                          i % 2 ? 'bg-[#14254A]/[0.02] dark:bg-white/[0.02]' : ''}`}>
                          <td className="px-4 py-2.5">
                            <code className="text-[11px] text-[#14254A] dark:text-white">{t.name}</code>
                            {t.type === 'VIEW' && <Pill tone="mute">View</Pill>}
                            {t.comment && (
                              <p className="text-[10px] text-gray-400 truncate max-w-[280px]" title={t.comment}>
                                {t.comment}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-white/45 tabular-nums">
                            {nf(t.rows)}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-white/45 tabular-nums">
                            {t.bytes >= 1 << 30
                              ? `${(t.bytes / (1 << 30)).toFixed(1)} GB`
                              : `${Math.round(t.bytes / (1 << 20))} MB`}
                          </td>
                          <td className="px-4 py-2.5">
                            {t.served
                              ? <Pill tone="ok">Yes</Pill>
                              : <Pill tone="mute">No</Pill>}
                          </td>
                          <td className="px-4 py-2.5 text-[11px] text-gray-500 dark:text-white/45">
                            {t.usedBy || '—'}
                          </td>
                          <td className="px-4 py-2.5">
                            {/* The switch reads as what it CONTROLS — whether the
                                picker offers it — rather than as "hidden", so it
                                is not mistaken for a permission or a delete.

                                A table a platform reads cannot be hidden at all:
                                the control is disabled and says why, rather than
                                accepting the click and failing behind it. */}
                            <label className={`inline-flex items-center gap-2 ${
                              t.canHide ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                              title={t.canHide
                                ? undefined
                                : `In use by ${t.usedBy}. Point that platform elsewhere before hiding this table.`}>
                              <input type="checkbox" checked={!t.hidden} disabled={!t.canHide}
                                onChange={e => setTableHidden(t, !e.target.checked)}
                                className={`w-4 h-4 rounded ${t.canHide ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                                style={{ accentColor: ORANGE }} />
                              <span className={`text-[11px] font-semibold ${
                                !t.canHide ? 'text-gray-400'
                                  : t.hidden ? 'text-gray-400'
                                    : 'text-[#14254A] dark:text-white'}`}>
                                {t.hidden ? 'Hidden' : 'Offered'}
                              </span>
                            </label>
                            {!t.canHide && (
                              <p className="text-[10px] text-gray-400 mt-0.5">
                                Locked — in use
                              </p>
                            )}
                            {t.hidden && t.usedBy && (
                              /* Only reachable from data written before the rule
                                 existed. Left visible so an install carrying that
                                 state can see it rather than wonder why a table
                                 is missing from the picker. */
                              <p className="text-[10px] text-amber-600 dark:text-amber-300 mt-0.5">
                                Still read by {t.usedBy}
                              </p>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <Pager page={page} totalPages={pages} perPage={PER} total={shown.length}
                  onPage={setWhPage} noun={['table', 'tables']} />
              </Card>
            )}

            {whNote && (
              <p className="text-[11px] text-gray-400 leading-relaxed max-w-3xl">{whNote}</p>
            )}
          </div>
        )
      })()}

      {tab === 'sources' && (() => {
        /* Counts for the strip at the top. A configuration screen should say
           what state it is in before it says what you can change. */
        const broken = platforms.filter(p =>
          (p.tableDetail ?? []).some(t => !t.usable) || (p.sources ?? []).some(s => !s.usable))
        const hidden = platforms.filter(p => !p.enabled)
        const q = sourceQuery.trim().toLowerCase()
        const shown = q
          ? platforms.filter(p =>
              p.label.toLowerCase().includes(q) ||
              p.key.toLowerCase().includes(q) ||
              // Only over what this login can actually see. Matching a hidden
              // table name would let the box be used to test guesses at one.
              (p.tables ?? []).some(t => t.toLowerCase().includes(q)) ||
              (p.sources ?? []).some(s =>
                s.alias.toLowerCase().includes(q) || s.ref.toLowerCase().includes(q)))
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
                {/* The reveal. Offered only to a Super Admin, off on arrival,
                    and never remembered — the same shape as revealing an API
                    key, because it is the same kind of act. */}
                {canEditSources && (
                  <button onClick={() => { setRevealNames(v => !v); setAddOpen(false) }}
                    title={revealed
                      ? 'Go back to showing sources by reference'
                      : 'Show the real warehouse schema and table names'}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                      revealed
                        ? 'border-[#FC934C]/40 text-[#c2691f] bg-[#FC934C]/10'
                        : 'border-gray-200 text-gray-500 hover:text-[#14254A] dark:border-white/15 dark:text-white/60'}`}>
                    {revealed ? 'Hide warehouse names' : 'Show warehouse names'}
                  </button>
                )}

                {/* Adding a platform means naming the warehouse tables behind
                    it, so it is offered only once those names are on screen —
                    and the server refuses it either way. */}
                {canEditSources && revealed && (
                  <button onClick={() => setAddOpen(o => !o)}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-white transition-all"
                    style={{ background: NAVY }}>
                    {addOpen ? 'Cancel' : '+ Add platform'}
                  </button>
                )}
              </div>
            </div>
          </Card>

          {/* Said once, plainly, rather than leaving someone to wonder why the
              sources are named the way they are and nothing can be edited. The
              wording differs by WHY they are hidden: a Super Admin has simply
              not asked yet, and telling them to contact a Super Admin would be
              absurd. */}
          {!revealed && (
            <Card className="p-3">
              <p className="text-xs text-gray-500 dark:text-white/45 leading-relaxed">
                <b className="text-[#14254A] dark:text-white">Sources are shown by reference.</b>{' '}
                {canEditSources
                  ? 'The warehouse tables behind each report are hidden until you ask for them — use Show warehouse names above. Renaming a report, hiding it and reordering it all work without them.'
                  : 'The warehouse tables behind each report, and the columns they are read by, are visible to Super Admins only. You can still rename a report, hide it from the sidebar and change its order — quote a source’s reference to a Super Admin if one needs looking at.'}
              </p>
            </Card>
          )}

          {/* ── Add a platform, only when asked for ─────────────────────── */}
          {addOpen && revealed && (
            <Card className="p-4">
              <div className="text-sm font-bold text-[#14254A] dark:text-white mb-1">Add a platform</div>
              <p className="text-xs text-gray-500 dark:text-white/45 mb-3 max-w-2xl leading-relaxed">
                A platform is a name and the warehouse tables behind it. Pick more than one and their
                numbers are added together. Everything else — which column holds the client, which holds
                the date, how rows are counted — is worked out from the tables themselves.
                <br />
                The list offers what the <b className="text-[#14254A] dark:text-white">Warehouse</b> tab
                leaves visible. A table marked <i>not served by the reports service</i> can be chosen but
                will not return data until a dataset for it exists there.
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
            const tablesDraft = draftTables[p.key] ?? p.tables ?? []
            const labelDraft = draftLabel[p.key] ?? p.label
            const dirty = labelDraft !== p.label ||
              (revealed && JSON.stringify(tablesDraft) !== JSON.stringify(p.tables ?? []))
            const unusable = (p.tableDetail ?? []).filter(t => !t.usable)
            const unusableRefs = (p.sources ?? []).filter(s => !s.usable)
            const brokenCount = revealed ? unusable.length : unusableRefs.length
            const sourceCount = p.tables?.length ?? p.tableCount ?? 0
            // An edited card stays open whatever else is clicked: a half-made
            // change must never be hidden behind a collapsed row.
            const open = openPlatform === p.key || dirty

            return (
              <Card key={p.key} className={brokenCount > 0
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
                      {/* A table name here would defeat the whole exercise for
                          the sake of a subtitle: the count says as much about
                          whether to open the row, and says nothing else. */}
                      {revealed && p.tables?.length === 1
                        ? p.tables[0].split('.').pop()
                        : `${sourceCount} source${sourceCount === 1 ? '' : 's'}`}
                    </span>
                    {dirty && <Pill tone="warn">Unsaved</Pill>}
                    {brokenCount > 0 && (
                      <Pill tone="warn">
                        {brokenCount} source{brokenCount === 1 ? '' : 's'} cannot be read
                      </Pill>
                    )}
                    {!p.enabled && <Pill tone="mute">Hidden from Reports</Pill>}
                  </button>

                  {/* Visibility without opening anything: the commonest change
                      on this screen is "take that one off the sidebar". */}
                  <button onClick={() => savePlatform(p.key, p.label, p.tables ?? [], !p.enabled)}
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
                      {revealed ? (
                        <Field label="Warehouse tables it reads"
                          hint={tablesDraft.length > 1 ? 'Numbers from these tables are added together' : undefined}>
                          <MultiSearchableSelect options={tables} values={tablesDraft}
                            onChange={v => setDraftTables(d => ({ ...d, [p.key]: v }))}
                            noun={['table', 'tables']} placeholder="Search warehouse tables…" />
                        </Field>
                      ) : (
                        <Field label="Sources it reads"
                          hint={sourceCount > 1 ? 'Numbers from these sources are added together' : undefined}>
                          <div className="rounded-xl border border-gray-200 dark:border-white/15
                            bg-gray-50 dark:bg-white/[0.04] px-3 py-2.5 text-sm
                            text-gray-500 dark:text-white/45">
                            {sourceCount} source{sourceCount === 1 ? '' : 's'}, listed below.
                            Changing them is a Super Admin action.
                          </div>
                        </Field>
                      )}
                    </div>

                    {/* The same card without a name on it. Whether a source is
                        understood, how much of the report it can fill and what
                        is wrong with it are all state — none of it identifies
                        the table, and all of it is what this screen is for. The
                        reference is there so a fault can be reported to someone
                        who can look it up. */}
                    {!revealed && (p.sources ?? []).length > 0 && (
                      <div className="mt-3 space-y-2">
                        {(p.sources ?? []).map(s => (
                          <div key={s.ref}
                            className={`rounded-xl border p-3 ${s.usable
                              ? 'border-gray-100 dark:border-white/10'
                              : 'border-amber-300/70 bg-amber-50/50 dark:border-amber-400/30 dark:bg-amber-500/[0.07]'}`}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[12px] font-semibold text-[#14254A] dark:text-white">
                                {s.alias}
                              </span>
                              <code className="text-[10px] px-1.5 py-0.5 rounded bg-[#14254A]/[0.06]
                                text-[#14254A]/60 dark:bg-white/10 dark:text-white/50"
                                title="Quote this when reporting a problem with this source">
                                ref {s.ref}
                              </code>
                              {s.usable
                                ? <Pill tone="ok">Understood</Pill>
                                : <Pill tone="bad">Cannot be read</Pill>}
                            </div>
                            {s.usable ? (
                              <p className="text-[11px] text-gray-500 dark:text-white/45 mt-1.5 leading-relaxed">
                                It can fill <b className="text-[#14254A] dark:text-white">{s.dimensions}</b>{' '}
                                breakdown panel{s.dimensions === 1 ? '' : 's'}.
                              </p>
                            ) : (
                              <p className="text-[11px] text-[#b45309] dark:text-amber-300 mt-1.5 leading-relaxed">
                                {sentence(s.error || 'This source could not be read')}{' '}
                                Its numbers are left out of this platform until it can be.
                                Ask a Super Admin to check source <b>{s.ref}</b>.
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* What the server worked out, in words first and
                        expressions second. An admin needs to know a table is
                        understood; the SQL is for the day it is not. */}
                    {revealed && (p.tableDetail ?? []).length > 0 && (
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
                            setDraftTables(d => ({ ...d, [p.key]: p.tables ?? [] }))
                          }}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors
                              border-gray-200 text-gray-500 hover:text-[#14254A] hover:border-gray-300
                              dark:border-white/15 dark:text-white/50 dark:hover:text-white">
                            Discard
                          </button>
                        )}
                        {/* Deleting a platform discards a source mapping that
                            only a Super Admin could put back, so it belongs
                            with the rest of these settings. */}
                        {canEditSources && (
                          <button onClick={() => setConfirmDelete(p)} disabled={busy === p.key}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors
                              border-gray-200 text-red-600 hover:bg-red-50 hover:border-red-300
                              dark:border-white/15 dark:text-red-300 dark:hover:bg-red-500/15 disabled:opacity-50">
                            Delete
                          </button>
                        )}
                        {dirty ? (
                          <button onClick={() => savePlatform(p.key, labelDraft.trim(), tablesDraft, p.enabled)}
                            disabled={!labelDraft.trim() ||
                              (revealed && tablesDraft.length === 0) || busy === p.key}
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
          <p className="text-xs text-gray-500 dark:text-white/45 max-w-3xl leading-relaxed">
            The <strong>filter pane</strong> down the right of the report is arranged here too —
            which slicers a reader gets and in what order, for this platform and, if you pick one
            below, for this client alone. A slicer starts out following its chart: hide the Genre
            breakdown and the Genre dropdown goes with it, since a control whose only visible effect
            is to empty the page is worse than no control. Switch one on here and it stays whatever
            became of its chart. Turnaround and Keyword start off — both are picked by clicking
            their own panel — and can be switched on like any other.
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
                    {gridPanels.filter(p => !p.hidden && p.kind === 'tile').length} KPI cards ·{' '}
                    {gridPanels.filter(p => !p.hidden && p.kind === 'dim').length} charts ·{' '}
                    {packRows(gridPanels.filter(p => !p.hidden)).length} rows ·{' '}
                    {panePanels.filter(p => !p.hidden).length} filters
                  </span>
                </div>
                {/* The grid and the rail beside it, laid out the way the report
                    lays them out — the charts take the width and the slicers sit
                    down one narrow column to their right. Drawing the pane as a
                    list under the grid would say it was part of the page flow,
                    which is the one thing about it that is not true. */}
                <div className="flex gap-2 items-start">
                <div className="flex-1 min-w-0 space-y-1.5">
                  {packRows(gridPanels.filter(p => !p.hidden)).map((row, i) => (
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
                          title={`${p.title || p.name} — drag to move`}>
                          {p.title || p.name}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                {/* The pane. Narrow on purpose: it is the shape of the thing,
                    and a filter list as wide as the charts would read as another
                    column of the report. */}
                <div className="w-[104px] flex-shrink-0 rounded-lg border border-gray-100 dark:border-white/10
                  bg-[#14254A]/[0.02] dark:bg-white/[0.02] p-1.5 space-y-1">
                  <p className="text-[8px] font-bold uppercase tracking-widest text-gray-400 px-1 pb-0.5">
                    Filters
                  </p>
                  {/* Always there, and shown as such: a report cannot be run
                      without a window, so it is not in the list below either. */}
                  <div className="rounded-md px-1.5 py-1.5 text-[9px] font-semibold border border-dashed
                    border-gray-200 text-gray-400 dark:border-white/15 dark:text-white/35">
                    Date range
                  </div>
                  {panePanels.filter(p => !p.hidden).map(p => (
                    <div key={p.key}
                      className="rounded-md px-1.5 py-1.5 text-[9px] font-semibold truncate border
                        bg-sky-50 border-sky-200 text-sky-800
                        dark:bg-sky-400/10 dark:border-sky-400/25 dark:text-sky-200"
                      title={p.name}>
                      {p.name}
                    </div>
                  ))}
                  {panePanels.filter(p => !p.hidden).length === 0 && (
                    <p className="text-[9px] text-gray-400 px-1 leading-snug">
                      Date range only
                    </p>
                  )}
                </div>
                </div>

                {/* ── Save, beneath the thing being saved ──────────────────
                    At the foot of the PREVIEW rather than the foot of the
                    page: the editor list runs to twenty-odd rows, so a bar
                    below it sat a long scroll away from the wireframe that
                    shows what you are about to commit. The preview is sticky,
                    so from here the buttons stay on screen however far down
                    the list you are. */}
                <div className="mt-4 pt-3 border-t border-gray-100 dark:border-white/10">
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
                  <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
                    {layoutClient
                      ? layoutConfigured
                        ? 'This client has a layout of its own. Changes to the shared layout will not touch it.'
                        : 'This client follows the shared layout. Saving here gives it one of its own.'
                      : layoutConfigured
                        ? 'Saved. This is what every client sees unless they have a layout of their own.'
                        : 'No saved layout yet — what you see is the default the report is built with.'}
                  </p>
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
              {packRows(gridPanels.filter(p => !p.hidden)).map((row, i) => {
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
              {gridPanels.some(p => p.hidden) && (
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
                    {gridPanels.filter(p => p.hidden).map(renderPanelRow)}
                  </div>
                </Card>
              )}

              {/* ── The filter pane ────────────────────────────────
                  Its own card, and the hidden ones listed with the rest rather
                  than swept into the block above: the pane is short, the whole
                  question here is which of a dozen slicers a reader gets, and
                  answering it should not mean reading two lists. */}
              {panePanels.length > 0 && (
                <Card className="overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-sky-500/[0.06] dark:bg-sky-400/[0.07]">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-sky-700 dark:text-sky-200">
                      Filter pane
                    </span>
                    <span className="h-px flex-1 bg-sky-100 dark:bg-white/10" />
                    <span className="text-[10px] text-gray-400 tabular-nums">
                      {panePanels.filter(p => !p.hidden).length}/{panePanels.length} shown
                    </span>
                  </div>
                  <div className="divide-y divide-gray-50 dark:divide-white/[0.06]">
                    {panePanels.map(renderPanelRow)}
                  </div>
                  <p className="px-3 py-2 text-[10px] text-gray-400 leading-relaxed border-t
                    border-gray-50 dark:border-white/[0.06]">
                    The date range and, for staff, the client picker are always in the pane — a
                    report cannot be run without them. Everything else is this list, top to bottom.
                    A slicer switched off still filters when a reader clicks the matching chart;
                    only the dropdown goes.
                  </p>
                </Card>
              )}
              </div>
            </div>

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
              {pagedClientMap.map(c => (
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
              {/* Told apart, because they send the reader somewhere different:
                  nothing loaded at all, versus a search that matched nothing. */}
              {clientMap.length === 0 && busy !== 'clients' && (
                <p className="px-4 py-8 text-center text-sm text-gray-400">No clients found.</p>
              )}
              {clientMap.length > 0 && visibleClientMap.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-gray-400">
                  No client matches &ldquo;{mapQuery}&rdquo;.
                </p>
              )}
            </div>

            <Pager page={mapSafePage} totalPages={mapTotalPages}
              perPage={MAP_PER_PAGE} total={visibleClientMap.length}
              onPage={setMapPage} noun={['client', 'clients']}
              suffix={mapQuery.trim() ? ' matching' : undefined} />
          </Card>

          <p className="text-[11px] text-gray-400 leading-relaxed max-w-3xl">
            Linking a client is not the same as giving it the page. Grant the{' '}
            <b className="text-[#14254A] dark:text-white">Reports</b> module to the individual
            logins that should see it, the same way every other client page is granted.
          </p>
        </div>
      )}

      {/* ── Database report ─────────────────────────────────────────────────── */}
      {tab === 'inventory' && canEditSources && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs text-gray-500 dark:text-white/45 max-w-2xl leading-relaxed">
              What each platform is actually attached to. A platform reading several tables appears
              once per table, with the client and date columns that were derived from it
              {inventoryProfiled
                ? ', its row and client counts, and the span of its dates.'
                : ' and how much of a report it can fill.'}
            </p>
            <button onClick={loadInventory} disabled={busy === 'inventory'}
              className="px-3.5 py-2 rounded-xl text-xs font-bold border transition-colors
                border-gray-200 text-gray-500 hover:text-[#14254A]
                dark:border-white/15 dark:text-white/60 dark:hover:text-white disabled:opacity-50">
              {busy === 'inventory' ? 'Checking…' : '↻ Re-check'}
            </button>
          </div>

          {/* The three profile columns are one query against the warehouse, and
              reading through reports_api there is no warehouse connection to
              make it with — every aggregate over there is scoped to one client,
              and these ask about the table as a whole. Said once, here, so the
              empty cells below are not read as empty tables. */}
          {!inventoryProfiled && inventory.length > 0 && (
            <Card className="p-3">
              <p className="text-[11px] text-gray-500 dark:text-white/45 leading-relaxed">
                <b className="text-[#14254A] dark:text-white">Row and date counts are unavailable.</b>{' '}
                This portal reads its reports through the reports service rather than holding
                warehouse credentials of its own, so it can say what each table is and whether the
                engine understands it, but not how many rows it holds.
              </p>
            </Card>
          )}

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
                  {/* Keyed on `ref` rather than `table`: the table is absent
                      when the names are hidden, and a key that collapses to
                      "platform--0" for every row of a platform is not a key. */}
                  {inventory.map((row, i) => (
                    <tr key={`${row.key}-${row.ref || row.table || i}-${i}`}
                      className={`border-b border-[#14254A]/[0.07] dark:border-white/[0.07] ${
                        i % 2 ? 'bg-[#14254A]/[0.02] dark:bg-white/[0.02]' : ''}`}>
                      <td className="px-4 py-3 font-semibold text-[#14254A] dark:text-white whitespace-nowrap">
                        {row.label}
                      </td>
                      <td className="px-4 py-3">
                        {row.table
                          ? <code className="text-[11px] text-[#14254A]/70 dark:text-white/60">{row.table}</code>
                          : (
                            /* Aliased. The reference is what makes two sources of
                               one platform tellable apart and what somebody quotes
                               when reporting a fault with one. */
                            <span>
                              <span className="text-[12px] text-[#14254A] dark:text-white">{row.alias || '—'}</span>
                              {row.ref && (
                                <code className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-[#14254A]/[0.06]
                                  text-[#14254A]/60 dark:bg-white/10 dark:text-white/50">{row.ref}</code>
                              )}
                            </span>
                          )}
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
                      <td className="px-4 py-3 text-[11px] whitespace-nowrap">
                        <span className="font-mono text-gray-500 dark:text-white/45">
                          {row.clientCol ? `${row.clientCol} · ${row.dateCol}` : '—'}
                        </span>
                        {/* How much of a report this table can fill. Derived from
                            the catalogue, so it is the one substantive figure
                            still available when the row counts are not. */}
                        {row.dimensions != null && (
                          <span className="block text-[10px] text-gray-400 mt-0.5">
                            fills {row.dimensions} panel{row.dimensions === 1 ? '' : 's'}
                          </span>
                        )}
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
      {tab === 'sports' && <SportsPeriodPanel />}

      {tab === 'connection' && <ReportsApiConnectionPanel />}

      {tab === 'cache' && <ReportCachePanel />}

      {tab === 'access' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs text-gray-500 dark:text-white/45 max-w-2xl leading-relaxed">
              Every login sees every platform by default. Untick one to take it away — the row then
              shows as restricted. Ticking all of them back restores the default rather than storing
              a full list.
              <br />
              The box beside a name covers that login; the one under a column heading covers that
              platform for <b>every login the search matches</b> — all {visibleUsers.length} of them,
              not just this page — so searching first narrows what a bulk tick will touch.
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
                            ? `Remove every platform from all ${visibleUsers.length} matching logins`
                            : `Give every platform to all ${visibleUsers.length} matching logins`}
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
                                ? `Remove ${r.label} from all ${visibleUsers.length} matching logins`
                                : `Give ${r.label} to all ${visibleUsers.length} matching logins`}
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
                  {pagedUsers.map((u, i) => (
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

            <Pager page={accessSafePage} totalPages={accessTotalPages}
              perPage={ACCESS_PER_PAGE} total={visibleUsers.length}
              onPage={setAccessPage} noun={['login', 'logins']}
              suffix={userQuery.trim() ? ' matching' : undefined} />
          </Card>
        </div>
      )}
    </div>
  )
}
