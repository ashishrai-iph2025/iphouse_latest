'use client'

/*
 * The client landing page — a proposal, live at /welcome so it can be judged
 * against real data before anything is rewired.
 *
 * ── Who lands here ───────────────────────────────────────────────────────────
 *
 * A REPORTS login. app/(client)/dashboard/page.tsx sends any login holding the
 * Reports grant here rather than straight to /reports, so this is the first
 * thing they see after signing in. A DASHBOARD login is untouched and still
 * gets the PowerBI shell; everyone else still goes to their first granted
 * module. To undo it, that one Navigate points back at /reports.
 *
 * ── One endpoint, one week ───────────────────────────────────────────────────
 *
 * Everything here comes from GET /api/reports/overview, which passes through
 * reports_api's /v1/overview/{dataset}. That endpoint answers the exact
 * question this page asks: the last seven days, against the seven before them,
 * with the change between the two ALREADY COMPUTED.
 *
 * So this page does no arithmetic on the figures. It does not run a second query
 * for last week, it does not divide one measure by another, and it does not work
 * out its own dates — `current.from` / `current.to` are the report's calendar
 * (IST), which is the calendar the warehouse stores its dates in. A page
 * computing a window locally and a service computing one server-side is two
 * definitions of "this week" that agree until the day they do not.
 *
 * It shows NOTHING BEYOND THAT WEEK. Earlier drafts carried a platform split, a
 * daily trend and a top-assets list, none of which this endpoint returns — they
 * came from a second, heavier query. They are gone rather than kept alive by a
 * call this page has no reason to make: the full report is one click away and
 * exists to answer exactly those questions.
 *
 * ── The two traps the payload warns about, and how each is handled ───────────
 *
 *   · removalRatePct is a PERCENTAGE, so its change is in percentage POINTS and
 *     its `percent` is null. "79.8%, up 1.7 points" is the sentence; "up 1.7%"
 *     would be a different and wrong claim about a rate that moved from 78.1.
 *   · A period with no rows reports every count as 0 with firstDate null —
 *     "nothing happened, rather than nothing is known". Zeroes are therefore
 *     REAL and are drawn as figures; the null firstDate is what earns the quiet
 *     empty state instead.
 *
 * ── The rules it holds itself to ─────────────────────────────────────────────
 *
 *   · NO INVENTED NUMBERS. Every figure is a measure the endpoint returned.
 *   · A FAILURE IS NEVER A ZERO. A call that could not run says so in words.
 *   · MODULE GRANTS DECIDE. A card renders only if the login holds the module
 *     behind it, read from the same allowedModules the nav uses.
 */

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '@/lib/auth-client'
import { useModuleAccess } from '@/lib/moduleAccess'
import ReportLoader from '@/components/shared/ReportLoader'
import ProgramCalendar from '@/components/client/ProgramCalendar'

/* ── The brand palette ──────────────────────────────────────────────────────
   Navy and orange plus one tint of each — the same set /admin/reports draws its
   marks from, copied here as values rather than invented again. The tint number
   is how much white is mixed in, so N20 is navy at 20% white.

   FOUR gradients, because the row is four cards and each has to be tellable
   from its neighbours at a glance. Gold carries the rate — the one figure that
   is neither found nor removed, which is the same job gold does on the reports
   page — and the pale navy carries the queue, which is not a measurement at all
   and should not look like one of the three that are. */
const NAVY = '#14254A'
const ORANGE = '#FC934C'
const GOLD = '#FFC82B'
const N20 = '#43516E'   // navy + 20% white
const N40 = '#727C92'   // navy + 40% white
const O40 = '#FDBE94'   // orange + 40% white
const G45 = '#FFE18A'   // gold + 45% white

/* A tile is a brand gradient and the ink that stays legible on it. Gold and
   light orange take NAVY text — white on either fails contrast outright, and a
   headline figure nobody can read is not a headline. */
const TILES = {
  identified: { from: NAVY,   to: N20, ink: '#fff', sub: 'rgba(255,255,255,.62)' },
  removed:    { from: ORANGE, to: O40, ink: NAVY,   sub: 'rgba(20,37,74,.60)' },
  /* Gold takes NAVY ink: white on gold fails contrast outright, and a headline
     figure nobody can read is not a headline. */
  rate:       { from: GOLD,   to: G45, ink: NAVY,   sub: 'rgba(20,37,74,.60)' },
  /* The queue, on the palest navy of the set. It is the one card in the row
     that is not a number about the week, so it reads as the quiet end of a
     navy-to-orange-to-gold row rather than as a fourth measurement. */
  queue:      { from: N20,    to: N40, ink: '#fff', sub: 'rgba(255,255,255,.66)' },
} as const

const nf = new Intl.NumberFormat()

/** A measure the endpoint returned, or null where it did not. Never coerced to
    0 — the payload uses 0 to mean "nothing happened", so inventing one would be
    claiming a fact rather than admitting a gap. */
const measure = (obj: any, key: string): number | null => {
  const v = obj?.[key]
  return v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v)
}

const fmt = (n: number | null) => (n === null ? '—' : nf.format(n))

/** Big figures, shortened. 20,620 reads fine in a card; 1.5M reads better in a
    tile that is mostly headline. */
function compact(n: number | null): string {
  if (n === null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return nf.format(n)
}

/** "2026-08-27" → "27 Aug". The window comes from the payload, so it is already
    the report's own calendar and needs formatting, not conversion. */
const dayWords = (ymd: string) => {
  if (!ymd) return ''
  const d = new Date(`${ymd}T00:00:00`)
  return isNaN(d.getTime()) ? ymd
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/* ── Pieces ─────────────────────────────────────────────────────────────── */

/**
 * The week-on-week line, straight from `change`.
 *
 * Two shapes, because the payload has two. A count moved by a PERCENTAGE; a
 * rate moved by percentage POINTS and reports `percent: null`, which is the
 * endpoint saying "a percentage of a percentage is not a number anyone means".
 * Reading `percent` for both would print "up 1.7%" for a rate that went from
 * 78.1 to 79.8 — a real number attached to the wrong claim, which is worse than
 * no number at all.
 */
function Delta({ change, good = 'up', muted, ink }: {
  change?: { absolute?: number | null; percent?: number | null } | null
  /** Which direction is the welcome one for THIS figure. */
  good?: 'up' | 'down'
  /** The surrounding surface's secondary ink, on a coloured tile. */
  muted?: string
  ink?: string
}) {
  const pct = change?.percent
  const abs = change?.absolute
  if (typeof pct !== 'number' && typeof abs !== 'number') {
    return (
      <p className={`text-[11px] mt-1.5 ${muted ? '' : 'text-gray-400'}`}
        style={muted ? { color: muted } : undefined}>
        no comparable week before this
      </p>
    )
  }
  // A rate's movement is in points; everything else moved by a percentage.
  const points = typeof pct !== 'number'
  const shown = points ? (abs as number) : (pct as number)
  const up = shown >= 0
  const welcome = (up && good === 'up') || (!up && good === 'down')
  /* On a coloured tile the figure takes the tile's own ink and the WORDS carry
     the judgement — green and red on a brand gradient would be a fifth and sixth
     colour on a page that owns three, and on gold neither is legible. */
  const toneClass = ink ? '' : welcome
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-rose-600 dark:text-rose-400'
  const size = Math.abs(shown)
  return (
    <p className={`flex items-center gap-1 text-[11px] mt-1.5 ${muted ? '' : 'text-gray-400'}`}
      style={muted ? { color: muted } : undefined}>
      <span className={`inline-flex items-center gap-0.5 font-bold ${toneClass}`}
        style={ink ? { color: ink } : undefined}>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"
          className={up ? '' : 'rotate-180'}>
          <path d="M12 4 22 20H2z" />
        </svg>
        {points ? `${size.toFixed(1)} pts` : `${size < 0.5 ? '<1' : Math.round(size)}%`}
      </span>
      {up ? 'increase' : 'decrease'} compare to last week
    </p>
  )
}

/**
 * One week figure, at a glance.
 *
 * Deliberately SMALLER than the tile it replaces. The calendar now leads the
 * page, and five full-height gradient cards beneath it competed with the thing
 * they exist to support. The share bar and the watermark icon are gone, which
 * buys back the height that made them shout.
 *
 * NOT a link. Making the whole tile clickable gave the row five targets that all
 * went to the same place as the "Open full report" button directly above it — a
 * figure the reader can click but which leads somewhere they did not ask for is
 * a surprise, not an affordance. These are readings; the one way into the report
 * is the button.
 */
function MiniTile({ tone, label, value }: {
  tone: { from: string; to: string; ink: string; sub: string }
  label: string
  value: string
}) {
  return (
    <div className="rounded-xl px-3.5 py-3 overflow-hidden shadow-card"
      style={{ background: `linear-gradient(135deg,${tone.from} 0%,${tone.to} 100%)`, color: tone.ink }}>
      <p className="text-[11.5px] font-bold leading-tight opacity-90">{label}</p>
      <p className="text-[25px] font-extrabold leading-none mt-2 tabular-nums">{value}</p>
    </div>
  )
}

/* The panel surface, named once.

   The calendar, the loader and the week's figures all sit on it, and three
   copies of one class list is three chances for one of them to drift — which is
   how the figures ended up as the only section on the page with no surface
   under it. */
const boxCls = 'rounded-2xl border border-gray-100 dark:border-white/10 bg-white dark:bg-[#1a2d55]'

function Card({ title, sub, children }: {
  title: string; sub?: string; children: React.ReactNode
}) {
  return (
    <div className={`${boxCls} p-5`}>
      <p className="text-[15px] font-bold text-[#14254A] dark:text-white">{title}</p>
      {sub && <p className="text-[12px] text-gray-500 dark:text-white/50 mt-0.5">{sub}</p>}
      <div className="mt-4">{children}</div>
    </div>
  )
}

/** One waiting queue. The count is optional on purpose — some queues can be
    counted from an endpoint this page can call cheaply and some cannot, and a
    row without a number is still a way in. A row with a WRONG number is not. */
/*
QueueRow, on a coloured tile rather than on white.

The row used to be dark text on a faint navy wash, which is unreadable on the
navy tile the queue now sits on. Its own ink comes from the tile's tone, and its
ground is a translucent WHITE rather than a fixed colour so it lifts off
whatever gradient it is dropped on — the same trick the tiles' `sub` ink uses.

The count keeps its own weight but not its own hue: orange on navy is the
brand's other colour fighting the tile it is inside, and the number is already
the only thing on the row that is bold and right-aligned.
*/
function QueueRow({ href, label, count, ink, muted }: {
  href: string; label: string; count: number | null; ink: string; muted: string
}) {
  return (
    <Link to={href}
      className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 transition-colors"
      style={{ background: 'rgba(255,255,255,.12)', color: ink }}>
      <span className="text-[11.5px] font-semibold truncate">{label}</span>
      <span className="text-[12.5px] font-extrabold tabular-nums flex-shrink-0"
        style={{ color: count === null ? muted : ink }}>
        {count === null ? '›' : nf.format(count)}
      </span>
    </Link>
  )
}

/* ── The page ───────────────────────────────────────────────────────────── */

export default function WelcomePage() {
  const { data: session } = useSession()
  const { allowedModules } = useModuleAccess()

  const [ov, setOv] = useState<any>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  /* The calendar's wait, reported up by ProgramCalendar. Tracked here so the
     page can show ONE loader for two fetches instead of one per panel. */
  const [calLoading, setCalLoading] = useState(true)
  const [company, setCompany] = useState('')
  const [unread, setUnread] = useState<number | null>(null)
  const [downloads, setDownloads] = useState<number | null>(null)

  const granted = allowedModules
  const has = useCallback(
    (pageName: string) => !!granted?.some(m => m.pageName === pageName),
    [granted])

  /* One call, and no dates on it. The endpoint's own default IS this window;
     asking for one computed in the browser would replace the report's calendar
     with the reader's, and those two agree right up until somebody opens the
     page from another time zone. */
  useEffect(() => {
    if (!has('Reports')) { setLoading(false); return }
    let live = true
    setLoading(true)
    ;(async () => {
      try {
        const d = await fetch('/api/reports/overview', { credentials: 'include' })
          .then(r => r.json())
        if (!live) return
        if (d?.available === false) { setErr(d.error || 'The reporting service is unavailable.'); return }
        if (!d?.ok) { setErr(d?.error || 'This week’s figures could not be read.'); return }
        setOv(d)
        setErr('')
      } catch (e: any) {
        if (live) setErr(e?.message || 'This week’s figures could not be read.')
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [has])

  // The company name, for the greeting. Cheap, and unrelated to the figures.
  useEffect(() => {
    let live = true
    fetch('/api/reports/scope', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (live && d?.clientName) setCompany(String(d.clientName)) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  /* The queues. Cheap, and each degrades to null rather than to zero — zero is
     an answer ("nothing is waiting") and a failed fetch must not make it. */
  useEffect(() => {
    let live = true
    fetch('/api/notifications/feed?limit=1', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (live && d?.success) setUnread(Number(d.unreadCount ?? 0)) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!has('DownloadRequest')) return
    let live = true
    fetch('/api/download?history=1', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!live || !d?.success) return
        /* "Ready" is whatever carries a link to collect, read that way rather
           than by matching a status vocabulary this page does not own. */
        const items: any[] = Array.isArray(d.items) ? d.items : []
        setDownloads(items.filter(i => i?.url || i?.downloadUrl || i?.fileUrl ||
          /ready|complete|success/i.test(String(i?.status ?? ''))).length)
      })
      .catch(() => {})
    return () => { live = false }
  }, [has])

  const cur = ov?.current
  const chg = ov?.change
  const days = measure(ov, 'days') ?? 7

  const identified = measure(cur, 'identified')
  const removed = measure(cur, 'removed')
  const delisted = measure(cur, 'delisted')
  const google = measure(cur, 'googleDelisted')
  const bing = measure(cur, 'bingDelisted')
  const batches = measure(cur, 'delistingBatches')
  const rate = measure(cur, 'removalRatePct')

  /* An empty period, in the payload's own terms: every count 0 and firstDate
     null — "nothing happened, rather than nothing is known". Zeroes alone are
     NOT this; they are a real reading and get drawn as figures. */
  const emptyWeek = !!cur && cur.firstDate == null

  /* Waiting on EITHER fetch, EACH under its own grant.

     A panel that is not mounted never reports itself finished, so waiting on
     one the login cannot see is a loader that never clears. That was already
     why this was gated — but the two panels answer to two different modules
     now, and keeping them both behind Reports would hang the page for a login
     holding Calendar alone. */
  const busy = (has('Reports') && loading) || (has('welcome') && calLoading)

  const name = String((session?.user as any)?.name || '').split(' ')[0] || 'there'
  const from = String(cur?.from ?? '')
  const to = String(cur?.to ?? '')

  return (
    /* No width or padding of its own: /welcome is no longer in ClientShell's
       FULL_WIDTH_PAGES, so the shell's measured wrapper supplies both, the same
       as every other client page.

       Setting them here as well would apply the padding TWICE — the wrapper's
       lg:px-8 plus this element's — which is the usual way a page ends up
       narrower than its neighbours by exactly one gutter. */
    <div className="fade-in space-y-5">

      {/* The greeting is ONE line. The calendar under it is the subject of this
          page, and a tall masthead above the subject only pushes it down. */}
      <h1 className="text-[22px] font-extrabold text-[#14254A] dark:text-white">
        Hi, {name}.
        <span className="font-normal text-[14px] text-gray-500 dark:text-white/50 ml-2">
          here&rsquo;s what&rsquo;s happened with your protection this week.
        </span>
      </h1>

      {/* ── 1. The calendar ──────────────────────────────────────────────────
          The first element on the page and the full width of it.

          It stays OUTSIDE the block below on purpose: it has its own endpoint
          and its own failure state, so an overview that 404s must not take the
          calendar with it, and a title list that fails must not blank the
          week's figures. */}
      {/* Mounted even while the page is still waiting: it renders nothing until
          its own fetch lands, and unmounting it until the wait ended would mean
          that fetch never started. */}
      {/* Its OWN grant, not the Reports one it used to borrow. The calendar has
          its own endpoint and its own failure state, so a client who should see
          the week's figures but not the fixture schedule is something an admin
          can express.

          The identifier is "welcome" — the PAGE this grant opens, which is how
          module_permission is keyed throughout and what the row an admin
          created actually says. It is the same string the nav item matches on
          (lib/navItems.tsx) and the same one /api/reports/assets checks
          server-side (handlers/calendarmodule.go), so the tab, the panel and
          the endpoint cannot disagree about one login. */}
      {has('welcome') && <ProgramCalendar onLoadingChange={setCalLoading} />}

      {/*
        ONE loader for the whole page.

        There were two — this page drew one for the overview and the calendar
        drew its own — so arriving showed two identical marks in two stacked
        boxes for a single wait, and whichever finished first left the other
        looking stuck. The panels still fetch independently and still fail
        independently; only the waiting is shared.
      */}
      {busy && (
        <div className={boxCls}>
          <ReportLoader size={150} label="Reading your week" className="py-16" />
        </div>
      )}

      {/* ── 2. The week's figures, and what they mean ───────────────────────
          Below the calendar and quieter than it. */}
      {busy ? null : err && has('Reports') ? (
        <div className="rounded-2xl border border-amber-200 dark:border-amber-400/25 bg-amber-50 dark:bg-amber-500/10 px-5 py-4">
          <p className="text-sm font-bold text-amber-800 dark:text-amber-200">Figures unavailable</p>
          <p className="text-xs text-amber-700 dark:text-amber-300/80 mt-1">{err}</p>
        </div>
      ) : emptyWeek ? (
        /* One card, one sentence, and the way out. Not a grid of zeroes
           pretending to be a reading. */
        <div className="rounded-2xl border border-gray-100 dark:border-white/10 bg-white dark:bg-[#1a2d55] p-10 text-center">
          <span className="w-14 h-14 mx-auto grid place-items-center rounded-2xl bg-[#FC934C]/10 text-[#FC934C]">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          <p className="text-base font-extrabold text-[#14254A] dark:text-white mt-4">
            Nothing new was found this week
          </p>
          <p className="text-[13px] text-gray-500 dark:text-white/55 mt-1.5 max-w-md mx-auto leading-relaxed">
            No infringements were identified for {company || 'your account'} between{' '}
            {dayWords(from)} and {dayWords(to)}. Earlier weeks may hold more — the full
            report opens on a wider window.
          </p>
          <Link to="/reports"
            className="ink-fixed inline-flex items-center gap-2 mt-5 px-5 py-2.5 rounded-xl text-[13px] font-bold
              text-[#14254A] bg-[#FFC82B] hover:bg-[#FFE18A] transition-colors">
            Open full report
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14m0 0-6-6m6 6-6 6" />
            </svg>
          </Link>
        </div>
      ) : has('Reports') && cur && (
        <>
          {/*
            BOXED, like every other panel on this page and on the report screens.

            The heading and the tile row used to sit bare on the page's grey,
            with the calendar above them in a white card and the three cards
            below them in white cards — so the one section carrying the figures
            was the only thing on the screen with no surface under it, and it
            read as though it had come loose between two panels.
          */}
          <section className={`${boxCls} p-4 sm:p-5 space-y-4`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              {/* Named for the WINDOW, not for a calendar week. "This week"
                  read as Monday-to-today; the figures are a rolling seven days
                  ending now, which is a different period and the one the tiles
                  below actually cover. */}
              <h2 className="text-[15px] font-extrabold text-[#14254A] dark:text-white">
                Last {days} days details
              </h2>
            </div>
            {/* Navy on the light ground, gold on the dark one. A single fixed
                colour cannot do both: navy is what the dark page is MADE of, and
                gold sitting on light grey is the washed-out half of the pair.
                Each theme gets the one that carries contrast on its own ground —
                the same rule the calendar's Live colour follows. */}
            <Link to="/reports"
              className="ink-fixed inline-flex items-center gap-2 px-4 py-2 rounded-xl text-[12.5px] font-bold
                bg-[#14254A] text-white hover:bg-[#1e3a6e]
                dark:bg-[#FFC82B] dark:text-[#14254A] dark:hover:bg-[#FFE18A] transition-colors">
              Open full report
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14m0 0-6-6m6 6-6 6" />
              </svg>
            </Link>
          </div>

          {/* TWO tiles, and the grid says two.

              Active, Websites affected and Assets targeted were dropped from
              this page: the landing page answers "how much was found and how much
              came down", and the rest of the breakdown is a click away behind
              Open full report. Removal rate — the third figure kept — stays in
              its own card below rather than becoming a third tile, because the
              bar under it is what makes a percentage mean something.

              The column count had to come down with them. Left at
              xl:grid-cols-5 the two tiles would have held the first two fifths
              of the row and stretched nothing across the other three. */}
          {/*
              ── ONE ROW, FOUR CARDS, ONE SURFACE ─────────────────────────

              These were two rows on two different surfaces: two gradient tiles
              inside this panel, then Removal rate and Needs you as white cards
              below it. Four things about one week, in two visual languages, with
              a panel edge between them.

              They are one grid now and every card is a gradient tile, so the row
              reads as one answer to one question. `items-stretch` is what keeps
              it honest: the queue card is taller than a figure, and without it
              the three number cards would sit short beside it.

              Anything conditional — the De-indexed card below — flows into the
              row after these four and wraps to a second line, which is why the
              column count is fixed at four rather than counting what is
              actually rendered.
          */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-stretch">
            <MiniTile label="Infringements identified" value={fmt(identified)} tone={TILES.identified} />
            <MiniTile label="Removed" value={fmt(removed)} tone={TILES.removed} />

            {/* The rate, as a tile. It keeps the bar, which is what makes a
                percentage mean something visually rather than as a bare
                41.7% — the bar's track and fill are drawn from the tile's own
                ink rather than in orange: on a gold ground the brand orange is
                the neighbouring tile's colour arriving inside this one. */}
            <div className="rounded-xl px-3.5 py-3 overflow-hidden shadow-card flex flex-col"
              style={{ background: `linear-gradient(135deg,${TILES.rate.from} 0%,${TILES.rate.to} 100%)`,
                       color: TILES.rate.ink }}>
              <p className="text-[11.5px] font-bold leading-tight opacity-90">Removal rate</p>
              <p className="text-[25px] font-extrabold leading-none mt-2 tabular-nums">
                {rate === null ? '—' : `${rate}%`}
              </p>
              <div className="h-1.5 rounded-full overflow-hidden mt-2.5"
                style={{ background: 'rgba(20,37,74,.15)' }}>
                <div className="h-full rounded-full transition-[width] duration-700"
                  style={{ width: `${rate === null ? 0 : Math.min(100, rate)}%`,
                           background: TILES.rate.ink }} />
              </div>
            </div>

            {/* The queue, on the same surface as the figures beside it. Its
                three destinations survive the restyle — collapsing them into one
                number would have made the row uniform by deleting two places a
                reader can go. */}
            {(has('PerformQC') || has('DownloadRequest')) && (
              <div className="rounded-xl px-3.5 py-3 overflow-hidden shadow-card flex flex-col"
                style={{ background: `linear-gradient(135deg,${TILES.queue.from} 0%,${TILES.queue.to} 100%)`,
                         color: TILES.queue.ink }}>
                <p className="text-[11.5px] font-bold leading-tight opacity-90">Needs you</p>
                <div className="mt-2 space-y-1.5">
                  {has('PerformQC') && (
                    <QueueRow href="/pending-count" label="Awaiting approval" count={null}
                      ink={TILES.queue.ink} muted={TILES.queue.sub} />
                  )}
                  {has('DownloadRequest') && (
                    <QueueRow href="/download-request" label="Downloads ready" count={downloads}
                      ink={TILES.queue.ink} muted={TILES.queue.sub} />
                  )}
                  <QueueRow href="/notifications" label="Unread notifications" count={unread}
                    ink={TILES.queue.ink} muted={TILES.queue.sub} />
                </div>
              </div>
            )}

          </div>
          </section>

          {/* De-indexing is its own outcome — a link an engine dropped is not a
              page taken down, and the report names the two apart.

              OUTSIDE the row above, and on its own white surface. That row is
              four gradient tiles about the week; this appears only for clients
              whose engines dropped something, and a lone white card sitting in
              a row of four coloured ones reads as a card that failed to load
              rather than as an extra answer. */}
          {delisted !== null && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card title="De-indexed" sub="Search results dropped this week">
                <p className="text-[34px] font-extrabold leading-none tabular-nums text-[#14254A] dark:text-white">
                  {fmt(delisted)}
                </p>
                <Delta change={chg?.delisted} good="up" />
                <div className="mt-3 space-y-1.5">
                  {google !== null && (
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: NAVY }} />
                      <span className="flex-1 text-gray-600 dark:text-white/70">Google</span>
                      <span className="font-bold tabular-nums text-[#14254A] dark:text-white">{nf.format(google)}</span>
                    </div>
                  )}
                  {bing !== null && (
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: ORANGE }} />
                      <span className="flex-1 text-gray-600 dark:text-white/70">Bing</span>
                      <span className="font-bold tabular-nums text-[#14254A] dark:text-white">{nf.format(bing)}</span>
                    </div>
                  )}
                  {batches !== null && (
                    <p className="text-[11px] text-gray-400 pt-1">
                      From {nf.format(batches)} submission{batches === 1 ? '' : 's'} — the notices sent,
                      not the links they covered.
                    </p>
                  )}
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  )
}
