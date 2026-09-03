'use client'

/**
 * The report's shape, as a wireframe.
 *
 * A list of toggles says WHAT is on a report; it cannot say what the report
 * looks like. Two panels set to Half sit side by side, three Thirds make a row,
 * and a Full one after two Halves starts a new row — none of which is visible
 * from a column of switches. So this draws the page: the grid on the left at the
 * widths the panels actually carry, and the slicer rail beside it.
 *
 * ── Why this is one component and not two ────────────────────────────────────
 *
 * The same wireframe is wanted in two places: the admin Layout tab, where the
 * shared arrangement is configured, and the "Arrange your reports" panel a
 * reader opens on the report itself.
 *
 * It is shared rather than copied because of packRows. That function has to
 * pack panels the way the report's CSS grid packs them, and a second copy would
 * be a second thing to keep in step with the real grid. A preview that packs
 * differently from the page does not merely look wrong — it tells the reader
 * their arrangement is something it is not, which is worse than showing no
 * preview at all.
 *
 * Presentational. It holds no state, saves nothing and decides nothing about
 * what a panel is; the drag handlers are optional props, so the reader's panel
 * can render exactly the same picture read-only while the admin screen wires
 * reordering into its own state.
 */

export type PreviewSpan = 'full' | 'half' | 'third' | 'quarter'

/** What the preview needs of a panel, and nothing more. Both callers have a
 *  richer type; this is the subset the wireframe reads, so neither has to
 *  convert and neither can pass the wrong thing. */
export interface PreviewPanel {
  key: string
  kind: 'tile' | 'heading' | 'trend' | 'rate' | 'dim' | 'filter'
  name: string
  /** The reader's own label for it, where one has been set. */
  title?: string
  span: PreviewSpan
  hidden?: boolean
}

export const GRID_COLS = 12
export const SPAN_COLS: Record<PreviewSpan, number> = {
  full: 12, half: 6, third: 4, quarter: 3,
}

/**
 * Pack panels into rows, the way the CSS grid will.
 *
 * Twelve columns, filled left to right; a panel that will not fit in what is
 * left of a row starts the next one. This is the whole reason the preview can
 * be trusted — it is the grid's own arithmetic rather than a guess at it.
 */
export function packRows<T extends { span: PreviewSpan }>(panels: T[]): T[][] {
  const rows: T[][] = []
  let row: T[] = []
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

/** Optional reordering. Supplied by the admin screen; omitted by the reader's
 *  panel, which shows the shape without offering to rearrange it by drag. */
export interface PreviewDrag {
  dragKey: string
  overKey: string
  setDragKey: (k: string) => void
  setOverKey: (k: string | ((cur: string) => string)) => void
  /** Move the panel with key `from` to where `to` currently sits. */
  moveByKey: (from: string, to: string) => void
}

export default function LayoutPreview({
  panels, drag, className = '',
}: {
  /** Every panel on the report, hidden ones included — they are filtered here
   *  so a caller cannot forget to and draw a page nobody sees. */
  panels: PreviewPanel[]
  drag?: PreviewDrag
  className?: string
}) {
  const shown = panels.filter(p => !p.hidden)
  const gridPanels = shown.filter(p => p.kind !== 'filter')
  const panePanels = shown.filter(p => p.kind === 'filter')
  const rows = packRows(gridPanels)

  const draggable = !!drag

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-[13px] font-bold text-[#14254A] dark:text-white">
          Preview
          <span className="ml-2 font-normal text-[10px] text-gray-400">
            {draggable ? 'drag a panel to move it' : 'how this report is laid out'}
          </span>
        </h3>
        <span className="text-[10px] text-gray-400">
          {gridPanels.filter(p => p.kind === 'tile').length} KPI cards ·{' '}
          {gridPanels.filter(p => p.kind === 'dim').length} charts ·{' '}
          {rows.length} rows · {panePanels.length} filters
        </span>
      </div>

      {/* The grid and the rail beside it, laid out the way the report lays them
          out — the charts take the width and the slicers sit down one narrow
          column to their right. Drawing the pane as a list under the grid would
          say it was part of the page flow, which is the one thing about it that
          is not true. */}
      <div className="flex gap-2 items-start">
        <div className="flex-1 min-w-0 space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-12 gap-1.5">
              {row.map(p => (
                <div key={p.key}
                  draggable={draggable}
                  onDragStart={draggable ? e => {
                    drag!.setDragKey(p.key)
                    e.dataTransfer.effectAllowed = 'move'
                    // Firefox will not start a drag without payload.
                    e.dataTransfer.setData('text/plain', p.key)
                  } : undefined}
                  onDragOver={draggable ? e => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    drag!.setOverKey(p.key)
                  } : undefined}
                  onDragLeave={draggable
                    ? () => drag!.setOverKey(cur => cur === p.key ? '' : cur)
                    : undefined}
                  onDrop={draggable ? e => {
                    e.preventDefault()
                    const from = drag!.dragKey || e.dataTransfer.getData('text/plain')
                    if (from) drag!.moveByKey(from, p.key)
                    drag!.setDragKey(''); drag!.setOverKey('')
                  } : undefined}
                  onDragEnd={draggable
                    ? () => { drag!.setDragKey(''); drag!.setOverKey('') }
                    : undefined}
                  className={`rounded-md px-2 py-2 text-[10px] font-semibold truncate border
                    select-none transition-all ${draggable ? 'cursor-move' : ''}
                    ${p.kind === 'heading'
                      ? 'bg-[#14254A]/[0.04] border-dashed border-[#14254A]/20 text-[#14254A]/60 dark:bg-white/[0.04] dark:border-white/20 dark:text-white/50'
                      : p.kind === 'tile'
                        ? 'bg-[#14254A]/[0.07] border-[#14254A]/20 text-[#14254A] dark:bg-white/10 dark:border-white/20 dark:text-white/80'
                        : 'bg-[#FC934C]/10 border-[#FC934C]/30 text-[#c2691f] dark:text-[#FDBE94]'}
                    ${drag?.dragKey === p.key ? 'opacity-35' : ''}
                    ${drag && drag.overKey === p.key && drag.dragKey && drag.dragKey !== p.key
                      ? 'ring-2 ring-[#FC934C] ring-offset-1 dark:ring-offset-[#1a2d55]' : ''}`}
                  style={{ gridColumn: `span ${SPAN_COLS[p.span]} / span ${SPAN_COLS[p.span]}` }}
                  title={draggable ? `${p.title || p.name} — drag to move` : (p.title || p.name)}>
                  {p.title || p.name}
                </div>
              ))}
            </div>
          ))}
          {rows.length === 0 && (
            <p className="text-[10px] text-gray-400 leading-snug py-4 text-center">
              Every panel is hidden — this report would draw nothing but its filters.
            </p>
          )}
        </div>

        {/* The pane. Narrow on purpose: it is the shape of the thing, and a
            filter list as wide as the charts would read as another column of the
            report. */}
        <div className="w-[104px] flex-shrink-0 rounded-lg border border-gray-100 dark:border-white/10
          bg-[#14254A]/[0.02] dark:bg-white/[0.02] p-1.5 space-y-1">
          <p className="text-[8px] font-bold uppercase tracking-widest text-gray-400 px-1 pb-0.5">
            Filters
          </p>
          {/* Always there, and shown as such: a report cannot be run without a
              window, so it is not in the list below either. */}
          <div className="rounded-md px-1.5 py-1.5 text-[9px] font-semibold border border-dashed
            border-gray-200 text-gray-400 dark:border-white/15 dark:text-white/35">
            Date range
          </div>
          {panePanels.map(p => (
            <div key={p.key}
              className="rounded-md px-1.5 py-1.5 text-[9px] font-semibold truncate border
                bg-sky-50 border-sky-200 text-sky-800
                dark:bg-sky-400/10 dark:border-sky-400/25 dark:text-sky-200"
              title={p.title || p.name}>
              {p.title || p.name}
            </div>
          ))}
          {panePanels.length === 0 && (
            <p className="text-[9px] text-gray-400 px-1 leading-snug">
              Date range only
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
