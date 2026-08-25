'use client'

// Date-range picker: one control for a from/to pair.
//
// Replaces two separate DatePickers plus a row of preset pills. Three reasons
// that combination was wrong for a report filter:
//
//   - Two pickers let you set an invalid range (to < from) and only complain
//     afterwards; one control that owns both ends cannot.
//   - Choosing "the last 30 days" took a click in a pill row and then read as
//     two dates with no indication of which preset produced them.
//   - A range spanning a month boundary is hard to judge one month at a time, so
//     the calendar shows two months side by side with the span highlighted.
//
// The popover is portalled and clamped to the viewport — the same problem the
// single DatePicker had when it sat in a right-hand filter rail.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  format, parse, isValid, startOfMonth, endOfMonth, eachDayOfInterval, getDay,
  addMonths, subMonths, isSameDay, isAfter, isBefore, startOfYear,
} from 'date-fns'

export interface DateRange { from: string; to: string }   // YYYY-MM-DD

interface Props {
  value: DateRange
  onChange: (v: DateRange) => void
  /** Latest selectable day, YYYY-MM-DD. Defaults to today. */
  max?: string
  min?: string
  /**
   * The day "today" means for the quick ranges, YYYY-MM-DD. Defaults to the
   * real today. War Room passes the newest upload date it holds instead: its
   * feed can lag by days, and "the last 7 days" counted from a real today would
   * quietly resolve to a window with nothing in it.
   */
  anchor?: string
  accentColor?: string
  disabled?: boolean
  /** A shorter trigger, to sit level with compact slicers in a filter rail.
   *  The calendar panel it opens is unchanged — see SearchableSelect's own
   *  `compact` for the same reasoning. */
  compact?: boolean
}

const NAVY = '#14254A'
const PANEL_W = 620
const PANEL_H = 430
/* The list on its own, before the calendar is asked for. Height is the eight
   quick ranges plus the heading and the Custom row — enough that the panel is
   clamped to the viewport correctly on the first frame rather than jumping once
   it has rendered. */
const COMPACT_W = 210
const COMPACT_H = 350

const ymd = (d: Date) => format(d, 'yyyy-MM-dd')
const parseYMD = (s: string): Date | null => {
  if (!s) return null
  const d = parse(s, 'yyyy-MM-dd', new Date())
  return isValid(d) ? d : null
}

/* Presets. `days` is inclusive of the anchor day, matching how the reports count
   a range: 1 day is that day alone, 30 days is it plus the 29 before it.
   Every preset is a function of the anchor — normally today, but War Room hands
   in the newest day its feed actually holds (see the `anchor` prop). */
type Preset = { label: string; short: string; range: (now: Date) => DateRange }

const daysBack = (n: number, now: Date): DateRange => {
  const from = new Date(now.getTime() - (n - 1) * 86400e3)
  return { from: ymd(from), to: ymd(now) }
}

const PRESETS: Preset[] = [
  { label: 'Today',          short: '1D',  range: now => daysBack(1, now) },
  { label: 'Last 7 days',    short: '7D',  range: now => daysBack(7, now) },
  { label: 'Last 15 days',   short: '15D', range: now => daysBack(15, now) },
  { label: 'Last 30 days',   short: '30D', range: now => daysBack(30, now) },
  { label: 'Last 90 days',   short: '90D', range: now => daysBack(90, now) },
  { label: 'This month',     short: 'MTD', range: now => ({ from: ymd(startOfMonth(now)), to: ymd(now) }) },
  {
    label: 'Last month', short: 'LM',
    range: now => {
      const prev = subMonths(now, 1)
      return { from: ymd(startOfMonth(prev)), to: ymd(endOfMonth(prev)) }
    },
  },
  { label: 'This year',      short: 'YTD', range: now => ({ from: ymd(startOfYear(now)), to: ymd(now) }) },
]

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** Months since year 0 — the only sane way to compare two months for order. */
const monthNo = (d: Date) => d.getFullYear() * 12 + d.getMonth()

/*
── One calendar pane ────────────────────────────────────────────────────────

	MonthYearPicker and Month live HERE, at module scope, and take everything
	they need as props. They used to be declared inside DateRangePicker, which
	looked tidier and was a bug: a function declared in a render body is a new
	function identity on every render, React compares component types by
	identity, and a changed type is not a re-render but an unmount and a fresh
	mount.

	Hovering a day sets `hover` state for the range highlight, so the whole
	two-month grid was being torn down and rebuilt on every pointer move — and
	any state inside it went with it. That is what made the month and year menus
	unopenable: the click opened one, the pointer then crossed a day cell on its
	way to the list, and the remount closed it before it could be used.

── The month / year jump ────────────────────────────────────────────────────

	A styled menu rather than a native <select>. The native one is drawn by the
	operating system: it ignores the panel's width, corner radius, palette and
	dark mode, paints its selection in the OS accent blue, and positions itself
	wherever it likes — which, in a 620px popover, is over the calendar it is
	supposed to be navigating.

	Portalled to <body> and marked `data-drp-jump`, because the picker's own
	outside-click handler would otherwise treat a click on one of these rows as a
	click outside the panel and close the whole thing before the row was chosen.
*/
function JumpSelect({ value, options, width, accent, ariaLabel, onPick }: {
  value: number
  options: { value: number; label: string; disabled?: boolean }[]
  /** Fixed, so the caption does not reflow as the month name changes length. */
  width: number
  accent: string
  ariaLabel: string
  onPick: (v: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setRect(btnRef.current?.getBoundingClientRect() ?? null)
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return
      setOpen(false)
    }
    /* Capture, and stopped: Escape should close this menu and leave the picker
       open, which is the opposite of what the panel's own handler would do. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    /* The panel repositions itself on scroll; this menu is measured once, so it
       would be left pointing at where the button used to be. Closing is the
       honest answer — the button is still there to reopen.

       Not for the menu's OWN scroll, though: a decade of years is a scrollable
       list, and it also scrolls itself to the current value on open. Both would
       otherwise close the thing the moment it appeared. */
    const onScroll = (e: Event) => {
      if (listRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  /* Opens on the current value rather than at the top. Twelve months is a short
     list, but a decade of years is not, and scrolling to find where you already
     are is not navigation.

     The container is scrolled directly rather than with scrollIntoView, which
     centres the row in EVERY scrollable ancestor including the viewport — and
     scrolling the page out from under an open popover is worse than a list that
     opens at the top. */
  useEffect(() => {
    if (!open) return
    const box = listRef.current
    const row = box?.querySelector('[data-on="1"]') as HTMLElement | null
    if (box && row) box.scrollTop = row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2
  }, [open, rect])

  const current = options.find(o => o.value === value)
  const MENU_H = 264

  return (
    <>
      <button ref={btnRef} type="button" aria-label={ariaLabel}
        aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={`flex items-center justify-center gap-1 rounded-md px-1.5 py-0.5
          text-xs font-bold text-[#14254A] dark:text-white outline-none transition-colors
          hover:bg-[#14254A]/[0.06] dark:hover:bg-white/10 ${
          open ? 'bg-[#14254A]/[0.06] dark:bg-white/10' : ''}`}>
        <span className="truncate">{current?.label ?? value}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"
          className={`flex-shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && rect && createPortal(
        <div ref={listRef} role="listbox" aria-label={ariaLabel} data-drp-jump
          className="fixed z-[10000] rounded-xl border shadow-2xl overflow-y-auto py-1
            bg-white border-gray-200 dark:bg-[#1a2d55] dark:border-white/15"
          style={{
            width,
            maxHeight: MENU_H,
            top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - MENU_H - 8)),
            left: Math.max(8, Math.min(
              rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)),
          }}>
          {options.map(o => {
            const on = o.value === value
            return (
              <button key={o.value} type="button" role="option" aria-selected={on}
                disabled={o.disabled}
                data-on={on ? '1' : '0'}
                onClick={() => { onPick(o.value); setOpen(false) }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  on ? 'font-bold text-white'
                     : o.disabled
                       ? 'text-gray-300 dark:text-white/25 cursor-not-allowed'
                       : 'text-gray-600 dark:text-white/75 hover:bg-[#14254A]/[0.06] dark:hover:bg-white/10'
                }`}
                style={on ? { background: accent } : undefined}>
                {o.label}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}

/* Jumping straight to a month or a year. Twelve clicks on an arrow to reach
   last January is not navigation, and the caption was already sitting in the
   exact spot the control belongs. `onSet` takes the month this pane should
   land on — the right-hand pane hands back one month earlier, because the
   view state is the left pane and the right is always view + 1. Its bounds
   are shifted by the same month, so December of the last allowed year stays
   reachable on the right. */
function MonthYearPicker({ m, lo, hi, accent, onSet }: {
  m: Date; lo: Date | null; hi: Date; accent: string; onSet: (d: Date) => void
}) {
  const yearFrom = lo ? lo.getFullYear() : hi.getFullYear() - 10
  const years = Array.from({ length: hi.getFullYear() - yearFrom + 1 }, (_, i) => yearFrom + i)
  const monthOpts = MONTHS.map((name, i) => {
    const cand = new Date(m.getFullYear(), i, 1)
    /* A month outside the allowed window would land the view on a clamped
       month that is not the one clicked — better to show it as unavailable
       than to move somewhere nobody asked to go. */
    const off = monthNo(cand) > monthNo(hi) || (!!lo && monthNo(cand) < monthNo(lo))
    return { value: i, label: name, disabled: off }
  })
  return (
    <div className="flex items-center justify-center gap-0.5 mb-2">
      <JumpSelect ariaLabel="Month" value={m.getMonth()} options={monthOpts}
        width={148} accent={accent}
        onPick={i => onSet(new Date(m.getFullYear(), i, 1))} />
      <JumpSelect ariaLabel="Year" value={m.getFullYear()}
        options={years.map(y => ({ value: y, label: String(y) }))}
        width={104} accent={accent}
        onPick={y => onSet(new Date(y, m.getMonth(), 1))} />
    </div>
  )
}

/** One month's grid. The range highlight is handed in already computed, so this
    stays a pure function of its props and never re-mounts its children. */
function Month({ m, lo, hi, accent, onSet, days, dayState, onPick, onHover }: {
  m: Date; lo: Date | null; hi: Date; accent: string
  onSet: (d: Date) => void
  days: (m: Date) => Date[]
  dayState: (d: Date) => { isStart: boolean; isEnd: boolean; within: boolean; off: boolean }
  onPick: (d: Date) => void
  onHover: (s: string) => void
}) {
  const offset = getDay(startOfMonth(m))
  return (
    <div className="flex-1 min-w-0">
      <MonthYearPicker m={m} lo={lo} hi={hi} accent={accent} onSet={onSet} />
      <div className="grid grid-cols-7">
        {WEEKDAYS.map(d => (
          <div key={d} className="text-center text-[10px] font-bold uppercase text-gray-400 pb-1">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {Array.from({ length: offset }).map((_, i) => <div key={`p${i}`} />)}
        {days(m).map(d => {
          const s = ymd(d)
          const { isStart, isEnd, within, off } = dayState(d)
          return (
            <button key={s} type="button" disabled={off}
              onClick={() => onPick(d)}
              onMouseEnter={() => onHover(s)}
              className={`h-8 text-xs font-medium transition-colors relative
                ${off ? 'opacity-25 cursor-not-allowed' : 'cursor-pointer'}
                ${within ? 'bg-[#14254A]/[0.08] dark:bg-white/10' : ''}
                ${isStart ? 'rounded-l-lg' : ''} ${isEnd ? 'rounded-r-lg' : ''}
                ${isStart || isEnd ? 'text-white font-bold' : 'text-gray-700 dark:text-white/80'}
                ${!within && !isStart && !isEnd && !off ? 'hover:bg-[#14254A]/[0.06] dark:hover:bg-white/[0.08] rounded-lg' : ''}`}
              style={isStart || isEnd ? { background: accent } : undefined}>
              {format(d, 'd')}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function DateRangePicker({
  value, onChange, max, min, anchor, accentColor = NAVY, disabled = false, compact = false,
}: Props) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  // Draft range, so a half-made selection never leaks out to the report and
  // trigger a query for a nonsense window.
  const [draft, setDraft] = useState<DateRange>(value)
  const [hover, setHover] = useState<string>('')
  const [view, setView] = useState<Date>(parseYMD(value.from) ?? new Date())
  /* The calendar is the SECOND step, not the first. Nearly every use of this
     control is "last 30 days" — one click on a list — and putting two months of
     day cells in front of that asks the reader to find the one row they wanted
     inside a 620px popover. So the panel opens as the list alone and grows into
     the calendar only when someone asks for a custom range.

     It does open on the calendar when a custom range is already in force: the
     value in the box came from those two months, and hiding them would mean
     opening the control that set it and not being shown what it is set to. */
  const [showCalendar, setShowCalendar] = useState(false)

  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setMounted(true) }, [])
  useEffect(() => { if (!open) setDraft(value) }, [value, open])

  const maxDate = parseYMD(max || '') ?? new Date()
  const minDate = parseYMD(min || '')

  const panelW = showCalendar ? PANEL_W : COMPACT_W
  const panelH = showCalendar ? PANEL_H : COMPACT_H

  /* Sized from the arguments rather than from state, because the first call
     happens in the click that opens the panel — before the state that decides
     which size it is has been committed, so reading it there would place the
     panel using the previous opening's dimensions. */
  function place(w = panelW, h = panelH) {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    const m = 8
    let left = r.left
    if (left + w + m > window.innerWidth) left = r.right - w
    left = Math.max(m, Math.min(left, window.innerWidth - w - m))
    let top = r.bottom + 6
    if (top + h > window.innerHeight && r.top - h - 6 > 0) top = r.top - h - 6
    top = Math.max(m, Math.min(top, Math.max(m, window.innerHeight - h - m)))
    setPos({ top, left })
  }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      /* The month and year menus are portalled to <body>, so they are outside
         the panel in the DOM while being very much inside it on screen. Without
         this, mousedown on "March" would close the picker before the click that
         chose March ever landed. */
      if ((t as Element)?.closest?.('[data-drp-jump]')) return
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // Wrapped rather than passed directly: the listener is handed an Event, and
    // place's first parameter is a width.
    const replace = () => place()
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', replace, true)
    window.addEventListener('resize', replace)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', replace, true)
      window.removeEventListener('resize', replace)
    }
    // showCalendar is a dependency because the panel's size changes with it, and
    // a scroll handler closed over the old size would re-place it wrongly.
  }, [open, showCalendar])

  /* What the quick ranges count back from. `max` is a ceiling on the days that
     may be clicked; the anchor is where "the last 7 days" starts counting. They
     are usually the same day and default to today, but they are not the same
     idea, so they are separate props. */
  const anchorDate = parseYMD(anchor || '') ?? new Date()

  /** Which preset the current value equals, so the list shows what is in force. */
  const activePreset = useMemo(() => {
    for (const p of PRESETS) {
      const r = p.range(anchorDate)
      if (r.from === value.from && r.to === value.to) return p.label
    }
    return ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, anchor])

  const fromD = parseYMD(draft.from)
  const toD = parseYMD(draft.to)
  const hoverD = parseYMD(hover)

  function pickDay(day: Date) {
    const s = ymd(day)
    // First click, or a click before the open end, starts a new range.
    if (!fromD || (fromD && toD) || isBefore(day, fromD)) {
      setDraft({ from: s, to: '' })
      return
    }
    setDraft({ from: draft.from, to: s })
  }

  function apply() {
    const f = draft.from
    // A single click leaves `to` empty; treat that as a one-day range rather than
    // sending a half-open window.
    const t = draft.to || draft.from
    if (!f) return
    onChange({ from: f, to: t })
    setOpen(false)
  }

  /*
  A preset is bounded by the same limits as a click.

  The quick ranges are a function of the anchor alone, so "Last 90 days" over a
  one-month window used to hand back sixty days its own calendar greys out — a
  range the caller then has to clamp, or display as chosen when it was not. The
  day grid has always refused those days; this makes the list beside it agree.

  Clamped rather than hidden, so the list does not change shape with the limits
  and every preset keeps meaning "as much of this as there is".
  */
  function clampToLimits(r: DateRange): DateRange {
    const lo = min && r.from < min ? min : r.from
    const hi = max && r.to > max ? max : r.to
    // A preset entirely outside the limits collapses onto the nearest edge
    // rather than inverting, which BETWEEN would answer with silence.
    return { from: lo > hi ? hi : lo, to: hi }
  }

  function usePreset(p: Preset) {
    const r = clampToLimits(p.range(anchorDate))
    setDraft(r)
    onChange(r)
    setView(parseYMD(r.from) ?? new Date())
    setOpen(false)
  }

  const disabledDay = (d: Date) =>
    (minDate && isBefore(d, minDate)) || (maxDate && isAfter(d, maxDate))

  /** In-range for the highlight, using the hovered day while a range is open. */
  function inRange(d: Date) {
    if (!fromD) return false
    const end = toD ?? (hoverD && isAfter(hoverD, fromD) ? hoverD : null)
    if (!end) return false
    return !isBefore(d, fromD) && !isAfter(d, end)
  }

  /* Everything a day cell needs to draw itself, resolved here where the draft
     and the hover live. Passing this down rather than the four pieces of state
     keeps Month a plain function of its props — see the note at the top of it. */
  const dayState = (d: Date) => {
    const isStart = !!fromD && isSameDay(d, fromD)
    const isEnd = !!toD && isSameDay(d, toD)
    return { isStart, isEnd, within: inRange(d) && !isStart && !isEnd, off: !!disabledDay(d) }
  }

  const label = (() => {
    const f = parseYMD(value.from)
    const t = parseYMD(value.to)
    if (!f) return 'Select a date range'
    const fs = format(f, 'd MMM yyyy')
    if (!t || isSameDay(f, t)) return fs
    return `${fs} – ${format(t, 'd MMM yyyy')}`
  })()

  const days = (m: Date) => eachDayOfInterval({ start: startOfMonth(m), end: endOfMonth(m) })

  /* Where the left-hand month is allowed to sit. Paging is bounded by the same
     limits as the days themselves, so the arrows and the dropdowns cannot walk
     off into years that hold nothing selectable. */
  const viewLo = minDate ? startOfMonth(minDate) : null
  const viewHi = startOfMonth(maxDate)
  const clampView = (d: Date) => {
    let v = startOfMonth(d)
    if (monthNo(v) > monthNo(viewHi)) v = viewHi
    if (viewLo && monthNo(v) < monthNo(viewLo)) v = viewLo
    return v
  }
  const goto = (d: Date) => setView(clampView(d))

  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={disabled}
        onClick={() => {
          if (disabled) return
          if (!open) {
            // Open on the month the range starts in, not wherever it was left
            // paged to three openings ago.
            setView(clampView(parseYMD(value.from) ?? maxDate))
            /* A range that matches no quick range came from the calendar, so the
               calendar is what to show. One that matches a preset opens as the
               list. */
            const custom = !activePreset
            setShowCalendar(custom)
            place(custom ? PANEL_W : COMPACT_W, custom ? PANEL_H : COMPACT_H)
          }
          setOpen(o => !o)
        }}
        className={`w-full flex items-center gap-2 text-left border transition-colors ${
          compact ? 'rounded-[0.625rem] px-2.5 h-8 text-[12.5px]' : 'rounded-xl px-3 py-2.5 text-sm'}
          bg-white dark:bg-white/5
          ${disabled ? 'opacity-50 cursor-not-allowed border-gray-200 dark:border-white/10'
                     : 'border-gray-200 hover:border-gray-300 dark:border-white/15 dark:hover:border-white/25 cursor-pointer'}
          ${open ? 'ring-2 border-transparent' : ''}`}
        style={open ? ({ '--tw-ring-color': accentColor } as React.CSSProperties) : {}}>
        <svg className="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24"
          stroke="currentColor" strokeWidth={1.8}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        <span className="flex-1 truncate text-[#14254A] dark:text-white">{label}</span>
        {activePreset && (
          <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md flex-shrink-0
            bg-[#14254A]/[0.07] text-[#14254A]/70 dark:bg-white/10 dark:text-white/60">
            {PRESETS.find(p => p.label === activePreset)?.short}
          </span>
        )}
      </button>

      {open && mounted && pos && createPortal(
        <div ref={panelRef}
          className="fixed z-[9999] rounded-2xl shadow-2xl overflow-hidden flex
            bg-white border border-gray-100 dark:bg-[#1a2d55] dark:border-white/10"
          style={{ top: pos.top, left: pos.left, width: panelW }}>

          {/* Presets rail. Its own borders and tint only apply once there is a
              calendar beside it — on its own it IS the panel, and a divider down
              the right of a 210px popover divides it from nothing. */}
          <div className={`flex-shrink-0 p-2 space-y-0.5 ${showCalendar
            ? 'w-[152px] border-r border-gray-100 dark:border-white/10 bg-[#14254A]/[0.02] dark:bg-white/[0.02]'
            : 'w-full'}`}>
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 px-2 py-1.5">
              Quick ranges
            </p>
            {PRESETS.map(p => {
              /* Nothing in the list is marked while the calendar is open: the
                 answer then is whatever is being built in it, and leaving a
                 preset lit would say the range in force is still that one. */
              const on = !showCalendar && activePreset === p.label
              return (
                <button key={p.label} type="button" onClick={() => usePreset(p)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    on ? 'font-bold text-white' : 'font-medium text-gray-600 hover:bg-[#14254A]/[0.06] dark:text-white/70 dark:hover:bg-white/10'
                  }`}
                  style={on ? { background: accentColor } : undefined}>
                  {p.label}
                </button>
              )
            })}

            {/* Custom range — the way into the calendar, and the only control
                here that does not close the panel. */}
            <div className="pt-1 mt-1 border-t border-gray-100 dark:border-white/10">
              <button type="button"
                aria-expanded={showCalendar}
                onClick={() => {
                  if (showCalendar) return
                  setShowCalendar(true)
                  // Placed for the size it is about to become; the state has not
                  // committed yet, so the dimensions are passed explicitly.
                  place(PANEL_W, PANEL_H)
                }}
                className={`w-full flex items-center gap-1.5 text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                  showCalendar
                    ? 'font-bold text-white'
                    : 'font-medium text-gray-600 hover:bg-[#14254A]/[0.06] dark:text-white/70 dark:hover:bg-white/10'
                }`}
                style={showCalendar ? { background: accentColor } : undefined}>
                <span className="flex-1">Custom range</span>
                {!showCalendar && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"
                    className="flex-shrink-0 text-gray-400">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Two-month calendar */}
          {showCalendar && (
          <div className="flex-1 min-w-0 p-3">
            <div className="flex items-center justify-between mb-2">
              <button type="button" onClick={() => goto(subMonths(view, 1))}
                disabled={!!viewLo && monthNo(view) <= monthNo(viewLo)}
                aria-label="Previous month"
                className="w-7 h-7 grid place-items-center rounded-lg text-gray-400
                  hover:bg-[#14254A]/[0.06] hover:text-[#14254A] dark:hover:bg-white/10 dark:hover:text-white
                  disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M15 19l-7-7 7-7" /></svg>
              </button>
              <span className="text-[11px] font-semibold text-gray-400">
                {draft.from ? format(parseYMD(draft.from)!, 'd MMM yyyy') : 'Pick a start'}
                {' – '}
                {draft.to ? format(parseYMD(draft.to)!, 'd MMM yyyy') : 'pick an end'}
              </span>
              <button type="button" onClick={() => goto(addMonths(view, 1))}
                disabled={monthNo(view) >= monthNo(viewHi)}
                aria-label="Next month"
                className="w-7 h-7 grid place-items-center rounded-lg text-gray-400
                  hover:bg-[#14254A]/[0.06] hover:text-[#14254A] dark:hover:bg-white/10 dark:hover:text-white
                  disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>

            <div className="flex gap-4" onMouseLeave={() => setHover('')}>
              <Month m={view} lo={viewLo} hi={viewHi} onSet={goto}
                accent={accentColor} days={days} dayState={dayState}
                onPick={pickDay} onHover={setHover} />
              <Month m={addMonths(view, 1)}
                lo={viewLo ? addMonths(viewLo, 1) : null} hi={addMonths(viewHi, 1)}
                onSet={d => goto(subMonths(d, 1))}
                accent={accentColor} days={days} dayState={dayState}
                onPick={pickDay} onHover={setHover} />
            </div>

            <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t
              border-gray-100 dark:border-white/10">
              <button type="button" onClick={() => setOpen(false)}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold border
                  border-gray-200 text-gray-600 hover:bg-gray-50
                  dark:border-white/15 dark:text-white/70 dark:hover:bg-white/10">
                Cancel
              </button>
              <button type="button" onClick={apply} disabled={!draft.from}
                className="px-4 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-40"
                style={{ background: accentColor }}>
                Apply
              </button>
            </div>
          </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
