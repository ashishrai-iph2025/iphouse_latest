'use client'

/*
 * The programme calendar — the client's own titles, on the dates
 * mediascan.Asset records, in a month grid you can actually read.
 *
 * ── What the categories ARE ──────────────────────────────────────────────────
 *
 * Genre and SubGenre, as the asset master serves them: Sports, Movies,
 * Television, Originals at the top level; NPC, Web Series, Wrestling and the
 * rest beneath. They are real columns, sourced from mediascan.AssetGenre, and
 * they are what this calendar colours by.
 *
 * That is a correction. An earlier version invented its own two-way split —
 * "NPC" for a title carrying a ReleaseDate, "Live" for one without — on the
 * reasoning that no column classified a title. One does. Worse, the invented
 * label collided with a real value: NPC is a SubGenre in the feed, so a wrestling
 * fixture that happened to carry a release date was labelled NPC by a rule that
 * had never looked at its genre. A derived label that contradicts a stored one
 * is worse than no label, so the derivation is gone and the columns are read.
 *
 * The date distinction it was standing in for is kept, because that part was
 * real — a title is placed by its StartDate where it has one and by its
 * ReleaseDate where it does not. What is gone is the business meaning that was
 * being read into it.
 *
 * WHERE THAT IS SAID is the detail card and nowhere else. It rode on every row
 * of the day panel as "starts" or "released", which is a fact about which COLUMN
 * placed the title rather than about the title, and on a day holding five of
 * them it was the same word five times under a heading that already named the
 * day. The card is where a reader has asked about one title and it can be put in
 * words — "placed on its release date" — instead of abbreviated to a verb.
 *
 * ── Two traps in the feed, both load-bearing ─────────────────────────────────
 *
 * MatchDay is NOT a date — it holds "Matchday 4", "Matchday 26", "-" — and V8
 * turns `new Date("Matchday 4")` into 4 January 2001 rather than an Invalid
 * Date. Reading it as a date papered the grid with phantom 2001 fixtures. Hence
 * ISO_DAY: a column that is not a date must read as absent, never as a wrong day.
 *
 * IsWarRoom was 0 on every row of all 1,657 DAZN titles when this was first
 * measured, which is why it went unread for a while. It is read now — as a FLAG
 * rather than a category, see WAR_ROOM below — and the legend states its count
 * even when that count is nought, because "no War Room titles" and "the calendar
 * does not know about War Room" are different answers and only one of them is a
 * reason to go and look at the data.
 *
 * ── Why a title sits on ONE day ──────────────────────────────────────────────
 *
 * A booking can run for YEARS — "Snooker of DAZN" is booked 2024 to 2032 — so
 * drawing a title on every day of its window would fill every cell of every
 * month between with one title. It is placed on the day it STARTS, and the
 * window it opens is printed on the chip and in the day panel. That is also what
 * makes the grid legible at a glance: a cell's chips are things that BEGIN that
 * day, not things that happen to overlap it.
 *
 * ── Colour ───────────────────────────────────────────────────────────────────
 *
 * By the most specific category a title carries — its sub-genre where it has
 * one, its genre where it does not. Colouring by genre alone was tried and the
 * data rules it out: 1,650 of DAZN's 1,658 titles are Sports, so the whole
 * calendar came out one colour. The sub-genre is where the variety actually is.
 *
 * Eight hues, in a fixed order, from a palette validated against both this
 * card's surfaces (white, and #1a2d55 in dark mode) for colour-vision
 * separation. A ninth category is never given a generated hue: it keeps its NAME
 * and wears a neutral, which says "past the point where colour can tell these
 * apart" instead of quietly reusing a hue that already means something else.
 * Every chip carries its title as visible text and every swatch is named in the
 * legend, so identity is never colour alone.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

const NAVY = '#14254A'
const ORANGE = '#FC934C'

export type AssetRow = {
  Id?: string
  AssetName?: string
  StartDate?: string | null
  EndDate?: string | null
  ReleaseDate?: string | null
  MatchDay?: string | null
  FranchiseName?: string | null
  IMDBId?: string | null
  IsExclusive?: number | boolean | null
  IsGlobal?: number | boolean | null
  IsCountrySpecific?: number | boolean | null
  /* Whether the title is a War Room asset. A FLAG, not a category: it cuts
     across genre rather than sitting inside it, so it is drawn as a mark on the
     chip and never as a colour of its own — see the note on WAR_ROOM. */
  IsWarRoom?: number | boolean | null
  /* Genre and sub-genre are SETS, comma-separated, from mediascan.AssetGenre —
     an asset can carry several of each. They arrive already resolved to names
     by reports_api; see the note on splitSet for what that costs to read. */
  Genre?: string | null
  GenreMSId?: string | null
  SubGenre?: string | null
  SubGenreMSId?: string | null
}

type State = 'upcoming' | 'running' | 'past'
/** Which column put the title on this day. `start` is a coverage window opening;
 *  `release` is a release date, used only where there is no StartDate to use. */
type Anchor = 'start' | 'release'

type Occ = {
  a: AssetRow
  anchor: Anchor
  /** The day it is drawn on. */
  day: number
  /** The end of its window, or `day` where it has none. */
  end: number
  state: State
  /** The category that colours it — see catOf. */
  cat: string
  /** A War Room title — marked, never coloured. See WAR_ROOM. */
  war: boolean
}

/* A date column is only read when it actually LOOKS like one — see the header
   note on MatchDay. Requiring a leading yyyy-mm-dd means a column that is not a
   date reads as absent instead of as the wrong day. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/
const DAY = 86400000

/* Dates arrive as RFC3339 at UTC midnight. Reading them with the LOCAL calendar
   would move a date across the boundary for anyone west of UTC, so the day is
   taken from the UTC parts and compared as a UTC-midnight stamp. */
function toDay(s?: string | null): number | null {
  if (!s || !ISO_DAY.test(String(s).trim())) return null
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

const addMonths = (ts: number, n: number) => {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)
}
const startOfMonth = (ts: number) => {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
const sameMonth = (a: number, b: number) =>
  new Date(a).getUTCFullYear() === new Date(b).getUTCFullYear() &&
  new Date(a).getUTCMonth() === new Date(b).getUTCMonth()

const fmtDay = (ts: number | null) =>
  ts === null ? '—'
    : new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const fmtDayLong = (ts: number) =>
  new Date(ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthLabel = (ts: number) =>
  new Date(ts).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

const nowDay = () => {
  const n = new Date()
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1'

/*
── Fitting the month on the screen, whatever the screen is ──────────────────

	The calendar is a SINGLE VIEW: a month taken in at a glance, with no
	scrollbar inside it. That is a height the component cannot know statically —
	it sits under a greeting, inside two different shells, on whatever display
	the reader has — so a fixed `100dvh` would be wrong by exactly the height of
	everything above it, and a hand-tuned `calc()` would be wrong the day that
	chrome changed.

	So it is measured: where the card's top edge actually is, how tall the
	viewport actually is, less whatever the page keeps BELOW the card. Every row
	below then divides what is left rather than claiming a fixed number of
	pixels, which is what makes one rule cover a laptop, a 4K monitor and a
	half-height browser window without a breakpoint for any of them.

	The gutter below is measured too, and that was a real bug rather than a
	refinement. It used to be the constant 18. The welcome page's container is
	`py-4 sm:py-6`, so the true gutter is 16 on a phone and 24 from `sm` up — and
	at 24 the page overflowed by exactly 24 − 18 = 6px. Six pixels is a
	scrollbar: the calendar fitted and the SCREEN did not, which is the whole
	thing this was for. A constant cannot be right at two breakpoints, so it is
	read off the layout instead — see spaceBelow.

	FLOORED rather than trusted all the way down. Below the floor the PAGE
	scrolls instead: a month squeezed into two hundred pixels is not a calendar,
	and asking the reader to scroll the page is a better answer than showing
	them one.
*/
/* The floor is what a month needs to still BE one: the card's own chrome, plus
   enough grid for every cell to carry a date and at least one title. Measured
   from the parts — header ~64, legend ceiling 96, month heading ~26, weekday row
   ~22, padding ~40, and 6 weeks × 52 — rather than picked, because picking it is
   how you get a calendar that technically fits and shows nothing. */
const FIT_FLOOR = 560

/*
spaceBelow is the page's own GUTTER under this element — not everything under it.

Walked rather than guessed, because the answer changes with the breakpoint: the
welcome page's container is `py-4 sm:py-6`, so the gutter is 16 on a phone and 24
from `sm` up. Hard-coded at 18 it overflowed the viewport by exactly 24 − 18 = 6
pixels, which is a scrollbar.

WHAT IT DELIBERATELY DOES NOT COUNT: siblings drawn after the card. The first
version of this added them, and on the welcome page — where the calendar is the
first element and the week's figures sit below it — that subtracted the whole
figures block from the calendar's height and collapsed it to the floor. The
harness could not show it, because the harness has nothing after the card.

The distinction is the requirement itself. The CALENDAR is what has to fit one
screen; content below it is below the fold and is reached by scrolling the page.
Counting it would be sizing the card to fit the whole document, which is a
different and much smaller card.

Rounded UP: a fractional pixel left over is a scrollbar, a fractional pixel
unused is invisible.
*/
function spaceBelow(el: HTMLElement): number {
  let total = 0
  let node: HTMLElement | null = el
  while (node && node.parentElement && node !== document.body) {
    total += parseFloat(getComputedStyle(node.parentElement).paddingBottom) || 0
    node = node.parentElement
  }
  return Math.ceil(total)
}

function useFitHeight(ref: React.RefObject<HTMLElement | null>, deps: unknown[]): number | undefined {
  const [h, setH] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const measure = () => {
      const el = ref.current
      if (!el) return
      const top = el.getBoundingClientRect().top
      setH(Math.max(FIT_FLOOR, window.innerHeight - top - spaceBelow(el)))
    }
    measure()
    window.addEventListener('resize', measure)
    /* Deliberately NOT on scroll, and not on a body observer. The card's top
       only moves when the page above it changes — which is what `deps` covers —
       and re-measuring while the reader scrolls would resize the calendar under
       their hands. A body observer would additionally feed its own writes back
       in, since setting this height is itself a body resize. */
    return () => window.removeEventListener('resize', measure)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return h
}

/* What one cell spends on things that are not chips, and what a chip row costs.
   Used to work out how many titles a cell can actually hold at the height the
   screen gave it — the alternative is a hardcoded three, which is too many on a
   short window and wastes half the cell on a tall one.

   MEASURED, not estimated: a rendered cell is 6px of padding top and bottom, an
   11.5px date row and a 4px gap before the first chip (27.5, rounded up), and a
   chip is 19.1px plus the same 4px gap (23.1, rounded up). Rounding UP on both
   is deliberate — a cap one too low leaves a sliver of empty cell, a cap one too
   high clips a title in half, and only one of those is a bug you can see. */
const CELL_CHROME = 28
const CHIP_ROW = 24

/* Genre and sub-genre come back as ONE STRING holding a comma-separated set,
   because an asset can be in several — every tagged ESA title is in Console,
   PC and Mobile Games at once. Split, trimmed, de-duplicated and SORTED here:
   sorted because the first element decides a title's colour, and an order that
   depended on how the warehouse happened to concatenate the set would repaint
   the calendar on a re-import that changed nothing. */
function splitSet(v?: string | null): string[] {
  if (!v) return []
  const seen = new Set<string>()
  for (const part of String(v).split(',')) {
    const t = part.trim()
    if (t) seen.add(t)
  }
  return Array.from(seen).sort()
}

/* What a title with no genre at all is filed under.

   Named rather than dropped: a client whose tagging is incomplete would
   otherwise see a legend whose counts do not add up to the number of titles
   above it, with nothing to say where the rest went. */
const UNTAGGED = 'Not categorised'

/*
── War Room, and why it is a MARK rather than a hue ─────────────────────────

	IsWarRoom cuts ACROSS the categories rather than sitting among them: a War
	Room title is still Wrestling, still Web Series, still whatever its genre
	says. Giving it one of the eight hues would force a choice between showing
	what a title IS and showing that it is being tracked, and a reader would have
	to give up one to see the other.

	So it is a second stripe on the chip, beside the category's own — the
	data-viz rule for exactly this case: an independent fact gets an independent
	channel, never a stolen one. A chip can therefore say "Wrestling, and in the
	War Room" at a glance, and the legend can filter on either without the two
	interfering.
*/
const WAR_ROOM = 'War Room'
const isWarRoom = (a: AssetRow) => truthy(a.IsWarRoom)

/**
 * The category a title is COLOURED by: its sub-genre where it has one, its
 * genre where it does not.
 *
 * The sub-genre is preferred because that is where the variety is. A broadcaster
 * is Sports almost to the row — colouring by genre paints the whole calendar one
 * colour and says nothing — while its sub-genres are Wrestling, Football, Boxing
 * and the rest, which is the distinction somebody scanning a month is making.
 */
const catOf = (a: AssetRow): string =>
  splitSet(a.SubGenre)[0] ?? splitSet(a.Genre)[0] ?? UNTAGGED

/**
 * The eight categorical hues, in the order they are handed out.
 *
 * From a palette validated with the data-viz validator against BOTH of this
 * card's surfaces — white in light mode, #1a2d55 in dark — for lightness band,
 * chroma, colour-vision separation and normal-vision separation. The dark column
 * is the same eight hues re-stepped for the dark ground, not an automatic flip.
 *
 * The contrast check returns a relief on three light slots and one dark one:
 * legal because identity here is never colour alone — every chip carries its
 * title as visible text and every swatch is named in the legend beside it.
 *
 * ORDER IS THE SAFETY MECHANISM. These are adjacent-pair validated, so they must
 * be handed out in this sequence and never cycled: a ninth category folds into
 * OTHER rather than reusing slot 1, because two categories sharing a hue on one
 * screen is a calendar that lies about what is on it.
 */
const HUES = [
  { light: '#2a78d6', dark: '#3987e5' },
  { light: '#eb6834', dark: '#d95926' },
  { light: '#1baf7a', dark: '#199e70' },
  { light: '#eda100', dark: '#c98500' },
  { light: '#e87ba4', dark: '#d55181' },
  { light: '#008300', dark: '#008300' },
  { light: '#4a3aa7', dark: '#9085e9' },
  { light: '#e34948', dark: '#e66767' },
]
/** The neutral OTHER and UNTAGGED wear — deliberately not one of the eight, so
    "everything else" can never be mistaken for a category of its own. */
const NEUTRAL = { light: '#6b7a90', dark: '#93a3ba' }

/**
 * The stylesheet the card runs on: one custom property per category slot, in
 * both modes.
 *
 * Built as variables rather than inline hex for the reason the previous version
 * already recorded — an inline style cannot carry a `dark:` variant, and a mark
 * that is legible on white can be invisible on navy. A variable with a `.dark`
 * override lets one rule resolve correctly on both grounds.
 *
 * `-t` is the chip's fill: the same hue at low alpha, so the chip reads as its
 * category while its TEXT stays in ink and keeps its own contrast. That is what
 * makes the palette's contrast relief hold — the hue identifies, the ink is read.
 */
function paletteCss(count: number): string {
  const slot = (i: number) => (i < HUES.length ? HUES[i] : NEUTRAL)
  let light = ''
  let dark = ''
  for (let i = 0; i < count; i++) {
    light += `--c${i}:${slot(i).light};--c${i}-t:${slot(i).light}1F;`
    dark += `--c${i}:${slot(i).dark};--c${i}-t:${slot(i).dark}33;`
  }
  /* The two STATE pills are variables for the same reason the categories are:
     "Soon" was navy ink on a navy tint, which is invisible on the dark card's
     own navy ground, and "Running" was a dark brown that reads as a smudge
     there. An inline style cannot carry a `dark:` variant; a variable can. */
  return `
.ipcal{${light}--cal-ink:${NAVY};
  --cal-soon-bg:${NAVY}14;--cal-soon-fg:${NAVY};
  --cal-run-bg:#FFC82B33;--cal-run-fg:#8a5a00;
  --cal-now-bg:${ORANGE}26;--cal-now-fg:#a55a13;
  --cal-war:#8a5a00;--cal-war-bg:#FFC82B33}
.dark .ipcal{${dark}--cal-ink:#fff;
  --cal-soon-bg:#8FB4F229;--cal-soon-fg:#CFE0FB;
  --cal-run-bg:#FFC82B2E;--cal-run-fg:#FFD979;
  --cal-now-bg:${ORANGE}2E;--cal-now-fg:#FFC79B;
  --cal-war:#FFC82B;--cal-war-bg:#FFC82B2E}
`
}

/**
 * Every category on the calendar, with the slot that colours it.
 *
 * Ranked by TITLE COUNT over the WHOLE row set, never over the filtered view.
 * Colour follows the category, not its rank in what happens to be on screen —
 * so narrowing to one genre must not repaint the categories that survive, which
 * is exactly what ranking the filtered set would do.
 */
function buildCategories(rows: AssetRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const a of rows) {
    const c = catOf(a)
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const ranked = Array.from(counts.entries())
    .sort((x, y) => (x[0] === UNTAGGED ? 1 : y[0] === UNTAGGED ? -1
      : y[1] - x[1] || x[0].localeCompare(y[0])))
    .map(([k]) => k)
  const slots = new Map<string, number>()
  ranked.forEach((k, i) => slots.set(k, i))
  return slots
}

/** Where a title sits, and what its window is. Null when it carries no date at
    all — the caller counts those rather than dropping them, because a title
    missing from a calendar with no explanation reads as one that does not exist. */
function occurrenceOf(a: AssetRow, today: number, cat: string): Occ | null {
  // StartDate first — it is what the calendar is asked to be "based on". A title
  // with no start but a release date is placed on the release rather than being
  // dropped; the chip says which column put it there.
  const start = toDay(a.StartDate)
  const rel = toDay(a.ReleaseDate)
  const anchor: Anchor = start !== null ? 'start' : 'release'
  const day = start !== null ? start : rel
  if (day === null) return null
  const rawEnd = toDay(a.EndDate)
  const end = rawEnd !== null && rawEnd > day ? rawEnd : day
  const state: State = day > today ? 'upcoming' : end >= today ? 'running' : 'past'
  return { a, anchor, day, end, state, cat, war: isWarRoom(a) }
}

/* ── The card ─────────────────────────────────────────────────────────────── */

/*
onLoadingChange lets the PAGE own the waiting state.

This component used to draw its own loader, and the welcome page drew a second
one for its own fetch — so arriving at the page showed two identical loaders in
two stacked boxes, for one wait. Reporting upward instead means one loader on
the page and no argument about which of them is finished.

Only the LOADING state is lifted. The fetch, the rows and the ERROR stay here,
deliberately: this endpoint and the overview's fail independently, and a title
list that 404s must not blank the week's figures — see the note in welcome/page.
*/
export default function ProgramCalendar({ onLoadingChange }: {
  onLoadingChange?: (loading: boolean) => void
} = {}) {
  const [rows, setRows] = useState<AssetRow[] | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const [cat, setCat] = useState<string>('all')
  const [genre, setGenre] = useState<string>('all')
  /* Narrowing to the War Room set. Held apart from `cat`/`genre` rather than
     folded in as another category value, because it is a different question —
     it can be asked WITH a genre, not instead of one. */
  const [warOnly, setWarOnly] = useState(false)
  const [q, setQ] = useState('')
  /* The month on screen. One at a time: a pair fit the "current and last month"
     brief literally and read as two half-size calendars competing for the same
     glance, with every cell too narrow to hold a title. One month at full width
     is the month you are actually looking at, and ‹ › reaches last month in a
     click — which is what the pair was really for. */
  const [anchor, setAnchor] = useState<number | null>(null)
  const [day, setDay] = useState<number | null>(null)
  const [open, setOpen] = useState<Occ | null>(null)

  const today = useMemo(nowDay, [])

  /* The card sizes itself to what is left of the screen — see useFitHeight.
     `rows` is a dependency because the page above draws a loader until the
     titles land, and the card's top edge moves when that loader goes. */
  const cardRef = useRef<HTMLDivElement>(null)
  /*
    Collapsed by default, and the legend's height is a dependency of the fit.

    Expanding it takes room from the grid rather than from the screen — the card
    is a fixed height and the grid is the flexible part — so the month re-divides
    and the cells report fewer chips. That is the reader's own trade, made
    knowingly, which is the difference between this and a scrollbar.
  */
  const [legendOpen, setLegendOpen] = useState(false)

  /*
    How many genre blocks fit on ONE line, read off the grid.

    The collapsed legend shows exactly one row of them, which is the only cap
    that makes sense once they sit side by side: at 1600px the grid resolves to
    six columns and all seven genres are one row, so collapsing would hide
    something for no gain — while on a phone it is one column and six stacked
    blocks would take the month down to bare numbers.

    Measured rather than derived from a breakpoint, because the number depends
    on the CARD's width — which the rail beside it, the shell around it and the
    reader's window all have a say in. Reading gridTemplateColumns is free and
    cannot feed back: it is a computed style, and nothing here writes it.
  */
  const legendGridRef = useRef<HTMLDivElement>(null)
  const [legendCols, setLegendCols] = useState(1)
  useEffect(() => {
    const el = legendGridRef.current
    if (!el || typeof window === 'undefined') return
    const read = () => {
      const n = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length
      setLegendCols(Math.max(1, n))
    }
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [rows])


  const fitH = useFitHeight(cardRef, [rows, err, legendOpen, legendCols])

  // Told to the page whenever it changes, including the first true.
  useEffect(() => { onLoadingChange?.(loading) }, [loading, onLoadingChange])

  useEffect(() => {
    let live = true
    setLoading(true)
    fetch('/api/reports/assets', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!live) return
        if (d?.available === false) { setErr(d.error || 'The reporting service is unavailable.'); return }
        if (!d?.ok) { setErr(d?.error || 'The title list could not be read.'); return }
        setRows(Array.isArray(d.rows) ? d.rows : [])
        setErr('')
      })
      .catch(e => { if (live) setErr(e?.message || 'The title list could not be read.') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  /* THE CURRENT MONTH, on the right, with last month on its left. Not the
     newest month holding data, which is what this used to open on: that reads
     as "here is the calendar" while showing 2032, and the question the page is
     actually asked on arrival is what is happening now. Where those two months
     are empty the grid says so and offers the jump — see the empty note below. */
  useEffect(() => {
    if (anchor === null) setAnchor(startOfMonth(today))
  }, [anchor, today])

  const slots = useMemo(() => buildCategories(rows ?? []), [rows])

  const all = useMemo(() => {
    if (!rows) return { occs: [] as Occ[], undated: [] as AssetRow[] }
    const occs: Occ[] = []
    const undated: AssetRow[] = []
    for (const a of rows) {
      const o = occurrenceOf(a, today, catOf(a))
      if (o) occs.push(o); else undated.push(a)
    }
    return { occs, undated }
  }, [rows, today])

  /*
    ── THE LEGEND ──────────────────────────────────────────────────────────

    Genre, with its sub-genres beneath it. The COLOUR is on the sub-genre where
    one exists, because that is the level the chips are coloured at; the genre
    carries a swatch of its own only where titles hold it with no sub-genre, so
    a swatch in the legend always corresponds to marks that are actually on the
    calendar.

    WHERE AN ASSET HAS SEVERAL GENRES its sub-genres are listed under each of
    them, because the API returns the two as independent flat sets and there is
    nothing in the payload saying which sub-genre hangs under which genre. That
    is a real limit, not a rounding error; it is invisible on the current data,
    where no asset carries more than one genre.
  */
  const legend = useMemo(() => {
    if (!rows) return [] as Array<{ genre: string; titles: number; cats: Array<{ cat: string; titles: number }> }>
    const acc = new Map<string, { titles: number; cats: Map<string, number> }>()
    for (const a of rows) {
      const gs = splitSet(a.Genre)
      const c = catOf(a)
      for (const g of gs.length > 0 ? gs : [UNTAGGED]) {
        let e = acc.get(g)
        if (!e) { e = { titles: 0, cats: new Map() }; acc.set(g, e) }
        e.titles++
        e.cats.set(c, (e.cats.get(c) ?? 0) + 1)
      }
    }
    return Array.from(acc.entries())
      .map(([g, e]) => ({
        genre: g,
        titles: e.titles,
        cats: Array.from(e.cats.entries())
          .map(([c, n]) => ({ cat: c, titles: n }))
          .sort((x, y) => y.titles - x.titles || x.cat.localeCompare(y.cat)),
      }))
      /* Biggest first, and the untagged bucket last wherever it lands: it is a
         gap in the data rather than a category, so it should not head a list of
         real ones just because it happens to be large. */
      .sort((x, y) => (x.genre === UNTAGGED ? 1 : y.genre === UNTAGGED ? -1 : y.titles - x.titles))
  }, [rows])

  /* How many genre blocks are drawn: one grid row when collapsed, all of them
     when the reader opens it. Placed after `legend` because it is a fact about
     that list, not about the state above. */
  const legendShown = legendOpen ? legend.length : Math.min(legend.length, legendCols)

  /** War Room titles in the whole catalogue — counted over rows, not marks. */
  const warTitles = useMemo(() => (rows ?? []).filter(isWarRoom).length, [rows])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.occs.filter(o =>
      (!warOnly || o.war) &&
      (cat === 'all' || o.cat === cat) &&
      (genre === 'all' || splitSet(o.a.Genre).includes(genre) ||
        (genre === UNTAGGED && splitSet(o.a.Genre).length === 0)) &&
      (!needle || (o.a.AssetName || '').toLowerCase().includes(needle)))
  }, [all.occs, cat, genre, q, warOnly])


  /* Everything that STARTS on a given day, for every day either grid can show.
     Built once for the pair rather than filtered per cell — 42 cells × 2 months
     × a filter pass each is the same work done eighty-four times. */
  const byDay = useMemo(() => {
    const m = new Map<number, Occ[]>()
    for (const o of shown) {
      const g = m.get(o.day)
      if (g) g.push(o); else m.set(o.day, [o])
    }
    for (const list of m.values()) {
      list.sort((x, y) => (x.a.AssetName || '').localeCompare(y.a.AssetName || ''))
    }
    return m
  }, [shown])

  /** How many of the shown titles start in the month on screen. */
  const inView = useMemo(() => {
    if (anchor === null) return 0
    const to = addMonths(anchor, 1)
    return shown.filter(o => o.day >= anchor && o.day < to).length
  }, [shown, anchor])

  /* The nearest month that actually holds something, for the empty state's
     offer. Most of this data is historical, so a client opening on a quiet
     fortnight would otherwise be looking at an empty grid with no way to tell
     an empty month from a broken page. */
  const busiest = useMemo(() => {
    if (shown.length === 0) return null
    return startOfMonth(shown.reduce((m, o) => (o.day > m ? o.day : m), shown[0].day))
  }, [shown])

  const dayItems = day === null ? [] : (byDay.get(day) ?? [])

  const card = 'rounded-2xl border border-gray-100 dark:border-white/10 bg-white dark:bg-[#1a2d55]'

  /* Nothing while loading — the page shows the one loader for both fetches.
     Still MOUNTED though, which is the point: unmounting it until the page
     stopped waiting would mean this fetch never started, and the page would
     wait on it for ever. */
  if (loading) return null
  if (err) {
    return (
      <div className="rounded-2xl border border-amber-200 dark:border-amber-400/25 bg-amber-50 dark:bg-amber-500/10 px-5 py-4">
        <p className="text-sm font-bold text-amber-800 dark:text-amber-200">Calendar unavailable</p>
        <p className="text-xs text-amber-700 dark:text-amber-300/80 mt-1">{err}</p>
      </div>
    )
  }

  const slotOf = (c: string) => slots.get(c) ?? 0
  const varOf = (c: string) => `var(--c${Math.min(slotOf(c), HUES.length)})`
  const tintOf = (c: string) => `var(--c${Math.min(slotOf(c), HUES.length)}-t)`

  return (
    <div ref={cardRef} className={`ipcal ${card} overflow-hidden flex flex-col`}
      style={fitH ? { height: fitH } : undefined}>
      <style>{paletteCss(Math.max(slots.size, 1) + 1)}</style>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-5 sm:px-6 pt-4 pb-3 border-b border-gray-100 dark:border-white/10
        flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-extrabold text-[#14254A] dark:text-white leading-none">
            Programme calendar
          </h2>
          <p className="text-[11.5px] text-gray-500 dark:text-white/50 mt-2">
            <b className="text-[#14254A] dark:text-white">{(rows?.length ?? 0).toLocaleString()}</b> titles
            <Dot /> <b className="text-[#14254A] dark:text-white">{inView.toLocaleString()}</b> starting
            {anchor !== null ? ` in ${monthLabel(anchor)}` : ' this month'}
            {all.undated.length > 0 && <><Dot /> {all.undated.length.toLocaleString()} undated</>}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" width="12" height="12"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
              strokeLinecap="round" style={{ color: '#9aa5b5' }}>
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search titles…"
              className="h-8 w-[140px] focus:w-[210px] rounded-lg border border-gray-200 dark:border-white/15
                bg-transparent pl-7 pr-2 text-[12px] text-[#14254A] dark:text-white placeholder:text-gray-400
                outline-none focus:border-[#FC934C] transition-all" />
          </div>
          <div className="flex items-center gap-1">
            <NavBtn onClick={() => { if (anchor !== null) { setAnchor(addMonths(anchor, -1)); setDay(null) } }}
              label="Earlier months">‹</NavBtn>
            <button onClick={() => { setAnchor(startOfMonth(today)); setDay(null) }}
              className="h-8 px-3 rounded-lg border border-gray-200 dark:border-white/15 text-[12px]
                font-bold text-[#14254A] dark:text-white hover:bg-gray-50 dark:hover:bg-white/5 transition">
              Today
            </button>
            <NavBtn onClick={() => { if (anchor !== null) { setAnchor(addMonths(anchor, 1)); setDay(null) } }}
              label="Later months">›</NavBtn>
          </div>
        </div>
      </div>

      {/* ── Legend ───────────────────────────────────────────────────────────
          Genre headings, each with the coloured categories underneath that its
          titles are actually drawn in. Every swatch is a filter; the label
          beside it is what keeps identity off colour alone. */}
      {legend.length > 0 && (
        /*
           NO SCROLLBAR, and that is the point of the whole card.

           This was capped at 96px with overflow-y-auto, on the reasoning that
           the legend is the one part that can scroll without anybody minding.
           Measured, it was hiding 78px of itself on every desktop size and
           157px on a phone — roughly half its categories, behind a scrollbar
           inside a card whose entire purpose is to be one screenful. A calendar
           you have to scroll to read the key of is not a single view.

           So the cap is a COUNT of genre rows, not a number of pixels: what is
           shown is whole rows, what is hidden is announced, and there is no
           scroll in either state. Dropping the cap altogether was the other
           option and it is worse — the full legend is 253px on a phone, which
           takes the month down to bare numbers. */
        <div className="flex-shrink-0 px-5 sm:px-6 py-2.5 border-b border-gray-100 dark:border-white/10
          bg-gray-50/60 dark:bg-black/10 overflow-hidden">
          {/* One ROW per genre, its name at the head of its own sub-genres.

              Laid out as rows rather than as side-by-side columns, which is what
              this was and what made it unreadable: a genre holding seven
              sub-genres and one holding a single sub-genre became columns of
              wildly different widths, so the genre names ended up strung across
              the top of the block nowhere near the swatches they name. A row
              keeps a genre and its colours on the same line as each other. */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <button onClick={() => { setGenre('all'); setCat('all'); setWarOnly(false) }}
                className={`text-[10px] font-extrabold uppercase tracking-[0.08em] px-2 py-1 rounded-md transition-colors
                  ${genre === 'all' && cat === 'all' && !warOnly
                    ? 'bg-[#14254A] text-white dark:bg-white/20'
                    : 'text-gray-400 dark:text-white/40 hover:text-[#14254A] dark:hover:text-white'}`}>
                All {(rows?.length ?? 0).toLocaleString()}
              </button>
              <span className="text-[10px] text-gray-400 dark:text-white/30">
                colour is the sub-genre, or the genre where a title carries none
              </span>
            </div>

            {/* War Room, on its own line above the genres.

                ABOVE them, and separated, because it is not one of them: it is
                a flag that any genre's title can carry, so listing it among
                Sports and Movies would read as a fourth genre a title is filed
                under instead of a second thing that is true of it.

                Shown even at nought. The column was 0 on every row of the first
                catalogue this was measured against, so "there are none" is a
                real and useful answer here — and hiding the row would leave a
                reader unable to tell it from a calendar that had never heard of
                War Room. */}
            {rows !== null && (
              <div className="flex flex-wrap items-center gap-x-1 gap-y-1 pb-1.5 mb-0.5
                border-b border-gray-200/70 dark:border-white/10">
                <span className="w-[104px] flex-shrink-0 text-[10px] font-extrabold uppercase
                  tracking-[0.08em] text-gray-400 dark:text-white/40">Tracking</span>
                <button
                  onClick={() => { if (warTitles > 0) setWarOnly(v => !v) }}
                  disabled={warTitles === 0}
                  title={warTitles === 0
                    ? 'No title in this catalogue is flagged as a War Room asset (IsWarRoom).'
                    : `${warTitles.toLocaleString()} War Room title${warTitles === 1 ? '' : 's'} — a mark on the chip, not a colour, so a title still shows its own genre`}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-[3px]
                    text-[10.5px] leading-none transition-colors ${warTitles === 0
                      ? 'border-transparent opacity-50 cursor-default'
                      : warOnly
                        ? 'border-[#14254A] dark:border-white/50'
                        : 'border-transparent hover:border-gray-200 dark:hover:border-white/15'}`}
                  style={{ background: warOnly ? 'var(--cal-war-bg)' : undefined }}>
                  <WarMark />
                  <span className="font-bold text-[#14254A] dark:text-white/85">{WAR_ROOM}</span>
                  <span className="font-bold tabular-nums text-gray-400 dark:text-white/35">
                    {warTitles.toLocaleString()}
                  </span>
                </button>
              </div>
            )}

            {/*
                ── GENRES SIDE BY SIDE, NOT STACKED ────────────────────────

                One BLOCK per genre, flowed into as many columns as the card is
                wide enough for. Stacked one per line, six genres cost six lines
                of a card whose whole problem is vertical room — and four of
                those lines held a single swatch, so most of the width went
                unused while the month above lost height for it.

                Columns were tried once before and reverted, for a reason worth
                keeping in view: they were side-by-side FLEX columns, so a genre
                with six sub-genres and one with a single sub-genre came out
                wildly different widths and the genre names ended up strung
                across the top of the block, nowhere near the swatches they
                name. This is not that. Each genre is a self-contained block
                carrying its OWN label above its OWN swatches, so a name cannot
                drift from what it names however uneven the contents are.

                auto-fill with a min track rather than a breakpoint list: the
                legend takes three columns on a wide card, two on a tablet and
                one on a phone, decided by the space it actually has rather than
                by a guess about the device that has it.
            */}
            <div ref={legendGridRef} className="grid gap-x-4 gap-y-1.5"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
              {legend.slice(0, legendShown).map(g => (
                <div key={g.genre} className="min-w-0">
                  <button onClick={() => { setGenre(genre === g.genre ? 'all' : g.genre); setCat('all') }}
                    className={`block w-full text-left text-[10px] font-extrabold uppercase
                      tracking-[0.08em] truncate transition-colors ${genre === g.genre
                        ? 'text-[#FC934C]'
                        : 'text-gray-400 dark:text-white/40 hover:text-[#14254A] dark:hover:text-white'}`}
                    title={`${g.genre} — ${g.titles.toLocaleString()} titles`}>
                    {g.genre} <span className="tabular-nums font-bold">{g.titles.toLocaleString()}</span>
                  </button>
                  {/* The swatches wrap WITHIN the block, so a busy genre grows
                      its own cell taller instead of pushing its neighbours
                      around. */}
                  <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 mt-0.5">
                    {g.cats.map(c => (
                      <Swatch key={c.cat} label={c.cat} count={c.titles}
                        colour={varOf(c.cat)} tint={tintOf(c.cat)}
                        capped={slotOf(c.cat) >= HUES.length}
                        active={cat === c.cat}
                        onClick={() => { setCat(cat === c.cat ? 'all' : c.cat); setGenre('all') }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* The rest, named rather than merely hidden. A count of what is not
                on screen is what separates a collapsed legend from a truncated
                one — and it collapses again, because a reader who opened it to
                find one genre should not have to reload to get their month
                back. */}
            {/* Only when something is actually hidden. Side by side, a wide card
                shows every genre on one line — and a "show more" that reveals
                nothing is worse than no control at all. */}
            {legend.length > legendCols && (
              <button onClick={() => setLegendOpen(v => !v)}
                className="text-[10px] font-extrabold uppercase tracking-[0.08em] px-2 py-1 -ml-2
                  rounded-md text-[#FC934C] hover:bg-[#FC934C]/10 transition-colors">
                {legendOpen
                  ? 'Show fewer genres'
                  : `+${legend.length - legendCols} more genre${legend.length - legendCols === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── The month, and the chosen day beside it ───────────────────────────
          Teams puts the day's agenda to the RIGHT of the month, and that is the
          right place for it: the grid answers "when", the panel answers "what",
          and a reader moving between them should not have to scroll. It falls
          under the grid below xl, where 320px of rail would leave the month too
          narrow to hold a title. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]">
        {anchor !== null && (
          <MonthGrid month={anchor} today={today} byDay={byDay} selected={day}
            onPickDay={ts => setDay(day === ts ? null : ts)} onPickOcc={setOpen}
            varOf={varOf} tintOf={tintOf} />
        )}

        {/* Beside the grid on a wide screen, UNDER it on a narrow one — and
            below xl it only exists once a day has been picked.

            Stacked, an idle rail was spending 135 vertical pixels on a sentence
            inviting the reader to pick a day, taken out of the month they were
            picking it from: at 1024×640 that was the difference between a cell
            holding a title and a cell holding nothing at all. Beside the grid it
            costs the month no height, so there it stays whether or not a day is
            chosen and keeps saying what it is for.

            Stacked it is also CAPPED, at a bit over a third. Uncapped, opening
            a day on a phone took so much of the column that every cell lost its
            titles and the month above went back to being a grid of bare
            numbers — the reader tapped a day and the calendar they tapped it in
            stopped being one. */}
        <div className={`min-h-0 border-t xl:border-t-0 xl:border-l border-gray-100 dark:border-white/10
          bg-gray-50/60 dark:bg-black/10 flex-col max-h-[38%] xl:max-h-none
          ${day === null ? 'hidden xl:flex' : 'flex'}`}>
          <div className="px-4 py-2.5 border-b border-gray-100 dark:border-white/10 flex items-center
            justify-between gap-2">
            <p className="text-[12px] font-extrabold text-[#14254A] dark:text-white truncate">
              {day === null ? 'Pick a day' : fmtDayLong(day)}
            </p>
            {day !== null && (
              <button onClick={() => setDay(null)}
                className="text-[11px] font-bold text-[#FC934C] hover:underline flex-shrink-0">Clear</button>
            )}
          </div>

          {/* The one place a scrollbar is still right: a day can hold thirty
              titles and they are a LIST, not the calendar. The grid beside it
              never scrolls. */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {day === null ? (
              /* Not an error, and not empty space: the panel says what it is for
                 rather than sitting blank beside a full month. */
              <p className="px-4 py-6 text-[11.5px] text-gray-400 dark:text-white/40 leading-relaxed">
                Choose a day in the calendar to see the titles on it. A day
                carrying titles shows them in the cell and counts them in its
                corner.
              </p>
            ) : dayItems.length === 0 ? (
              <p className="px-4 py-6 text-[11.5px] text-gray-400 dark:text-white/40">
                No titles on this day.
              </p>
            ) : (
              <>
                <p className="px-4 pt-3 pb-1 text-[10px] font-extrabold uppercase tracking-[0.08em]
                  text-gray-400 dark:text-white/40">
                  {dayItems.length} {dayItems.length === 1 ? 'title' : 'titles'}
                </p>
                {dayItems.map((o, i) => (
                  <button key={i} onClick={() => setOpen(o)}
                    className="w-full flex items-start gap-2.5 px-4 py-2 text-left
                      border-b border-gray-100/70 dark:border-white/[0.05]
                      hover:bg-[#FC934C]/[0.07] transition-colors">
                    <span className="flex items-stretch gap-[2px] flex-shrink-0 mt-0.5">
                      <span className="w-1.5 h-8 rounded-full" style={{ background: varOf(o.cat) }} />
                      {o.war && (
                        <span className="w-1.5 h-8 rounded-full" style={{ background: 'var(--cal-war)' }} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-bold text-[#14254A] dark:text-white/90
                        leading-snug break-words">
                        {o.a.AssetName || '(untitled)'}
                      </span>
                      {/* The CATEGORY, the war-room mark, and where the coverage
                          runs to. No "starts" / "released" word: which column
                          placed the title here is a fact about the DATA, not
                          about the title, and repeating it on all five rows of
                          a day said nothing that differed between them — the
                          panel is headed with the day, so being in the list is
                          already the claim. It is still on the detail card,
                          where a reader has asked about one title and the
                          distinction can be explained rather than abbreviated
                          to a verb. */}
                      <span className="block text-[10.5px] text-gray-400 dark:text-white/40 mt-0.5">
                        {o.cat}
                        {o.war && <> · <b style={{ color: 'var(--cal-war)' }}>{WAR_ROOM}</b></>}
                        {o.end > o.day ? ` · → ${fmtDay(o.end)}` : ''}
                      </span>
                    </span>
                    <StatePill state={o.state} />
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Nothing in either month. Said, with the jump — an empty grid on a page
          somebody just opened is indistinguishable from a page that failed. */}
      {inView === 0 && (
        <div className="px-5 sm:px-6 py-6 text-center border-t border-gray-100 dark:border-white/10">
          <p className="text-[12.5px] font-bold text-[#14254A] dark:text-white/80">
            Nothing starts in {anchor === null ? 'this month' : monthLabel(anchor)}
          </p>
          <p className="text-[11.5px] text-gray-400 dark:text-white/40 mt-1">
            {busiest !== null
              ? 'Most of this catalogue is dated elsewhere.'
              : 'No title in this catalogue carries a start or release date.'}
          </p>
          {busiest !== null && (
            <button onClick={() => { setAnchor(busiest); setDay(null) }}
              className="mt-2.5 h-8 px-3 rounded-lg border border-gray-200 dark:border-white/15 text-[12px]
                font-bold text-[#14254A] dark:text-white hover:bg-gray-50 dark:hover:bg-white/5 transition">
              Go to {monthLabel(busiest)}
            </button>
          )}
        </div>
      )}

      {open && <AssetModal occ={open} onClose={() => setOpen(null)} colour={varOf(open.cat)} />}
    </div>
  )
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

const Dot = () => <span className="mx-1 text-gray-300 dark:text-white/20">·</span>

/**
 * One month, as a Teams-style grid.
 *
 * Cells hold their content rather than a dot standing in for it — a dot answers
 * "is there anything here" and nothing else, and the whole point of expanding
 * the calendar is that the answer to "what" belongs on the grid too.
 *
 * HOW MANY they hold is worked out from the height the screen actually gave
 * this grid, not from a constant. Three was the constant, and it is the wrong
 * number twice: on a short window three chips overflow a cell that can hold
 * one, and on a tall monitor it leaves half of every cell empty while the day
 * says "+4 more". The weeks divide the grid evenly, each cell reports what it
 * can fit, and the overflow line is only counted against that when there is
 * actually an overflow to announce.
 */
function MonthGrid({ month, today, byDay, selected, onPickDay, onPickOcc, varOf, tintOf, className = '' }: {
  month: number
  today: number
  byDay: Map<number, Occ[]>
  selected: number | null
  onPickDay: (ts: number) => void
  onPickOcc: (o: Occ) => void
  varOf: (c: string) => string
  tintOf: (c: string) => string
  className?: string
}) {
  const { days, weeks } = useMemo(() => {
    const first = new Date(month)
    const lead = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1 - first.getUTCDay())
    /* Only the weeks this month actually occupies — five for most of them, six
       when a long month starts late in the week. A fixed 42 cells always drew a
       final row belonging entirely to the NEXT month, which is a whole row of
       greyed-out nothing at the bottom of every grid. */
    const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
    const w = Math.ceil((first.getUTCDay() + count) / 7)
    return { days: Array.from({ length: w * 7 }, (_, i) => lead + i * DAY), weeks: w }
  }, [month])

  /*
    How tall one cell came out, so a cell can say how many chips it holds.

    MEASURED rather than computed from the viewport: this grid is one cell of a
    larger layout, and what it ends up with depends on the rail beside it, the
    legend above it and the reader's own window.

    ── Why not a ResizeObserver ────────────────────────────────────────────

    That was the first attempt and it silently did nothing: the observer never
    fired — not even the initial callback it is specified to deliver — so the
    cap froze at whatever the first paint happened to measure and every busy day
    rendered as "+6 more" beside a cell with room for five of them. It is not
    worth depending on something that can fail that quietly for a number this
    visible.

    A layout effect with no dependency list runs after EVERY render, which is
    exactly when the answer can have changed — the card's height is state, the
    week count is a prop, and the legend wrapping to another line is a render
    too. The guard is what keeps it from looping: state is only set when the
    measurement actually moved, so the usual second render settles it and stops.
  */
  const gridRef = useRef<HTMLDivElement>(null)
  const [cellH, setCellH] = useState(0)
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const h = el.clientHeight / weeks
    setCellH(prev => (Math.abs(prev - h) > 0.5 ? h : prev))
  })

  /* Nought until the grid has been measured, which is one paint. A cell with
     no room for even one chip shows its date and its count and nothing else —
     including no "+N more", which would need a row this cell has not got. */
  const fit = Math.max(0, Math.floor((cellH - CELL_CHROME) / CHIP_ROW))

  const isCurrent = sameMonth(month, today)

  return (
    <div className={`min-h-0 flex flex-col p-3 sm:p-4 xl:p-5 ${className}`}>
      <div className="flex-shrink-0 flex items-baseline gap-2 mb-2.5">
        <h3 className="text-[14px] font-extrabold text-[#14254A] dark:text-white">{monthLabel(month)}</h3>
        {isCurrent && (
          <span className="text-[9.5px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded"
            style={{ background: 'var(--cal-now-bg)', color: 'var(--cal-now-fg)' }}>This month</span>
        )}
      </div>

      <div className="flex-shrink-0 grid grid-cols-7 gap-px">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="text-[10px] font-extrabold uppercase tracking-wider
            text-gray-400 dark:text-white/35 text-center pb-1.5">
            <span className="hidden sm:inline">{d}</span>
            <span className="sm:hidden">{d[0]}</span>
          </div>
        ))}
      </div>

      {/* The weeks share what is left, evenly — `minmax(0, 1fr)` rather than
          `1fr` so a cell holding more than it can show shrinks with the rest
          instead of pushing the last week off the bottom. */}
      <div ref={gridRef} className="flex-1 min-h-0 grid grid-cols-7 gap-px"
        style={{ gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` }}>
        {days.map(ts => {
          const d = new Date(ts)
          const outside = d.getUTCMonth() !== new Date(month).getUTCMonth()
          const items = outside ? [] : (byDay.get(ts) ?? [])
          const isToday = ts === today
          const isSel = ts === selected
          /* The overflow line costs a row of its own, but only when there IS
             an overflow — taking it off the top unconditionally would hide a
             third title behind "+1 more" in a cell with room for it. */
          const head = items.length <= fit ? items : items.slice(0, Math.max(0, fit - 1))
          const rest = items.length - head.length
          return (
            <div key={ts}
              onClick={() => { if (!outside) onPickDay(ts) }}
              role={outside ? undefined : 'button'}
              tabIndex={outside ? -1 : 0}
              onKeyDown={e => { if (!outside && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPickDay(ts) } }}
              className={`min-h-0 overflow-hidden rounded-lg p-1.5 flex flex-col gap-1 transition-colors outline-none
                ${outside
                  ? 'bg-transparent'
                  : `cursor-pointer bg-gray-50/70 dark:bg-white/[0.03]
                     hover:bg-[#FC934C]/[0.09] focus-visible:ring-2 focus-visible:ring-[#FC934C]
                     ${isSel ? 'ring-2 ring-[#14254A] dark:ring-white/50' : ''}`}`}>
              <div className="flex items-center justify-between leading-none">
                <span className={`text-[11.5px] tabular-nums ${
                  outside ? 'text-gray-300 dark:text-white/15'
                    : isToday ? 'font-extrabold text-white bg-[#FC934C] rounded-full w-[19px] h-[19px] grid place-items-center'
                      : items.length > 0 ? 'font-extrabold text-[#14254A] dark:text-white'
                        : 'text-gray-400 dark:text-white/35'}`}>
                  {d.getUTCDate()}
                </span>
                {items.length > 0 && (
                  <span className="text-[9.5px] font-bold tabular-nums text-gray-400 dark:text-white/30">
                    {items.length}
                  </span>
                )}
              </div>

              {head.map((o, i) => (
                <button key={i}
                  onClick={e => { e.stopPropagation(); onPickOcc(o) }}
                  title={`${o.a.AssetName || '(untitled)'} — ${o.cat}${o.war ? ` · ${WAR_ROOM}` : ''}${o.end > o.day ? ` (to ${fmtDay(o.end)})` : ''}`}
                  className="w-full flex-shrink-0 text-left rounded px-1.5 py-[3px] text-[10.5px]
                    font-semibold leading-tight truncate hover:brightness-95
                    dark:hover:brightness-125 transition"
                  style={{
                    background: tintOf(o.cat),
                    /* A 2px inset rule in the category's own hue: the chip's
                       identity survives on a tinted ground where the fill alone
                       would be too pale to read as a colour at all.

                       A War Room title gets a SECOND stripe beside it rather
                       than a different colour — the two facts are independent,
                       so they get independent channels. Listed after the first
                       so the category's rule paints over it: the category owns
                       the leading 2px, War Room the 2px behind it. */
                    boxShadow: o.war
                      ? `inset 2px 0 0 0 ${varOf(o.cat)}, inset 5px 0 0 0 var(--cal-war)`
                      : `inset 2px 0 0 0 ${varOf(o.cat)}`,
                    paddingLeft: o.war ? 9 : undefined,
                    color: 'var(--cal-ink)',
                  }}>
                  {o.a.AssetName || '(untitled)'}
                </button>
              ))}

              {/* `fit > 0` as well as `rest > 0`: in a cell too short for a
                  single chip there is no row for this line either, and the
                  count already sits in the corner. */}
              {rest > 0 && fit > 0 && (
                <span className="flex-shrink-0 text-[10px] font-bold text-[#FC934C] px-1.5">+{rest} more</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function NavBtn({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      className="w-8 h-8 rounded-lg border border-gray-200 dark:border-white/15 text-[17px] leading-none
        text-[#14254A] dark:text-white hover:bg-gray-50 dark:hover:bg-white/5 transition flex-shrink-0">
      {children}
    </button>
  )
}

/**
 * One category in the legend: its colour, its name, its count.
 *
 * The NAME is always present beside the swatch, which is what makes the
 * palette's contrast relief hold — a reader who cannot separate two hues still
 * has the word. `capped` marks a category past the eighth slot, drawn in the
 * neutral rather than given a ninth hue.
 */
function Swatch({ label, count, colour, tint, active, capped, onClick }: {
  label: string; count: number; colour: string; tint: string
  active: boolean; capped?: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick}
      title={capped
        ? `${label} — beyond the eight distinct colours, drawn in the neutral`
        : `${label} — ${count.toLocaleString()} title${count === 1 ? '' : 's'}`}
      className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-[3px] text-[10.5px]
        leading-none transition-colors max-w-[190px] ${active
          ? 'border-[#14254A] dark:border-white/50'
          : 'border-transparent hover:border-gray-200 dark:hover:border-white/15'}`}
      style={{ background: active ? tint : undefined }}>
      <span className="w-2.5 h-2.5 rounded-[3px] flex-shrink-0" style={{ background: colour }} />
      <span className="font-bold text-[#14254A] dark:text-white/85 truncate">{label}</span>
      <span className="font-bold tabular-nums text-gray-400 dark:text-white/35">{count.toLocaleString()}</span>
    </button>
  )
}

/**
 * The War Room mark: two bars, the way it is drawn on a chip.
 *
 * A glyph rather than a coloured square, so the legend key looks like the thing
 * it explains — a swatch here would promise a hue the calendar never uses for
 * this, which is the one thing the mark exists to avoid.
 */
function WarMark() {
  return (
    <span className="inline-flex items-stretch gap-[2px] h-2.5 flex-shrink-0" aria-hidden>
      <span className="w-[3px] rounded-[1px]" style={{ background: 'var(--cal-ink)', opacity: 0.35 }} />
      <span className="w-[3px] rounded-[1px]" style={{ background: 'var(--cal-war)' }} />
    </span>
  )
}

function StatePill({ state }: { state: State }) {
  if (state === 'past') return null
  const on = state === 'running'
  return (
    <span className="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0"
      style={on
        ? { background: 'var(--cal-run-bg)', color: 'var(--cal-run-fg)' }
        : { background: 'var(--cal-soon-bg)', color: 'var(--cal-soon-fg)' }}>
      {on ? 'Running' : 'Soon'}
    </span>
  )
}

function AssetModal({ occ, onClose, colour }: { occ: Occ; onClose: () => void; colour: string }) {
  const a = occ.a
  const flags = [
    truthy(a.IsExclusive) && 'Exclusive',
    truthy(a.IsGlobal) && 'Global',
    truthy(a.IsCountrySpecific) && 'Country-specific',
  ].filter(Boolean) as string[]
  const stateWord = occ.state === 'upcoming' ? 'Upcoming' : occ.state === 'running' ? 'Running' : 'Past'

  return (
    <div onClick={onClose}
      className="fixed inset-0 z-[80] flex items-center justify-center p-5"
      style={{ background: 'rgba(20,37,74,.55)', backdropFilter: 'blur(3px)' }}>
      <div onClick={e => e.stopPropagation()}
        className="w-full max-w-lg max-h-[82vh] overflow-auto rounded-2xl bg-white dark:bg-[#1a2d55]
          shadow-[0_24px_70px_rgba(13,36,75,.3)]">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-100 dark:border-white/10">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              <span className="inline-flex items-center gap-1.5 text-[10.5px] font-extrabold px-2 py-0.5
                rounded-full border border-gray-200 dark:border-white/15 text-[#14254A] dark:text-white/85">
                <span className="w-2 h-2 rounded-[3px]" style={{ background: colour }} />
                {occ.cat}
              </span>
              <span className="text-[10.5px] font-extrabold px-2.5 py-0.5 rounded-full
                bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70">{stateWord}</span>
              {occ.war && (
                <span className="inline-flex items-center gap-1.5 text-[10.5px] font-extrabold
                  px-2 py-0.5 rounded-full"
                  style={{ background: 'var(--cal-war-bg)', color: 'var(--cal-war)' }}>
                  <WarMark /> {WAR_ROOM}
                </span>
              )}
              {occ.anchor === 'release' && (
                <span className="text-[10.5px] font-semibold text-gray-400">placed on its release date</span>
              )}
            </div>
            <p className="text-[17px] font-extrabold leading-snug text-[#14254A] dark:text-white break-words">
              {a.AssetName || '(untitled)'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/60 flex-shrink-0">×</button>
        </div>
        <div className="p-5 grid grid-cols-[112px_1fr] gap-y-2.5 gap-x-4 text-[13px]">
          <Cell k="Start date" v={fmtDay(toDay(a.StartDate))} />
          <Cell k="End date" v={fmtDay(toDay(a.EndDate))} />
          <Cell k="Release date" v={fmtDay(toDay(a.ReleaseDate))} />
          {/* Verbatim: this column holds "Matchday 4", not a date. */}
          <Cell k="Match day" v={a.MatchDay || '—'} />
          <Cell k="Genre" v={splitSet(a.Genre).join(', ') || '—'} />
          <Cell k="Sub-genre" v={splitSet(a.SubGenre).join(', ') || '—'} />
          <Cell k="Franchise" v={a.FranchiseName || '—'} />
          <Cell k="IMDB Id" v={a.IMDBId || '—'} />
        </div>
        {flags.length > 0 && (
          <div className="px-5 pb-5 flex flex-wrap gap-1.5">
            {flags.map(f => (
              <span key={f} className="text-[11px] font-bold rounded-full border border-gray-200
                dark:border-white/15 px-2.5 py-1 text-[#14254A] dark:text-white/80">{f}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div className="font-bold text-gray-400 dark:text-white/40">{k}</div>
      <div className="text-[#14254A] dark:text-white/90">{v}</div>
    </>
  )
}
