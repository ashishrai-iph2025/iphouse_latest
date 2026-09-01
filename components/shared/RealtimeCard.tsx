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

import { useCallback, useEffect, useRef, useState } from 'react'

import InfoDot from '@/components/shared/InfoDot'

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
  /** Where that window came from. 'period' is the client's configured sports
      season, which no slicer on the page can move — the caption says so rather
      than calling it "this range". Absent on sources that do not report it. */
  scope?: 'period' | 'request' | string
  /** How many platforms failed on this reading. The rest are still shown. */
  partial?: number
  asOf: string
  error?: string
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
function rangeWords(p: { startDate?: string; endDate?: string; scope?: string }) {
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

function scopeNote(p: Payload, refreshMs: number): string {
  const paras: string[] = []
  const span = p.startDate && p.endDate
    ? `${dayWords(p.startDate)} and ${dayWords(p.endDate)}`
    : ''

  /* WHAT and WHEN. The sports card names its season and says outright that the
     date slicer does not reach it — a control that appears to act on a figure
     it cannot touch is worth one sentence to close off. */
  if (p.scope === 'period') {
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
How often the card re-reads, per source.

'markscan' is 30s. It runs the War Room's own incremental pull — a delta against
the stored rows, so a quiet half-minute costs one small request per platform and
nothing is re-paged.

'warehouse' is 5 minutes. That one is a count per platform over a whole sports
season — measured at 14.5s against production, against 1.4s for a week — and it
once blew a 30-second deadline as an all-time query. A number covering months
does not move meaningfully in a minute, and polling it faster than it can be
computed just queues scans behind each other. The server also shares one answer
across tabs for two minutes, and the window no longer moves with the date
slicer, so the real cost is well under one query per five.

Either way the "x ago" stamp says how fresh the number is, so a slower cadence
is visible rather than implied.
*/
const REFRESH_MS: Record<string, number> = { markscan: 30_000, warehouse: 300_000 }

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
  className = '',
  pinned,
  onTogglePin,
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
}) {
  const [data, setData]   = useState<Payload | null>(null)
  const [err, setErr]     = useState('')
  const [live, setLive]   = useState(true)

  // Held across refreshes so a failed one can leave the last good numbers up.
  const lastGood = useRef<Payload | null>(null)

  /* The asset scope as ONE string.

     The callers build these arrays inline, so a fresh identity arrives on every
     render — as an effect dependency that is an endless refetch loop, one
     request per render. Joined, the effect re-runs only when the selection
     actually changes. */
  const assetKey = [...(assetIds ?? []), ...(assetNames ?? [])].join(' ')

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      // Repeated rather than comma-joined: an asset name may contain a comma,
      // and the server splits on one.
      for (const a of assetNames ?? []) qs.append('assetName', a)

      let path: string
      if (source === 'markscan') {
        path = '/api/warroom/realtime'
        if (startDate) qs.set('startDate', startDate)
        if (endDate) qs.set('endDate', endDate)
        // Staff viewing a client's War Room: the same field the report sends,
        // so both resolve the same MarkScan token.
        if (userId) qs.set('clientUserId', String(userId))
      } else {
        path = `/api/realtime/${view}`
        if (clientId) qs.set('clientId', clientId)
        if (userId) qs.set('userId', String(userId))
        for (const a of assetIds ?? []) qs.append('assetId', a)
        /* The window the report is showing. Without it the service was asked
           for every row it holds and answered 504 — see the note on
           scopeFromRequest. */
        if (startDate) qs.set('from', startDate)
        if (endDate) qs.set('to', endDate)
      }

      const r = await fetch(`${path}?${qs}`, { credentials: 'include' })
      const j = await r.json()
      if (!j.ok && !j.success) throw new Error(j.error || 'Could not read the live counts')
      setData(j); lastGood.current = j; setErr('')
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    }
  }, [view, source, clientId, userId, assetKey, startDate, endDate])

  useEffect(() => { load() }, [load])

  /* Paused while the tab is hidden. A card left open on a second monitor
     overnight would otherwise run twelve hundred counts against the warehouse
     that nobody was ever going to read. */
  useEffect(() => {
    if (!live) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => { timer ??= setInterval(load, REFRESH_MS[source] ?? 60_000) }
    const stop  = () => { if (timer) { clearInterval(timer); timer = null } }
    const onVis = () => (document.visibilityState === 'visible' ? (load(), start()) : stop())

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [live, load, source])

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
  const counting = !shown && /deadline|timeout|timed out/i.test(err)
  if (counting) {
    return (
      <div className={`min-w-0 bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-5 ${className}`}>
        <h3 className="font-bold text-[#14254A] dark:text-white">Realtime</h3>
        <p className="text-xs text-gray-500 dark:text-white/50 mt-1">
          Still counting — this client&rsquo;s all-time total takes a while the first time.
          It will appear here and then refresh on its own.
        </p>
      </div>
    )
  }
  if (!shown && err) {
    return (
      <div className={`bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-6 ${className}`}>
        <h3 className="font-bold text-[#14254A] dark:text-white">Realtime</h3>
        <p className="text-xs text-red-600 mt-2">{err}</p>
      </div>
    )
  }
  if (!shown) {
    return (
      <div className={`bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-6 ${className}`}>
        <h3 className="font-bold text-[#14254A] dark:text-white">Realtime</h3>
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

     A count of what was hidden goes under the grid, because a list that
     silently changes length is the failure the war room's rule exists to avoid
     — it is only acceptable here if the card says it happened. */
  const hidesEmpty = view === 'sports'
  const platforms = hidesEmpty ? allPlatforms.filter(p => p.count > 0) : allPlatforms
  const hidden = allPlatforms.length - platforms.length

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
  // Bars are relative to the busiest platform, not to the total: with one
  // platform holding most of the volume, shares of the total would render every
  // other bar as an invisible sliver.
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

  return (
    <div className={`bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 ${className}`}>
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
              Realtime
              <InfoDot text={scopeNote(shown, REFRESH_MS[source] ?? 60_000)} />
            </h3>
            <span className="flex items-center gap-1.5 flex-shrink-0">
              <RelativeTime iso={shown.asOf} stale={stale} />
              {onTogglePin && (
                /* Filled and brand-coloured when pinned, hollow and grey when
                   not — the state has to be readable from the icon itself,
                   since the card looks the same either way until the page is
                   scrolled. */
                <button type="button" onClick={onTogglePin}
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

          <p className={`mt-2 text-3xl font-bold tabular-nums tracking-tight leading-none transition-colors duration-500 ${
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
            /* UNDER the identified total, not beside it.

               Side by side they read as two independent figures a reader has to
               relate themselves. Stacked, with the share bar between them, the
               smaller number reads as what it is: a part of the one above it.

               Orange is removed and navy is identified throughout this product —
               the same two roles the report's own charts use — so the bar needs
               no words to be read the right way round. */
            <div className="mt-2.5 pt-2.5 border-t border-gray-100 dark:border-white/10">
              <p className="flex items-baseline gap-2">
                <span className="text-lg font-bold tabular-nums leading-none text-[#FC934C]">
                  {nf.format(removed)}
                </span>
                <span className="text-[11px] text-gray-500 dark:text-white/50">
                  removed{removalRate !== null && <> · {removalRate}%</>}
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
                stale ? 'bg-amber-500' : live ? 'bg-[#FC934C]' : 'bg-gray-300'}`} />
            </span>
            {stale ? 'Reconnecting' : live ? 'Updating live' : 'Paused'}
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

        <div className={`flex-1 min-w-0 px-5 py-4 ${stale ? 'opacity-60' : ''}`}>
          {platforms.length === 0 ? (
            /* Nothing to draw, for one of two very different reasons. "Nothing
               found yet" is a report about the window; "no platforms are
               configured" is a report about the setup, and the reader can only
               act on the second. */
            <p className="text-sm text-gray-400">
              {allPlatforms.length > 0
                ? `Nothing found on any of the ${allPlatforms.length} platforms watched in this range.`
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
                return (
                  <div key={p.key}
                    title={`${p.label} — ${nf.format(p.count)} identified${
                      rem !== null ? `, ${nf.format(rem)} removed` : ''}${
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
                    {/* The bar's LENGTH is still this platform's share of the
                        busiest one — that is what makes the grid scannable — and
                        removals are drawn INSIDE it rather than as a second bar,
                        so the two are read as parts of one figure. Where nothing
                        answered on removals the bar stays one colour, exactly as
                        it was before this existed. */}
                    <div className="mt-1 h-1 rounded-full bg-gray-100 dark:bg-white/10 overflow-hidden">
                      <div className="h-full rounded-full flex overflow-hidden transition-[width] duration-500"
                        style={{ width: `${Math.round((p.count / peak) * 100)}%` }}>
                        {rem === null ? (
                          <span className="h-full w-full bg-[#FC934C]" />
                        ) : (
                          <>
                            <span className="h-full bg-[#FC934C]" style={{ width: `${share}%` }} />
                            <span className="h-full bg-[#14254A]/25 dark:bg-white/30"
                              style={{ width: `${100 - share}%` }} />
                          </>
                        )}
                      </div>
                    </div>
                    {rem !== null && (
                      <p className="mt-0.5 text-[10px] tabular-nums text-gray-400 dark:text-white/40 truncate">
                        {nf.format(rem)} removed{p.count > 0 && <> · {share}%</>}
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
          {/* What the filter took. Without this the card is a list that quietly
              changes length between refreshes — which is exactly the objection
              the war room's keep-the-zeroes rule was written against, and the
              one thing that makes hiding them safe here. */}
          {hidden > 0 && (
            <p className="mt-3 text-[10px] text-gray-400 dark:text-white/40">
              {hidden} platform{hidden === 1 ? '' : 's'} watched with nothing found — hidden
            </p>
          )}

          {hasRemovals && platforms.length > 0 && (
            <p className="mt-2 flex items-center gap-3 text-[10px] text-gray-400 dark:text-white/40">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-1 rounded-full bg-[#FC934C]" />removed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-1 rounded-full bg-[#14254A]/25 dark:bg-white/30" />still live
              </span>
            </p>
          )}
        </div>
      </div>
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
