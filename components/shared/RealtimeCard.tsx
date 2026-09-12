'use client'

/**
 * Live discovery counts, per platform.
 *
 * How much has been found for this client and where — the LIVE total, moving as
 * rows arrive, not a recent slice. It reads /api/realtime/{war-room|sports},
 * which passes through to reports_api and scopes the client server-side.
 *
 * Where the view reports them — sports does, war-room does not — the same card
 * carries the REMOVED half beside the identified one: how many of the URLs it
 * has counted are down again. It is drawn only where it was answered, never
 * defaulted to zero. "0 removed" beside a real discovery total is the strongest
 * statement this card could make about enforcement, and it must never be one a
 * missing field made on its own.
 *
 * Three things it is careful about, all of them ways a live number misleads:
 *
 *   · It says AS OF when it was taken, not "now". A card that refreshes every
 *     half minute is showing a number up to half a minute old, and the one
 *     moment that matters is when it stops refreshing — at which point "now" is
 *     a lie that gets worse in silence.
 *   · A platform on zero is KEPT — on the WAR ROOM. It is being watched and
 *     nothing turned up, which is a finding, and dropping it makes the list
 *     change length as discoveries move between platforms.
 *
 *     The SPORTS card drops them, by request. That report covers fourteen
 *     platforms of which a fixture usually touches three, so the row of zeroes
 *     was most of the card and the numbers that matter were what a reader had
 *     to hunt for. The count of what was dropped is printed instead, so the
 *     list getting shorter still says so rather than simply looking shorter.
 *   · A failed refresh leaves the last good numbers on screen, greyed, with the
 *     reason. Blanking them would lose information the reader still wants.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import InfoDot from '@/components/shared/InfoDot'
import SearchableSelect from '@/components/ui/SearchableSelect'

export interface RealtimePlatform {
  key: string
  label: string
  family: string
  count: number
  /** How many of `count` are down again. ABSENT where the view does not report
      removals, and absent where this platform could not be counted — neither is
      a zero, and the cell draws nothing rather than claiming none. */
  removed?: number | null
  /** What a removal MEANS here, in words: an approved delisting notice on Open
      Web, a URL that can no longer be reached everywhere else. The server
      derives it from the predicate it counted by and blanks the predicate. */
  removalBasis?: string
}

interface Payload {
  ok: boolean
  view: string
  total: number
  platforms: RealtimePlatform[]
  /** The removed half of `total`. Absent on views that do not count removals. */
  totalRemoved?: number | null
  /** How many assets the figure covers. 0 means every asset. */
  assets?: number
  /** Which system counted. "markscan" is the enforcement platform's own view;
      absent means the reports warehouse. */
  source?: string
  /** The window counted, echoed back. Absent or empty means everything. */
  startDate?: string
  endDate?: string
  /** The dimension filters the count was narrowed by, echoed back. Read from the
      ANSWER rather than from what was asked for: a filter the service did not
      apply must not be described on the card as though it had been. */
  franchise?: string
  matchDay?: string
  /** Where that window came from. 'period' is the client's configured sports
      season, which no slicer on the page can move — the caption says so rather
      than calling it "this range". 'rolling' is the window the card's own
      control asked for, ending now. Absent on sources that do not report it. */
  scope?: 'period' | 'request' | 'rolling' | string
  /** How many hours a rolling window covers, as the server ACTUALLY counted it.
      The week-long ceiling is enforced there, so a card asking for more is
      answered for a week and has to caption itself with the week it got. Zero
      or absent on every other scope. */
  windowHours?: number
  /** How many platforms failed on this reading. The rest are still shown. */
  partial?: number
  asOf: string
  error?: string
}

/*
windowDates turns a rolling window in hours into the date pair MarkScan needs.

Rounded UP to whole days, and inclusive of today: MarkScan filters on dates, so
24 hours is today, 72 is today and the two before it. Rounding up rather than
down because a window that asked for three days and was given two would under-
report, and a live card that under-reports is worse than one that covers a few
hours more than it says.

Null for hours <= 0, which is the "no window offered" case every caller had
before this existed — the dates then come from the page, exactly as they did.
*/
function windowDates(hours: number): { start: string; end: string } | null {
  if (hours <= 0) return null
  const days = Math.max(1, Math.ceil(hours / 24))
  const end = new Date()
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (days - 1))
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { start: iso(start), end: iso(end) }
}

/**
 * A rolling window in words: "24 hours", "3 days", "7 days".
 *
 * Hours below a day and days above it, because that is how the two are asked
 * for. "0.5 days" and "168 hours" are both technically right and neither is a
 * label anybody would pick off a control.
 */
function windowWords(hours: number): string {
  if (hours <= 0) return ''
  /* A day inclusive is spoken in HOURS. "the last 1 day" is the phrase nobody
     says — a live card covering a day means "the last 24 hours", and the plural
     is what makes it read as a duration rather than as a count of calendar
     days. Above that, days: "the last 168 hours" is the same span in a unit
     nobody would pick off a control. */
  if (hours <= 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  // A whole number of days says days; anything else keeps its hours rather than
  // rounding 36 into "2 days" and overstating the window by half.
  if (hours % 24 !== 0) return `${hours} hours`
  return `${hours / 24} days`
}

/*
What the caption calls the window it counted.

Three answers, and they are not interchangeable. A SEASON is the client's
configured sports period — fixed, and unmoved by the date slicer beside it, so
calling it "this range" would invite a reader to change the range and wonder why
the number did not follow. A RANGE is a window the caller asked for. And no
window at all is all time, which is only true when the payload carries neither
end.
*/
/**
 * What the card is narrowed to, for the corner of it.
 *
 * The filters were already stated in the info tooltip, which nobody opens. On
 * screen the card said "identified · this season · 1 asset" — the count of
 * assets but never WHICH, and never the match day or the dates. A reader
 * comparing it with the tiles below could not tell whether the two were even
 * answering about the same fixture.
 *
 * Dates come LAST and always, because they are the one part that is never
 * implied by the filter rail: on a sports report the card is scoped to the
 * configured season, not the range in the picker, and those differ by months.
 *
 * Names, not ids. The reports screens carry GUIDs and would otherwise print
 * one here, which tells a reader nothing and takes the width of the row.
 */
function scopeBits(p: {
  assetNames?: string[]
  assets?: number
  franchise?: string
  matchDay?: string
  startDate?: string
  endDate?: string
  scope?: string
  windowHours?: number
}): string[] {
  const bits: string[] = []

  const names = (p.assetNames ?? []).filter(Boolean)
  const asset = names.length === 1
    ? names[0]
    : names.length === 2
      ? names.join(' + ')
      : names.length > 2
        ? `${names.length} assets`
        /* Filtered by id with no name to hand — say how many rather than
           printing a GUID at a reader. */
        : p.assets && p.assets > 0
          ? `${p.assets} asset${p.assets === 1 ? '' : 's'}`
          : ''
  if (asset) bits.push(asset)

  /* The franchise is dropped when the asset title already carries it. Fixture
     names here read "LaLiga: Barcelona vs Athletic", so naming the franchise
     beside one produced "LaLiga: Barcelona vs Athletic · LaLiga" — the same
     word twice, which reads as a rendering fault rather than two filters. */
  if (p.franchise && !asset.toLowerCase().includes(p.franchise.toLowerCase())) {
    bits.push(p.franchise)
  }

  /* Prefixed only where the value does not already say it. The slicer's values
     are spelled "Matchday 1", so an unconditional prefix gave
     "Match day Matchday 1". Whichever way the upstream spelling settles, one of
     the two branches is right and neither doubles the word. */
  if (p.matchDay) {
    bits.push(/match\s*day/i.test(p.matchDay) ? p.matchDay : `Match day ${p.matchDay}`)
  }

  /* A rolling window is named by its LENGTH, not by its ends. "6 Sep 2026 –
     7 Sep 2026" is what the timestamps say and it is the wrong sentence: the
     reader chose "last 24 hours" off a control on this card, and a caption
     spelling that as two dates reads as a fixed range they can no longer see
     the width of. Checked before the dates for that reason. */
  if (p.windowHours && p.windowHours > 0) {
    bits.push(`last ${windowWords(p.windowHours)}`)
  } else if (p.startDate || p.endDate) {
    const a = dayWords(p.startDate)
    const b = dayWords(p.endDate)
    bits.push(a && b ? (a === b ? a : `${a} – ${b}`) : a || b)
  } else if (p.scope === 'period') {
    bits.push('this season')
  }
  return bits.filter(Boolean)
}

function rangeWords(p: { startDate?: string; endDate?: string; scope?: string; windowHours?: number }) {
  /* "in the last 24 hours", which is the whole of what the headline means now.
     It comes first because a rolling scope also carries dates — they are its
     two ends — and "in this range" over a figure that moves every thirty
     seconds is the caption this card exists to avoid. */
  if (p.windowHours && p.windowHours > 0) return `in the last ${windowWords(p.windowHours)}`
  if (p.scope === 'period') return 'this season'
  return p.startDate || p.endDate ? 'in this range' : 'all time'
}

/*
── What the card is actually showing, in words ──────────────────────────────

	The figure needs a note more than most, because it sits directly above KPI
	tiles that count the same subject and DO NOT agree with it — three separate
	reasons, none of them visible on the card:

	  · the window is the configured season, which the date slicer cannot move
	  · the count is de-duplicated per URL; the tiles count rows
	  · it reads the live discovery tables; the tiles read the curated ones,
	    which split the open web into linking pages and the hosts behind them

	Left unexplained, a reader compares the two, finds them different, and
	distrusts whichever one they were not expecting. So the note is composed
	from the payload rather than written as fixed copy — the dates, the asset
	scope and the removal wording are the reading's own, so it cannot describe a
	window the card is not showing.
*/

// "2026-08-01 00:00:00" → "1 Aug 2026". The server sends the window as a
// warehouse timestamp; nobody reads one of those as a date.
function dayWords(v?: string) {
  if (!v) return ''
  const d = new Date(v.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return v.slice(0, 10)
  /* en-GB rather than the reader's own locale, and UTC rather than their own
     zone: this must read the way the date-range chip beside it does — "1 Aug
     2026" — and it names a warehouse day, which does not shift with whoever is
     looking at it. */
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

// The refresh cadence in the unit it is actually in. Rounding 30s to minutes
// gave "every 1 minutes" — the wrong figure and the wrong grammar in one line.
function everyWords(ms: number) {
  if (ms < 60_000) return `every ${Math.round(ms / 1000)} seconds`
  const m = Math.round(ms / 60_000)
  return m === 1 ? 'every minute' : `every ${m} minutes`
}

/*
What a platform's `removed` figure should be CALLED.

Two things travel under one word and they are not the same event. On the open
web a "removal" is an APPROVED DE-INDEXING NOTICE — an engine agreed to drop
the link, and the page it pointed at may well still be up. Everywhere else it is
a URL the crawler can no longer reach: the thing is gone.

Labelling both "removed" made the card disagree with the report beside it by 17%
with the reason hidden in a tooltip — 1,247 against 1,040 on the same fixture,
because one counted de-indexings and the other counted pages. Both figures were
right. Only the word was wrong.

Read off `removalBasis`, which the server derives from the predicate the service
actually counted by (see removalBasis in realtime.go) — NOT from a list of
platform names kept here. A platform that changes which of the two it records
changes its own label, and a platform this does not recognise keeps the neutral
word rather than being guessed at.
*/
function removedWord(basis?: string): string {
  return /delist|de-?index/i.test(basis ?? '') ? 'de-indexed' : 'removed'
}

/** The words in play across the platforms actually on screen. One where they
    agree, both where they do not — a legend naming one of two measures is a
    legend that mislabels half the bars under it. */
function removedWords(ps: RealtimePlatform[]): string[] {
  const seen = new Set<string>()
  for (const p of ps) {
    if (typeof p.removed === 'number') seen.add(removedWord(p.removalBasis))
  }
  return seen.size > 0 ? [...seen] : ['removed']
}

function scopeNote(p: Payload, refreshMs: number): string {
  const paras: string[] = []
  const span = p.startDate && p.endDate
    ? `${dayWords(p.startDate)} and ${dayWords(p.endDate)}`
    : ''

  /* WHAT and WHEN.

     The rolling window comes first, because it is what the sports card takes by
     default now and the only window on the page the reader picked themselves.
     It says outright that this is NOT the date range on the right, for the same
     reason the season branch does: a control that appears to act on a figure it
     cannot touch is worth one sentence to close off. */
  if (p.windowHours && p.windowHours > 0) {
    paras.push(
      `Everything found for this client in the last ${windowWords(p.windowHours)}, counted up to ` +
      `the stamp above. A live window that moves with the clock — not the date range on the ` +
      `right, which does not reach this figure. The buttons under the number widen it, ` +
      `to a week at most.`)
  } else if (p.scope === 'period') {
    paras.push(
      `Everything found for this client between ${span} — the reporting season set in ` +
      `Report Configuration → Sports period. The date range on the right does not move this ` +
      `figure; the Asset slicer does.`)
  } else if (span) {
    paras.push(`Everything found for this client between ${span} — the window the report below is showing.`)
  } else {
    paras.push('Everything found for this client, with no date limit.')
  }

  // The asset scope, only when it is narrowed: "every asset" is the resting
  // state and saying so on every reading is noise.
  if (p.assets && p.assets > 0) {
    paras.push(`Narrowed to ${p.assets} asset${p.assets === 1 ? '' : 's'}.`)
  }

  /* And the dimension filters, NAMED. The card starts unfiltered and these
     arrive as the reader works the rail beside it, so what it was narrowed to
     is the thing most likely to have changed since they last looked — and it is
     the only way to tell a count that honoured the filter from one that quietly
     ignored it. */
  const narrowed = [
    p.franchise && `franchise ${p.franchise}`,
    p.matchDay && `match day ${p.matchDay}`,
  ].filter(Boolean)
  if (narrowed.length > 0) {
    paras.push(`Narrowed to ${narrowed.join(' and ')}.`)
  }

  /* WHY IT WILL NOT MATCH THE TILES. The single most common question about this
     card, and the answer is not guessable from anything on screen. Warehouse
     source only — the War Room's card sits above no such tiles. */
  if (p.source !== 'markscan') {
    paras.push(
      'Counted live and de-duplicated per URL, so a page found on three days counts once. ' +
      'The report below counts rows in the prepared tables and reports the open web from both ' +
      'sides — the linking pages and the hosts behind them — so the two figures are not ' +
      'expected to tie out.')
  }

  /* WHAT "REMOVED" MEANS, in the reading's own words. Two different claims
     travel under one label — an approved delisting notice on the open web, an
     unreachable URL everywhere else — and a card stacking them in one bar
     should say which it holds. Read off the platforms present, so a reading
     carrying only one of the two does not describe both. */
  const bases = Array.from(new Set(
    p.platforms.map(x => x.removalBasis).filter((b): b is string => !!b)))
  if (bases.length === 1) {
    paras.push(`"Removed" here means ${bases[0]}.`)
  } else if (bases.length > 1) {
    paras.push(`"Removed" is not one thing: ${bases.join(' on the open web, and ')} elsewhere.`)
  }

  // A partial reading must say so wherever it is described, not only on the
  // platform that failed: the headline total is a floor when this is set.
  if (p.partial) {
    paras.push(
      `${p.partial} platform${p.partial === 1 ? '' : 's'} could not be counted on this reading, ` +
      'so the totals are a floor rather than an exact figure.')
  }

  paras.push(`Re-read ${everyWords(refreshMs)}; the stamp above says how old this reading is.`)
  return paras.join('\n\n')
}

/*
How often the card re-reads: every 30 seconds, from either source.

'markscan' runs the War Room's own incremental pull — a delta against the stored
rows, so a quiet half-minute costs one small request per platform and nothing is
re-paged. That was always 30s.

'warehouse' is a count per platform over a whole sports season — measured at
14.5s against production, against 1.4s for a week — and it used to poll at five
minutes for exactly that reason. It polls at 30s now, by request: a card headed
"Updating live" that re-read twice in the time somebody sits with it open was
live in name only.

What makes that affordable is that the cadence here is NOT the query rate. The
server holds one answer per (client, assets, window) and single-flights it, so
every tab on the same report shares one count and a poll inside the hold costs a
cache read (cachedRealtimeCount in go-server/handlers/realtime.go). The hold is
the thing that decides how hard the warehouse is worked; this only decides how
soon the card notices.

Either way the "x ago" stamp is the count's OWN age, not the age of the request
that fetched it — so a reading served from the hold says how old it really is,
and polling faster can never make a stale number look fresh.
*/
const REFRESH_MS: Record<string, number> = { markscan: 30_000, warehouse: 30_000 }

const nf = new Intl.NumberFormat()

/**
 * A number that TRAVELS to its new value instead of snapping to it.
 *
 * The card said "Updating live" beside a figure that changed once every thirty
 * seconds, in one frame, usually while nobody was looking at it — so the only
 * evidence of life was a pulsing dot, and a pulsing dot is what a static mock
 * has too. Counting up is the difference between being told it is live and
 * seeing that it is.
 *
 * Short, and eased out: six hundred milliseconds reads as the number arriving,
 * where a second and a half reads as the page being slow. The first value is
 * NOT animated — a card that counts up from zero on load is theatre, and it
 * hides how long the first reading actually took.
 */
function useCountUp(value: number, ms = 600) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const seeded = useRef(false)

  useEffect(() => {
    if (!seeded.current) { seeded.current = true; from.current = value; setShown(value); return }
    if (value === from.current) return

    const start = performance.now()
    const a = from.current
    const b = value
    let raf = 0

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      // easeOutCubic: most of the distance early, so it settles rather than
      // creeping the last few units.
      const eased = 1 - Math.pow(1 - t, 3)
      setShown(Math.round(a + (b - a) * eased))
      if (t < 1) raf = requestAnimationFrame(step)
      else from.current = b
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, ms])

  return shown
}

/** A window in the fewest characters that still say it: "24h", "3d", "7d".
 *
 *  A day and under in hours, above it in days — the same split windowWords
 *  uses, so a stop on the track and the sentence under the figure can never
 *  describe two different windows. */
function shortWindow(h: number): string {
  return h <= 24 ? `${h}h` : `${Math.round(h / 24)}d`
}

/**
 * The window control: how far back the live figure reaches.
 *
 * A SLIDER, and a slider over the index rather than over the hours.
 *
 * The options are 24, 72 and 168 hours. Ranged over the hours themselves, 24h
 * and 3d would sit within a thumb's width of one another and two thirds of the
 * track would be the empty run up to 7d — the control would draw three equal
 * choices as a lopsided scale and invite the reader to look for values between
 * them that do not exist. Over the index the three stops are evenly spaced,
 * which is what they are.
 *
 * What the slider buys over the segmented buttons it replaces is the reading:
 * these are three points on ONE axis, ordered, and a row of buttons says only
 * that they are alternatives. The current window is named in a pill beside the
 * label — the value has to stay legible without measuring the thumb against the
 * track — and the stops are named under it, so the whole range is readable at
 * rest and each name is still a click of its own.
 */
function WindowPicker({
  options, value, onChange, className = '',
}: {
  options: number[]
  value: number
  onChange: (h: number) => void
  className?: string
}) {
  const i = Math.max(0, options.indexOf(value))
  const last = options.length - 1
  const pct = last > 0 ? (i / last) * 100 : 0

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-white/40">
          Window
        </span>
        {/* The value, said rather than measured. A thumb two thirds along a
            track is a position, not a number, and this card is read for
            numbers. */}
        <span className="px-1.5 py-0.5 rounded-md text-[11px] font-bold tabular-nums
          bg-gray-100 text-[#14254A] dark:bg-white/10 dark:text-white">
          {shortWindow(options[i])}
        </span>
      </div>

      {/* The filled part of the track is painted as a hard-stop gradient the
          component computes per value, so there is no second element to keep in
          sync with the thumb. Same technique as the policy sliders; see
          .rt-range in globals.css. */}
      <input type="range" min={0} max={last} step={1} value={i}
        onChange={e => onChange(options[Number(e.target.value)] ?? options[0])}
        className="rt-range"
        aria-label="How far back the live count reaches"
        aria-valuetext={windowWords(options[i])}
        title={`Count the last ${windowWords(options[i])}`}
        style={{
          background: `linear-gradient(to right, var(--brand-blue) 0%, var(--brand-blue) ${pct}%,
            var(--rt-track) ${pct}%, var(--rt-track) 100%)`,
        }} />

      {/* The stops, named and clickable. A slider whose values are a closed set
          should not need dragging to reach one of them, and the names are what
          make the track legible without moving the thumb at all.

          Each one is placed AT its stop rather than the row being spread with
          justify-between. Spread, the labels sit at even intervals while the
          thumb sits at even intervals of a track inset by its own radius, and
          the two only agree at the ends — with three stops that was a pixel or
          two in the middle and invisible, with seven it is a row of names that
          plainly do not line up with the thing they label.

          `calc(7px + (100% - 14px) * frac)` is the thumb's own centre line: it
          travels from one radius in to one radius short of the end, not from 0
          to 100%. And `translateX(-frac%)` is what keeps the first name flush
          left, the last flush right and every one between centred, so none of
          them overhangs the track. */}
      <div className="relative h-3 mt-1">
        {options.map((h, n) => {
          const frac = last > 0 ? n / last : 0
          return (
            <button key={h} type="button" onClick={() => onChange(h)}
              title={`Count the last ${windowWords(h)}`}
              style={{
                left: `calc(7px + (100% - 14px) * ${frac})`,
                transform: `translateX(-${frac * 100}%)`,
              }}
              className={`absolute top-0 whitespace-nowrap text-[9.5px] font-semibold
                tabular-nums transition-colors ${
                n === i
                  ? 'text-[#14254A] dark:text-white'
                  : 'text-gray-400 hover:text-[#14254A] dark:text-white/35 dark:hover:text-white'
              }`}>
              {shortWindow(h)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** One option in a card slicer. Ids where the report carries ids, names where
    it carries names — exactly the shape the reports page's own `asOpts` makes,
    so the card and the rail cannot disagree about what a value is. */
export interface RealtimeOption { key: string; label: string }

/** The three the live tables can actually be narrowed by. Mirrors
    REALTIME_COUNT_FILTERS on the reports page and realtimeDims in
    go-server/handlers/realtime.go. */
export interface RealtimeDimOptions {
  franchiseName?: RealtimeOption[]
  matchDay?: RealtimeOption[]
  assetId?: RealtimeOption[]
}

/**
 * The card's own three slicers.
 *
 * The RAIL'S OWN control — SearchableSelect, in its compact trigger.
 *
 * These were native <select>s, on the argument that the rail already offers the
 * same three values in a richer widget a foot to the right and a second copy of
 * it here would be the elaborate version of something the reader can already do
 * properly. That argument was about the TRIGGER, and it does not survive what a
 * native select actually opens: a list drawn by the operating system, in the
 * OS's font at the OS's size with the OS's blue highlight, which on Windows
 * looks like nothing else in this product. It also cannot be wider than the
 * control, and the control is 190px in a 256px column — so the Asset list, the
 * one that most needs reading, was the one truncated hardest. And it cannot be
 * searched, over a catalogue that runs to four figures.
 *
 * The shared control answers all three: the list is portalled so it escapes the
 * column and opens upward near the foot of the window, it is wider than its
 * trigger, and it grows a search box past seven options. The compact trigger is
 * the same one the rail carries a dozen of, so the card and the rail no longer
 * look like two applications.
 *
 * Empty value means "every one", which is what the endpoint reads an absent
 * filter as — so the clear row is spelled "All" rather than left blank.
 */
function DimPicker({
  label, value, options, overridden, onChange,
}: {
  label: string
  value: string
  options: RealtimeOption[]
  /* Whether this one has been moved AWAY from the report's own selection.
     Marked, because a card quietly counting a different fixture from the panels
     under it is the one failure these controls introduce. */
  overridden: boolean
  onChange: (v: string) => void
}) {
  /* The report can hold a value this list does not carry. The rail rescopes its
     options as the client, the window and the other slicers move, so for a
     render or two a selection outlives the option that produced it — and a
     trigger whose value matches no option falls back to the placeholder. "All"
     over a count that is very much narrowed is the worst way for a filter
     control to be wrong, so the current value is carried as its own option.

     KEY AND LABEL ONLY — the count the rail's lists carry is deliberately
     dropped here.

     On the rail that number is the right one: it is rows in the report's
     tables, over the report's date range, and it is exactly what picking the
     option will do to the report underneath. On this card it is a number about
     something else entirely. The card counts live discovery rows, de-duplicated
     per URL, over its own rolling window — so "1,308" beside a fixture and "0"
     in the figure above it are both correct and look like a contradiction, and
     the reader has nothing on screen to reconcile them with. A count that
     answers a different question than the number it sits next to is worse than
     no count. */
  const opts = useMemo(
    () => {
      const bare = options.map(o => ({ key: o.key, label: o.label }))
      return !value || bare.some(o => o.key === value)
        ? bare
        : [{ key: value, label: value }, ...bare]
    },
    [options, value])

  return (
    /* A GRID with BOTH tracks fixed, because these now sit in a row along the
       foot of the card rather than stacked down a column.

       The label track was fixed already: three labels of different lengths in a
       flex row each started the control at a different x, which is what made a
       stack of them look broken. The control track has to be fixed too now —
       stacked it took the column's width from `1fr`, but a flex item sizes to
       its content and the trigger inside is `width: 100%` of nothing, so an
       auto track collapses it to the chevron.

       170px, which is where a fixture name stops being two words and an
       ellipsis. The whole pair is 240px, so three fit across any card wider
       than a phone and wrap cleanly below that.

       A <div> rather than a <label>: the control is a button now, and wrapping
       a button in a label neither names it nor focuses it. The name goes to the
       trigger directly. */
    <div className="grid grid-cols-[64px_170px] items-center gap-1.5 min-w-0 max-w-full">
      <span className={`text-[10px] uppercase tracking-wide truncate ${
        overridden ? 'text-[#FC934C]' : 'text-gray-400 dark:text-white/40'}`}>
        {label}
      </span>
      <SearchableSelect options={opts} value={value} onChange={onChange}
        placeholder="All" emptyLabel="All" compact marked={overridden}
        ariaLabel={overridden
          ? `${label} — set on this card, so the live count no longer matches the report below`
          : `${label} — following the report`} />
    </div>
  )
}

/** One line in the strip along the bottom of the card.
 *
 *  `applied` is whether the live count could honour it. `onCard` is whether it
 *  came from the card's own pickers rather than the report's rail — the two
 *  are drawn differently because a filter the card cannot count and one the
 *  reader cleared here are not the same admission. */
export interface ScopeItem {
  key: string
  label: string
  value: string
  applied: boolean
  onCard?: boolean
  /** What the report below is narrowed to, where the card has been moved off
      it. Named in the tooltip, so a reader can see the two have parted. */
  reportValue?: string
}

/**
 * The filter rail's current selection, along the bottom of the card.
 *
 * The card counts by three filters at most — asset, franchise, match day — and
 * the rail beside it carries a dozen. That gap is invisible on the numbers: an
 * unfiltered live total under a rail set to Spain and Spanish looks like a
 * Spanish figure and is out by an order of magnitude, with nothing on screen
 * admitting it.
 *
 * So every active filter is named, and the ones the count could not honour are
 * marked and said out loud underneath. Two lists in one strip rather than two
 * strips: what a reader is checking is "does this number answer the same
 * question as the report below", and that is one answer.
 */
function ScopeStrip({ items }: { items: ScopeItem[] }) {
  /* Two different reasons a filter is not on the count, and they want different
     sentences. One the card CANNOT honour — the live tables carry three
     dimensions and the rail carries a dozen. One the reader cleared themselves,
     on a picker a few lines above, which is not a limitation and must not be
     apologised for as one. */
  const cantCount = items.filter(i => !i.applied && !i.onCard)
  const clearedHere = items.filter(i => !i.applied && i.onCard)
  return (
    <div className="px-5 py-2.5 border-t border-gray-100 dark:border-white/10
      flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-white/40 flex-shrink-0">
        {items.length === 0 ? 'No filters' : 'Filters'}
      </span>

      {items.length === 0 ? (
        /* The resting state says what it IS, not that something is missing.
           "No filters" alone reads as a control that failed to load; this is the
           whole client, which is a perfectly good thing for a live card to be
           counting and the state it opens in. */
        <span className="text-[11px] text-gray-400 dark:text-white/40">
          counting every asset for this client — narrow it on the pickers above, or in the rail
        </span>
      ) : items.map(i => (
        /* Struck through and dimmed where the live count could not honour it.
           Absent instead, the reader would have no way to tell a filter the card
           ignored from one they had not set. */
        <span key={i.key}
          title={i.applied
            ? (i.onCard
                ? `${i.label}: ${i.value} — set on this card${
                    i.reportValue ? `, while the report below is on ${i.reportValue}` : ''}`
                : `${i.label}: ${i.value} — the live count is narrowed to this`)
            : (i.onCard
                ? `${i.label}: ${i.value} — cleared on this card, so the live count no longer honours it; the report below still does`
                : `${i.label}: ${i.value} — the report below is narrowed to this; the live count is not`)}
          className={`inline-flex items-baseline gap-1 max-w-full text-[11px] ${
            i.applied ? '' : 'opacity-60'}`}>
          {/* Orange where the reader set it here — the same mark the picker
              itself carries, so one glance ties the strip to the control. */}
          <span className={`flex-shrink-0 ${i.onCard && i.applied
            ? 'text-[#FC934C]' : 'text-gray-400 dark:text-white/40'}`}>{i.label}</span>
          <span className={`truncate font-medium ${i.applied
            ? 'text-[#14254A] dark:text-white'
            : 'text-gray-500 dark:text-white/50 line-through decoration-gray-300 dark:decoration-white/30'}`}>
            {i.value}
          </span>
        </span>
      ))}

      {cantCount.length > 0 && (
        <span className="text-[10px] text-amber-700 dark:text-amber-400 basis-full">
          {cantCount.map(i => i.label).join(', ')} {cantCount.length === 1 ? 'narrows' : 'narrow'} the
          report below but not this count — the live tables carry asset, franchise and match day only.
        </span>
      )}

      {clearedHere.length > 0 && (
        /* Grey, not amber. Nothing went wrong: the reader widened the card on
           purpose, and the only thing worth saying is that the report below did
           not widen with it. */
        <span className="text-[10px] text-gray-500 dark:text-white/50 basis-full">
          {clearedHere.map(i => i.label).join(', ')} {clearedHere.length === 1 ? 'was' : 'were'} cleared
          on this card — the report below is still narrowed by {clearedHere.length === 1 ? 'it' : 'them'}.
        </span>
      )}
    </div>
  )
}

/** Whether a value has just gone up, held briefly so a cell can flash. */
function useBumped(value: number, ms = 1200) {
  const [bumped, setBumped] = useState(false)
  const prev = useRef(value)
  useEffect(() => {
    if (value > prev.current) {
      setBumped(true)
      const t = setTimeout(() => setBumped(false), ms)
      prev.current = value
      return () => clearTimeout(t)
    }
    prev.current = value
  }, [value, ms])
  return bumped
}

export default function RealtimeCard({
  view,
  source = 'warehouse',
  clientId,
  userId,
  assetIds,
  assetNames,
  startDate,
  endDate,
  franchise,
  matchDay,
  windowOptions,
  waitingFor,
  scopeFilters,
  dimOptions,
  onDimsChange,
  platformKey,
  className = '',
  pinned,
  onTogglePin,
  title = 'Realtime',
  desc,
}: {
  view: 'war-room' | 'sports'
  /* WHICH SYSTEM COUNTS.

     'warehouse' reads /api/realtime/{view} — reports_api, the same data the
     reports are built from, complete and comparable with every other figure on
     those screens.

     'markscan' reads /api/warroom/realtime — the enforcement platform's own
     counts, per asset, through the very endpoints the War Room report pulls
     from. The War Room uses this because a card above a MarkScan report that
     answered from the warehouse would invite a comparison it cannot survive:
     the two are not lagged copies of one number.

     Both are kept. Neither is a fallback for the other. */
  source?: 'warehouse' | 'markscan'
  /** The warehouse client GUID, as the report screens carry it. Staff only —
      a client login's own id is enforced server-side and anything passed here
      is discarded. */
  clientId?: string
  /** The PORTAL user id, as the War Room picks clients by. Resolved to a
      warehouse client through the same mapping. Staff only, same rule. */
  userId?: string | number
  /** Asset GUIDs to scope the count to. Empty or absent means every asset. */
  assetIds?: string[]
  /** Asset NAMES. On the warehouse source these are resolved to GUIDs against
      the asset master; on MarkScan they are what its endpoints filter by. */
  assetNames?: string[]
  /** The window the report beside the card covers. MarkScan only — without it
      that source answers for everything it holds, which stops matching the
      report the moment the report is dated. */
  startDate?: string
  endDate?: string
  /* The narrowing filters the report page has applied, where they are ones this
     count can honour.

     The card is on screen from the moment a sports report loads and these
     arrive afterwards, one at a time, as the reader works the filter rail — so
     the count has to follow them or it is a live figure about a different
     subject than everything under it. Sending only the asset was the bug:
     picking Serie A narrowed every panel below to twenty-two thousand rows and
     left the card reporting a hundred and three thousand for the whole season,
     two figures about the same subject a hand's width apart. */
  franchise?: string
  matchDay?: string
  /* ── The window control, and what it may offer ───────────────────────────

     Rolling windows in HOURS, offered as buttons under the figure; the first is
     the one the card opens on. Absent and there is no control and no window
     asked for, which is how every consumer that had this card before keeps the
     window its own endpoint chose — the War Room's report range, the sports
     season.

     The sports card passes [24, 72, 168]. It used to wait for a narrowing
     filter before it appeared at all, because unfiltered it counted the whole
     configured season and that is the most expensive query in the product. A
     day is not, so the card can be on screen from the first paint and the
     reader can widen it as far as a week — the ceiling is the SERVER's and is
     enforced there, this list only decides what is offered. */
  windowOptions?: number[]
  /*
    WHY THE CARD IS NOT COUNTING YET, or empty when it is.

    Set, the card draws its full frame with this line in place of the numbers
    and makes NO request. Unset, it counts.

    It exists because the alternative was hiding the card until its scope was
    known, and that is what put the live counts behind a filter: no client
    chosen on the reports page, no asset chosen in War Room, and the strip was
    simply absent — a reader had no way to know it existed, and the page jumped
    when it appeared. The frame is now there from the first paint and says what
    it is waiting for.

    A REASON, not a boolean, because the two callers are waiting on different
    things and "not available" would be the least useful way to say either.

    And it suppresses the FETCH, which is the load-bearing half. Rendering the
    frame while still calling the endpoint would trade a missing card for an
    error one: /api/warroom/realtime answers 422 "Pick at least one asset", and
    the reader would be shown a failure caused by the page, not by anything they
    did.
  */
  waitingFor?: string
  /* What the filter rail currently holds, for the strip along the bottom.

     The card counts by three of these at most — asset, franchise, match day —
     and the rail carries a dozen. Both are listed, and each says which it is:
     an unfiltered live total under a rail set to Spain and Spanish would
     otherwise look like a Spanish figure, and be out by an order of magnitude
     with nothing on screen admitting it.

     `applied` is the whole of that distinction and it is the caller's to state,
     because it is the caller that decides what gets sent. */
  scopeFilters?: ScopeItem[]
  /* ── The card's own three slicers ────────────────────────────────────────

     The option lists for Franchise, Match Day and Asset, as the rail already
     holds them. Passed in rather than fetched here because the rail's lists are
     SCOPED — narrowed by the client, the window and each other — and a card
     fetching its own would offer values the report has already ruled out.

     Absent and the card draws no slicers at all, which is how the War Room and
     every other consumer keeps the card it had.

     They arrive scoped to the REPORT, which is right while the card is
     following it and wrong the moment it is not — see onDimsChange.

     The controls are the card's, and so is what they select: they narrow the
     LIVE figure only and never touch the report below. They start on whatever
     the rail holds, so the card and the panels agree on load; from the first
     one a reader moves, that dimension is the card's own until they put it
     back. See `ov` in the body. */
  dimOptions?: RealtimeDimOptions
  /* ── What this card is counting, back up to whoever supplies the lists ────

     The option lists come in scoped to the report's own filters. That is right
     until the reader moves one of these three HERE, and then the lists are
     describing a scope the count no longer has: with the franchise moved on the
     card and the asset list still the rail's, every fixture in the competition
     the reader just filtered away is still on offer. Picking one asks the
     warehouse for a fixture that cannot be in that franchise — Serie A: Parma
     vs Monza under Belgian Pro League — which is an empty intersection, so the
     card reads 0 while the list it was picked from was still advertising rows
     against it.

     Reported so the supplier can re-list them under what is ACTUALLY being
     counted. Must be a stable callback: it fires whenever the effective three
     change, and a fresh identity each render would make that every render.

     Absent and nothing happens — the lists stay the report's, which is the card
     every consumer had before this. */
  onDimsChange?: (dims: { franchiseName: string; matchDay: string; assetId: string }) => void
  /* WHICH REPORT the card is sitting on, as the section rail keys it.

     Sent so the server can read this section's own layout — the live card's
     platform list is configured per report and per client on the same Report
     Configuration row as its width and its title, and without this the server
     has no way to know which of a client's reports is asking. Absent and
     nothing is folded, which is the card every consumer had before. */
  platformKey?: string
  className?: string
  /* PINNING — the card holding its place while the report scrolls under it.
     Live counts are the reason to leave this screen open, and unpinned they are
     the first thing to leave the viewport.

     The card only draws the control and reports the click; the POSITIONING is
     the page's, because only the page knows what the card is sticky within and
     what it has to sit above. Both props omitted and there is no pin button at
     all, which is how every other consumer keeps the card it already had. */
  pinned?: boolean
  onTogglePin?: () => void
  /* WHAT THIS CARD IS CALLED, and what a reader is told about it before they
     read the number — both set per platform and per client in Report
     Configuration → Page Layout, where the strip is a panel like every chart
     under it. See panelRealtime in go-server/handlers/reportlayout.go.

     `desc` is ADDED to the card's own note, not swapped in for it. That note is
     rebuilt from every reading — the season it covered, what it was narrowed to,
     which platform failed to answer and so why the total is a floor — and none
     of that is knowable to whoever wrote a description months ago. Replacing it
     would trade a live caveat for fixed prose, which is the one exchange a card
     like this must never make. So the admin's paragraph goes FIRST, where it is
     read first, and the live note follows it. */
  title?: string
  desc?: string
}) {
  const [data, setData]   = useState<Payload | null>(null)
  const [err, setErr]     = useState('')
  const [live, setLive]   = useState(true)

  /* Whether a reading the READER asked for is in flight.

     The card re-read in silence. Move a slicer and the previous numbers sat
     there — correct-looking, correctly captioned, still answering the question
     before last — until the new ones swapped in under a total that animates
     between the two anyway. With three pickers on the card that is not a
     nicety: the one thing somebody needs the instant they change a filter is to
     know the figure in front of them is not yet the answer.

     Only for reads somebody asked for. The thirty-second heartbeat passes
     `quiet` — a spinner that reappears on its own twice a minute is noise, and
     it also makes the one that matters indistinguishable from it. */
  const [busy, setBusy] = useState(false)

  /* The rolling window this card is asking for, in hours. Zero — and no control
     drawn — where the caller offered no options, which leaves the window
     entirely to the endpoint, exactly as it was for every consumer before this
     existed.

     The CARD's state, not the page's. It is a property of how somebody is
     reading this one strip, like the pause button and the pin beside it. In the
     page's filter state it would be a report setting, which is a different
     thing — one that would want saving with the layout and carrying in a URL,
     and that would put the live card's window in the same box as the slicers it
     deliberately does not obey. */
  const [hours, setHours] = useState(windowOptions?.[0] ?? 0)

  /* ── What the card's own slicers have been moved to ──────────────────────

     Overrides, NOT values. A key that is absent means "follow the report", and
     a key that is present means the reader set this one on the card — including
     when they set it back to All, which is a deliberate choice and not the same
     as never having touched it.

     That distinction is the whole design. Holding the three as plain values
     seeded from the props would freeze them at whatever the rail held on the
     render the card mounted: pick a franchise in the rail afterwards and the
     card would sit there counting the old one, with two controls on screen
     disagreeing and no way to tell which had won. Held as overrides, an
     untouched dimension tracks the rail for as long as it is untouched, and a
     touched one stays where it was put until "match the report" clears it. */
  const [ov, setOv] = useState<Partial<Record<'franchiseName' | 'matchDay' | 'assetId', string>>>({})
  const setDim = (k: 'franchiseName' | 'matchDay' | 'assetId', v: string) =>
    setOv(o => ({ ...o, [k]: v }))
  const overridden = Object.keys(ov).length > 0

  /* The three as the count will actually use them: the card's own where it has
     one, the report's otherwise. */
  const effFranchise = ov.franchiseName ?? franchise ?? ''
  const effMatchDay = ov.matchDay ?? matchDay ?? ''

  /* The asset is two values — an id to filter by and a name to caption with —
     so the override has to produce both or the card would count one fixture and
     name another. Resolved out of the same option list the picker is drawn
     from, which is the rail's, so the name on the card is the name in the rail.

     `undefined` in `ov` is the untouched case and falls back to the props,
     which is exactly what the page has always passed. */
  const effAssetIds = ov.assetId === undefined
    ? (assetIds ?? [])
    : (ov.assetId ? [ov.assetId] : [])
  const effAssetNames = ov.assetId === undefined
    ? (assetNames ?? [])
    : (dimOptions?.assetId?.find(o => o.key === ov.assetId)?.label
        ? [dimOptions.assetId.find(o => o.key === ov.assetId)!.label]
        : [])

  // The rail filters to one asset at a time; the card's picker likewise.
  const effAssetId = effAssetIds[0] ?? ''

  /* The three, back to whoever supplies the option lists — see onDimsChange.
     The EFFECTIVE ones, which is the whole point: the lists have to describe
     the scope the count has, not the one the report has. */
  useEffect(() => {
    onDimsChange?.({ franchiseName: effFranchise, matchDay: effMatchDay, assetId: effAssetId })
  }, [effFranchise, effMatchDay, effAssetId, onDimsChange])

  // Held across refreshes so a failed one can leave the last good numbers up.
  const lastGood = useRef<Payload | null>(null)

  /* Which read is the current one.

     Two can be in flight at once — a slicer moved while the previous answer was
     still coming, or the heartbeat firing into a read somebody asked for — and
     nothing stopped the SLOWER of them landing last. Move from a big franchise
     to a small one quickly and the card settled on the big one's count, under
     the small one's name, and stayed there until the next refresh happened to
     put it right. Numbered, so only the newest answer may write. */
  const run = useRef(0)

  /* The asset scope as ONE string.

     The callers build these arrays inline, so a fresh identity arrives on every
     render — as an effect dependency that is an endless refetch loop, one
     request per render. Joined, the effect re-runs only when the selection
     actually changes. */
  /* The EFFECTIVE assets, so a fixture picked on the card re-reads exactly as
     one picked in the rail does. */
  const assetKey = [...effAssetIds, ...effAssetNames].join(' ')

  const load = useCallback(async (quiet = false) => {
    // Nothing to count yet — see waitingFor. Returning here is what keeps the
    // frame on screen without an error in it.
    if (waitingFor) return
    const seq = ++run.current
    // Before the await, so the very first paint after a picker moves already
    // says so — not the one after the request has been built.
    if (!quiet) setBusy(true)
    try {
      const qs = new URLSearchParams()
      // Repeated rather than comma-joined: an asset name may contain a comma,
      // and the server splits on one.
      for (const a of effAssetNames) qs.append('assetName', a)

      let path: string
      if (source === 'markscan') {
        path = '/api/warroom/realtime'
        /*
          The card's own window, expressed as DATES.

          The warehouse endpoint takes lastHours; MarkScan's does not — it filters
          on a start and end date, so a rolling window has to be turned into one.
          That makes the granularity a whole DAY: "24 hours" is today's date
          window, not the trailing 24 hours to the minute. The caption on the card
          says which window it is showing, which is what stops the difference
          being invisible.

          Worth stating plainly: with its own window the card no longer matches
          the platform strip below it, which covers the report's range. That was
          deliberate in the other direction once — the card exists partly so the
          two agree — but a live card whose default is a 30-day report window is
          not a live card. It says "in the last 24 hours" beside the number, and
          the reader can widen it to the report's range.
        */
        const w = windowDates(hours)
        if (w) {
          qs.set('startDate', w.start)
          qs.set('endDate', w.end)
        } else {
          if (startDate) qs.set('startDate', startDate)
          if (endDate) qs.set('endDate', endDate)
        }
        // Staff viewing a client's War Room: the same field the report sends,
        // so both resolve the same MarkScan token.
        if (userId) qs.set('clientUserId', String(userId))
      } else {
        path = `/api/realtime/${view}`
        if (clientId) qs.set('clientId', clientId)
        if (userId) qs.set('userId', String(userId))
        for (const a of effAssetIds) qs.append('assetId', a)
        /* The window the report is showing. Without it the service was asked
           for every row it holds and answered 504 — see the note on
           scopeFromRequest. */
        if (startDate) qs.set('from', startDate)
        if (endDate) qs.set('to', endDate)
        // Under the same names the report's own slicers use, so one vocabulary
        // covers the panels and the card.
        if (effFranchise) qs.set('franchiseName', effFranchise)
        if (effMatchDay) qs.set('matchDay', effMatchDay)
        /* And the rolling window, which REPLACES the dates above rather than
           narrowing them — see scopeFromRequest in realtime.go. Sent only where
           the caller offered the control, so nothing that did not opt in has
           its window moved underneath it. */
        if (hours > 0) qs.set('lastHours', String(hours))
        // Which report this is, so the server reads this section's own platform
        // configuration — see realtimeRollupFor.
        if (platformKey) qs.set('platformKey', platformKey)
      }

      const r = await fetch(`${path}?${qs}`, { credentials: 'include' })
      const j = await r.json()
      // Superseded while this was in the air. Dropped rather than drawn: it is
      // an answer to a question nobody is asking any more.
      if (seq !== run.current) return
      if (!j.ok && !j.success) throw new Error(j.error || 'Could not read the live counts')
      setData(j); lastGood.current = j; setErr('')
    } catch (e: any) {
      // Same rule for the failure. A superseded read that failed must not put
      // an error over numbers the read after it is about to replace anyway.
      if (seq !== run.current) return
      setErr(e?.message || 'Network error')
    } finally {
      /* Cleared by whichever read is the LATEST when it finishes — not only by
         the one that raised it. A heartbeat that supersedes a reader's read
         would otherwise leave the indicator up with nothing left to clear it.

         In `finally`, because a read that failed still finished, and a card
         left marked busy would hide the error behind a signal that never
         stops. */
      if (seq === run.current) setBusy(false)
    }
    /* The EFFECTIVE dimensions, not the props. A slicer moved on the card has
       to re-read, and one moved in the rail has to re-read too — unless the
       card has taken that dimension over, which is what `ov` decides. Listing
       the props here would leave the card's own controls inert. */
  }, [view, source, clientId, userId, assetKey, startDate, endDate, effFranchise, effMatchDay, hours, platformKey, waitingFor])

  useEffect(() => { load() }, [load])

  /* Paused while the tab is hidden. A card left open on a second monitor
     overnight would otherwise run twelve hundred counts against the warehouse
     that nobody was ever going to read. */
  useEffect(() => {
    // Not while waiting: a timer firing a call that returns immediately is
    // harmless, but it also never stops, and the card would keep a thirty-second
    // heartbeat going for a scope that does not exist.
    if (!live || waitingFor) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => { timer ??= setInterval(() => load(true), REFRESH_MS[source] ?? 60_000) }
    const stop  = () => { if (timer) { clearInterval(timer); timer = null } }
    const onVis = () => (document.visibilityState === 'visible' ? (load(true), start()) : stop())

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [live, load, source, waitingFor])

  const shown = data ?? lastGood.current
  const stale = !!err && !!shown

  /* Above the loading and error returns, deliberately. React identifies a hook
     by call order, so one that runs only once there is something to show would
     change the order on the render where the first reading lands. */
  const total = useCountUp(shown?.total ?? 0)
  const totalBumped = useBumped(shown?.total ?? 0)
  /* Animated on the same terms as the total — it is the other half of the same
     reading and a still number beside a travelling one reads as the stale one.
     Seeded from 0 where the view reports no removals, which is never drawn. */
  const removed = useCountUp(shown?.totalRemoved ?? 0)

  /* A first load that timed out is still counting somewhere, not broken. The
     raw "context deadline exceeded" was true and unreadable; this says what to
     expect. Once any reading has landed the normal stale path takes over and
     the last good numbers stay on screen. */
  /*
    Waiting for a scope. FIRST of the early returns, because it is the only one
    that is not a failure — the card has not been asked to count anything yet,
    so an error or a skeleton would both be describing something that has not
    happened.

    The window control still draws. It is the reader's, not the report's, and
    setting it before the scope arrives is a perfectly ordinary thing to do.
  */
  if (waitingFor) {
    return (
      <div className={`min-w-0 bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-5 ${className}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-bold text-[#14254A] dark:text-white">{title}</h3>
          <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5
            rounded bg-gray-100 dark:bg-white/10 text-gray-400 dark:text-white/40">Live</span>
        </div>
        <p className="text-xs text-gray-500 dark:text-white/50 mt-1.5">{waitingFor}</p>
        {windowOptions && windowOptions.length > 1 && (
          <WindowPicker options={windowOptions} value={hours} onChange={setHours} className="mt-3" />
        )}
      </div>
    )
  }

  const counting = !shown && /deadline|timeout|timed out/i.test(err)
  if (counting) {
    return (
      <div className={`min-w-0 bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-5 ${className}`}>
        <h3 className="font-bold text-[#14254A] dark:text-white">{title}</h3>
        <p className="text-xs text-gray-500 dark:text-white/50 mt-1">
          Still counting — the first reading for this client takes a while.
          It will appear here and then refresh on its own.
        </p>
        {/* The control stays reachable while it counts. A window that timed out
            is the ONE moment a reader most wants a narrower one, and hiding the
            buttons behind the reading leaves them waiting on the very query
            they would have cancelled. */}
        {windowOptions && windowOptions.length > 1 && (
          <WindowPicker options={windowOptions} value={hours} onChange={setHours} className="mt-3" />
        )}
      </div>
    )
  }
  if (!shown && err) {
    return (
      <div className={`bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-6 ${className}`}>
        <h3 className="font-bold text-[#14254A] dark:text-white">{title}</h3>
        <p className="text-xs text-red-600 mt-2">{err}</p>
      </div>
    )
  }
  if (!shown) {
    return (
      <div className={`bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-6 ${className}`}>
        <h3 className="font-bold text-[#14254A] dark:text-white">{title}</h3>
        {/* Sized like the loaded strip, so the page does not jump when the
            first reading lands. */}
        <div className="mt-3 flex flex-col lg:flex-row gap-6 animate-pulse">
          <div className="lg:w-64 lg:flex-shrink-0 space-y-2">
            <div className="h-8 w-32 rounded bg-gray-100 dark:bg-white/10" />
            <div className="h-3 w-24 rounded bg-gray-100 dark:bg-white/10" />
          </div>
          <div className="flex-1 grid gap-x-6 gap-y-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="h-3 w-full rounded bg-gray-100 dark:bg-white/10" />
                <div className="h-1 w-full rounded bg-gray-100 dark:bg-white/10" />
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const allPlatforms = shown.platforms ?? []

  /* ── Which platforms are drawn ─────────────────────────────────────────────

     Sports hides the empty ones; the war room keeps them. Two answers because
     the two cards are read for different things: the war room is a watch list,
     where "watched, found nothing" is the finding, and the sports card sits over
     a report about one competition, where fourteen rows of nothing bury the
     three that moved.

     WHAT WAS HIDDEN IS NOT REPORTED. A count of it used to go under the grid,
     on the reasoning that a list which silently changes length is the failure
     the war room's rule exists to avoid, so hiding the empties was only
     acceptable if the card said it happened. That line is gone by request, and
     the reasoning it stood on goes with it rather than being left half-applied:
     the sports card is read for what was found, and the roster of platforms
     being watched is configuration rather than a finding of this window.

     The war room still keeps its zeroes, which is the part that actually
     mattered — there, "watched, found nothing" IS the finding. */
  const hidesEmpty = view === 'sports'
  const platforms = hidesEmpty ? allPlatforms.filter(p => p.count > 0) : allPlatforms

  /* EVERY platform, always, each in its own cell.

     They were collapsed to the ones that had found something, with the rest
     summarised as "11 platforms found nothing". That reads as tidy and is
     wrong for this card: the question it answers is "what is being watched and
     what is it finding", and a platform reporting zero is half of that answer.
     Rolled into a count, OK.ru finding nothing and Dailymotion finding nothing
     become one anonymous number — and the reader cannot tell a quiet platform
     from one that has silently stopped being scanned, which is the failure this
     card exists to make visible.

     Thirteen cells across a five-column grid is three short rows, so showing
     them all costs almost nothing in height. */
  /* The busiest platform, for the volume bars.

     Only reached where the view does NOT count removals — see the bar itself
     for why. Relative to the busiest platform rather than to the total, because
     with one platform holding most of the volume a share of the total renders
     every other bar as an invisible sliver. Which, it turned out, is what
     happened to the removal split drawn inside these lengths, and is why the
     two readings no longer share a bar. */
  const peak = Math.max(1, ...platforms.map(p => p.count))

  /* Whether this reading CARRIES removals at all.

     `typeof`, not truthiness: a client whose every discovered URL is still up
     answers 0, and 0 is the finding. `!!shown.totalRemoved` would hide exactly
     the reading somebody needs to see and make it indistinguishable from the
     war-room view, which never counts removals at all. */
  const hasRemovals = typeof shown.totalRemoved === 'number'

  /* The share — and only where dividing is honest.

     A platform that could not be counted makes BOTH numbers floors, and a
     percentage of two floors renders as though it were exact. The service
     refuses to send this figure for that reason and leaves the ratio to
     whoever knows whether the reading was complete; here, that is `partial`. */
  const removalRate = hasRemovals && shown.total > 0 && !shown.partial
    ? Math.round(((shown.totalRemoved ?? 0) / shown.total) * 100)
    : null

  /* ── What the strip along the bottom says the count was narrowed by ────────

     The rail's chips with the card's own three folded in.

     Passed straight through, the strip described the REPORT while the pickers a
     few lines above it described the COUNT — pick a franchise on the card and
     the line underneath still read "No filters · counting every asset for this
     client — pick one in the rail", directly below the control that had just
     been used and about a number that was no longer the whole client's.

     So for the three dimensions the card can take over, what is named here is
     what was actually counted: marked as set on the card, and carrying the
     report's own value in the tooltip where the two have parted. A dimension
     the reader CLEARED here keeps the rail's chip, struck through — from the
     number's point of view that is exactly what a filter the count does not
     honour looks like. */
  const scopeItems: ScopeItem[] | undefined = scopeFilters && (() => {
    const owned = {
      franchiseName: effFranchise,
      matchDay: effMatchDay,
      assetId: effAssetId,
    }
    const fallbackLabel: Record<keyof typeof owned, string> = {
      franchiseName: 'Franchise', matchDay: 'Match Day', assetId: 'Asset',
    }
    /* The asset is an id, so it is captioned by the NAME the picker resolved —
       never the GUID. The other two are already names. */
    const display = (k: keyof typeof owned, v: string) =>
      (k === 'assetId' ? effAssetNames[0] : undefined)
        ?? dimOptions?.[k]?.find(o => o.key === v)?.label
        ?? v

    const mine: ScopeItem[] = []
    for (const k of ['franchiseName', 'matchDay', 'assetId'] as const) {
      const rail = scopeFilters.find(i => i.key === k)
      const v = owned[k]
      if (v) {
        const value = display(k, v)
        mine.push({
          key: k,
          label: rail?.label ?? fallbackLabel[k],
          value,
          applied: true,
          onCard: ov[k] !== undefined,
          reportValue: rail && rail.value !== value ? rail.value : undefined,
        })
      } else if (rail) {
        mine.push({ ...rail, applied: false, onCard: ov[k] !== undefined })
      }
    }
    // The three first, then everything the rail carries that the card cannot
    // count — the order the reader reads them in is applied, then not.
    return [...mine, ...scopeFilters.filter(i => !(i.key in owned))]
  })()

  /* The slicers the caller actually has options for. A control with nothing in
     it but "All" cannot be used, and three of them would be a bar across the
     foot of the card that does nothing. Built as a list so the bar can ask
     whether there are any before it draws a border. */
  const pickers = dimOptions ? [
    dimOptions.franchiseName?.length ? (
      <DimPicker key="franchiseName" label="Franchise" value={effFranchise}
        options={dimOptions.franchiseName}
        overridden={ov.franchiseName !== undefined}
        onChange={v => setDim('franchiseName', v)} />
    ) : null,
    dimOptions.matchDay?.length ? (
      <DimPicker key="matchDay" label="Match Day" value={effMatchDay}
        options={dimOptions.matchDay}
        overridden={ov.matchDay !== undefined}
        onChange={v => setDim('matchDay', v)} />
    ) : null,
    dimOptions.assetId?.length ? (
      <DimPicker key="assetId" label="Asset" value={effAssetId}
        options={dimOptions.assetId}
        overridden={ov.assetId !== undefined}
        onChange={v => setDim('assetId', v)} />
    ) : null,
  ].filter(Boolean) : []

  /* What the strip under the bar still has to say.

     With the three controls now sitting at the foot of the card showing their
     own values, a chip repeating "Franchise: Serie A" a few pixels under the
     dropdown that reads "Serie A" is the same fact printed twice. So where
     there are controls, the strip drops what they ALREADY SAY and keeps only
     what they cannot: a filter the live tables carry no column for, and one
     the reader cleared here while the report below is still narrowed by it.
     Nothing left to say and there is no strip at all.

     Where there are NO controls — the War Room passes no options — it keeps
     the whole list, because then the strip is the only thing on the card that
     names the scope. */
  const stripItems = scopeItems && (pickers.length > 0
    ? scopeItems.filter(i => !i.applied)
    : scopeItems)

  return (
    <div aria-busy={busy}
      className={`relative bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 ${className}`}>
      {/* ── The read in flight ──────────────────────────────────────────────

          A sweep along the top edge of the WHOLE card, not a spinner in the
          corner of the column that changed. Both columns are re-read by one
          request and both are about to move, so marking one of them would be
          saying the other had settled.

          Indeterminate on purpose. The count reports no progress, and a bar
          that fills would be inventing one. */}
      {busy && (
        <div className="absolute inset-x-0 top-0 h-0.5 z-10 overflow-hidden rounded-t-2xl
          bg-[#FC934C]/20 pointer-events-none">
          <div className="h-full w-1/3 rounded-full bg-[#FC934C] sweep" />
        </div>
      )}

      {/* ── The strip ────────────────────────────────────────────────────────
          Horizontal, not a column. As a narrow card this was three inches wide
          and thirteen rows tall next to an empty half-screen — it pushed the
          KPI tiles below the fold to show mostly zeros. The headline sits on the
          left at a fixed width and the platforms flow across the rest, so the
          card is as wide as the frame and about as tall as one KPI tile. */}
      <div className="flex flex-col lg:flex-row lg:items-stretch">

        <div className="px-5 py-4 lg:w-64 lg:flex-shrink-0 lg:border-r border-b lg:border-b-0
          border-gray-100 dark:border-white/10">
          <div className="flex items-start justify-between gap-2">
            {/* The heading and its note together. "Realtime" names the card but
                says nothing about WHAT was counted or over what window, and the
                three ways this figure differs from the tiles below it are not
                guessable from anything on screen — see scopeNote. */}
            <h3 className="font-bold text-[#14254A] dark:text-white leading-tight flex items-center gap-1.5">
              {title}
              {/* The configured description where there is one, the card's own
                  note where there is not — see `desc` above. Trimmed before the
                  test so a description of nothing but spaces reads as none,
                  rather than as a blank tooltip that has replaced a useful one. */}
              <InfoDot text={desc?.trim() || scopeNote(shown, REFRESH_MS[source] ?? 60_000)} />
            </h3>
            <span className="flex items-center gap-1.5 flex-shrink-0">
              {/* While a read the reader asked for is in flight, how old the
                  reading on screen is happens to be the one fact that misleads:
                  "just now" over numbers that answer the PREVIOUS filter is the
                  sentence that made the swap invisible. */}
              {busy
                ? <span className="inline-flex items-center gap-1 flex-shrink-0 text-[10px]
                    font-semibold uppercase tracking-wide text-[#FC934C]">
                    <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-current
                      border-r-transparent animate-spin" />
                    Updating
                  </span>
                : <RelativeTime iso={shown.asOf} stale={stale} />}
              {onTogglePin && (
                /* Filled and brand-coloured when pinned, hollow and grey when
                   not — the state has to be readable from the icon itself,
                   since the card looks the same either way until the page is
                   scrolled. */
                <button type="button" onClick={onTogglePin}
                  /* Dropped from a printed page — see lib/printReport. Where
                     the card sits while the report scrolls is a fact about the
                     screen and about nothing else. */
                  data-print-hide=""
                  aria-pressed={!!pinned}
                  title={pinned
                    ? 'Unpin — let the card scroll away with the report'
                    : 'Pin — keep the card in view while the report scrolls'}
                  className={`w-6 h-6 grid place-items-center rounded-md transition-colors ${
                    pinned
                      ? 'text-[#FC934C] bg-[#FC934C]/10'
                      : 'text-gray-300 hover:text-[#14254A] hover:bg-[#14254A]/[0.06] dark:text-white/25 dark:hover:text-white dark:hover:bg-white/10'
                  }`}>
                  <svg width="13" height="13" viewBox="0 0 24 24"
                    fill={pinned ? 'currentColor' : 'none'} stroke="currentColor"
                    strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 17v5" />
                    <path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                  </svg>
                </button>
              )}
            </span>
          </div>

          {/* Dimmed while it is being replaced. The total counts UP to its new
              value, so without this the digits move for a second with nothing
              on screen saying why — indistinguishable from the live drift the
              card does on its own. */}
          <p className={`mt-2 text-3xl font-bold tabular-nums tracking-tight leading-none
            transition-[color,opacity] duration-500 ${busy ? 'opacity-40' : ''} ${
            totalBumped ? 'text-[#FC934C]' : 'text-[#14254A] dark:text-white'}`}>
            {nf.format(total)}
          </p>
          {/* No window in the words, because there is none in the number. It
              is every infringement found for this client, which is what makes
              it comparable with the headline figures below it. */}
          {/* What the figure covers — the WINDOW and the assets.

              It said "all time" unconditionally, which stopped being true the
              moment a date range was passed, and the War Room always passes the
              one its report was generated for. A live number carrying the wrong
              scope in its caption is worse than one carrying none: it invites
              exactly the comparison it will fail. */}
          <p className="text-[11px] text-gray-500 dark:text-white/50 mt-1">
            {/* "identified" where a removed figure sits under it, because that
                is the pair the report below the card names its own columns —
                identified and removed. On its own it is just what was found. */}
            {hasRemovals ? 'identified' : 'found'} · {rangeWords(shown)}
            {!!shown.assets && shown.assets > 0 && (
              <> · {shown.assets} asset{shown.assets === 1 ? '' : 's'}</>
            )}
          </p>

          {hasRemovals && (
            /* UNDER the identified total, not beside it, and DIRECTLY under it.

               Side by side they read as two independent figures a reader has to
               relate themselves. Stacked, with the share bar between them, this
               number reads as what it is: a part of the one above it — which is
               only true while nothing sits between them. The window and the
               three slicers used to, so the pair the card exists to show was
               split by half a column of controls; they are grouped below now,
               and this is back against the figure it belongs to.

               SET IN THE SAME TYPE AS THE IDENTIFIED TOTAL — same size, weight,
               tracking and tabular figures. It was a step smaller, on the
               reasoning that the subordinate figure should look subordinate;
               the position and the rule above it already say that, and two
               sizes made the pair read as a headline with a footnote rather
               than as the two halves of one measure. Any change to the type
               above belongs here too.

               Orange is removed and navy is identified throughout this product —
               the same two roles the report's own charts use — so the bar needs
               no words to be read the right way round. */
            <div className="mt-2.5 pt-2.5 border-t border-gray-100 dark:border-white/10">
              {/* WRAPS AS A WHOLE, which matters now the figure is full size.
                  In the card's 262px column "de-indexed / removed · 74%" no
                  longer fits beside a text-3xl number, and without this it broke
                  mid-phrase into a two-line sliver ("de-indexed /" over
                  "removed · 74%"). Allowed to wrap, the label drops below the
                  number and gets the full width; a short one ("removed") still
                  sits on the baseline beside it. */}
              <p className="flex items-baseline gap-2 flex-wrap">
                <span className="text-3xl font-bold tabular-nums tracking-tight leading-none text-[#FC934C]">
                  {nf.format(removed)}
                </span>
                {/* The same word the bars below use, and for the same reason:
                    this total SUMS the two measures, so calling it "removed"
                    mislabels whichever part of it was a de-indexing. Where the
                    platforms agree it reads as one word and nothing changes. */}
                <span className="text-[11px] text-gray-500 dark:text-white/50">
                  {removedWords(platforms).join(' / ')}
                  {removalRate !== null && <> · {removalRate}%</>}
                </span>
              </p>
              {/* Drawn only where the percentage above it was. A bar IS a
                  percentage, and one drawn from a reading we have just declined
                  to divide would make the same exact-looking claim in a form
                  that cannot be qualified. */}
              {removalRate !== null && (
                <div className="mt-1.5 h-1 rounded-full bg-[#14254A]/15 dark:bg-white/15 overflow-hidden"
                  title={`${nf.format(shown.totalRemoved ?? 0)} of ${nf.format(shown.total)} taken down`}>
                  <div className="h-full rounded-full bg-[#FC934C] transition-[width] duration-500"
                    style={{ width: `${removalRate}%` }} />
                </div>
              )}
            </div>
          )}

          {/* ── The window ─────────────────────────────────────────────────

              The one control that stays in the column, because it belongs to
              the figure directly above it: it decides the span that figure
              counts, and the caption under the number names it in words. The
              three slicers went to the foot of the card — see the bar below,
              and the note on it for why.

              Behind a rule, so the column still reads as figures first and
              controls second rather than as one undifferentiated stack. */}
          {windowOptions && windowOptions.length > 1 && (
            <div className="mt-3 pt-3 border-t border-gray-100 dark:border-white/10">
              <WindowPicker options={windowOptions} value={hours} onChange={setHours} />
            </div>
          )}

          <button
            type="button"
            onClick={() => setLive(v => !v)}
            title={live ? 'Pause the live refresh' : 'Resume the live refresh'}
            className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-white/60
              hover:text-[#14254A] dark:hover:text-white transition-colors"
          >
            {/* A ring that expands and fades out of the dot — a radar sweep
                rather than a fade in place. `animate-pulse` alone dims and
                brightens, which reads as a disabled control as easily as a live
                one. */}
            <span className="relative flex w-1.5 h-1.5">
              {live && !stale && (
                <span className="absolute inline-flex w-full h-full rounded-full bg-[#FC934C] opacity-75 animate-ping" />
              )}
              <span className={`relative inline-flex w-1.5 h-1.5 rounded-full ${
                busy ? 'bg-[#FC934C]' : stale ? 'bg-amber-500' : live ? 'bg-[#FC934C]' : 'bg-gray-300'}`} />
            </span>
            {/* "Updating live" is about the heartbeat and stays true while a
                read is in flight — but it is not what is happening RIGHT NOW,
                and the foot of the column is where a reader looks to find out.
                It goes back to its own words the moment the reading lands. */}
            {busy ? 'Updating…' : stale ? 'Reconnecting' : live ? 'Updating live' : 'Paused'}
          </button>

          {stale && (
            <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1.5 leading-snug">
              Last good reading — {err}
            </p>
          )}
          {/* A short total is worse than an error, because it looks like an
              answer. Said out loud rather than left to be inferred from a
              platform sitting at zero. */}
          {!stale && !!shown.partial && shown.partial > 0 && (
            <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1.5 leading-snug">
              {shown.partial} platform{shown.partial === 1 ? '' : 's'} did not answer — this total is short
            </p>
          )}
        </div>

        <div className={`flex-1 min-w-0 px-5 py-4 transition-opacity duration-300 ${
          stale ? 'opacity-60' : busy ? 'opacity-40' : ''}`}>
          {platforms.length === 0 ? (
            /* Nothing to draw, for one of two very different reasons. An empty
               RANGE is the ordinary one and says so in one line; NO PLATFORMS
               CONFIGURED is a report about the setup, and it keeps its own
               wording because it is the only one of the two a reader can act on
               — folded into "no data" it would read as a quiet week and the
               missing configuration would never be chased.

               The empty-range line used to count the platforms it had looked at
               ("Nothing found on any of the 15 platforms watched in this
               range"), with a second line under the grid repeating the same
               fifteen as "watched with nothing found — hidden". Both are gone;
               neither the empty state nor a populated one reports the roster
               now. */
            <p className="text-sm text-gray-400">
              {allPlatforms.length > 0
                ? 'No data found for the selected date range.'
                : 'No platforms are configured for this view.'}
            </p>
          ) : (
            /* A responsive grid rather than a list: at this width a column of
               rows wastes four-fifths of the space it is given. Five columns at
               the widest lays thirteen platforms out in three short rows. */
            <div className="grid gap-x-6 gap-y-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {platforms.map(p => {
                /* Absent means NOT ANSWERED — this view does not count removals,
                   or this platform could not be counted at all. Either way the
                   cell says nothing rather than drawing a zero, which would read
                   as "watched, nothing taken down" on a platform nobody looked
                   at. Clamped because a share above 100% is a bug rendering as
                   a full bar, which hides it. */
                const rem = typeof p.removed === 'number' ? Math.min(p.removed, p.count) : null
                const share = rem !== null && p.count > 0 ? Math.round((rem / p.count) * 100) : 0
                /* The bar's own share, UNROUNDED and with a floor.

                   Rounded, a platform with one removal out of twenty-six
                   thousand draws a 0%-wide mark — nothing — under a caption
                   that says one was removed. The floor is the standard
                   minimum-mark convention: past a couple of pixels the eye
                   cannot read the difference anyway, and "some came down" is
                   the signal that must survive. The exact figure is printed
                   underneath either way. */
                const exact = rem !== null && p.count > 0 ? (rem / p.count) * 100 : 0
                const fill = rem !== null && rem > 0 ? Math.max(2, exact) : exact
                return (
                  <div key={p.key}
                    title={`${p.label} — ${nf.format(p.count)} identified${
                      rem !== null ? `, ${nf.format(rem)} ${removedWord(p.removalBasis)}` : ''}${
                      rem !== null && p.removalBasis ? ` (${p.removalBasis})` : ''}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`text-xs truncate ${p.count > 0
                        ? 'text-[#14254A] dark:text-white font-medium'
                        : 'text-gray-400 dark:text-white/40'}`}>
                        {p.label}
                      </span>
                      <span className={`text-sm tabular-nums flex-shrink-0 ${p.count > 0
                        ? 'text-[#14254A] dark:text-white font-bold'
                        : 'text-gray-300 dark:text-white/25'}`}>
                        {nf.format(p.count)}
                      </span>
                    </div>
                    {/* ── WHAT THE BAR MEASURES, AND WHY IT CHANGED ────────

                        It used to be VOLUME — this platform's count against the
                        busiest platform's — with the removal split drawn inside
                        that length. On a real reading that made the split
                        unreadable on every row but one. Open Web holds 26,613
                        of 27,294; against that peak, Telegram's 240 is a bar
                        nine tenths of one percent wide, and a 45% removal
                        inside nine tenths of a percent is a fraction of a
                        pixel. Every platform bar on the card except the biggest
                        was a coloured speck, and the removal figures underneath
                        them were the only place the reading existed at all.

                        So where the view answers on removals, the bar measures
                        THE REMOVAL SHARE and spans the whole cell. That is the
                        one thing on this card that IS comparable between a
                        platform with 26,613 and one with 15 — volume is not, and
                        volume is already carried twice over: by the figure in
                        bold beside the name, and by the order, which runs
                        busiest first.

                        Where the view does not count removals at all — the war
                        room is one — there is no share to draw and the bar goes
                        back to being volume against the peak, which is then the
                        only thing it can honestly say. */}
                    <div className="mt-1 h-1 rounded-full bg-gray-100 dark:bg-white/10 overflow-hidden">
                      {!hasRemovals ? (
                        /* Floored at 2%, for the same reason the removal fill
                           is: against a peak of 26,613 a platform holding 240
                           is nine tenths of one percent of the cell and draws
                           as nothing, which reads as "found none" on a platform
                           that found 240. Two percent is still visibly almost
                           nothing, which is the truth. */
                        <div className="h-full rounded-full bg-[#FC934C] transition-[width] duration-500"
                          style={{ width: `${p.count > 0 ? Math.max(2, (p.count / peak) * 100) : 0}%` }} />
                      ) : rem === null ? (
                        /* This view counts removals and this platform did not
                           answer on them. An empty track, because any fill here
                           would be a claim: orange would read as removed and
                           grey as active, and neither was measured. The
                           caption below is absent for the same reason. */
                        null
                      ) : (
                        <div className="h-full flex">
                          <span className="h-full bg-[#FC934C] transition-[width] duration-500"
                            style={{ width: `${fill}%` }} />
                          <span className="h-full bg-[#14254A]/25 dark:bg-white/30"
                            style={{ width: `${100 - fill}%` }} />
                        </div>
                      )}
                    </div>
                    {rem !== null && (
                      <p className="mt-0.5 text-[10px] tabular-nums text-gray-400 dark:text-white/40 truncate">
                        {nf.format(rem)} {removedWord(p.removalBasis)}{p.count > 0 && <> · {share}%</>}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Named once rather than in every cell. Without it the two-tone bars
              are a colour scheme; with it they are a reading. Only where the
              view answered on removals — a legend for a series that is not on
              screen is worse than none. */}
          {/* NO "n platforms watched with nothing found — hidden" LINE.

              It used to sit here, on the reasoning that a list which silently
              changes length between refreshes is the thing the war room's
              keep-the-zeroes rule exists to prevent, so hiding the empties was
              only safe if the card admitted it. Removed by request: the card is
              read for what was FOUND, and a reader watching one competition does
              not need a running tally of the platforms that turned up nothing —
              the platform roster is a matter of configuration, not of this
              window's findings.

              Nothing else depended on it, so the count itself is gone too rather
              than left computed and unused — see the note beside `platforms`. */}

          {hasRemovals && platforms.length > 0 && (
            <p className="mt-2 flex items-center gap-3 text-[10px] text-gray-400 dark:text-white/40">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-1 rounded-full bg-[#FC934C]" />{removedWords(platforms).join(' / ')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-1 rounded-full bg-[#14254A]/25 dark:bg-white/30" />active
              </span>
            </p>
          )}

          {/* WHAT THIS READING IS OF, in the corner.

              A TITLE with a tooltip, not a printout. Spelled out inline it ran
              to "LaLiga: Barcelona vs Athletic (28-08-2026) · LaLiga · Match day
              Matchday 1 · 1 Aug 2026 – 31 Dec 2026" — wider than the platform
              grid above it and competing with the figures for attention, which
              is the opposite of what a caption is for.

              So the line is truncated to one row and the whole of it is on
              `title`. Quiet, bottom right, and complete on hover. */}
          {(() => {
            const bits = scopeBits({
              /* The EFFECTIVE three. The caption names what was counted, and
                 once a slicer has been moved on the card the props are what the
                 report below is showing rather than what this figure is. */
              assetNames: effAssetNames,
              assets: shown.assets,
              franchise: effFranchise || undefined,
              matchDay: effMatchDay || undefined,
              /* The reading's OWN dates, not the props'. On a sports report the
                 card is scoped to the configured season and the props carry the
                 picker's range, so printing the props would caption the figure
                 with a window it was not counted over. */
              startDate: shown.startDate,
              endDate: shown.endDate,
              scope: shown.scope,
              // Same rule, same reason: the window the reading COVERS, not the
              // one the buttons are currently set to. A click re-reads, and for
              // that half-second the two disagree.
              windowHours: shown.windowHours,
            })
            if (bits.length === 0) return null
            const full = bits.join(' · ')
            return (
              <p
                title={full}
                className="mt-2 text-right text-[10px] leading-4 text-gray-400 dark:text-white/40
                           truncate cursor-default"
              >
                {full}
              </p>
            )
          })()}
        </div>
      </div>

      {/* ── What the filter rail holds, along the bottom ─────────────────────
          Under BOTH columns rather than in either, because it qualifies both:
          the headline total and every platform bar beside it were counted under
          exactly these filters. In the left column it would read as a footnote
          to the number; in the right, as one to the grid.

          Only where the caller passes the list. Every consumer that had this
          card before passes nothing and keeps the card it had. */}
      {/* ── The card's own three slicers, across the foot ────────────────────

          Under BOTH columns, not inside the left one.

          They were stacked down the headline column, which is 256px wide and
          already carrying a 3xl figure, its caption, the removed half, its
          share bar and the window. Three labelled dropdowns under all of that
          made the column half again as tall as the platform grid beside it, so
          the card grew a foot of empty space to the right of the numbers and
          the strip stopped being a strip.

          Along the bottom they run left to right in the width the card actually
          has, they read as one filter bar rather than as three more rows of a
          column, and each control gets 160px instead of 120 — which is the
          difference between reading a fixture name and reading the first two
          words of one.

          Below the platform grid rather than above it because they qualify
          BOTH halves: the headline total and every bar beside it were counted
          under exactly these. */}
      {pickers.length > 0 && (
        <div className="px-5 py-3 border-t border-gray-100 dark:border-white/10
          flex flex-wrap items-center gap-x-6 gap-y-2.5">
          {pickers}
          {/* Offered only once something has been moved, and it is the ONE way
              back. Without it a reader who has narrowed the card by hand has no
              way to tell it to follow the report again short of guessing which
              values the rail holds — and the card would quietly keep answering
              about a different fixture for the rest of the session. */}
          {overridden && (
            <button type="button" onClick={() => setOv({})}
              title="Drop the filters set here and follow the report's own again"
              className="text-[10px] font-semibold text-[#FC934C] hover:underline">
              match the report
            </button>
          )}
        </div>
      )}

      {stripItems && stripItems.length > 0 && <ScopeStrip items={stripItems} />}
    </div>
  )
}

/**
 * How old the reading is.
 *
 * "Now" would be a lie the moment a refresh fails, and the failure is silent by
 * design — the numbers stay on screen. This is what tells a reader the card has
 * stopped moving.
 */
function RelativeTime({ iso, stale }: { iso: string; stale: boolean }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 10_000)
    return () => clearInterval(t)
  }, [])

  const at = new Date(iso)
  if (isNaN(at.getTime())) return null
  const secs = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000))
  const text = secs < 15 ? 'just now'
    : secs < 90 ? `${secs}s ago`
    : secs < 5400 ? `${Math.round(secs / 60)} min ago`
    : `${Math.round(secs / 3600)} h ago`

  return (
    <span className={`text-[11px] whitespace-nowrap ${stale ? 'text-amber-600' : 'text-gray-400 dark:text-white/40'}`}
      title={at.toLocaleString()}>
      {text}
    </span>
  )
}
