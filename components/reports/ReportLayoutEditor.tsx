'use client'

/*
 * Rearranging a report, from the report.
 *
 * The same thing Report Configuration does — order, width, visibility and chart
 * type for every panel — offered to a client login whose account an admin has
 * granted it. It writes through /api/user/report-layout, which forces the client
 * from the session and then hands the request to the very handler the admin
 * screen uses, so the two cannot drift apart.
 *
 * ── What a client may NOT do ─────────────────────────────────────────────────
 *
 * Turn on a panel IP House switched off. Those panels are absent from this
 * screen entirely rather than shown disabled: the reason they are unavailable is
 * on a screen the reader cannot open, so a greyed row would raise a question
 * with no answer in reach. The server enforces the same rule on the way in — see
 * scopeSaveBody — because a hidden control is not a permission.
 *
 * Throw the arrangement away. There is no Reset here, and the DELETE it used to
 * call is refused for a client session — see UserReportLayout. The two facts
 * that make it the wrong control: this layout is the whole company's, not the
 * reader's, and reset is not an undo — it discards every panel anyone at the
 * company has ever moved, in one click, with nothing to restore it from. Going
 * back to the shared default is a support request, and Report Configuration is
 * where it is answered.
 *
 * ── Why three quarters, and not a rail or the whole screen ───────────────────
 *
 * A report is thirty-odd panels across several sections. In a 340px rail that is
 * a scroll with no overview, and arranging things you cannot see at once is
 * guesswork; three quarters fits the grid panels and the slicer rail side by
 * side, which is also how they sit on the report.
 *
 * The remaining quarter is doing a job too. The report stays visible down the
 * left, so it is clear what is being arranged and that it is still there — a
 * full-screen takeover reads as having navigated somewhere, and the way back
 * becomes a question.
 *
 * ── Why a list and not the page itself ───────────────────────────────────────
 *
 * Dragging panels around the live report would need it re-rendered on every
 * move, and the report is the expensive thing here: each panel is a warehouse
 * query. A list reorders instantly, and it is the shape the admin editor already
 * uses — so an admin helping a client over the phone is describing the same
 * controls in the same order.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'

import LayoutPreview, { GRID_COLS, SPAN_COLS, packRows } from '@/components/reports/LayoutPreview'

const ORANGE = '#FC934C'
const NAVY = '#14254A'

type Span = 'full' | 'half' | 'third' | 'quarter'

interface Panel {
  key: string
  kind: 'tile' | 'heading' | 'trend' | 'rate' | 'dim' | 'filter'
  name: string
  viz?: string
  span: Span
  hidden: boolean
  title: string
  desc: string
  defaultSpan: Span
  defaultViz?: string
  defaultHidden?: boolean
  fixedSpan?: boolean
  rowLimit?: number
  /** The note this panel carries when nobody has written one. Offered as the
      description box's placeholder, so clearing the box visibly means "back to
      this" rather than leaving a field blank to no stated effect. */
  defaultDesc: string
}

interface VizChoice { key: string; label: string }

export interface EditableSection { key: string; label: string }

const KIND_LABEL: Record<Panel['kind'], string> = {
  tile: 'KPI card', heading: 'Section rule', trend: 'Trend', rate: 'Trend',
  dim: 'Chart', filter: 'Filter',
}

/* The fraction, not the word — four of these per row and "Full row / Half /
   Third / Quarter" spelled out is most of the row. Same decision the admin
   editor made, for the same reason; the long name is on the tooltip. */
const SPAN_SHORT: Record<Span, string> = {
  full: '1/1', half: '1/2', third: '1/3', quarter: '1/4',
}
const SPAN_TITLE: Record<Span, string> = {
  full: 'Full row', half: 'Half row', third: 'A third', quarter: 'A quarter',
}
const SPANS: Span[] = ['full', 'half', 'third', 'quarter']

const isFilter = (p: Panel) => p.kind === 'filter'

/** What a save would send, as one string — so "has anything changed" is a
    comparison rather than a flag every handler has to remember to set. */
const fingerprint = (ps: Panel[]) =>
  ps.map(p => [
    p.key, p.span, p.viz || '', p.hidden ? 1 : 0, p.title, p.desc,
  ].join('\u0000')).join('|')

interface Props {
  /** The section on screen when the editor was opened. */
  platform: string
  /** Every section this login can open, so a report can be arranged without
      leaving the editor to go and select it first. */
  sections: EditableSection[]
  open: boolean
  onClose: () => void
  /** Called after a successful save or reset, so the report behind reloads. */
  onSaved: () => void
}

export default function ReportLayoutEditor({ platform, sections, open, onClose, onSaved }: Props) {
  const [active,  setActive]  = useState(platform)
  const [panels,  setPanels]  = useState<Panel[]>([])
  const [baseline, setBaseline] = useState('')
  const [vizList, setVizList] = useState<VizChoice[]>([])
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [err,     setErr]     = useState('')
  const [note,    setNote]    = useState('')
  const [ownLayout, setOwnLayout] = useState(false)
  /** A section the reader asked for while holding unsaved changes. Held rather
      than switched to, so the work is never thrown away without being offered
      back. */
  const [pending, setPending] = useState<string | null>(null)
  /** The row whose rename/description editor is open. One at a time — two open
      editors push the list apart and only one is being written in. */
  const [editKey, setEditKey] = useState<string | null>(null)

  // Follow the report while the editor is closed; once open, the section picker
  // inside it is in charge and the page behind must not yank it.
  useEffect(() => { if (!open) setActive(platform) }, [platform, open])

  const load = useCallback(async (key: string) => {
    if (!key) return
    setLoading(true); setErr(''); setNote('')
    try {
      const r = await fetch(`/api/user/report-layout?platform=${encodeURIComponent(key)}`,
        { credentials: 'include' })
      const d = await r.json()
      if (!d?.success) { setErr(d?.error || 'This layout could not be read.'); setPanels([]); return }
      /* Panels IP House hid never enter this screen — not as a disabled row,
         not in state. Dropping them here also keeps the save honest: what is
         sent is exactly what was shown, and the server puts the hidden ones
         back itself. */
      const visible = (d.panels || []).filter((p: any) => !p.adminHidden)
      const mapped: Panel[] = visible.map((p: any) => ({
        key: p.key, kind: p.kind, name: p.name || p.key,
        viz: p.viz || '', span: (p.span || p.defaultSpan || 'full') as Span,
        hidden: !!p.hidden, title: p.customLabel || '', desc: p.desc || '',
        defaultSpan: (p.defaultSpan || 'full') as Span,
        defaultViz: p.defaultViz || '', defaultHidden: p.defaultHidden,
        fixedSpan: !!p.fixedSpan, rowLimit: p.rowLimit,
        defaultDesc: p.defaultDesc || '',
      }))
      setPanels(mapped)
      setBaseline(fingerprint(mapped))
      setVizList(d.vizChoices || [])
      setOwnLayout(!!d.ownLayout)
    } catch {
      setErr('This layout could not be read.'); setPanels([])
    } finally {
      setLoading(false)
    }
  }, [])

  /* Re-read on every open and on every section change, not once: an admin may
     have changed the shared default since this was last looked at, and editing
     a stale copy would save it back over their change. */
  useEffect(() => { if (open) load(active) }, [open, active, load])

  // A row open on one report must not stay open against another's panel list.
  useEffect(() => { setEditKey(null) }, [active])

  const dirty = !loading && !err && fingerprint(panels) !== baseline

  function switchTo(key: string) {
    if (key === active) return
    if (dirty) { setPending(key); return }
    setActive(key)
  }

  function patch(key: string, fields: Partial<Panel>) {
    setNote('')
    setPanels(ps => ps.map(p => p.key === key ? { ...p, ...fields } : p))
  }

  /* Moves within the panel's OWN group.

     Filters live in a rail beside the grid, not in it, so a slicer moved past
     the last chart would be moved out of the only place it can be drawn.
     Swapping with the nearest neighbour of the same kind keeps the two lists
     independent while leaving one array to save. */
  function move(key: string, dir: -1 | 1) {
    setNote('')
    setPanels(ps => {
      const i = ps.findIndex(p => p.key === key)
      if (i < 0) return ps
      const mine = isFilter(ps[i])
      let j = i + dir
      while (j >= 0 && j < ps.length && isFilter(ps[j]) !== mine) j += dir
      if (j < 0 || j >= ps.length) return ps
      const next = [...ps]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  /*
    Drag-and-drop's move: put the dragged panel WHERE THE DROP TARGET SITS,
    rather than swapping the two.

    Different from move() above on purpose. The arrows step one place, so a swap
    is what a step means; dragging is "put this here", and swapping would send
    the panel you dropped on back to where the dragged one came from — halfway
    across the report, having touched nothing you pointed at.

    A filter cannot cross into the grid and a chart cannot cross into the rail.
    They are two lists in one array — the pane is drawn beside the report, not in
    it — so a slicer dropped on a chart would be moved out of the only place it
    can be drawn. Refused rather than clamped: the drop just does nothing, which
    is what a drop on an impossible target should do.
  */
  function moveByKey(fromKey: string, toKey: string) {
    if (fromKey === toKey) return
    setNote('')
    setPanels(cur => {
      const from = cur.findIndex(p => p.key === fromKey)
      const to = cur.findIndex(p => p.key === toKey)
      if (from < 0 || to < 0) return cur
      if (isFilter(cur[from]) !== isFilter(cur[to])) return cur
      const next = [...cur]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  async function save() {
    setSaving(true); setErr(''); setNote('')
    try {
      const r = await fetch('/api/user/report-layout', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: active,
          panels: panels.map(p => ({
            key: p.key,
            // A fixed-span panel sends nothing, so the server keeps the
            // registry's own width rather than storing one it will ignore.
            span: p.fixedSpan ? '' : p.span,
            viz: p.kind === 'dim' ? (p.viz || '') : '',
            hidden: p.hidden,
            title: p.title,
            desc: p.desc,
            rowLimit: p.rowLimit ?? 0,
          })),
        }),
      })
      const d = await r.json()
      if (!d?.success) { setErr(d?.error || 'This layout could not be saved.'); return }
      setOwnLayout(true)
      setBaseline(fingerprint(panels))
      setNote('Saved. Everyone at your company sees this arrangement.')
      onSaved()
    } catch {
      setErr('This layout could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const grid = useMemo(() => panels.filter(p => !isFilter(p)), [panels])
  const rail = useMemo(() => panels.filter(isFilter), [panels])

  /* The grid panels split by whether they are drawn, and the drawn ones packed
     into the rows the report will lay them out in — the same packRows the
     preview uses, so the "Row 2" a control sits under is the row the panel
     actually lands in rather than a second opinion about it. */
  /* Which panel is being dragged, and which one it is currently over. Held
     here rather than inside the preview because the preview is presentational
     and the array it reorders lives here. */
  const [dragKey, setDragKey] = useState('')
  const [overKey, setOverKey] = useState('')

  const shownGrid = useMemo(() => grid.filter(p => !p.hidden), [grid])
  const hiddenGrid = useMemo(() => grid.filter(p => p.hidden), [grid])
  const packedRows = useMemo(() => packRows(shownGrid), [shownGrid])
  const shownCount = panels.filter(p => !p.hidden).length

  const row = (p: Panel) => {
    const changed =
      p.hidden !== !!p.defaultHidden ||
      (!p.fixedSpan && p.span !== p.defaultSpan) ||
      (p.kind === 'dim' && (p.viz || '') !== (p.defaultViz || ''))
    return (
      <div key={p.key}
        className={`rounded-xl border px-3 py-2.5 transition-colors ${p.hidden
          ? 'border-gray-100 bg-gray-50 dark:border-white/10 dark:bg-white/[0.02]'
          : 'border-gray-200 bg-white dark:border-white/15 dark:bg-white/[0.04]'}`}>

        <div className="flex items-center gap-2.5">
          {/* Show/hide first: it decides whether the rest of the row means
              anything. */}
          <button type="button" onClick={() => patch(p.key, { hidden: !p.hidden })}
            role="switch" aria-checked={!p.hidden}
            title={p.hidden ? 'Hidden — click to show' : 'Shown — click to hide'}
            className={`relative inline-flex items-center h-5 w-9 rounded-full flex-shrink-0
              transition-colors ${p.hidden ? 'bg-gray-200 dark:bg-white/15' : 'bg-emerald-500'}`}>
            <span className={`inline-block w-[15px] h-[15px] bg-white rounded-full shadow transform
              transition-transform ${p.hidden ? 'translate-x-[3px]' : 'translate-x-[20px]'}`} />
          </button>

          <span className="min-w-0 flex-1">
            <span className={`block text-xs font-semibold truncate ${p.hidden
              ? 'text-gray-400 dark:text-white/35'
              : 'text-[#14254A] dark:text-white'}`}>
              {p.title || p.name}
            </span>
            <span className="block text-[10px] text-gray-400 truncate">
              {KIND_LABEL[p.kind]}
              {/* Renamed panels show their own name here, so the card can still
                  be found by what the report used to call it. */}
              {p.title.trim() !== '' && <> · was &ldquo;{p.name}&rdquo;</>}
              {changed && <span className="ml-1.5 font-bold" style={{ color: ORANGE }}>· changed</span>}
            </span>
          </span>

          <span className="flex items-center gap-0.5 flex-shrink-0">
            {/* Everything but a section rule can be renamed and described —
                slicers included, since the rail is where a reader most often
                needs telling what a control narrows. A rule already IS a title
                and carries its own subtitle, so it has nothing to add. */}
            {p.kind !== 'heading' && (
              <button type="button"
                onClick={() => setEditKey(k => k === p.key ? null : p.key)}
                aria-expanded={editKey === p.key}
                title={editKey === p.key ? 'Done' : 'Rename or describe'}
                className={`w-6 h-6 rounded-md transition-colors ${editKey === p.key
                  ? 'text-white'
                  : 'text-gray-400 hover:text-[#14254A] hover:bg-gray-100 ' +
                    'dark:hover:text-white dark:hover:bg-white/10'}`}
                style={editKey === p.key ? { background: NAVY } : undefined}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="mx-auto">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
              </button>
            )}
            <button type="button" onClick={() => move(p.key, -1)} title="Move up"
              className="w-6 h-6 rounded-md text-gray-400 hover:text-[#14254A] hover:bg-gray-100
                dark:hover:text-white dark:hover:bg-white/10 transition-colors">↑</button>
            <button type="button" onClick={() => move(p.key, 1)} title="Move down"
              className="w-6 h-6 rounded-md text-gray-400 hover:text-[#14254A] hover:bg-gray-100
                dark:hover:text-white dark:hover:bg-white/10 transition-colors">↓</button>
          </span>
        </div>

        {/* Width and chart type on their own line, at every width.

            One line rather than a wide row that collapses to a second one on
            narrow screens: that arrangement needed the chart picker written
            twice, and two copies of a control are two things to keep in step.
            A hidden panel gets no line at all — there is nothing to size. */}
        {!p.hidden && (!p.fixedSpan || (p.kind === 'dim' && vizList.length > 0)) && (
          <div className="flex flex-wrap items-center gap-2 mt-2 pl-[46px]">
            {!p.fixedSpan && (
              <span className="flex items-center gap-1">
                {SPANS.map(s => (
                  <button key={s} type="button" onClick={() => patch(p.key, { span: s })}
                    title={SPAN_TITLE[s]}
                    className={`px-2 py-0.5 rounded-md text-[10px] font-bold border transition-colors ${
                      p.span === s
                        ? 'text-white border-transparent'
                        : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50 ' +
                          'dark:bg-white/5 dark:text-white/60 dark:border-white/15'}`}
                    style={p.span === s ? { background: NAVY } : undefined}>
                    {SPAN_SHORT[s]}
                  </button>
                ))}
              </span>
            )}
            {p.kind === 'dim' && vizList.length > 0 && (
              /* The house dropdown, portalled — not a native <select>.

                 A <select>'s list is drawn by the OPERATING SYSTEM: square
                 corners, its own blue highlight, its own font, none of it
                 answering to this stylesheet. Beside controls that round at
                 12px and highlight in navy it read as a control borrowed from
                 another application. It is also the same picker the rest of
                 the product uses, so it searches and it opens upwards near the
                 bottom of the panel.

                 `clearable` with an emptyLabel rather than an option keyed on
                 the empty string: clearing IS the meaning here — an empty viz
                 tells the server to keep whatever chart the registry chose for
                 that dimension, which is exactly what "no override" is. */
              <span className="w-[11rem]">
                <SearchableSelect
                  options={vizList.map(v => ({ key: v.key, label: v.label }))}
                  value={p.viz || ''}
                  onChange={v => patch(p.key, { viz: v })}
                  emptyLabel="Default chart"
                  placeholder="Default chart"
                  compact />
              </span>
            )}
          </div>
        )}

        {/* Rename and describe. Local until Save, like every other edit here —
            the report keeps its current wording until the whole layout is
            written, so a half-typed title never reaches a reader. */}
        {editKey === p.key && p.kind !== 'heading' && (
          <div className="mt-2.5 pt-2.5 border-t border-gray-100 dark:border-white/10 space-y-2.5">
            <label className="block">
              <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 block mb-1">
                Title
              </span>
              <input type="text" value={p.title} maxLength={191}
                onChange={e => patch(p.key, { title: e.target.value })}
                placeholder={p.name}
                className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-white/15
                  bg-white dark:bg-white/[0.06] text-[12px] text-[#14254A] dark:text-white
                  placeholder:text-gray-300 dark:placeholder:text-white/25
                  focus:outline-none focus:border-[#FC934C]" />
              <span className="text-[10px] text-gray-400 block mt-0.5">
                Leave empty to keep &ldquo;{p.name}&rdquo;.
              </span>
            </label>
            <label className="block">
              <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 block mb-1">
                Description
              </span>
              <textarea value={p.desc} maxLength={1000} rows={3}
                onChange={e => patch(p.key, { desc: e.target.value })}
                placeholder={p.defaultDesc
                  || 'What this figure means, how it is counted, or what to read it against…'}
                className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-white/15
                  bg-white dark:bg-white/[0.06] text-[12px] text-[#14254A] dark:text-white resize-y
                  placeholder:text-gray-300 dark:placeholder:text-white/25
                  focus:outline-none focus:border-[#FC934C]" />
              <span className="text-[10px] text-gray-400 block mt-0.5">
                {p.defaultDesc
                  ? 'Appears behind an ⓘ on the card. Leave empty to keep the note shown in grey.'
                  : 'Appears behind an ⓘ on the card. Leave empty for no icon.'}
              </span>
            </label>
          </div>
        )}
      </div>
    )
  }

  /* Rendered even while closed, and slid off-screen instead.

     A panel that unmounts cannot animate, and this one arrives over a report
     the reader is still looking at — the slide is what says it came from the
     side rather than replacing the page. The parent mounts this component only
     for a login that holds the grant, so a closed panel costs one translated
     div and nothing else. */
  return (
    <>
      {open && <div className="fixed inset-0 bg-black/30 z-[69]" onClick={onClose} />}

      {/* FULL screen, not a three-quarter drawer.

          This is a two-pane workspace now — the wireframe on one side and the
          controls on the other — and at 3/4 width the two panes were each about
          a third of the glass, so the preview's twelve columns were drawn across
          400px and the panel names truncated in both. There is nothing behind it
          worth keeping in view while it is open. */}
      <div className={`fixed inset-0 h-full z-[70] flex flex-col shadow-2xl
        w-full bg-[#eef2f7] dark:bg-[#0f1f3d]
        transition-transform duration-300 ease-in-out
        ${open ? 'translate-x-0' : 'translate-x-full'}`}
        aria-hidden={!open}>

      {/* Header */}
      <div className="flex items-center justify-between px-5 sm:px-8 py-4 flex-shrink-0"
        style={{ background: 'linear-gradient(135deg,#14254A 0%,#FC934C 100%)' }}>
        <div className="min-w-0">
          <h2 className="text-white font-bold text-lg">Arrange your reports</h2>
          <p className="text-white/70 text-xs mt-0.5">
            Show, hide, reorder and resize the cards, charts and filters on each report.
          </p>
        </div>
        <button onClick={onClose}
          className="px-3 py-1.5 rounded-xl bg-white/20 hover:bg-white/30 text-white text-xs
            font-semibold transition-colors flex-shrink-0">
          Close
        </button>
      </div>

      {/* Which report.

          Every section this login can open, so the whole set is arranged from
          one place rather than by closing the editor, switching report and
          opening it again. */}
      {sections.length > 1 && (
        <div className="flex-shrink-0 flex flex-wrap gap-1.5 px-5 sm:px-8 py-3 border-b
          border-gray-200 bg-white dark:bg-[#1a2d55] dark:border-white/10">
          {sections.map(s => {
            const on = s.key === active
            return (
              <button key={s.key} type="button" onClick={() => switchTo(s.key)}
                className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-colors ${on
                  ? 'text-white border-transparent'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50 ' +
                    'dark:bg-white/5 dark:text-white/70 dark:border-white/15 dark:hover:bg-white/10'}`}
                style={on ? { background: NAVY } : undefined}>
                {s.label}
              </button>
            )
          })}
        </div>
      )}

      {/* Unsaved work, offered back rather than discarded silently. */}
      {pending && (
        <div className="flex-shrink-0 flex flex-wrap items-center gap-3 px-5 sm:px-8 py-2.5
          bg-amber-50 border-b border-amber-200 text-amber-800
          dark:bg-amber-500/10 dark:border-amber-400/25 dark:text-amber-200">
          <span className="text-xs font-medium">
            You have unsaved changes to this report.
          </span>
          <button type="button"
            onClick={() => { const k = pending; setPending(null); setActive(k!) }}
            className="text-xs font-bold underline underline-offset-2">
            Discard and switch
          </button>
          <button type="button" onClick={() => setPending(null)}
            className="text-xs font-semibold opacity-70 hover:opacity-100">
            Stay here
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 sm:px-8 py-5">
        {loading ? (
          <p className="text-sm text-gray-400">Reading the layout…</p>
        ) : err ? (
          <p className="text-sm text-red-600">{err}</p>
        ) : panels.length === 0 ? (
          <p className="text-sm text-gray-400">This report has nothing you can arrange.</p>
        ) : (
          /* TWO SECTIONS, side by side: the shape on the left and the
             controls on the right.

             They were stacked — the wireframe above a flat list of every panel
             — which meant the one thing the list cannot tell you (what the page
             looks like) scrolled out of view as soon as you started changing it.
             Beside each other, and with the preview pinned, every toggle is made
             while looking at what it does.

             The right-hand side is grouped BY ROW rather than run as one list,
             for the same reason: "Row 2 · 12/12 columns" is what explains why a
             panel set to a quarter has landed where it has. */
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">

            <div className="rounded-2xl border border-gray-100 dark:border-white/10
              bg-white dark:bg-[#1a2d55] p-4 xl:sticky xl:top-0">
              {/* Draggable, the same as the admin Layout tab. The arrows on
                  each control row remain: they are the precise, keyboard-
                  reachable way to step one place, and dragging is the fast way
                  to move something a long way. Neither is a substitute for the
                  other, and only one of the two works without a mouse. */}
              <LayoutPreview
                panels={panels}
                drag={{ dragKey, overKey, setDragKey, setOverKey, moveByKey }}
              />
            </div>

            <div className="space-y-3">
              {shownGrid.length === 0 && rail.length === 0 && (
                <p className="text-xs text-gray-400">Nothing on this report can be arranged.</p>
              )}

              {packedRows.map((r, i) => {
                const used = r.reduce((n, p) => n + (SPAN_COLS[p.span] ?? 6), 0)
                return (
                  <div key={`row${i}`} className="rounded-2xl border border-gray-100
                    dark:border-white/10 bg-white dark:bg-[#1a2d55] overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-1.5
                      bg-[#14254A]/[0.025] dark:bg-white/[0.03]">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                        Row {i + 1}
                      </span>
                      <span className="h-px flex-1 bg-gray-100 dark:bg-white/10" />
                      {/* Amber when a row is short: a row that does not fill its
                          twelve columns leaves a gap on the report, which is
                          legitimate and worth seeing rather than being told. */}
                      <span className={`text-[10px] font-semibold tabular-nums ${
                        used === GRID_COLS ? 'text-gray-300' : 'text-amber-600 dark:text-amber-400'}`}>
                        {used}/{GRID_COLS} columns
                      </span>
                    </div>
                    <div className="p-2 space-y-2">{r.map(row)}</div>
                  </div>
                )
              })}

              {/* Hidden panels keep their place in the order — they are one
                  save away from being back on the page — so they are listed
                  rather than dropped. */}
              {hiddenGrid.length > 0 && (
                <div className="rounded-2xl border border-gray-100 dark:border-white/10
                  bg-white dark:bg-[#1a2d55] overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5
                    bg-[#14254A]/[0.025] dark:bg-white/[0.03]">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                      Hidden
                    </span>
                    <span className="h-px flex-1 bg-gray-100 dark:bg-white/10" />
                    <span className="text-[10px] text-gray-300">not drawn on the report</span>
                  </div>
                  <div className="p-2 space-y-2">{hiddenGrid.map(row)}</div>
                </div>
              )}

              {rail.length > 0 && (
                <div className="rounded-2xl border border-gray-100 dark:border-white/10
                  bg-white dark:bg-[#1a2d55] overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5
                    bg-[#14254A]/[0.025] dark:bg-white/[0.03]">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                      Filters
                    </span>
                    <span className="h-px flex-1 bg-gray-100 dark:bg-white/10" />
                    {/* Said once: a slicer is ordered and switched on or off but
                        never given a width, because it sits in a rail rather
                        than in the grid. */}
                    <span className="text-[10px] text-gray-300">an order, but no width</span>
                  </div>
                  <div className="p-2 space-y-2">{rail.map(row)}</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {note && (
        <p className="flex-shrink-0 px-5 sm:px-8 py-2 text-xs border-t
          bg-emerald-50 border-emerald-200 text-emerald-700
          dark:bg-emerald-500/10 dark:border-emerald-400/25 dark:text-emerald-300">
          {note}
        </p>
      )}

      {/* Footer */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-3 px-5 sm:px-8 py-3
        bg-white dark:bg-[#1a2d55] border-t border-gray-200 dark:border-white/10">
        <div className="min-w-0 flex-1">
          {/* The consequence, where the button is rather than in a tooltip:
              this is not a personal view.

              Whose arrangement is in force is stated here rather than implied by
              a Reset button's enabled state, which is how it used to be read.
              That button is gone — see the note at the top of this file — and
              the fact it carried is worth keeping without it: a reader who has
              never arranged this report should know the shape is IP House's. */}
          <p className="text-[11px] text-gray-500 dark:text-white/50 leading-snug">
            Saved for your whole company — everyone who opens this report sees it.
            {!loading && !err && panels.length > 0 && (
              <> · {shownCount} of {panels.length} shown</>
            )}
            {!loading && !err && panels.length > 0 && (
              <> · {ownLayout
                ? 'Using your own arrangement'
                : 'Using the arrangement IP House set'}</>
            )}
          </p>
        </div>
        <button type="button" onClick={save} disabled={saving || loading || !!err || !dirty}
          className="px-5 py-2 rounded-xl text-xs font-bold text-white
            transition-opacity hover:opacity-90 disabled:opacity-40"
          style={{ background: NAVY }}>
          {saving ? 'Saving…' : dirty ? 'Save layout' : 'Saved'}
        </button>
      </div>
      </div>
    </>
  )
}
