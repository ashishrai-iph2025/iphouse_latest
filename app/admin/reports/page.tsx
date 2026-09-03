'use client'

// Reports — the in-house replacement for the embedded PowerBI report files.
//
// Structure follows the PowerBI report it replaces — left section-navigation
// rail, KPI band, chart grid, right-hand slicer rail — while the card shell and
// chart chrome follow the dashboard reference: a bold card header over a
// hairline divider, a muted chart title inside the plot area, thin marks, solid
// hairline grids, a bottom legend with circle keys, and values direct-labelled
// at the mark rather than sprayed over every point.
//
// Data comes from the analytics warehouse over /api/reports/* (see
// go-server/handlers/reports.go), a SEPARATE database from the portal's own.
// Those endpoints are staff-only, which is why this page sits under /admin: the
// report is keyed on a warehouse ClientId supplied by the caller, and there is
// no portal-login → warehouse-client mapping yet.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  LineChart, Line, LabelList, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { createPortal } from 'react-dom'
import InfoDot from '@/components/shared/InfoDot'
import Portal from '@/components/ui/Portal'
import { Link } from 'react-router-dom'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DateRangePicker from '@/components/ui/DateRangePicker'
import { WORLD_SHAPES, WORLD_VIEWBOX } from './worldShapes'
import RealtimeCard from '@/components/shared/RealtimeCard'
import ReportLoader from '@/components/shared/ReportLoader'
import ReportLayoutEditor from '@/components/reports/ReportLayoutEditor'

/* ── Palette ───────────────────────────────────────────────────────────────────
   Two families, deliberately kept apart:

   · CHROME — brand navy/orange/gold. Headings, the active rail item, chips, the
     progress bar. This is the product's identity and it matches War Room.

   · MARKS  — the colours data is drawn in. BRAND ONLY: navy, orange and gold,
     plus tints of those three. A tint is the brand hue mixed with white by a
     percentage, so every mark on this page is one of our colours at some
     strength and nothing else.

     What that costs, so it is not rediscovered later: mixing navy toward white
     desaturates it, so the navy steps read as blue-greys rather than as distinct
     hues, and adjacent categorical steps are separated more by lightness than by
     colour. Every component here prints the value beside its mark — the bar
     lists, the donut legend, the table and the heat grid all do — which is the
     relief that makes a low-separation set readable. Keep that rule if a new
     visual is added: brand tints are only safe next to their numbers.

     Dark theme cannot use full navy on a navy card, so its navy family starts at
     a lighter tint. Orange and gold carry unchanged in both themes.

*/

const BRAND_NAVY   = '#14254A'
const BRAND_ORANGE = '#FC934C'

interface MarkTheme {
  ident: string          // series 1 — links identified
  identSoft: string      // a lighter step of the same hue, for "the remainder"
  removed: string        // series 2 — links taken down
  cat: string[]          // categorical identity, fixed order, never cycled
  other: string          // the folded tail of a categorical split
  ordinal: string[]      // funnel stages: one hue, strongest step first
  seq: string[]          // magnitude, lowest intensity first
  seqInk: boolean[]      // true where a label on that step must be dark
  segInk: string         // label colour inside a filled segment, this theme
  surface: string        // card background — the colour the 2px spacers wear
  grid: string
  axis: string
}

/* Tints of the three brand colours. The number is how much white is mixed in,
   so N60 is navy at 40% strength against a white card. Named rather than
   computed at runtime: these exact steps were chosen so neighbouring
   categorical slots differ in lightness as well as family. */
const N40 = '#727C92'
const N55 = '#959DAE'
const N62 = '#A6ACBA'
const N72 = '#BDC2CC'
const N75 = '#C4C8D1'
const N80 = '#D0D3DA'
const N85 = '#DCDEE3'
const N92 = '#EDEEF0'
const N30 = '#5B6680'
const N20 = '#43516E'
const O40 = '#FDBE94'   // orange + 40% white
const O55 = '#FECEAE'
const G45 = '#FFE18A'   // gold + 45% white

const BRAND_GOLD = '#FFC82B'

const MARKS: Record<'light' | 'dark', MarkTheme> = {
  light: {
    ident: BRAND_NAVY, identSoft: N62, removed: BRAND_ORANGE,
    // Order alternates family before it steps lightness, so the first slices —
    // the ones that carry most of the total — are the easiest to tell apart.
    cat: [BRAND_NAVY, BRAND_ORANGE, BRAND_GOLD, N40, O40, G45, N72, O55],
    other: N75,
    ordinal: [BRAND_NAVY, N40, N75],
    seq: [N85, N75, N62, N40, BRAND_NAVY],
    seqInk: [true, true, true, false, false],
    segInk: BRAND_NAVY,
    surface: '#ffffff',
    grid: N92,
    axis: N40,
  },
  dark: {
    // Full navy is invisible on a navy card, so the family starts lighter here.
    ident: N55, identSoft: N75, removed: BRAND_ORANGE,
    cat: [N55, BRAND_ORANGE, BRAND_GOLD, N75, O40, G45, N30, O55],
    other: N30,
    ordinal: [N75, N55, N30],
    seq: [N20, N30, N40, N62, N80],
    seqInk: [false, false, false, true, true],
    // Dark-theme fills are light tints and brand orange/gold, so a dark label
    // beats a white one on all of them.
    segInk: BRAND_NAVY,
    surface: '#1a2d55',
    grid: 'rgba(255,255,255,0.10)',
    axis: N55,
  },
}

/** A categorical split shows at most this many slices; the rest fold to "Other".
    Past six segments neighbouring slices stop being tellable apart. */
const CAT_LIMIT = 6

/* Marks are drawn with `isAnimationActive={false}` throughout. The report
   re-runs on every slicer change, and recharts replays its entry animation on
   each new dataset — so an animated build-up here means every filter click
   costs a second of marks growing out of the floor. Holding the previous render
   and swapping it is both faster to read and what the loading state promises. */

/**
 * Tracks the global dark theme (`.dark` on <html>), the same way
 * components/ui/SearchableSelect does. Recharts styles grid lines, marks and
 * tooltips through inline props, which Tailwind's `dark:` variants cannot
 * reach — so the values have to be chosen in JS or they stay light-only on a
 * dark card.
 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const check = () => setDark(document.documentElement.classList.contains('dark'))
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

/** The one message that means "sign in again", kept in one place so every fetch
    classifies a 401/403 the same way. */
const AUTH_MSG = 'The reports API rejected this request as unauthenticated'

/**
 * Split a platform's name into its subject and its qualifier:
 * "UGC & Social Media - Sports" → ["UGC & Social Media", "Sports"].
 *
 * Half these names are one report cut two ways, and written on one line the cut
 * is the part that falls off the end — which is exactly the part telling you
 * which of two near-identical entries you are looking at. On its own line it
 * always survives.
 */
function splitLabel(label: string): [string, string?] {
  const m = /^(.*\S)\s+[-–—]\s+(\S.*)$/.exec(String(label))
  return m ? [m[1], m[2]] : [String(label)]
}

/* ── Formatting ───────────────────────────────────────────────────────────── */
function fmt(v: number, dec = 1): string {
  if (!v && v !== 0) return '–'
  const a = Math.abs(v)
  if (a >= 1_000_000_000) return (v / 1_000_000_000).toFixed(dec) + 'B'
  if (a >= 1_000_000)     return (v / 1_000_000).toFixed(dec) + 'M'
  if (a >= 1_000)         return (v / 1_000).toFixed(dec) + 'K'
  return String(Math.round(v))
}
const full = (v: number) => Number(v || 0).toLocaleString()

/**
 * A headline figure on a KPI tile.
 *
 * Exact below 100,000, compacted above it. A tile is read for the number, and
 * "3.7K" throws away the three digits that distinguish 3,712 from 3,749 to save
 * two characters the tile has room for. Past six figures the exact number stops
 * being readable at a glance and starts overflowing the tile, so the compaction
 * earns its place and takes over.
 *
 * Charts keep `fmt` — an axis tick is a scale marker, not a figure to be read
 * off, and 100,000 spelled out on every gridline is noise.
 */
function kpiFmt(v: number, dec = 1): string {
  if (!v && v !== 0) return '–'
  return Math.abs(v) < 100_000 ? full(Math.round(v)) : fmt(v, dec)
}
const pct  = (part: number, whole: number) => whole > 0 ? Math.round((part / whole) * 100) : 0

/**
 * Axis ticks on clean numbers — steps of 1 / 2 / 2.5 / 5 × 10ⁿ.
 *
 * Recharts' own ticks divide the data range, which lands on values like 1,050
 * and 1,400; compacted for the axis they BOTH read "1K", so the scale appears
 * to stop. Choosing the step first means every tick compacts to its own label.
 */
function niceTicks(max: number, count = 5): number[] {
  if (!isFinite(max) || max <= 0) return [0, 1]
  const raw  = max / (count - 1)
  const mag  = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = 0; v <= max + step / 2; v += step) out.push(Math.round(v * 100) / 100)
  return out
}

/** The first number in a bucket label — "12-24 hours" → 12 — so ordered buckets
    can be put back in their own order after the server sorted them by size.
    Labels with no number sort last, which keeps an "Unknown" bucket at the end. */
function leadingNum(s: string): number {
  const hit = /(-?\d+(?:\.\d+)?)/.exec(String(s))
  return hit ? Number(hit[1]) : Number.POSITIVE_INFINITY
}

/** Axis tick label. Only ever sees the round numbers `niceTicks` produced, so
    one decimal is always enough to keep two neighbours apart. */
function axisNum(v: number): string {
  const unit = (n: number, s: string) =>
    (Number.isInteger(n) ? String(n) : n.toFixed(1)) + s
  const a = Math.abs(v)
  if (a >= 1_000_000) return unit(v / 1_000_000, 'M')
  if (a >= 1_000)     return unit(v / 1_000, 'K')
  return String(v)
}

/** "2026-08-11" → "11 Aug"; "2026-08" → "Aug '26". Axis ticks only. */
/** "2026-06-15" → "15 Jun 2026". The year is load-bearing on a comparison
    window, which can sit in the previous one. */
function shortDateFull(v: string): string {
  const s = String(v || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(s + 'T00:00:00')
  return `${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })} ${d.getFullYear()}`
}

function shortDate(v: string): string {
  const s = String(v || '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00')
    return `${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })}`
  }
  if (/^\d{4}-\d{2}$/.test(s)) {
    const d = new Date(s + '-01T00:00:00')
    return `${d.toLocaleString(undefined, { month: 'short' })} '${s.slice(2, 4)}`
  }
  return s
}

/* ── Sections ──────────────────────────────────────────────────────────────────
   The sidebar, the slicers and the breakdown panels are all built from
   /api/reports/sections, which serves the server-side report registry
   (go-server/handlers/reportspecs.go). Adding a report there makes it appear
   here with its own filters and panels, with no matching change in this file —
   which is the point: six near-identical report pages in the source project
   become one page plus six config rows. */

/** `viz` is chosen server-side per dimension: a platform split reads better as a
    donut, a turnaround split as a stacked bar, a channel list as a table. */
interface SectionDim {
  key: string
  label: string
  viz?: string
  /** How much of a row the panel takes. Absent → derived from `viz`. */
  span?: 'full' | 'half' | 'third'
  /** Admin-written note from Report Configuration, shown behind an ⓘ icon. */
  desc?: string
}

/* The page is a twelve-column grid, so a row holds one panel, two, three or
   four. Twelve rather than six because the headline figures are panels too, and
   four across is what a KPI band has always looked like — which six columns
   cannot express. Which width each panel takes is configuration (Report
   Configuration → Page layout); these are just the classes those four choices
   map to. Spelled out rather than built from a template string — Tailwind only
   ships classes it can see. */
const SPAN_CLASS: Record<string, string> = {
  full: 'xl:col-span-12', half: 'xl:col-span-6',
  third: 'xl:col-span-4', quarter: 'xl:col-span-3',
}
/**
 * One visual on the page, positioned and sized by the server.
 *
 * A panel is not only a chart: the KPI band and the section rules are panels
 * too, because "where does this sit and how wide is it" is the same question for
 * all of them, and an admin arranging the page should be able to move the
 * headline figures below the trend if that is how their client reads it.
 *
 * `key` is stable across renders and is what the layout is stored against — for
 * a breakdown it IS the dimension key, so a dimension that leaves the warehouse
 * takes its layout row with it and nothing dangles.
 */
interface SectionPanel {
  key: string
  kind: 'tile' | 'heading' | 'trend' | 'rate' | 'dim'
  label?: string
  sub?: string     // heading only
  viz?: string     // breakdown only
  role?: string    // trend only: which source it draws
  metric?: string  // tile only: the kpi key it shows
  span?: 'full' | 'half' | 'third' | 'quarter'
  /** Admin-written note from Report Configuration, shown behind an ⓘ icon on
      the card. `label` already carries any rename the admin made there. */
  desc?: string
}

interface Section {
  key: string
  label: string
  dimensions: SectionDim[]
  /** The page's shape. Absent from an older server — see the fallback in the
      page body, which is the layout this file used to hardcode. */
  panels?: SectionPanel[]
  filters: string[]    // slicer query params this section understands
  /** The subset of `filters` that gets a DROPDOWN in the rail, in the order it
      is drawn — the filter pane as Report Configuration arranged it, per
      platform and per client. Absent from an older server, where the pane is
      every understood filter less the panel-only ones; see the fallback below. */
  slicers?: string[]
  /** Per-slicer rename and ⓘ note, keyed by query parameter. Only carries the
      slicers somebody actually renamed or described. */
  slicerMeta?: Record<string, { label?: string; desc?: string }>
  extraKpi: string[]   // KPI keys beyond identified/removed/pending/removalPct
  kpiTiles?: string[]  // the headline metrics, in their default reading order
  /** The window this report is bound to, where one is configured — the sports
      reporting period (Report Configuration → Sports reporting period). Absent
      means the open calendar every report used to have. The server clamps to
      this whatever the browser sends, so it is a description of the report and
      not a rule this page is trusted to keep. */
  period?: { start: string; end: string }
}

/*
The window a report opens on, inside a configured period.

Seven days, because that is what a reader wants first — and counted back from
the period's END rather than from today, since a season that closed in March has
no last seven days if "last" means "up to now". Where the period is still
running, today is inside it and this is the real last week.

Clipped to the period's start too: a period shorter than a week opens on all of
itself rather than on days that predate its own data.
*/
const DEFAULT_DAYS = 7

/**
 * The range a reader has chosen, carried into another section — unless that
 * section cannot show it.
 *
 * switchSection used to replace the range outright whenever the section being
 * ENTERED had a period of its own, which is every sports report. So picking
 * 1 Aug - 2 Sep on Summary and clicking Open Web threw the choice away and
 * reopened on the default week, and the navigation stopped being "the same
 * question asked of another platform".
 *
 * The worry behind that rule was real but wider than it needed to be: a range
 * carried in from an UNBOUNDED report can land outside the period, and the
 * server would then clamp it to something the reader never picked and cannot
 * see the reason for. A range already INSIDE the period has no such problem, so
 * it travels. Same test the client-change effect applies, for the same reason.
 */
function carriedRange(
  period: { start: string; end: string } | undefined,
  from: string,
  to: string,
): { from: string; to: string } {
  if (!period) return { from, to }
  const inside =
    from >= period.start && from <= period.end &&
    to >= period.start && to <= period.end
  return inside ? { from, to } : periodDefaultRange(period)
}

function periodDefaultRange(period: { start: string; end: string }): { from: string; to: string } {
  const now = today()
  const to = period.end < now ? period.end : now
  const back = new Date(`${to}T00:00:00Z`)
  back.setUTCDate(back.getUTCDate() - (DEFAULT_DAYS - 1))
  const from = back.toISOString().slice(0, 10)
  return { from: from < period.start ? period.start : from, to: to < period.start ? period.start : to }
}

/** What each source role is CALLED. Mirrors roleDisplayName in
    go-server/handlers/reportplatforms.go — this copy is what titles a role's
    trend card when that role returned no rows at all, and so is not in
    `data.sources` to be read off. */
const ROLE_LABELS: Record<string, string> = { linking: 'Linking', host: 'Host' }

/** Display labels for the slicers a section may declare. */
const FILTER_LABELS: Record<string, string> = {
  assetId: 'Asset', language: 'Language', country: 'Country',
  searchEngine: 'Search Engine', tatBucket: 'TAT Bucket', platform: 'Platform',
  channel: 'Channel Name', groupType: 'Group Type', quality: 'Print Quality',
  genre: 'Genre', infringementType: 'Infringement Type',
  deliveryType: 'Delivery Type', keyword: 'Keyword', domain: 'Domain',
  // Mobile apps.
  sourceFeed: 'Source Feed', appName: 'App', category: 'Category',
  developer: 'Developer', storeType: 'Listing Type',
  contentRating: 'Content Rating', removalStatus: 'Removal Status',
  // Sports. Attributes of the asset, not of the row — the reports API reads
  // them off the title master, so they appear only on the sports tables.
  franchiseName: 'Franchise', matchDay: 'Match Day',
  // The account behind the post, identified by its URL rather than by the
  // display name `channel` filters on. Set by clicking the repeat-offenders
  // panel; it gets no dropdown — see PANEL_ONLY_FILTERS.
  channelUrl: 'Channel / Profile URL',
  // The provider a DMCA notice was sent to — the party that answers for the
  // site, which is not the site itself.
  hspName: 'Hosting Provider',
  /* Which SIDE of the open web the report reads — the infringing links, or the
     hosts behind them. The only slicer here that picks a TABLE rather than a
     value in one, which is why the server offers its two options itself rather
     than listing them from a column. See go-server/handlers/sourcetype.go. */
  sourceType: 'Source Type',
}

/** Display labels for the extra KPI keys a section may return. */
const KPI_LABELS: Record<string, string> = {
  googleDelisted: 'Google De-Indexed', bingDelisted: 'Bing De-Indexed',
  totalDomains: 'Total Websites', totalAssets: 'Total Assets',
  suspendedWebsites: 'Suspended Websites', impactedTraffic: 'Impacted Traffic',
  totalChannels: 'Channels', channelsSuspended: 'Website / Channel Suspended',
  profilesSuspended: 'Profiles Suspended',
  views: 'Total Views', viewsSaved: 'Total Views Saved',
  // The part of that audience the takedown removed — the pair to Total Views,
  // which is the audience it reached.
  viewsImpacted: 'Total Views Impacted',
  /* Broadcasters, not accounts. "Channels" sits on the same report counting the
     accounts that carried the feed; this counts the stations whose feed it was,
     and a report can show 58 of these against thousands of those. */
  totalTVChannels: 'Total Channels',
  impactedSubscribers: 'Impacted Subscribers', likes: 'Total Likes',
  crawled: 'Crawled', notices: 'Notices Sent',
  /* Submissions, not de-indexed URLs. "De-Indexed" is how many links an engine
     DROPPED; this is how many submissions we sent it, and both appear on the
     same report — so neither may be called the other.

     Submissions, never "batches". That is the warehouse's word for the grouping
     (DelistingBatchId is a column) and it had leaked onto a tile, where it asks
     the reader to understand an internal id before they can read a number. The
     key stays `delistingBatches` — it addresses stored layouts and the server's
     own map — but nothing shown says it. */
  delistingBatches: 'De-Indexing',
  totalPlaces: 'No. of Website / Channel / Page', savedRevenue: 'Estimated Saved Revenue',
  // Mobile apps.
  totalApps: 'Total Apps', totalCategories: 'Categories', totalDevelopers: 'Developers',
  installs: 'Total Installs', ratings: 'Total Ratings', reviews: 'Total Reviews',
  avgStars: 'Average Rating', enforced: 'Enforced',
  sourceRemoved: 'Listings Removed', infringingRemoved: 'Downloads Removed',
}

/** The line under a tile's number saying what it counts. Only for the figures
    whose label does not already say it. */
const KPI_FOOT: Record<string, string> = {
  totalAssets: 'Titles in scope',
  totalPlaces: 'Places content was found',
  totalDomains: 'Sites carrying it',
  totalChannels: 'Channels carrying it',
  channelsSuspended: 'Taken offline entirely',
  suspendedWebsites: 'Taken offline entirely',
  profilesSuspended: 'Accounts taken down',
  impactedSubscribers: 'Audience the infringement reached',
  impactedTraffic: 'Audience the infringement reached',
  viewsSaved: 'Views the removals prevented',
  views: 'Views the infringement took',
  viewsImpacted: 'Views the removals took down',
  totalTVChannels: 'Distinct TV channel names',
  delisted: 'Dropped by a search engine',
  googleDelisted: 'Dropped by Google',
  bingDelisted: 'Dropped by Bing',
  notices: 'Distinct notices, not the URLs they listed',
  delistingBatches: 'Distinct submissions, not the links they covered',
  crawled: 'Pages crawled',
  // Mobile apps.
  totalApps: 'Distinct app titles',
  totalDevelopers: 'Publishers behind them',
  installs: 'Downloads the listings claim',
  avgStars: 'Mean over rated listings',
  enforced: 'Notices sent on a listing',
  sourceRemoved: 'Store pages taken down',
  infringingRemoved: 'Download links killed',
}

/** The cross-platform section, which the server serves as a virtual platform
    (go-server/handlers/reportsummary.go). Named here because its KPI band and
    two of its panels are the one place this page is not fully generic. */
const SUMMARY = 'summary'

/**
 * Filters that exist but get no slicer in the rail.
 *
 * Turnaround is read off its own panel — you pick the bucket by clicking the bar
 * — so a dropdown of the same values is a second control for one job. Keyword is
 * a long tail with no useful head to pick from, and the report it replaces has
 * no such slicer either. The filters themselves still work: clicking the panel
 * sets one and a chip appears to clear it.
 *
 * Channel used to be here for the same reason as turnaround, and is not any
 * more: the report this page replaces carries a Channel Name slicer, the values
 * are searchable rather than a raw scroll, and the panel is a top-ten that
 * cannot reach the channel you are actually looking for.
 *
 * This is now a FALLBACK. The pane is arranged in Report Configuration and the
 * server sends the result as `slicers`; the same two are its defaults there, so
 * an install where nobody has touched the pane behaves exactly as this list
 * says — and one where somebody has, does what they asked instead.
 */
const PANEL_ONLY_FILTERS = new Set(['tatBucket', 'keyword', 'channelUrl'])

/** Which slicer a breakdown panel cross-filters, when the section has one.
    Mirrors DIMFilterParam in go-server/handlers/reportplatforms.go. */
const DIM_FILTER: Record<string, string> = {
  byAsset: 'assetId', byAssetName: 'assetId',
  byLanguage: 'language', byLanguageId: 'language',
  byQualityId: 'quality',
  byCountry: 'country', byCountryId: 'country',
  bySearchEngine: 'searchEngine', bySearchEngineId: 'searchEngine',
  bySearchEngineNotices: 'searchEngine', byTAT: 'tatBucket',
  byPlatform: 'platform', byChannel: 'channel', byGroupType: 'groupType',
  byQuality: 'quality', byGenre: 'genre', byGenreId: 'genre',
  byInfringementType: 'infringementType', byInfringementTypeId: 'infringementType',
  byDeliveryType: 'deliveryType', byKeyword: 'keyword',
  byDomain: 'domain', byDomainSource: 'domain',
  // Mobile apps. Mirrors DIMFilterParam in go-server/handlers/reportplatforms.go
  // — this is what makes clicking a bar cross-filter the rest of the page.
  bySourceFeed: 'sourceFeed', byApp: 'appName', byCategory: 'category',
  byDeveloper: 'developer', byStoreType: 'storeType',
  byContentRating: 'contentRating', byRemovalStatus: 'removalStatus',
  // Sports.
  byFranchise: 'franchiseName', byMatchDay: 'matchDay',
  // Its own parameter rather than `channel`: that one filters on the display
  // name and this panel's rows are URLs.
  byRepeatOffender: 'channelUrl',
  /* Enforcement, per counterparty. The engine panel shares `searchEngine` with
     the volume breakdown above it — one engine, one slicer — while a hosting
     provider is a party no other panel groups by and gets its own. */
  byHSPNotices: 'hspName',
  /* The provider panel on the linking half. Same slicer as the host one above:
     one provider, one filter, so clicking a bar on either narrows both. */
  byDelistingBatchHSP: 'hspName',
  byDelistingBatchEngine: 'searchEngine',
}

/**
 * Panels that draw EVERY row rather than the top slice of one.
 *
 * The charts cut to ten by default, which is right for domains, channels and
 * assets: the eleventh is the eleventh worst of thousands, and the tail is a
 * scroll nobody reads. It is wrong for a closed set. A league has the
 * franchises it has and a season has the fixtures it has, so a card that
 * silently drew ten of them would be answering "the ten busiest match days"
 * under a title that promises the season.
 *
 * Mirrors closedSetDims in go-server/handlers/reportplatforms.go, which is what
 * stops the same rows being cut on the way here.
 */
const FULL_SET_DIMS = new Set(['byMatchDay', 'byFranchise'])

/**
 * Panels whose rows read in their OWN sequence rather than by volume.
 *
 * A breakdown arrives ranked by what it found, because the question asked of
 * most of them is "which are the worst". A season is not that question:
 * "Match 12, then Match 7, then Match 41" is an order no season was played in,
 * and nothing can be read across it — not a build-up over the group stage, not
 * a spike on a final. Sorted by the label instead, so the card reads left to
 * right the way the fixtures ran.
 */
const SEQUENCE_DIMS = new Set(['byMatchDay'])

/**
 * Rows in the order their panel should read them.
 *
 * Numeric collation, so "Match 2" comes before "Match 10" — the plain string
 * comparison puts 10 second, which is the classic way a fixture list ends up in
 * an order that looks deliberate and is not. Applied to the CHART and its table
 * twin together: they are two views of one panel and reordering only one of
 * them is worse than reordering neither.
 */
const orderRows = (key: string, rows: any[]) => {
  if (!SEQUENCE_DIMS.has(key) || rows.length < 2) return rows
  return [...rows].sort((a, b) =>
    String(a.label ?? '').localeCompare(String(b.label ?? ''), undefined, { numeric: true }))
}

/** Filters are open-ended: each section declares its own set. */
type Filters = Record<string, string>

/* A calendar day in the READER'S timezone, which is the one the date picker
   draws and the one the reader means by "today".

   toISOString() answers in UTC. East of Greenwich that is still yesterday for
   the first hours of every day — at half past one in the morning in India it
   returns the previous date — and this value is the `max` handed to the date
   range picker, so the day the reader is actually in was greyed out until the
   offset had been slept off.

   A function rather than a module constant for the other half of the same bug:
   a constant is evaluated once when the module is imported, so a tab left open
   across midnight goes on insisting it is yesterday for the whole next day. */
const ymdLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const today = () => ymdLocal(new Date())

/* "Last N days" is inclusive of today, so 30 days is today plus the 29 before
   it — the same rule DateRangePicker's quick ranges use. The default is 30 days:
   a year of warehouse rows is a slow scan and an unreadable trend axis. */
const rangeFrom = (days: number) => ymdLocal(new Date(Date.now() - (days - 1) * 86400e3))

// Only the slicers every section shares. Section-specific ones are added as
// they are set and dropped when the section changes. Built per mount rather
// than once at import, for the reason given on `today`.
const emptyFilters = (): Filters => ({ clientId: '', from: rangeFrom(30), to: today() })

/* ── Chart chrome ─────────────────────────────────────────────────────────── */

/** Legend: always present for two or more series, so identity never rests on
    colour-matching alone. Circle keys, muted text — the mark carries the hue,
    the label stays in ink. */
function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 pt-2">
      {items.map(it => (
        <span key={it.label} className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-white/55">
          <i className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  )
}

/** Tooltip body: the value leads, the series name follows, each row keyed by a
    short stroke of its colour. Recharts hands us the payload for every series
    at the hovered X, so one readout covers them all. */
function ChartTip({ active, payload, label, suffix = '' }: any) {
  if (!active || !payload?.length) return null
  // `label` is the category-axis value, which a pie does not have — its slice
  // name is on the payload row instead. Falling back to it keeps a donut from
  // heading every tooltip with "undefined".
  const head = label ?? payload[0]?.name
  // A donut then has one row whose name IS the heading; repeating it there
  // would just print the slice name twice.
  const echo = payload.length === 1 && String(payload[0]?.name) === String(head)
  return (
    <div className="rounded-lg px-3 py-2 text-xs shadow-lg border bg-white border-gray-200
      dark:bg-[#14254A] dark:border-white/15">
      {head !== undefined && head !== null && (
        <div className="font-semibold mb-1.5 text-gray-500 dark:text-white/60">{shortDate(String(head))}</div>
      )}
      {payload.map((p: any, i: number) => (
        <div key={p.dataKey ?? i} className="flex items-center gap-2 leading-5">
          {/* A pie slice carries its colour on the datum, not on the series. */}
          <i className="w-3 h-[2px] rounded-full flex-shrink-0"
            style={{ background: p.color || p.stroke || p.payload?.fill }} />
          <span className="font-bold tabular-nums text-[#14254A] dark:text-white">
            {full(Number(p.value))}{suffix}
          </span>
          {!echo && <span className="text-gray-400 dark:text-white/45">{p.name}</span>}
        </div>
      ))}
    </div>
  )
}

/**
 * Card — the reference shell: a bold title in a header band, a hairline rule,
 * then the plot with its own muted caption. `table` adds a view toggle in the
 * header; every chart carries one, so no value is reachable only by hovering.
 */
/* ── Choosing the shape of a visual ────────────────────────────────────────────
   Every panel arrives with a shape chosen server-side (Report Configuration →
   Page layout). That is the SENSIBLE DEFAULT, not a verdict: the same rows read
   differently as a donut, a ranked table or a column chart, and which one
   answers today's question is the reader's, not the configuration's.

   So a picker sits on each card and the choice is remembered per reader, in this
   browser. It never changes what anyone else sees and never touches the stored
   layout; clearing it puts the configured shape back. */

interface VizOption { key: string; label: string; hint: string }

/** Shapes a breakdown panel can take, most literal first. */
const DIM_VIZ: VizOption[] = [
  { key: 'bars',    label: 'Grouped bars',    hint: 'Found and removed side by side, per row' },
  { key: 'hbar',    label: 'Bar chart',       hint: 'Horizontal — best when the labels are long' },
  { key: 'column',  label: 'Column chart',    hint: 'Vertical columns' },
  { key: 'value',   label: 'Single bars',     hint: 'One measure only, largest first' },
  { key: 'stacked', label: 'Stacked 100%',    hint: 'Removed against still-live, as a share of each row' },
  { key: 'donut',   label: 'Donut',           hint: 'Share of the total — best under six slices' },
  { key: 'share',   label: 'Donut (ordered)', hint: 'Share on a one-hue ramp, in bucket order' },
  { key: 'table',   label: 'Ranked table',    hint: 'Every row with its rate and share' },
  { key: 'heat',    label: 'Heat grid',       hint: 'Tinted tiles, ranked by volume' },
]

/** Offered only where the dimension is geographic — a map of channel names is
    not a map of anything. */
const MAP_VIZ: VizOption = { key: 'map', label: 'World map', hint: 'Countries tinted by volume' }

/** Offered only on the repeat-offenders panel — it is the one breakdown whose
    rows carry a day count, and on any other panel this shape draws an axis of
    "0 days". */
const REPEAT_VIZ: VizOption = {
  key: 'repeat', label: 'Repeat offenders',
  hint: 'Ranked by how many separate days each account was found on',
}

const TREND_VIZ: VizOption[] = [
  { key: 'auto',   label: 'Automatic',    hint: 'Columns for a few periods, an area for many' },
  { key: 'column', label: 'Column chart', hint: 'One pair of columns per period' },
  { key: 'line',   label: 'Line chart',   hint: 'Two lines, no fill' },
  { key: 'area',   label: 'Area chart',   hint: 'Lines over a wash' },
]

const RATE_VIZ: VizOption[] = [
  { key: 'line',   label: 'Line chart',   hint: 'The rate over time' },
  { key: 'area',   label: 'Area chart',   hint: 'The same, filled' },
  { key: 'column', label: 'Column chart', hint: 'One column per period' },
]

/**
 * The chart-shape menu on a card header.
 *
 * Every shape offers TWO actions, because they are two different intentions:
 *
 *   - VIEW redraws the panel now and is forgotten on reload. Trying a shape out
 *     is the common case, and it must not be a commitment.
 *   - SET DEFAULT keeps it against this login, so the panel comes back this
 *     shape on the next visit and on any other browser the same person signs in
 *     from. Stored server-side — see go-server/handlers/reportvizprefs.go.
 *
 * Portalled because a card is `overflow-hidden`: a menu positioned inside one
 * is clipped by it.
 */
function VizPicker({ options, value, fallback, saved, onPick, onSetDefault }: {
  options: VizOption[]
  value: string
  /** The configured shape, so the menu can mark it and offer a way back. */
  fallback: string
  /** This reader's kept shape, if they have one. Empty means they have not. */
  saved?: string
  onPick: (key: string | null) => void
  /** null clears the kept shape rather than storing a blank. */
  onSetDefault: (key: string | null) => Promise<string | null>
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setRect(btnRef.current?.getBoundingClientRect() ?? null)
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find(o => o.key === value)
  /* "Changed" is measured against what the panel would be on its own — the kept
     shape if there is one, the configured shape otherwise. Without that, a
     reader whose default IS the current shape would see the card marked as
     modified on every visit. */
  const resting = saved || fallback
  const changed = value !== resting

  /* `busyId` is the row being acted on rather than the value being stored, so
     clearing a kept shape marks the row it was kept against — not a row keyed
     on the null it is being set to. */
  const keep = async (key: string | null, busyId: string) => {
    setBusy(busyId)
    setSaveErr(null)
    const err = await onSetDefault(key)
    setBusy(null)
    if (err) { setSaveErr(err); return }
    setOpen(false)
  }

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen(o => !o)}
        aria-haspopup="menu" aria-expanded={open}
        title={`Chart type: ${current?.label ?? value}`}
        className={`w-6 h-6 grid place-items-center rounded-md border transition-colors ${
          changed
            ? 'border-[#14254A] text-[#14254A] dark:border-white/40 dark:text-white'
            : 'border-gray-200 text-gray-400 hover:text-[#14254A] hover:border-gray-300 dark:border-white/15 dark:text-white/50 dark:hover:text-white'
        }`}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
        </svg>
      </button>

      {open && rect && createPortal(
        <div ref={menuRef} role="menu"
          /* Wider than it was: each row now carries a label, a hint and a second
             action, and at the old 250px the hint truncated on every one. */
          className="fixed z-[9999] w-[300px] rounded-xl border shadow-2xl overflow-hidden py-1
            bg-white border-gray-200 dark:bg-[#1a2d55] dark:border-white/15"
          style={{
            top: Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 400)),
            left: Math.max(8, Math.min(rect.right - 300, window.innerWidth - 308)),
          }}>
          <p className="px-3 pt-1.5 text-[9px] font-bold uppercase tracking-widest text-gray-400">
            Show this as
          </p>
          <p className="px-3 pb-1.5 text-[10px] leading-snug text-gray-400">
            Pick one to view it now, or keep it for every future visit.
          </p>
          <div className="max-h-[300px] overflow-y-auto">
            {options.map(o => {
              const on = o.key === value
              const isSaved = !!saved && o.key === saved
              return (
                <div key={o.key} className={`group flex items-stretch transition-colors ${
                  on ? 'bg-[#14254A]/[0.06] dark:bg-white/10' : 'hover:bg-gray-50 dark:hover:bg-white/5'
                }`}>
                  {/* View — the whole row, because trying a shape out is what
                      this menu is opened for nine times in ten. */}
                  <button type="button" role="menuitem"
                    title={`View as ${o.label}`}
                    onClick={() => { onPick(o.key === resting ? null : o.key); setOpen(false) }}
                    className="flex-1 min-w-0 text-left px-3 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span className={`text-xs truncate ${on
                        ? 'font-bold text-[#14254A] dark:text-white'
                        : 'text-gray-600 dark:text-gray-300'}`}>
                        {o.label}
                      </span>
                      {isSaved && (
                        <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-[#FC934C]">
                          yours
                        </span>
                      )}
                      {o.key === fallback && !isSaved && (
                        <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-gray-400">default</span>
                      )}
                      {on && <span className="ml-auto shrink-0 text-[#FC934C] font-bold">✓</span>}
                    </span>
                    <span className="block text-[10px] text-gray-400 leading-snug truncate">{o.hint}</span>
                  </button>

                  {/* Set default — deliberately a separate target. A shape you
                      keep is a different decision from one you glance at, and
                      one stray click should not follow you to the next login. */}
                  <button type="button"
                    disabled={busy !== null}
                    title={isSaved
                      ? 'Stop keeping this shape for your login'
                      : 'Keep this shape for your login, on every device'}
                    onClick={() => keep(isSaved ? null : o.key, o.key)}
                    className={`shrink-0 self-center mr-2 px-1.5 py-1 rounded-md text-[9px] font-bold
                      uppercase tracking-wide border transition-colors disabled:opacity-40 ${
                      isSaved
                        ? 'border-[#FC934C]/40 text-[#FC934C] hover:bg-[#FC934C]/10'
                        : 'border-transparent text-gray-300 group-hover:border-gray-200 group-hover:text-gray-500 dark:text-white/25 dark:group-hover:border-white/20 dark:group-hover:text-white/60'
                    }`}>
                    {busy === o.key ? '…' : isSaved ? 'Clear' : 'Set default'}
                  </button>
                </div>
              )
            })}
          </div>

          {saveErr && (
            <p className="px-3 py-1.5 text-[10px] leading-snug text-red-500 border-t border-gray-100 dark:border-white/10">
              {saveErr}
            </p>
          )}

          {(changed || saved) && (
            <div className="border-t border-gray-100 dark:border-white/10 mt-1 pt-1">
              {changed && (
                <button type="button" onClick={() => { onPick(null); setOpen(false) }}
                  className="w-full text-left px-3 py-1.5 text-[11px] font-semibold
                    text-gray-400 hover:text-[#FC934C] transition-colors">
                  Back to {saved ? 'your kept shape' : 'the configured shape'}
                </button>
              )}
              {saved && (
                <button type="button" disabled={busy !== null}
                  onClick={() => { onPick(null); keep(null, '__clear__') }}
                  className="w-full text-left px-3 py-1.5 text-[11px] font-semibold
                    text-gray-400 hover:text-[#FC934C] transition-colors disabled:opacity-40">
                  {busy === '__clear__' ? 'Forgetting…' : 'Forget my chart type for this panel'}
                </button>
              )}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

function Card({ title, info, chartTitle, action, table, className = '', children }: {
  title?: string; info?: string; chartTitle?: string; action?: React.ReactNode
  table?: React.ReactNode; className?: string; children: React.ReactNode
}) {
  const [asTable, setAsTable] = useState(false)
  return (
    <div className={`h-full flex flex-col bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card
      border border-gray-100 dark:border-white/10 overflow-hidden ${className}`}>
      {title && (
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-white/10">
          <h3 className="text-[14px] font-bold text-[#14254A] dark:text-white truncate">{title}</h3>
          <InfoDot text={info} />
          <span className="ml-auto flex items-center gap-1.5">
            {action}
            {table && (
              <button type="button" onClick={() => setAsTable(v => !v)}
                aria-pressed={asTable} title={asTable ? 'Show the chart' : 'Show the numbers'}
                className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-colors ${
                  asTable
                    ? 'bg-[#14254A] text-white border-[#14254A] dark:bg-white/15 dark:border-white/25'
                    : 'border-gray-200 text-gray-400 hover:text-[#14254A] hover:border-gray-300 dark:border-white/15 dark:text-white/50 dark:hover:text-white'
                }`}>
                Table
              </button>
            )}
          </span>
        </div>
      )}
      <div className="flex-1 p-4 pt-3">
        {chartTitle && !asTable && (
          <p className="text-[11.5px] text-gray-400 dark:text-white/40 mb-2">{chartTitle}</p>
        )}
        {asTable && table ? table : children}
      </div>
    </div>
  )
}

/**
 * What a panel draws when the window returned nothing for it.
 *
 * A panel the layout puts on the page STAYS on the page. Returning null instead
 * meant a card configured in Report Configuration → Page Layout simply was not
 * there, with nothing on either screen to say why — the layout listed a panel
 * the reader could not find, and the reader saw a gap they could not explain.
 * Saying "no data for this period" answers both.
 *
 * Which is also why this is not a reason to hide the panel automatically: an
 * empty card is a fact about the window, not about the page, and whether the
 * page carries it at all is the layout's decision alone.
 */
function NoData({ note = 'No data for this period' }: { note?: string }) {
  return (
    <div className="h-full min-h-[120px] grid place-items-center text-center px-4">
      <span className="text-[11.5px] text-gray-400 dark:text-white/35">{note}</span>
    </div>
  )
}

/** The table twin behind every chart's Table toggle. */
function DataTable({ head, rows, onPick, pickValues, activeVal = '' }: {
  head: string[]; rows: (string | number)[][]
  /* Clicking a row filters by it, exactly as clicking its mark does.

     A table twin exists because the chart had to shorten or drop something — a
     long channel URL, a date the axis skipped — and the reader who switched to
     it was already reaching for that row. Leaving the click behind on the chart
     made TABLE a dead end: the value you came to find was the one value you
     could no longer act on. */
  onPick?: (v: string) => void
  /* The value each row filters BY, one per row, in row order.

     Passed rather than read off column 0, because column 0 is a DISPLAY string.
     A trend table prints "11 Aug" where the filter needs "2026-08-11", and a
     rate column is a formatted percentage — picking the rendered text would
     filter by a value that exists nowhere in the data. Absent, and the rows
     simply do not pick. */
  pickValues?: string[]
  activeVal?: string
}) {
  if (rows.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>
  return (
    <div className="overflow-x-auto max-h-[320px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-white dark:bg-[#1a2d55]">
          <tr className="text-gray-400">
            {head.map((h, i) => (
              <th key={h} className={`font-bold uppercase tracking-widest text-[9px] px-2 pb-2 ${
                i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
          /* A row picks only where it has BOTH a handler and a value of its own.
             A dimension this section cannot filter by passes no handler, and its
             rows must not take a pointer cursor promising something no click
             will do. */
          const pv = pickValues?.[i]
          const can = !!onPick && !!pv
          const on  = can && pv === activeVal
          return (
            <tr key={i} onClick={can ? () => onPick!(pv!) : undefined}
              title={can ? 'Filter the report by this row' : undefined}
              className={`border-t border-[#14254A]/[0.07] dark:border-white/[0.07] transition-colors ${
                can ? 'cursor-pointer hover:bg-[#14254A]/[0.045] dark:hover:bg-white/[0.06]' : ''} ${
                on ? 'bg-[#14254A]/[0.07] dark:bg-white/[0.09]' : ''}`}>
              {r.map((c, j) => (
                /* The name column is clipped at 220px, so its full value lives
                   on the title — a table twin exists to make what the chart had
                   to shorten readable, and a URL cut at 220px is the chart's
                   problem repeated. */
                <td key={j} title={typeof c === 'number' ? undefined : String(c)}
                  className={`px-2 py-1.5 ${
                  j === 0
                    ? 'text-gray-700 dark:text-gray-200 truncate max-w-[220px]'
                    : 'text-right tabular-nums font-semibold text-[#14254A] dark:text-white'}`}>
                  {typeof c === 'number' ? full(c) : c}
                </td>
              ))}
            </tr>
          )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ── Primitives ───────────────────────────────────────────────────────────── */

/**
 * The glyph on a tile's chip, by metric. Line icons at a single weight — a tile
 * is read for its number, and an icon that competes with the figure has taken
 * the reader's eye for the one thing on the tile they already knew.
 *
 * Unknown metrics fall through to a neutral mark rather than a wrong one: a
 * clock on a figure that has nothing to do with time is worse than no clock.
 */
const KPI_ICON: Record<string, string> = {
  identified: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',       // magnifier
  removed: 'M20 6L9 17l-5-5',                                              // tick
  removalPct: 'M12 3v9l7 4M12 3a9 9 0 1 0 9 9',                            // pie
  pending: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',              // clock
  totalAssets: 'M4 5h16v14H4zM4 10h16M9 5v14',                             // reel
  totalPlaces: 'M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z',        // pin
  totalDomains: 'M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z',        // globe
  totalChannels: 'M4 9h16v10H4zM8 9V5h8v4M9 14h6',                         // broadcast
  totalCountries: 'M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z',
  channelsSuspended: 'M5 5l14 14M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',     // barred
  profilesSuspended: 'M5 5l14 14M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  suspendedWebsites: 'M5 5l14 14M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  impactedSubscribers: 'M16 19v-2a4 4 0 0 0-8 0v2M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  impactedTraffic: 'M16 19v-2a4 4 0 0 0-8 0v2M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  views: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  viewsSaved: 'M12 21s7-4 7-9V6l-7-3-7 3v6c0 5 7 9 7 9z',                  // shield
  savedRevenue: 'M12 4v16M8 8h6a2.5 2.5 0 0 1 0 5H9a2.5 2.5 0 0 0 0 5h7',  // currency
  delisted: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM8 11h6M20 20l-4.2-4.2',
  googleDelisted: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM8 11h6M20 20l-4.2-4.2',
  bingDelisted: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM8 11h6M20 20l-4.2-4.2',
  notices: 'M3 6h18v12H3zM3 7l9 6 9-6',                                    // envelope
  crawled: 'M4 18V9M10 18V5M16 18v-6M22 18h-20',                           // bars
}
const KPI_ICON_FALLBACK = 'M6 12h.01M12 12h.01M18 12h.01'

/**
 * The change on a tile, against the same-length window before this one.
 *
 * `tone` is the deliberate part. A rise is not automatically good news here:
 * more links taken down is, more links still live is not, and more links
 * IDENTIFIED is neither — it can mean piracy grew or that detection did, and
 * this page cannot tell which. Those neutral figures get the arrow and the
 * number in ink, so the tile reports the movement without editorialising about
 * a direction it cannot read.
 */
type KpiDelta = { text: string; dir: 'up' | 'down'; tone: 'good' | 'bad' | 'flat'; title: string }

/** Metrics where up is the outcome you want, and where it is the one you don't. */
const KPI_UP_IS_GOOD = new Set(['removed', 'removalPct', 'delisted', 'googleDelisted',
  'bingDelisted', 'channelsSuspended', 'suspendedWebsites', 'viewsSaved', 'savedRevenue',
  'notices'])
const KPI_UP_IS_BAD = new Set(['pending', 'views', 'impactedSubscribers', 'impactedTraffic'])

/**
 * The change on one metric against the previous window's figure.
 *
 * The ABSOLUTE change leads, not the percentage: a rise from 2 to 6 is "+4", and
 * printing that as "+200%" makes a rounding-sized movement look like a crisis.
 * The proportion is on the tooltip, for a reader who wants it.
 *
 * Null when there is nothing honest to say — no previous figure at all, or two
 * identical ones, which the absence of a pill states better than a "0" the eye
 * has to stop and dismiss.
 */
function kpiDelta(metric: string, cur: unknown, prev: unknown, window?: string): KpiDelta | null {
  const c = Number(cur)
  const p = Number(prev)
  if (!isFinite(c) || !isFinite(p) || cur === undefined || prev === undefined) return null
  const diff = c - p
  if (Math.abs(diff) < (metric === 'removalPct' ? 0.05 : 0.5)) return null

  const tone: KpiDelta['tone'] =
    KPI_UP_IS_GOOD.has(metric) ? (diff > 0 ? 'good' : 'bad')
      : KPI_UP_IS_BAD.has(metric) ? (diff > 0 ? 'bad' : 'good')
        : 'flat'
  // A share moves in percentage POINTS. "+2%" on a removal rate reads as two
  // percent of the rate, which is a different and much smaller number.
  const text = metric === 'removalPct'
    ? `${Math.abs(diff).toFixed(1)} pts`
    : kpiFmt(Math.abs(diff))
  const show = (v: number) => metric === 'removalPct' ? `${v.toFixed(2)}%` : full(Math.round(v))
  const share = p !== 0 && metric !== 'removalPct'
    ? ` — ${diff > 0 ? '+' : '−'}${Math.abs((diff / p) * 100).toFixed(1)}%`
    : ''
  return {
    text, tone, dir: diff > 0 ? 'up' : 'down',
    title: `${show(p)} over ${window || 'the previous window'}, ${show(c)} now${share}`,
  }
}

/**
 * KPI tile.
 *
 * The chip and the sparkline wear the colour of the series the tile summarises,
 * so a tile and its line in the chart below read as the same thing; the value
 * itself stays in ink — a number is text, not a mark. Proportional figures, not
 * tabular: at this size equal-width digits look loose.
 */
function Kpi({ label, value, foot, accent, spark, sparkData, dense, delta, icon, info }: {
  label: string; value: string; foot?: string; accent: string
  spark?: string; sparkData?: any[]
  delta?: KpiDelta | null
  /** Metric key, for the chip glyph. */
  icon?: string
  /** A tile whose figure is a range rather than a number — two values and a
      dash need a step down in size to sit on one line at this width. */
  dense?: boolean
  /** Admin-written note from Report Configuration, behind an ⓘ by the label. */
  info?: string
}) {
  /* Every tile is the same box whatever it holds. The label sits at the top and
     the sparkline at the bottom, with the value, its change and its footnote
     taking the slack between them — so a tile with a trend and a tile without
     still line up, instead of the row with sparklines standing taller than the
     row below it. */
  const tone = delta?.tone === 'good'
    ? 'text-emerald-600 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-400/12'
    : delta?.tone === 'bad'
      ? 'text-red-600 bg-red-50 dark:text-red-300 dark:bg-red-400/12'
      : 'text-[#14254A]/70 bg-[#14254A]/[0.06] dark:text-white/70 dark:bg-white/10'
  return (
    <div className="relative h-full flex flex-col bg-white dark:bg-[#1a2d55] rounded-xl shadow-card
      border border-gray-100 dark:border-white/10 p-3.5 pt-4 overflow-hidden">
      {/* Along the top rather than down the side: the chip now carries the
          series colour at size, and a second bar of it on the left made two
          marks for one fact. */}
      <span className="absolute left-0 right-0 top-0 h-[3px]" style={{ background: accent }} />

      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-1 mb-1.5">
            <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 leading-tight">
              {label}
            </span>
            <InfoDot text={info} />
          </span>
          <div className={`font-extrabold leading-none text-[#14254A] dark:text-white ${
            dense ? 'text-[15px] leading-tight' : 'text-xl'}`}>{value}</div>
        </div>
        <span className="w-8 h-8 rounded-[10px] grid place-items-center flex-shrink-0"
          style={{ background: accent }} aria-hidden>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff"
            strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <path d={KPI_ICON[icon ?? ''] ?? KPI_ICON_FALLBACK} />
          </svg>
        </span>
      </div>

      {delta && (
        <div className="flex items-center gap-1.5 mt-2" title={delta.title}>
          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md
            text-[10px] font-bold tabular-nums ${tone}`}>
            {delta.dir === 'up' ? '↑' : '↓'}{delta.text}
          </span>
          <span className="text-[10px] text-gray-400 truncate">vs previous period</span>
        </div>
      )}
      {foot && <div className="text-[10px] text-gray-400 mt-1.5">{foot}</div>}
      <div className="flex-1 min-h-[6px]" />
      {spark && sparkData && sparkData.length > 1 && (
        <Spark data={sparkData} dataKey={spark} color={accent} />
      )}
    </div>
  )
}

/**
 * Sparkline for a KPI tile — 32px of trend under a number, so a headline figure
 * carries its direction as well as its value. No axes: at this size they would
 * cost more than they explain, and the tile's value is the label.
 */
function Spark({ data, dataKey, color }: { data: any[]; dataKey: string; color: string }) {
  const id = `sp-${dataKey}-${color.replace('#', '')}`
  return (
    <div className="h-7 -mx-1 -mb-1 mt-1">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false}
            fill={`url(#${id})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * Trend — identification against removal over time.
 *
 * The form follows the point count, because neither shape works at both ends:
 * a dozen periods or fewer are columns (each period is a discrete thing you
 * compare), more than that is an area (the shape of the run is the story and
 * columns turn into a picket fence). Values are direct-laballed only where they
 * carry weight — the peak of each series on columns, the last point on the
 * area — with the axis and the tooltip carrying the rest.
 */
function Trend({ data, m, firstName = 'Identified', secondName = 'Removed', mode = 'auto',
  single = false, color, onPick }: {
  data: any[]; m: MarkTheme
  /* Clicking a period narrows the whole report to it — see periodSpan and
     pickPeriod. Every other panel on this page has cross-filtered on click
     since it was built; the dated ones were the exception, which made the axis
     everybody actually wants to drill into the one thing that did nothing. */
  onPick?: (label: string) => void
  /** 'auto' keeps the shape the point count asks for; anything else is the
      reader overriding it from the card's chart-type menu. */
  mode?: 'auto' | 'column' | 'line' | 'area'
  /* The second series is always carried on `removed` — see toTrend — but it is
     not always a removal. On the linking half of Open Web it is links search
     engines have dropped, which is a different event from a page coming down, so
     the caller names it. */
  firstName?: string; secondName?: string
  /* ONE series, for a figure that has no counterpart. An enforcement action is
     sent or it is not — there is no "notices removed" — and a flat zero drawn
     beside it would invite a removal rate to be read off a card that has none. */
  single?: boolean
  /** Overrides the first series' colour, so a card measuring a different UNIT
      from the trend beside it does not wear the same navy. */
  color?: string
}) {
  if (data.length === 0) {
    return <div className="text-sm text-gray-400 py-16 text-center">No dated rows in this range.</div>
  }
  if (data.length === 1) {
    // One period is a number, not a chart — a single column tells you nothing a
    // KPI tile has not already said.
    const d = data[0]
    return (
      <div className="py-10 text-center">
        <p className="text-[11px] text-gray-400 uppercase tracking-widest mb-2">{shortDate(d.label)}</p>
        <p className="text-3xl font-extrabold text-[#14254A] dark:text-white">{full(d.urls)}</p>
        <p className="text-xs text-gray-400 mt-1">
          {single
            ? firstName.toLowerCase()
            : `${firstName.toLowerCase()} · ${full(d.removed)} ${secondName.toLowerCase()} (${d.rate}%)`}
        </p>
        <p className="text-[11px] text-gray-400 mt-4 max-w-xs mx-auto">
          Widen the date range to see this as a trend.
        </p>
      </div>
    )
  }

  const axis = { tickLine: false, axisLine: false, tick: { fill: m.axis, fontSize: 11 } }
  const series = [
    { key: 'urls', name: firstName, color: color ?? m.ident },
    ...(single ? [] : [{ key: 'removed', name: secondName, color: m.removed }]),
  ]

  /* Label only the tallest column of each series. `above` keeps the two apart:
     identified is always ≥ removed, so its label goes over the cap and removal's
     sits just under it. */
  const peakLabel = (key: string, above: boolean) => {
    const peak = data.reduce((best, r, i) => (r[key] > data[best][key] ? i : best), 0)
    return (props: any) => {
      if (props.index !== peak || !props.value) return null
      return (
        <text x={props.x + props.width / 2} y={props.y + (above ? -6 : 14)}
          textAnchor="middle" fontSize={10} fontWeight={700}
          className="fill-[#14254A] dark:fill-white">
          {fmt(Number(props.value))}
        </text>
      )
    }
  }

  /* The last point of each series, set in the right margin rather than over the
     plot — an end-label placed inside lands on top of its own line. */
  const endLabel = (props: any) => {
    if (props.index !== data.length - 1) return null
    return (
      <text x={props.x + 7} y={props.y + 3.5} textAnchor="start" fontSize={10} fontWeight={700}
        className="fill-[#14254A] dark:fill-white">
        {fmt(Number(props.value))}
      </text>
    )
  }

  const ticks = niceTicks(Math.max(...data.map(d => single ? d.urls : Math.max(d.urls, d.removed))))
  const yAxis = { ...axis, width: 46, ticks, domain: [0, ticks[ticks.length - 1]], tickFormatter: axisNum }

  /* Recharts reports the clicked CATEGORY on the chart itself rather than on
     each mark, which is what we want here: on an area chart the mark is a
     two-pixel line and the reader is aiming at the day, not at the stroke. The
     tooltip already tracks the nearest column, so the click lands where the
     tooltip says it will. */
  const clickable = onPick
    ? { onClick: (st: any) => { const l = st?.activeLabel; if (l) onPick(String(l)) } }
    : {}

  return (
    <>
      <div style={{ height: 168, cursor: onPick ? 'pointer' : undefined }}>
        <ResponsiveContainer width="100%" height="100%">
          {(mode === 'column' || (mode === 'auto' && data.length <= 12)) ? (
            /* Columns: capped at 24px so a sparse range leaves air in the band
               rather than three slabs, and 2px apart in the surface colour. */
            <BarChart data={data} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barGap={2}
              {...clickable}>
              <CartesianGrid vertical={false} stroke={m.grid} />
              <XAxis dataKey="label" {...axis} tickFormatter={shortDate} />
              <YAxis {...yAxis} />
              <Tooltip cursor={{ fill: m.grid, fillOpacity: 0.5 }} content={<ChartTip />} />
              {series.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color}
                  maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  <LabelList dataKey={s.key} content={peakLabel(s.key, i === 0)} />
                </Bar>
              ))}
            </BarChart>
          ) : (
            /* Area: 2px stroke over a wash — enough to read the shape, not
               enough to hide the series underneath it. */
            <AreaChart data={data} margin={{ top: 18, right: 34, left: 0, bottom: 0 }} {...clickable}>
              <defs>
                {series.map(s => (
                  <linearGradient key={s.key} id={`tr-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} stroke={m.grid} />
              <XAxis dataKey="label" {...axis} tickFormatter={shortDate} minTickGap={28} />
              <YAxis {...yAxis} />
              <Tooltip cursor={{ stroke: m.axis, strokeWidth: 1, strokeOpacity: 0.5 }} content={<ChartTip />} />
              {series.map(s => (
                <Area key={s.key} type="monotone" dataKey={s.key} name={s.name}
                  stroke={s.color} strokeWidth={2} dot={false}
                  fill={mode === 'line' ? 'none' : `url(#tr-${s.key})`}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: m.surface }} isAnimationActive={false}>
                  <LabelList dataKey={s.key} content={endLabel} />
                </Area>
              ))}
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
      <Legend items={series.map(s => ({ label: s.name, color: s.color }))} />
    </>
  )
}

/**
 * Removal rate over the same periods, on its own card.
 *
 * Rate and volume move independently — a busy month can have poor removal — but
 * they belong on separate axes only in the sense of separate charts: two scales
 * sharing one plot invent a correlation out of where the two axes happen to be
 * pinned. One series here, so no legend box: the card title names it.
 */
function RateTrend({ data, m, mode = 'line', onPick }: {
  data: any[]; m: MarkTheme
  /** The rate is a line by default; the card's menu can make it an area or
      a column per period. */
  mode?: 'line' | 'area' | 'column'
  /** Same period pick as the trend beside it — a poor week is read off THIS
      card, so it is the one a reader is most likely to want to open. */
  onPick?: (label: string) => void
}) {
  if (data.length < 2) {
    return <div className="text-sm text-gray-400 py-16 text-center">Not enough periods in this range to plot a rate.</div>
  }
  const axis = { tickLine: false, axisLine: false, tick: { fill: m.axis, fontSize: 11 } }
  const endLabel = (props: any) => {
    if (props.index !== data.length - 1) return null
    return (
      <text x={props.x + 7} y={props.y + 4} textAnchor="start" fontSize={11} fontWeight={700}
        className="fill-[#14254A] dark:fill-white">
        {props.value}%
      </text>
    )
  }
  // The three shapes share every axis and both labels; only the mark differs.
  const frame = (
    <>
      <CartesianGrid vertical={false} stroke={m.grid} />
      <XAxis dataKey="label" {...axis} tickFormatter={shortDate} minTickGap={28} />
      <YAxis {...axis} width={40} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]}
        tickFormatter={(v: number) => `${v}%`} />
      <Tooltip cursor={mode === 'column'
        ? { fill: m.grid, fillOpacity: 0.5 }
        : { stroke: m.axis, strokeWidth: 1, strokeOpacity: 0.5 }}
        content={<ChartTip suffix="%" />} />
    </>
  )
  const margin = { top: 18, right: mode === 'column' ? 8 : 40, left: 0, bottom: 0 }
  const clickable = onPick
    ? { onClick: (st: any) => { const l = st?.activeLabel; if (l) onPick(String(l)) } }
    : {}

  return (
    <div style={{ height: 200, cursor: onPick ? 'pointer' : undefined }}>
      <ResponsiveContainer width="100%" height="100%">
        {mode === 'column' ? (
          <BarChart data={data} margin={margin} {...clickable}>
            {frame}
            <Bar dataKey="rate" name="Removal rate" fill={m.removed}
              maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        ) : mode === 'area' ? (
          <AreaChart data={data} margin={margin} {...clickable}>
            <defs>
              <linearGradient id="rate-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={m.removed} stopOpacity={0.18} />
                <stop offset="100%" stopColor={m.removed} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            {frame}
            <Area type="monotone" dataKey="rate" name="Removal rate" stroke={m.removed}
              strokeWidth={2} fill="url(#rate-fill)" dot={false} isAnimationActive={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: m.surface }}>
              <LabelList dataKey="rate" content={endLabel} />
            </Area>
          </AreaChart>
        ) : (
          <LineChart data={data} margin={margin} {...clickable}>
            {frame}
            <Line type="monotone" dataKey="rate" name="Removal rate" stroke={m.removed}
              strokeWidth={2} strokeLinecap="round" dot={false} isAnimationActive={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: m.surface }}>
              <LabelList dataKey="rate" content={endLabel} />
            </Line>
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

/**
 * Grouped bars — the default breakdown shape. Horizontal, because dimension
 * labels are names and names read horizontally; value at the tip of each bar,
 * which is where the eye already is. Selecting a row cross-filters the report
 * and dims the rest, which is how this product signals an active filter.
 */
function SegmentBars({ rows, m, activeVal = '', onPick, limit = 10 }: {
  rows: any[]; m: MarkTheme; activeVal?: string; onPick?: (v: string) => void; limit?: number
}) {
  const segs = rows.slice(0, limit)
  const max = Math.max(1, ...segs.map(r => Number(r.urls) || 0))
  const hasActive = !!activeVal
  if (segs.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>
  return (
    <>
      <div className="flex flex-col gap-1.5">
        {segs.map((r, i) => {
          const label = String(r['label'] ?? '—')
          // Lookup dimensions carry the id in `value` and the name in `label`;
          // the filter must use the id, the display must use the name.
          const filterVal = String(r.value ?? label)
          const urls = Number(r.urls) || 0
          const removed = Number(r.removed) || 0
          const isActive = activeVal === filterVal || activeVal === label
          const dimmed = hasActive && !isActive
          return (
            <button key={label + i} type="button" disabled={!onPick} onClick={() => onPick?.(filterVal)}
              title={`${label}: ${full(urls)} identified · ${full(removed)} removed`}
              className={`grid items-center gap-3 rounded-md px-1.5 py-0.5 text-left transition-all ${
                onPick ? 'hover:bg-[#14254A]/[0.04] dark:hover:bg-white/5' : 'cursor-default'} ${
                isActive ? 'bg-[#14254A]/[0.05] ring-1 ring-[#14254A]/30 dark:bg-white/5 dark:ring-white/20' : ''} ${
                dimmed ? 'opacity-40' : ''}`}
              style={{ gridTemplateColumns: '104px 1fr' }}>
              <span className="text-xs text-gray-600 dark:text-gray-300 truncate" title={label}>{label}</span>
              {/* Two thin bars from a shared baseline, 2px apart, each with its
                  value at the tip — no axis needed at this size. */}
              <span className="flex flex-col gap-[2px] min-w-0">
                {[{ v: urls, c: m.ident }, { v: removed, c: m.removed }].map((b, j) => (
                  <span key={j} className="flex items-center gap-1.5">
                    <span className="h-2 rounded-r-[3px]"
                      style={{ width: `${Math.max(0.5, (b.v / max) * 100)}%`, minWidth: 2, background: b.c }} />
                    <span className="text-[10px] font-bold tabular-nums text-[#14254A] dark:text-white whitespace-nowrap">
                      {fmt(b.v, 0)}
                    </span>
                  </span>
                ))}
              </span>
            </button>
          )
        })}
      </div>
      <Legend items={[{ label: 'Identified', color: m.ident }, { label: 'Removed', color: m.removed }]} />
    </>
  )
}

/**
 * Share of total. Part-to-whole at a glance, capped at six slices with the tail
 * folded into a neutral "Other" — past that, neighbouring wedges stop being
 * tellable apart and the chart is worse than the list beside it. The list is
 * that relief: every slice's value and share in plain text.
 */
function Donut({ rows, m, onPick, activeVal = '', ramp = 'cat' }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string
  /** `ordinal` is for buckets that have an order — turnaround, tiers, bands.
      They take the one-hue ramp in their own order, so the colour carries the
      sequence; identity hues would say these are unrelated things. */
  ramp?: 'cat' | 'ordinal'
}) {
  const ordered = ramp === 'ordinal'
  const palette = ordered ? m.seq : m.cat
  const limit   = ordered ? m.seq.length : CAT_LIMIT

  const all = rows.map(r => ({
    name: String(r.label ?? '—'), value: Number(r.urls) || 0,
    value_: String(r.value ?? r.label ?? ''),
  }))
  // Server rows arrive biggest-first, which is the wrong order for a sequence.
  if (ordered) all.sort((a, b) => leadingNum(a.name) - leadingNum(b.name))

  const kept = all.slice(0, limit)
  const tail = all.slice(limit)
  const slices = tail.length > 0
    ? [...kept, { name: `Other (${tail.length})`, value: tail.reduce((a, b) => a + b.value, 0), value_: '' }]
    : kept
  // The colour lives on the datum rather than only on the <Cell>, so the sector
  // and the tooltip's key read the same field.
  const data = slices.map((d, i) => ({
    ...d, fill: d.value_ === '' && tail.length > 0 ? m.other : palette[i % palette.length],
  }))
  const total = data.reduce((a, b) => a + b.value, 0)
  if (data.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>

  // One category is not a share of anything — a ring drawn at 100% tells the
  // reader nothing the number does not. The figure is the chart.
  if (data.length === 1) {
    return (
      <div className="py-8 text-center">
        <p className="text-3xl font-extrabold text-[#14254A] dark:text-white">{full(data[0].value)}</p>
        <p className="text-xs text-gray-400 mt-1.5">
          all of it <span className="font-semibold text-gray-500 dark:text-white/60">{data[0].name}</span>
        </p>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-4 flex-wrap sm:flex-nowrap">
      <div style={{ width: 150, height: 150, flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            {/* paddingAngle + a surface-coloured stroke give the 2px gap that
                separates touching wedges without drawing a border on them. */}
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="94%"
              paddingAngle={2} stroke={m.surface} strokeWidth={2} isAnimationActive={false}
              onClick={(e: any) => e?.payload?.value_ && onPick?.(String(e.payload.value_))}>
              {data.map((d, i) => (
                <Cell key={d.name} fill={d.fill}
                  opacity={activeVal && activeVal !== d.value_ && activeVal !== d.name ? 0.35 : 1}
                  cursor={onPick && d.value_ ? 'pointer' : 'default'} />
              ))}
            </Pie>
            <Tooltip content={<ChartTip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      {/* The legend is also the value list — identity, magnitude and share in
          text, so nothing here needs a hover to be read. */}
      <ul className="flex-1 min-w-0 space-y-0.5">
        {data.map((d, i) => (
          <li key={d.name}>
            <button type="button" disabled={!onPick || !d.value_} onClick={() => onPick?.(d.value_)}
              className={`w-full flex items-center gap-2 text-left rounded-md px-1.5 py-1 transition-colors ${
                onPick && d.value_ ? 'hover:bg-[#14254A]/[0.04] dark:hover:bg-white/5' : 'cursor-default'}`}>
              <i className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: d.fill }} />
              <span className="text-[11px] truncate text-gray-600 dark:text-gray-300" title={d.name}>{d.name}</span>
              <span className="ml-auto text-[11px] font-bold tabular-nums text-[#14254A] dark:text-white">
                {full(d.value)}
              </span>
              <span className="text-[10px] text-gray-400 tabular-nums w-9 text-right">
                {pct(d.value, total)}%
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 100% stacked bars — removed against still-live as a share of each row, so
 * rows of wildly different size are still comparable on the one thing the
 * report is about. Built in HTML rather than recharts for the 2px surface gap
 * between the two segments, and so an in-segment label can be dropped when it
 * does not fit instead of being clipped.
 */
function StackedBars({ rows, m, onPick, activeVal = '', limit = 12 }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string; limit?: number
}) {
  const data = rows.slice(0, limit)
  if (data.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>
  const hasActive = !!activeVal
  return (
    <>
      <div className="flex flex-col gap-1.5">
        {data.map((r, i) => {
          const urls = Number(r.urls) || 0
          const removed = Math.min(urls, Number(r.removed) || 0)
          const label = String(r.label ?? '—')
          const val = String(r.value ?? label)
          const share = pct(removed, urls)
          const isActive = activeVal === val || activeVal === label
          return (
            <button key={val + i} type="button" disabled={!onPick} onClick={() => onPick?.(val)}
              title={`${label}: ${full(removed)} of ${full(urls)} removed`}
              className={`grid items-center gap-3 rounded-md px-1.5 py-0.5 text-left transition-all ${
                onPick ? 'hover:bg-[#14254A]/[0.04] dark:hover:bg-white/5' : 'cursor-default'} ${
                isActive ? 'bg-[#14254A]/[0.05] ring-1 ring-[#14254A]/30 dark:bg-white/5 dark:ring-white/20' : ''} ${
                hasActive && !isActive ? 'opacity-40' : ''}`}
              style={{ gridTemplateColumns: '104px 1fr 40px' }}>
              <span className="text-xs text-gray-600 dark:text-gray-300 truncate" title={label}>{label}</span>
              <span className="flex h-5 rounded-[3px]" style={{ gap: 2 }}>
                {/* A percentage only goes inside a segment when it has room for
                    it — roughly 4 characters' worth — otherwise the row's
                    right-hand column and the table view carry it. */}
                <span className="grid place-items-center rounded-l-[3px]"
                  style={{ width: `${share}%`, background: m.removed }}>
                  {share >= 18 && (
                    <span className="text-[10px] font-bold" style={{ color: m.segInk }}>{share}%</span>
                  )}
                </span>
                <span className="grid place-items-center rounded-r-[3px]"
                  style={{ width: `${100 - share}%`, background: m.identSoft }}>
                  {100 - share >= 18 && (
                    <span className="text-[10px] font-bold" style={{ color: m.segInk }}>{100 - share}%</span>
                  )}
                </span>
              </span>
              <span className="text-[10px] font-bold tabular-nums text-right text-[#14254A] dark:text-white">
                {fmt(urls, 0)}
              </span>
            </button>
          )
        })}
      </div>
      <Legend items={[
        { label: 'Removed', color: m.removed },
        { label: 'Still live', color: m.identSoft },
      ]} />
    </>
  )
}

/**
 * Single-series bars.
 *
 * For a dimension where there is no second measure to draw: channels suspended
 * per platform, or the count that landed in each turnaround bucket — a bucket's
 * rows have all been removed by definition, so "removed vs still live" is a bar
 * at 100% next to a bar at nothing. The grouped list would print a "0" beside
 * every row instead of saying that.
 *
 * `ordered` is for buckets that have a sequence rather than a ranking. They are
 * put back in their own order and take the one-hue ramp, so the colour carries
 * the progression — 0-6 hours pale, 24+ hours dark.
 */
function ValueBars({ rows, m, onPick, activeVal = '', ordered = false, limit = 12 }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string
  ordered?: boolean; limit?: number
}) {
  const data = (ordered
    ? [...rows].sort((a, b) => leadingNum(String(a.label)) - leadingNum(String(b.label)))
    : rows
  ).slice(0, limit)
  if (data.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>

  const max = Math.max(1, ...data.map(r => Number(r.urls) || 0))
  const hasActive = !!activeVal
  return (
    <div className="flex flex-col gap-2 py-1">
      {data.map((r, i) => {
        const label = String(r.label ?? '—')
        const val = String(r.value ?? label)
        const urls = Number(r.urls) || 0
        const isActive = activeVal === val || activeVal === label
        // The ramp runs low→high across the rows in sequence order; an unordered
        // list is one hue, because there is nothing for a second one to mean.
        const color = ordered ? m.seq[Math.min(m.seq.length - 1, i)] : m.ident
        return (
          <button key={val + i} type="button" disabled={!onPick} onClick={() => onPick?.(val)}
            title={`${label}: ${full(urls)}`}
            className={`grid items-center gap-3 rounded-md px-1.5 py-0.5 text-left transition-all ${
              onPick ? 'hover:bg-[#14254A]/[0.04] dark:hover:bg-white/5' : 'cursor-default'} ${
              isActive ? 'bg-[#14254A]/[0.05] ring-1 ring-[#14254A]/30 dark:bg-white/5 dark:ring-white/20' : ''} ${
              hasActive && !isActive ? 'opacity-40' : ''}`}
            style={{ gridTemplateColumns: '112px 1fr' }}>
            <span className="text-xs text-gray-600 dark:text-gray-300 truncate" title={label}>{label}</span>
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="h-3 rounded-r-[3px]"
                style={{ width: `${Math.max(0.5, (urls / max) * 100)}%`, minWidth: 2, background: color }} />
              <span className="text-[10px] font-bold tabular-nums text-[#14254A] dark:text-white whitespace-nowrap">
                {fmt(urls, urls >= 1000 ? 1 : 0)}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Ranked table with a share column — for long, name-heavy dimensions. */
function RankTable({ rows, onPick, activeVal = '', limit = 12 }: {
  rows: any[]; onPick?: (v: string) => void; activeVal?: string; limit?: number
}) {
  const data = rows.slice(0, limit)
  const total = data.reduce((a, r) => a + (Number(r.urls) || 0), 0)
  if (data.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400">
            {['#', 'Name', 'Identified', 'Removed', 'Rate', 'Share'].map((h, i) => (
              <th key={h} className={`font-bold uppercase tracking-widest text-[9px] px-1.5 pb-2 ${
                i <= 1 ? 'text-left' : 'text-right'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((r, i) => {
            const urls = Number(r.urls) || 0
            const removed = Number(r.removed) || 0
            const val = String(r.value ?? r.label ?? '')
            const on = activeVal !== '' && (activeVal === val || activeVal === r.label)
            return (
              <tr key={val + i} onClick={() => onPick?.(val)}
                className={`border-t border-[#14254A]/[0.07] dark:border-white/[0.07] ${
                  onPick ? 'cursor-pointer hover:bg-[#14254A]/[0.04] dark:hover:bg-white/[0.06]' : ''} ${
                  on ? 'bg-[#14254A]/[0.05] dark:bg-white/[0.08]' : ''}`}>
                <td className="px-1.5 py-1.5 text-gray-400 tabular-nums">{i + 1}</td>
                <td className="px-1.5 py-1.5 text-gray-700 dark:text-gray-200 truncate max-w-[240px]" title={String(r.label)}>
                  {String(r.label)}
                </td>
                <td className="px-1.5 py-1.5 text-right font-bold tabular-nums text-[#14254A] dark:text-white">{full(urls)}</td>
                <td className="px-1.5 py-1.5 text-right font-bold tabular-nums text-[#14254A] dark:text-white">{full(removed)}</td>
                <td className="px-1.5 py-1.5 text-right tabular-nums text-gray-500 dark:text-white/50">{pct(removed, urls)}%</td>
                <td className="px-1.5 py-1.5 text-right tabular-nums text-gray-400">{pct(urls, total)}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Heat grid — intensity by value, for a geography split. A choropleth needs a
 * topology this project does not ship, and a tinted grid conveys the same
 * ranking honestly without pretending to be a map. Colour is the only magnitude
 * channel here (there is no bar to read), so it is a genuine sequential scale:
 * one hue, five steps, light→dark, with the count printed on every tile and a
 * scale legend underneath.
 */
/* ── World map ─────────────────────────────────────────────────────────────────
   Country geometry lives in ./worldShapes.ts — Natural Earth 110m, projected at
   build time so the page needs no geo library at runtime. */

/** Compare country names loosely: case, punctuation and spacing all vary
    between the warehouse and Natural Earth ("Côte d'Ivoire" / "Cote d Ivoire"). */
const normCountry = (s: string) => String(s).toLowerCase().replace(/[^a-z]/g, '')

/**
 * Warehouse spellings that differ from Natural Earth's, normalised on both
 * sides. Anything not listed here and not an exact match simply goes unmapped
 * and is reported under the map rather than dropped.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'United States of America', us: 'United States of America',
  unitedstates: 'United States of America', america: 'United States of America',
  uk: 'United Kingdom', greatbritain: 'United Kingdom', england: 'United Kingdom',
  unitedkingdomofgreatbritainandnorthernireland: 'United Kingdom',
  russianfederation: 'Russia', czechrepublic: 'Czechia',
  republicofkorea: 'South Korea', koreasouth: 'South Korea', korea: 'South Korea',
  koreanorth: 'North Korea', democraticpeoplesrepublicofkorea: 'North Korea',
  ivorycoast: "Côte d'Ivoire", cotedivoire: "Côte d'Ivoire",
  democraticrepublicofthecongo: 'Dem. Rep. Congo', drcongo: 'Dem. Rep. Congo',
  republicofthecongo: 'Congo', burma: 'Myanmar',
  bosniaandherzegovina: 'Bosnia and Herz.', northmacedonia: 'Macedonia',
  swaziland: 'eSwatini', capeverde: 'Cabo Verde',
  easttimor: 'Timor-Leste', dominicanrepublic: 'Dominican Rep.',
  centralafricanrepublic: 'Central African Rep.', southsudan: 'S. Sudan',
  equatorialguinea: 'Eq. Guinea', solomonislands: 'Solomon Is.',
  westernsahara: 'W. Sahara', uae: 'United Arab Emirates',
  vietnamsocialistrepublic: 'Vietnam', laopdr: 'Laos',
}

/** Natural Earth name → its path, by normalised name, built once. */
const SHAPE_BY_NAME = new Map(WORLD_SHAPES.map(s => [normCountry(s.name), s]))

/** Warehouse label → the shape it belongs to, or undefined if it has no place
    on a map (a region rollup like "Global", or a spelling we do not know). */
function shapeFor(label: string) {
  const n = normCountry(label)
  const direct = SHAPE_BY_NAME.get(n)
  if (direct) return direct
  const alias = COUNTRY_ALIASES[n]
  return alias ? SHAPE_BY_NAME.get(normCountry(alias)) : undefined
}

/**
 * Choropleth. Countries carrying data are tinted on the same rank-based scale
 * the tile grid uses; everything else takes a neutral "no data" fill, which is
 * a different statement from "zero" and has to look different.
 *
 * Rows that cannot be placed — "Global" is one, and it is usually the largest —
 * are listed under the map instead of being silently dropped, so the panel never
 * shows less than the query returned.
 */
function WorldMap({ rows, m, onPick, activeVal = '' }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string
}) {
  const [hover, setHover] = useState<{ name: string; urls: number; removed: number; x: number; y: number } | null>(null)

  const placed = rows.map(r => ({ row: r, shape: shapeFor(String(r.label ?? '')) }))
  const mapped = placed.filter(p => p.shape)
  const unmapped = placed.filter(p => !p.shape)
  if (rows.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>

  const steps = rankSteps(mapped.map(p => Number(p.row.urls) || 0), m.seq.length)
  const byShape = new Map<string, { fill: string; row: any; step: number }>()
  mapped.forEach((p, i) => {
    byShape.set(p.shape!.name, { fill: m.seq[steps[i]], row: p.row, step: steps[i] })
  })

  const blank = m.grid                     // one step off the card, so land still reads as land
  const border = m.surface

  return (
    <>
      <div className="relative">
        <svg viewBox={WORLD_VIEWBOX} className="w-full h-auto block" role="img"
          aria-label="Identified links by country">
          {WORLD_SHAPES.map(s => {
            const hit = byShape.get(s.name)
            const label = hit ? String(hit.row.label) : s.name
            const val = hit ? String(hit.row.value ?? hit.row.label) : ''
            const on = !!hit && activeVal !== '' && (activeVal === val || activeVal === hit.row.label)
            const dimmed = !!hit && activeVal !== '' && !on
            return (
              <path key={s.id + s.name} d={s.d}
                fill={hit ? hit.fill : blank}
                fillOpacity={dimmed ? 0.4 : 1}
                stroke={on ? m.ident : border}
                strokeWidth={on ? 1.6 : 0.5}
                style={{ cursor: hit && onPick ? 'pointer' : 'default' }}
                onClick={() => hit && onPick?.(val)}
                onMouseMove={e => hit && setHover({
                  name: label,
                  urls: Number(hit.row.urls) || 0,
                  removed: Number(hit.row.removed) || 0,
                  x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY,
                })}
                onMouseLeave={() => setHover(null)}>
                <title>{hit ? `${label}: ${full(Number(hit.row.urls) || 0)} identified` : s.name}</title>
              </path>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute z-10 pointer-events-none rounded-lg px-3 py-2 text-xs shadow-lg border
            bg-white border-gray-200 dark:bg-[#14254A] dark:border-white/15"
            style={{ left: Math.min(hover.x + 12, 640), top: Math.max(0, hover.y - 12) }}>
            <div className="font-semibold mb-1 text-gray-500 dark:text-white/60">{hover.name}</div>
            <div className="font-bold tabular-nums text-[#14254A] dark:text-white">
              {full(hover.urls)} <span className="font-normal text-gray-400">identified</span>
            </div>
            <div className="font-bold tabular-nums text-[#14254A] dark:text-white">
              {full(hover.removed)} <span className="font-normal text-gray-400">removed</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 mt-3 text-[10px] text-gray-400">
        <span>Fewer</span>
        <span className="flex gap-[2px] w-40 h-2">
          {m.seq.map(c => <i key={c} className="flex-1 rounded-[2px]" style={{ background: c }} />)}
        </span>
        <span>More</span>
        <span className="flex items-center gap-1.5 ml-3">
          <i className="w-3 h-2 rounded-[2px]" style={{ background: blank }} />No data
        </span>
      </div>

      {unmapped.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[#14254A]/[0.07] dark:border-white/[0.07]">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1.5">
            Not on the map
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unmapped.map((p, i) => {
              const val = String(p.row.value ?? p.row.label ?? '')
              const on = activeVal !== '' && (activeVal === val || activeVal === p.row.label)
              return (
                <button key={val + i} type="button" disabled={!onPick} onClick={() => onPick?.(val)}
                  title="No country of this name in the map data"
                  className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border transition-colors ${
                    on
                      ? 'border-[#14254A] bg-[#14254A]/[0.05] dark:border-white/40 dark:bg-white/10'
                      : 'border-gray-200 dark:border-white/15'} ${
                    onPick ? 'hover:border-gray-300 dark:hover:border-white/30' : 'cursor-default'}`}>
                  <span className="text-gray-600 dark:text-gray-300">{String(p.row.label)}</span>
                  <span className="font-bold tabular-nums text-[#14254A] dark:text-white">
                    {full(Number(p.row.urls) || 0)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Assign each value one of `count` steps by RANK.
 *
 * Country volumes are heavily skewed — one market can hold most of the total and
 * the rest sit in single digits. Cutting a ramp linearly against the maximum
 * then puts everything but the leader in the palest step, and a heat map where
 * nothing is hot conveys nothing. Ranking spreads the rows across the ramp, so
 * the picture always reads as an ordering. Ties share a step, and the exact
 * count is always available in the tooltip and the table view, so no comparison
 * rests on the colour alone.
 */
function rankSteps(values: number[], count: number): number[] {
  const ascending = [...values].sort((a, b) => a - b)
  const rankOfValue = new Map<number, number>()
  ascending.forEach((v, pos) => { if (!rankOfValue.has(v)) rankOfValue.set(v, pos) })
  const span = Math.max(1, values.length - 1)
  return values.map(v => Math.min(count - 1, Math.floor(((rankOfValue.get(v) ?? 0) / span) * count)))
}

function HeatGrid({ rows, m, onPick, activeVal = '', limit = 24 }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string; limit?: number
}) {
  const data = rows.slice(0, limit)
  if (data.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>

  // Same rank-based scale as the map — see rankSteps.
  const steps = rankSteps(data.map(r => Number(r.urls) || 0), m.seq.length)
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-[2px]">
        {data.map((r, i) => {
          const urls = Number(r.urls) || 0
          const removed = Number(r.removed) || 0
          const step = steps[i]
          const ink = m.seqInk[step] ? '#14254A' : '#ffffff'
          const val = String(r.value ?? r.label ?? '')
          const on = activeVal !== '' && (activeVal === val || activeVal === r.label)
          return (
            <button key={val + i} type="button" disabled={!onPick} onClick={() => onPick?.(val)}
              title={`${r.label}: ${full(urls)} identified · ${full(removed)} removed`}
              className={`rounded-md px-2.5 py-2 text-left transition-all ${
                onPick ? 'cursor-pointer hover:brightness-110' : ''} ${
                on ? 'ring-2 ring-offset-1 ring-[#14254A] dark:ring-white dark:ring-offset-[#1a2d55]' : ''}`}
              style={{ background: m.seq[step] }}>
              {/* Ink is chosen from the tile's own step and set inline: the
                  global `.dark` rules repaint hardcoded-navy text classes to
                  white, which on the palest tiles is white on near-white. */}
              <div className="text-[10px] font-semibold truncate" style={{ color: ink }}>
                {String(r.label)}
              </div>
              <div className="text-[13px] font-extrabold" style={{ color: ink }}>
                {fmt(urls)}
              </div>
            </button>
          )
        })}
      </div>
      <div className="flex items-center gap-2 mt-3 text-[10px] text-gray-400">
        <span>Fewer</span>
        <span className="flex gap-[2px] flex-1 h-2">
          {m.seq.map(c => <i key={c} className="flex-1 rounded-[2px]" style={{ background: c }} />)}
        </span>
        <span>More</span>
      </div>
    </>
  )
}

/**
 * Daily warehouse rows → the series a trend chart draws.
 *
 * Rows are kept per day when the range is short enough to read one point per
 * day; past that they roll up by month. Rolling up unconditionally — which this
 * page used to do — turns the default 30-day range into one or two columns,
 * which is not a trend.
 *
 * The rate is derived per period, never averaged across periods: averaging rates
 * weights a quiet day the same as a busy one.
 *
 * `secondKey` names the column the second series comes from, and it is always
 * stored back as `removed` so every chart reads the same two fields. The linking
 * half of Open Web uses `delisted` — search engines dropping a link is not the
 * same event as a page coming down, and the two move apart.
 */
/* `firstKey` is which column the leading series reads. It is `urls` for every
   volume trend, and the action key — `notices`, `delistingBatches` — for the
   enforcement cards, which plot how many actions were SENT rather than how many
   URLs were found. The monthly rollup below then sums the right column too,
   which is the part that would silently draw an empty chart if it were faked at
   the call site instead. */
/**
 * The date range one point on a dated chart stands for.
 *
 * toTrend draws two grains and a click has to mean whatever the mark meant:
 * "2026-08-11" is one day, "2026-08" is the whole of August — the rollup the
 * trend switches to past 62 rows. Clicking a MONTH therefore drills to that
 * month's days rather than to a single figure, which is the useful direction.
 *
 * Anything else returns null and does not pick. The labels come from data, and
 * a chart drawn over something that is not a date must not silently move the
 * reader's date range.
 */
function periodSpan(label: string): { from: string; to: string } | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) return { from: label, to: label }
  if (/^\d{4}-\d{2}$/.test(label)) {
    const [y, mo] = label.split('-').map(Number)
    /* Day 0 of the NEXT month is the last day of this one — no table of month
       lengths, and February in a leap year is right for free. UTC because the
       label is a warehouse date, not a moment in the reader's zone. */
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate()
    return { from: `${label}-01`, to: `${label}-${String(last).padStart(2, '0')}` }
  }
  return null
}

function toTrend(daily: any[], secondKey = 'removed', firstKey = 'urls') {
  const withRate = (r: { label: string; urls: number; removed: number }) =>
    ({ ...r, rate: pct(r.removed, r.urls) })
  const second = (d: any) => Number(d[secondKey]) || 0

  const first = (d: any) => Number(d[firstKey]) || 0

  if (daily.length <= 62) {
    return daily
      .map(d => ({ label: String(d.date || '').slice(0, 10), urls: first(d), removed: second(d) }))
      .filter(d => d.label)
      .map(withRate)
  }
  const months = new Map<string, { label: string; urls: number; removed: number }>()
  for (const d of daily) {
    const key = String(d.date || '').slice(0, 7)
    if (!key) continue
    const row = months.get(key) ?? { label: key, urls: 0, removed: 0 }
    row.urls    += first(d)
    row.removed += second(d)
    months.set(key, row)
  }
  return [...months.values()].sort((a, b) => a.label.localeCompare(b.label)).map(withRate)
}

/** Section heading, to group the page instead of one long run of cards. */
function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3 pt-1.5">
      <span className="w-1 h-7 rounded-full"
        style={{ background: `linear-gradient(180deg,${BRAND_NAVY},${BRAND_NAVY}55)` }} />
      <div>
        <div className="text-sm font-extrabold tracking-tight text-[#14254A] dark:text-white">{title}</div>
        {sub && <div className="text-[11px] text-gray-400">{sub}</div>}
      </div>
      <span className="flex-1 h-px bg-[#14254A]/10 dark:bg-white/10" />
    </div>
  )
}

/**
 * Grouped horizontal bars. Used where the category label is long — asset titles,
 * domains — because a column chart has to angle or truncate those, and the label
 * is the part being read. Direct-labelled at the bar end, matching the other
 * charts here.
 */
function HBarChart({ rows, m, onPick, activeVal = '', limit = 10 }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string; limit?: number
}) {
  const data = rows.slice(0, limit).map(r => ({
    label: String(r.label ?? '—'),
    value_: String(r.value ?? r.label ?? ''),
    urls: Number(r.urls) || 0,
    removed: Number(r.removed) || 0,
  }))
  if (data.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>

  const axis = { tickLine: false, axisLine: false, tick: { fill: m.axis, fontSize: 11 } }
  /* Height follows the row count, and each row has to hold BOTH bars plus the
     gap that separates it from the next asset — 22px of mark needs more than
     27px of band, or the space between two categories is the same 2px as the
     space inside one and the pairs read as a single striped block. */
  const height = Math.max(180, data.length * 38 + 24)
  const hasActive = !!activeVal

  /* Ticks are drawn one to a line and truncated, never wrapped.
     Recharts wraps a category label that does not fit its axis width, which
     turns a long asset title into two lines inside a band sized for one — and
     two of those in a row collide. The full title stays reachable: it is on the
     tick as a tooltip, in the chart's own tooltip, and in the table view. */
  const Tick = ({ x, y, payload }: any) => {
    const full = String(payload?.value ?? '')
    const short = full.length > 26 ? full.slice(0, 26) + '…' : full
    return (
      <text x={x} y={y} dy={4} textAnchor="end" fill={m.axis} fontSize={11}>
        <title>{full}</title>
        {short}
      </text>
    )
  }

  /* The handler sits on the bars, not on the chart. A chart-level onClick reads
     recharts' hover state to say which category was hit, so it misses on a
     touch or a click that arrives without a preceding pointer move — and a
     click on empty plot area fires it with no payload, silently clearing the
     filter. A bar knows its own datum. */
  const pickFrom = (d: any) => {
    const v = d?.payload?.value_ ?? d?.value_
    if (v) onPick?.(String(v))
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {/* barGap separates the two bars WITHIN an asset; barCategoryGap
            separates one asset from the next. They have to differ or the
            grouping is invisible. */}
        <BarChart data={data} layout="vertical" barGap={2} barCategoryGap="34%"
          margin={{ top: 4, right: 52, left: 0, bottom: 0 }}
>
          <CartesianGrid horizontal={false} stroke={m.grid} />
          <XAxis type="number" {...axis} tickFormatter={axisNum} />
          <YAxis type="category" dataKey="label" width={172} {...axis}
            interval={0} tick={<Tick />} />
          <Tooltip cursor={{ fill: m.grid, fillOpacity: 0.5 }} content={<ChartTip />} />
          <Bar dataKey="urls" name="Identified" fill={m.ident} radius={[0, 3, 3, 0]}
            maxBarSize={10} isAnimationActive={false} cursor={onPick ? 'pointer' : 'default'} onClick={pickFrom}>
            <LabelList dataKey="urls" position="right" formatter={(v: any) => axisNum(Number(v))}
              style={{ fill: m.axis, fontSize: 10, fontWeight: 700 }} />
            {data.map(d => (
              <Cell key={d.value_} opacity={hasActive && activeVal !== d.value_ && activeVal !== d.label ? 0.4 : 1} />
            ))}
          </Bar>
          <Bar dataKey="removed" name="Removed" fill={m.removed} radius={[0, 3, 3, 0]}
            maxBarSize={10} isAnimationActive={false} cursor={onPick ? 'pointer' : 'default'} onClick={pickFrom}>
            {data.map(d => (
              <Cell key={d.value_} opacity={hasActive && activeVal !== d.value_ && activeVal !== d.label ? 0.4 : 1} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * Grouped columns — the vertical twin of HBarChart, for a dimension read as
 * "how much per thing" rather than as a ranked list.
 *
 * Category labels here are often long (asset titles), which is what a column
 * chart is worst at: the label has to angle and truncate to fit under its
 * column. Two things keep that honest — the tick angles only when a label
 * actually needs it, and the tooltip carries the untruncated name, as does the
 * card's table view.
 */
function ColumnChart({ rows, m, onPick, activeVal = '', limit = 10 }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string; limit?: number
}) {
  const data = rows.slice(0, limit).map(r => ({
    label: String(r.label ?? '—'),
    value_: String(r.value ?? r.label ?? ''),
    urls: Number(r.urls) || 0,
    removed: Number(r.removed) || 0,
  }))
  if (data.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>

  const axis = { tickLine: false, axisLine: false, tick: { fill: m.axis, fontSize: 11 } }
  const hasActive = !!activeVal
  const ticks = niceTicks(Math.max(...data.map(d => Math.max(d.urls, d.removed))))

  // Horizontal ticks read better; they are only angled when a straight one
  // would have to be cut to a few characters to fit its column's share.
  const longest = Math.max(...data.map(d => d.label.length))
  const angled  = longest > 10 && data.length > 3
  const cut     = angled ? 20 : 14

  const Tick = ({ x, y, payload }: any) => {
    const t = String(payload?.value ?? '')
    const short = t.length > cut ? t.slice(0, cut) + '…' : t
    return (
      <g transform={`translate(${x},${y + 8})`}>
        <text fill={m.axis} fontSize={10}
          transform={angled ? 'rotate(-32)' : undefined}
          textAnchor={angled ? 'end' : 'middle'}>
          {short}
        </text>
      </g>
    )
  }

  const dim = (d: typeof data[number]) =>
    hasActive && activeVal !== d.value_ && activeVal !== d.label ? 0.4 : 1

  /* An explicit width, not `maxBarSize`: the latter shrinks the mark but leaves
     it centred in the slot recharts had already allotted, which pushes a
     category's two bars far enough apart that they read as two categories. */
  const barSize = data.length <= 8 ? 22 : 12

  /* The handler sits on the bars, not on the chart. A chart-level onClick reads
     recharts' hover state to say which category was hit, so it misses on a
     touch or a click that arrives without a preceding pointer move — and a
     click on empty plot area fires it with no payload, silently clearing the
     filter. A bar knows its own datum. */
  const pickFrom = (d: any) => {
    const v = d?.payload?.value_ ?? d?.value_
    if (v) onPick?.(String(v))
  }

  return (
    <>
      <div style={{ height: angled ? 262 : 208 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barGap={2}
            margin={{ top: 18, right: 8, left: 0, bottom: 4 }}
  >
            <CartesianGrid vertical={false} stroke={m.grid} />
            {/* The tick band has to be tall enough for the angled text itself:
                sized short, recharts clips the far end of each rotated label. */}
            <XAxis dataKey="label" {...axis} interval={0} tick={<Tick />}
              height={angled ? 88 : 26} />
            <YAxis {...axis} width={46} ticks={ticks}
              domain={[0, ticks[ticks.length - 1]]} tickFormatter={axisNum} />
            <Tooltip cursor={{ fill: m.grid, fillOpacity: 0.5 }} content={<ChartTip />} />
            <Bar dataKey="urls" name="Identified" fill={m.ident} radius={[4, 4, 0, 0]}
              barSize={barSize} isAnimationActive={false} cursor={onPick ? 'pointer' : 'default'} onClick={pickFrom}>
              <LabelList dataKey="urls" position="top" formatter={(v: any) => axisNum(Number(v))}
                style={{ fill: m.axis, fontSize: 10, fontWeight: 700 }} />
              {data.map(d => <Cell key={d.value_} opacity={dim(d)} />)}
            </Bar>
            <Bar dataKey="removed" name="Removed" fill={m.removed} radius={[4, 4, 0, 0]}
              barSize={barSize} isAnimationActive={false} cursor={onPick ? 'pointer' : 'default'} onClick={pickFrom}>
              {data.map(d => <Cell key={d.value_} opacity={dim(d)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend items={[{ label: 'Identified', color: m.ident }, { label: 'Removed', color: m.removed }]} />
    </>
  )
}

/**
 * A grouped column chart for a CLOSED SET read in its own order — a league's
 * franchises, a season's fixtures.
 *
 * Hand-built rather than recharts, for the same reason StackedBars is: what
 * this card needs is four things no combination of props will give.
 *
 *   THE SCALE STAYS PUT. Seventy fixtures do not fit a card, so the plot
 *   scrolls — and a y-axis inside the scroller leaves with the first ten of
 *   them, after which every column is a height with nothing to measure it
 *   against. The axis is drawn in its own column, outside the scroller.
 *
 *   ONE DIRECT LABEL, NOT SEVENTY. A value over every column is chaos and goes
 *   unread. The busiest category is the one figure the card exists to surface;
 *   the axis, the tooltip and the Table view carry the rest.
 *
 *   THE TARGET IS THE CATEGORY, NOT THE MARK. At eight pixels a column, a click
 *   that cross-filters the whole page is a test of aim. Each category owns a
 *   full-height hit band the width of its slot.
 *
 *   THE EDGE SAYS THERE IS MORE. A flush scroller reads as a chart that ends,
 *   so the plot dissolves into the card edge until the last category is on
 *   screen.
 *
 * Everything else — the 2px gap inside a pair, the 4px rounded data end square
 * at the baseline, the hairline grid — is the spec the other marks in this file
 * already follow.
 */
function SeasonColumns({ rows, m, onPick, activeVal = '' }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [avail, setAvail] = useState(0)
  const [atEnd, setAtEnd] = useState(true)
  const [hover, setHover] = useState<
    { label: string; urls: number; removed: number; x: number; y: number } | null>(null)

  /* How wide a category may be is decided by how much room the card actually
     has, which is not knowable from props: the same panel is full-width on the
     platform page and half-width in the summary. Measured rather than assumed,
     so a card that can show the whole set spreads to fill it and only a card
     that cannot starts scrolling. */
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    setAvail(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (w) setAvail(w)
    })
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  const sync = useCallback(() => {
    const node = scrollRef.current
    if (!node) return
    setAtEnd(node.scrollLeft + node.clientWidth >= node.scrollWidth - 2)
  }, [])

  const data = rows.map(r => ({
    label: String(r.label ?? '—'),
    value_: String(r.value ?? r.label ?? ''),
    urls: Number(r.urls) || 0,
    removed: Number(r.removed) || 0,
  }))

  const n = data.length
  const longest = data.reduce((a, d) => Math.max(a, d.label.length), 0)
  const CHAR_W = 5.6                                   // 10px sans, near enough

  /* Whether angled labels are POSSIBLE, which is not the same question as
     whether they are used.

     The slot floor and ceiling below have to reserve room for the widest label
     before the slot exists, and the label mode cannot be settled until it does.
     So this is the reservation, and the decision is made further down against
     the slot that actually came out. */
  const mayAngle = longest > 10 && n > 3

  /* THE SLOT IS DECIDED FIRST, THE MARK SECOND.
     A category owns a slot; the bars are sized to sit inside it with air left
     over, rather than a fixed bar width dictating the layout. That ordering is
     what lets one component draw ten franchises across a full-width card and
     seventy fixtures in a half-width one without either looking stretched. */
  const baseBar = n <= 8 ? 22 : n <= 20 ? 14 : 8
  const minSlot = Math.max(baseBar * 2 + 12, mayAngle ? 48 : 30)

  /* AND A CEILING, WHICH IS THE OTHER HALF OF THE SAME RULE.

     Dividing the card evenly is right until there is more card than data. Four
     platforms in a full-width panel gives a slot of ~475px, and a 24px pair
     alone in the middle of that reads as a chart that failed to load rather
     than as four large numbers: the eye has to travel half a screen between
     marks it is meant to compare. Past roughly this width the extra space stops
     helping and starts separating.

     What is left over is not filled. It is put on BOTH SIDES — see xOffset —
     so a short set sits as a centred group under a full-width rule, rather than
     as a row of bars trailing off to the right. */
  const maxSlot = mayAngle ? 150 : 132
  const fair = avail > 0 ? avail / Math.max(n, 1) : minSlot
  const slot = Math.min(Math.max(fair, minSlot), maxSlot)

  /* THE MARKS' WIDTH AND THE CANVAS' WIDTH ARE NOT THE SAME NUMBER.

     rawW is what the bars occupy; plotW is the SVG they are drawn on. They part
     company in both directions, and one of them used to draw a scrollbar for
     nothing.

     When the set fits, the canvas is the whole scroller and the bars are
     centred on it, so the grid rules still span the card. `Math.floor` is doing
     real work there: `avail` is fractional far more often than not, an SVG a
     third of a pixel wider than its container overflows it, and the browser
     answers that with a horizontal scrollbar under a chart that fits.

     When it does not fit, the canvas is the bars and the scroller scrolls,
     which is the case this component was built for. */
  const rawW = Math.max(1, Math.round(slot * n))
  const scrolls = avail > 0 && rawW > avail + 1
  const plotW = avail > 0 ? (scrolls ? rawW : Math.max(1, Math.floor(avail))) : rawW
  const xOffset = scrolls || plotW <= rawW ? 0 : Math.round((plotW - rawW) / 2)

  /* 2px between the pair, and at least 10px of surface between one pair and the
     next — the outer gap has to beat the inner one or neighbouring pairs read
     as a single group of four bars. Capped at 30, which is where the slot
     ceiling above puts it on a short set: a pair then fills a little under half
     its slot, so the rhythm of mark and gap holds whether there are four
     categories or forty. */
  const barW = Math.min(30, Math.max(5, Math.floor((slot - 12) / 2)))

  /* HOW A CATEGORY IS LABELLED, DECIDED FROM THE ROOM IT ACTUALLY HAS.

     Three ways, in order of preference:

       one line   it fits as it is. Best, always — it reads like every other
                  axis in the product.
       two lines  it does not fit, but half of it would. Broken on a space,
                  never mid-word.
       angled     the slot is too narrow for either. The dense case — seventy
                  fixtures in a half-width card.

     This was decided from the label's LENGTH alone, before the slot was known,
     so an eighteen-character franchise was angled in a card with 130px of room
     going spare. */
  const room = slot - 6
  const oneLine = longest * CHAR_W <= room
  const wraps = !oneLine && slot >= 64
  const angled = !oneLine && !wraps

  const AXIS_W = 52
  const TOP = 22                      // room for the one direct label
  const PLOT = 190

  /* THE BAND IS MEASURED, NOT ASSUMED — and it was assumed.

     A fixed 52px was fine for the short labels it was written against and cut
     the long ones in half: anchored at its end and turned 32°, a label descends
     its own width times sin(32°) BELOW the anchor, so an 18-character name
     reaches ~53px into a 52px band and loses its opening characters off the
     bottom edge of the SVG. Nothing truncated them — they were drawn and then
     clipped, which is why there was no ellipsis to give it away. */
  const ANGLE_SIN = Math.sin((32 * Math.PI) / 180)
  const ANGLED_CUT = 22
  const band = angled
    ? Math.min(112, Math.round(Math.min(longest, ANGLED_CUT) * CHAR_W * ANGLE_SIN) + 20)
    : wraps ? 40 : 26
  const H = TOP + PLOT + band

  const ticks = niceTicks(data.reduce((a, d) => Math.max(a, d.urls, d.removed), 0))
  const max = ticks[ticks.length - 1] || 1
  const y = (v: number) => TOP + PLOT - (v / max) * PLOT
  const peak = n > 0 ? data.reduce((a, d) => (d.urls > a.urls ? d : a), data[0]) : null

  useEffect(sync, [sync, plotW, avail])

  if (n === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>

  const isDim = (d: typeof data[number]) =>
    activeVal !== '' && activeVal !== d.value_ && activeVal !== d.label

  /* Rounded at the data end and square at the baseline, so a column reads as
     growing FROM the axis rather than floating above it. */
  const barPath = (x: number, val: number) => {
    const h = Math.max((val / max) * PLOT, val > 0 ? 1.5 : 0)
    if (h <= 0) return ''
    const r = Math.min(4, barW / 2, h)
    const top = TOP + PLOT - h
    return 'M' + x + ',' + (top + r) +
      'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + -r +
      'h' + (barW - 2 * r) +
      'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
      'v' + (h - r) + 'h' + -barW + 'z'
  }

  /* EVERY CATEGORY IS LABELLED NOW, BECAUSE EVERY LABEL FITS.

     This used to thin the axis — every second or third name — because a label
     wider than its slot overlapped its neighbour into a grey smear. Wrapping
     answers that better: the reason for thinning was width, and two lines are
     half the width. The tooltip still names everything either way. */
  const fit = (t: string, w: number) => {
    const max = Math.max(3, Math.floor(w / CHAR_W))
    return t.length > max ? t.slice(0, max - 1) + '…' : t
  }

  /* Broken on a space and balanced by WIDTH, not by word count: "Belgian Pro
     League" reads as "Belgian / Pro League" rather than "Belgian Pro / League",
     because the eye pairs the short line with the bar above it. A label with no
     space cannot be broken at all, so it is cut instead. */
  const twoLines = (t: string): string[] => {
    const words = t.split(/\s+/).filter(Boolean)
    if (words.length < 2) return [fit(t, room)]
    let at = 1
    let best = Infinity
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(' ').length * CHAR_W
      const b = words.slice(k).join(' ').length * CHAR_W
      // Any split that still overflows is worse than any split that does not.
      const score = Math.max(a, b) > room ? 1e6 + Math.abs(a - b) : Math.abs(a - b)
      if (score < best) { best = score; at = k }
    }
    return [fit(words.slice(0, at).join(' '), room), fit(words.slice(at).join(' '), room)]
  }

  const labelLines = (t: string): string[] =>
    oneLine ? [t] : wraps ? twoLines(t) : [fit(t, ANGLED_CUT * CHAR_W)]

  return (
    <>
      <div ref={hostRef} className="relative flex items-stretch">
        {/* The pinned scale — outside the scroller on purpose, see above. */}
        <svg width={AXIS_W} height={H} className="block flex-none" aria-hidden="true">
          {ticks.map(t => (
            <text key={t} x={AXIS_W - 8} y={y(t) + 3.5} textAnchor="end"
              fill={m.axis} fontSize={10} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {axisNum(t)}
            </text>
          ))}
        </svg>

        <div ref={scrollRef} onScroll={sync}
          className="relative flex-1 overflow-x-auto overflow-y-hidden">
          <svg width={plotW} height={H} className="block"
            role="img" aria-label="Identified and removed per category">
            {/* Hairline, solid, one step off the card — run the full plot width
                so a scrolled category still sits on a readable rule. */}
            {ticks.map(t => (
              <line key={t} x1={0} x2={plotW} y1={y(t)} y2={y(t)}
                stroke={m.grid} strokeWidth={1} />
            ))}

            {data.map((d, i) => {
              const cx = xOffset + i * slot + slot / 2
              /* The 2px gap inside a pair is the surface doing the separating —
                 never a stroke drawn around the marks. */
              const xI = cx - barW - 1
              const xR = cx + 1
              const o = isDim(d) ? 0.4 : 1
              const labelY = TOP + PLOT + (angled ? 12 : 15)
              return (
                <g key={d.value_ + i}>
                  <path d={barPath(xI, d.urls)} fill={m.ident} opacity={o} />
                  <path d={barPath(xR, d.removed)} fill={m.removed} opacity={o} />

                  <text x={cx} y={labelY} fontSize={10} fill={m.axis}
                    textAnchor={angled ? 'end' : 'middle'}
                    transform={angled ? `rotate(-32 ${cx} ${labelY})` : undefined}>
                    {/* tspan per line, each re-anchored at cx: without the
                        repeated x a second line starts where the first ended
                        instead of under it. */}
                    {labelLines(d.label).map((ln, k) => (
                      <tspan key={k} x={cx} dy={k === 0 ? 0 : 11}>{ln}</tspan>
                    ))}
                  </text>

                  {/* The extreme, and only the extreme. */}
                  {d === peak && d.urls > 0 && (
                    <text x={cx} y={y(d.urls) - 8} textAnchor="middle" fontSize={10}
                      fontWeight={700} fill={m.axis}
                      style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {axisNum(d.urls)}
                    </text>
                  )}

                  <rect x={xOffset + i * slot} y={TOP} width={slot} height={PLOT} fill="transparent"
                    style={{ cursor: onPick ? 'pointer' : 'default' }}
                    onClick={() => d.value_ && onPick?.(d.value_)}
                    onMouseMove={e => {
                      const box = hostRef.current?.getBoundingClientRect()
                      if (!box) return
                      setHover({
                        label: d.label, urls: d.urls, removed: d.removed,
                        x: e.clientX - box.left, y: e.clientY - box.top,
                      })
                    }}
                    onMouseLeave={() => setHover(null)}>
                    <title>{`${d.label}: ${full(d.urls)} identified, ${full(d.removed)} removed`}</title>
                  </rect>
                </g>
              )
            })}
          </svg>
        </div>

        {/* A SIBLING of the scroller, not a child: an absolutely positioned
            child of a scroll container is laid against its CONTENT box, so it
            rides the content and only surfaces once you have reached the end —
            which is the one moment it should be gone. */}
        {scrolls && !atEnd && (
          <div aria-hidden="true"
            className="absolute top-0 right-0 pointer-events-none"
            style={{
              width: 44, height: H,
              background: `linear-gradient(to right, transparent, ${m.surface})`,
            }} />
        )}

        {hover && (
          <div className="absolute z-10 pointer-events-none rounded-lg px-3 py-2 text-xs shadow-lg border
            bg-white border-gray-200 dark:bg-[#14254A] dark:border-white/15"
            style={{
              left: Math.max(0, Math.min(hover.x + 12, avail + AXIS_W - 190)),
              top: Math.max(0, hover.y - 12),
            }}>
            <div className="font-semibold mb-1 text-gray-500 dark:text-white/60">{hover.label}</div>
            <div className="font-bold tabular-nums text-[#14254A] dark:text-white">
              {full(hover.urls)} <span className="font-normal text-gray-400">identified</span>
            </div>
            <div className="font-bold tabular-nums text-[#14254A] dark:text-white">
              {full(hover.removed)} <span className="font-normal text-gray-400">removed</span>
            </div>
            <div className="text-[11px] text-gray-400 tabular-nums mt-0.5">
              {pct(hover.removed, hover.urls)}% removed
            </div>
          </div>
        )}
      </div>

      {/* Aligned to the plot rather than to the card, and outside the scroller
          so the key stays put while the season is dragged past it. */}
      <div style={{ paddingLeft: AXIS_W }}>
        <Legend items={[
          { label: 'Identified', color: m.ident },
          { label: 'Removed', color: m.removed },
        ]} />
      </div>
      {scrolls && (
        <p className="text-[11px] text-gray-400 mt-1" style={{ paddingLeft: AXIS_W }}>
          {n} in this set, in their own order — drag sideways for the rest.
        </p>
      )}
    </>
  )
}

/* ── Repeat offenders ──────────────────────────────────────────────────────────
   The one panel on this page whose ranking measure is not a volume.

   Everywhere else the longest bar is the answer, so the order explains itself.
   Here it does not: the rows are ranked by how many DISTINCT DAYS the account
   was identified on (see go-server/handlers/repeatoffenders.go), and a chart
   that draws only the volumes puts 82 above 155 for reasons nothing on the card
   discloses. That is not a chart with an odd sort — it is a chart that looks
   broken.

   So the day count LEADS each row, in gold, beside the position it earned. The
   reader sees 14, 11, 9 running down the card and the order is explained before
   the volumes are read at all.

   Horizontal, and deliberately: these labels are URLs. A column chart gives each
   account about a tenth of the card and angles what is left, which is how ten
   VK accounts all come to read "https://vkvideo…". Down the side, the label
   column gets real width and the whole account is legible.

   Volumes stay on the two brand series the rest of the page uses — navy found,
   orange removed — sharing one scale, so no second axis is implied for a count
   of days that could never share one. */

/** Truncate through the MIDDLE. Account URLs share their beginning far more
    often than their end — ten `vkvideo.ru/video-…` rows differ only in the id —
    so trimming the tail is exactly what makes two different accounts print the
    same label. The full URL is always on the row's tooltip and in the Table. */
function midCut(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  return s.slice(0, head) + '…' + s.slice(s.length - (max - 1 - head))
}

/** The URL as a reader needs it: no scheme, no `www.`, no trailing slash. Those
    are eighteen characters that are identical on every row and push the part
    that identifies the account off the end. */
function prettyURL(u: string): string {
  const raw = String(u ?? '').trim()
  if (!raw) return '—'
  const bare = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
  return bare || raw
}

function RepeatOffenders({ rows, m, onPick, activeVal = '', limit = 10 }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string; limit?: number
}) {
  const segs = rows.slice(0, limit)
  /* Not "No data.", which reads as a card that failed. An empty repeat-offender
     list is a FINDING — every account this window found, it found once — and the
     panel says which of the two it is looking at. */
  if (segs.length === 0) {
    return (
      <div className="text-sm text-gray-400 dark:text-white/45 py-6 text-center">
        No channel or profile was identified on more than one day in this window.
      </div>
    )
  }
  const max = Math.max(1, ...segs.map(r => Number(r.urls) || 0))
  const hasActive = !!activeVal

  return (
    <>
      <div className="flex flex-col gap-1.5">
        {segs.map((r, i) => {
          const url = String(r.label ?? r.value ?? '—')
          const filterVal = String(r.value ?? url)
          const urls = Number(r.urls) || 0
          const removed = Number(r.removed) || 0
          const days = Number(r.repeats) || 0
          const isActive = activeVal === filterVal || activeVal === url
          const dimmed = hasActive && !isActive
          return (
            <button key={filterVal + i} type="button" disabled={!onPick} onClick={() => onPick?.(filterVal)}
              title={`${url}\nIdentified on ${days} separate days · ${full(urls)} URLs identified · ${full(removed)} removed`}
              className={`grid items-center gap-3 rounded-md px-1.5 py-1 text-left transition-all ${
                onPick ? 'hover:bg-[#14254A]/[0.04] dark:hover:bg-white/5' : 'cursor-default'} ${
                isActive ? 'bg-[#14254A]/[0.05] ring-1 ring-[#14254A]/30 dark:bg-white/5 dark:ring-white/20' : ''} ${
                dimmed ? 'opacity-40' : ''}`}
              /* The label column is given real room — these are URLs, and the
                 whole complaint a top-ten of accounts answers is "which
                 account". The bars take a share rather than a fixed width, so
                 the same panel works full-width here and half-width in a
                 summary. */
              style={{ gridTemplateColumns: '18px 52px minmax(90px, 1fr) minmax(160px, 42%)' }}>

              {/* The position, so "top 10" is a fact on the card rather than a
                  claim in its title. */}
              <span className="text-[10px] font-bold tabular-nums text-gray-300 dark:text-white/30 text-right">
                {i + 1}
              </span>

              {/* THE RANKING MEASURE, first and in gold — the third brand
                  colour, kept for the one figure that is neither found nor
                  removed. Read down the column it is a descending list, which
                  is the order the card is in. */}
              <span className="flex items-baseline gap-0.5 justify-end tabular-nums"
                style={{ color: BRAND_GOLD }}>
                <span className="text-[13px] font-extrabold leading-none">{days}</span>
                <span className="text-[9px] font-bold uppercase tracking-wide">days</span>
              </span>

              <span className="text-xs text-gray-600 dark:text-gray-300 truncate" title={url}>
                {midCut(prettyURL(url), 56)}
              </span>

              {/* Two thin bars from a shared baseline, 2px apart, each with its
                  value at the tip — no axis needed at this size. The same mark
                  the other ranked lists on this page use. */}
              <span className="flex flex-col gap-[2px] min-w-0">
                {[{ v: urls, c: m.ident }, { v: removed, c: m.removed }].map((b, j) => (
                  <span key={j} className="flex items-center gap-1.5">
                    <span className="h-2 rounded-r-[3px]"
                      style={{ width: `${Math.max(0.5, (b.v / max) * 100)}%`, minWidth: 2, background: b.c }} />
                    <span className="text-[10px] font-bold tabular-nums text-[#14254A] dark:text-white whitespace-nowrap">
                      {fmt(b.v, 0)}
                    </span>
                  </span>
                ))}
              </span>
            </button>
          )
        })}
      </div>
      <Legend items={[
        { label: 'Days identified on — the ranking', color: BRAND_GOLD },
        { label: 'URLs identified', color: m.ident },
        { label: 'Removed', color: m.removed },
      ]} />
    </>
  )
}

/** Slicer in the right rail. */
function Slicer({ label, info, value, onChange, options, placeholder = 'All', required, disabled, wide }: {
  label: string; value: string; onChange: (v: string) => void
  options: { key: string; label: string }[]
  placeholder?: string; required?: boolean; disabled?: boolean
  /** What this slicer narrows, behind an ⓘ — see reportpaneldesc.go. */
  info?: string
  /** Rendered in the wide pane rather than the rail. Same control, more room:
      compact is what makes a dozen of these fit a 244px column, and it is also
      what cuts "Serie A: Bologna vs Lazio (24 Aug 2026)" to "Serie A: Bologna
      vs Lazio (24…" — which is the whole reason the wide pane exists. */
  wide?: boolean
}) {
  return (
    <div>
      {/* Tight against its control: a dozen of these run down the rail, and the
          label belongs to the box under it rather than floating between two. */}
      <label className={`flex items-center gap-1 font-bold uppercase tracking-wider text-gray-400 ${
        wide ? 'text-[11px] mb-1.5' : 'text-[10px] mb-[3px]'}`}>
        <span className="truncate">
          {label}
          {required && <span className="text-[#FC934C] ml-0.5">*</span>}
        </span>
        <InfoDot text={info} />
      </label>
      <SearchableSelect options={options} value={value} onChange={onChange}
        placeholder={placeholder} emptyLabel={clearLabel(label)} disabled={disabled}
        compact={!wide} />
    </div>
  )
}

/** The "no filter" row's wording, from the slicer's own label: "2 · Client" →
    "All Client". Dashes around it read as a placeholder rather than a choice,
    and this row IS a choice — it is how a filter is cleared. */
function clearLabel(label: string): string {
  const name = label.replace(/^\s*\d+\s*·\s*/, '').trim()
  return name ? `All ${name}` : 'All'
}

/** In-card message — used for every "nothing to draw yet" state. */
function Notice({ cardTitle, title, body }: { cardTitle: string; title: string; body: string }) {
  return (
    <Card title={cardTitle}>
      <div className="px-5 py-12 text-center">
        <p className="font-bold text-[#14254A] dark:text-white mb-1.5">{title}</p>
        <p className="text-sm max-w-md mx-auto leading-relaxed text-gray-500 dark:text-white/45">{body}</p>
      </div>
    </Card>
  )
}

function Chip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md
      bg-[#FC934C]/12 text-[#c2691f] border border-[#FC934C]/30">
      <span className="opacity-70">{label}:</span>
      <span className="truncate max-w-[110px]">{value}</span>
      <button onClick={onClear} aria-label={`Clear ${label}`} className="ml-0.5 leading-none hover:opacity-60">×</button>
    </span>
  )
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

/**
 * The report, for staff and for clients.
 *
 * `scoped` is the client-facing mode: one company's numbers, chosen by the
 * mapping staff set rather than by a slicer. It is the SAME component on
 * purpose — a second copy for clients would drift from this one within a
 * release, and the difference between the two is genuinely only "who picks the
 * client, and what may be said about the warehouse when something is wrong".
 *
 * Nothing here is the access control. The server forces the client id for any
 * login that is not staff and refuses the request without the module grant
 * (go-server/handlers/reportclientmap.go); this only decides what to draw.
 */
export default function ReportsPage({ scoped = false }: { scoped?: boolean }) {
  const [sections, setSections] = useState<Section[]>([])
  const [section,  setSection]  = useState('')
  /* Arranging the report FROM the report.

     `canArrange` is the per-login grant an admin sets on the Module access
     pane of Edit Login Account. `layoutRev` exists because the arrangement
     arrives with the SECTION list rather than with the data — saving a layout
     has to re-ask for the sections, or the page keeps drawing the panels it
     was given before the change. */
  const [canArrange, setCanArrange] = useState(false)
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [layoutRev,  setLayoutRev]  = useState(0)
  const [filters,  setFilters]  = useState<Filters>(emptyFilters)
  const [opts,     setOpts]     = useState<Record<string, any>>({})
  const [data,     setData]     = useState<any>(null)
  const [loading,  setLoading]  = useState(false)
  const [err,      setErr]      = useState('')
  const [unavailable, setUnavailable] = useState('')
  const [lastRun,  setLastRun]  = useState<Date | null>(null)
  // 401/403 is a session problem, not a warehouse problem — kept apart so the
  // page can tell you to sign in again instead of blaming the database config.
  const [authError, setAuthError] = useState('')
  // Rail visibility, remembered across visits: on a narrow screen the three
  // columns are tight, and someone who works in one report all day should not
  // have to look at the list of the others.
  const [railOpen, setRailOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem('reports.rail') !== 'closed'
  })
  // The filter rail collapses as well, so the charts can have the whole width
  // once a filter set is settled — which is most of the time you spend reading.
  const [filtersOpen, setFiltersOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem('reports.filters') !== 'closed'
  })
  /* The WIDE pane, off-canvas.

     Not a second filter set — the same one, given room. The rail is 244px so
     the charts get the rest, and at that width a slicer showing "Serie A:
     Bologna vs Lazio (24 Aug 2026)" shows "Serie A: Bologna vs Lazio (24…":
     every fixture in a season truncating to the same nine characters, which
     makes the control unusable for the one thing it is for.

     Deliberately NOT remembered across visits, unlike the rail's own state.
     This is a thing a reader opens to make one selection they could not make in
     the rail, and then closes; reopening the page into a panel covering half the
     report would be answering a question nobody asked twice. */
  const [filtersWide, setFiltersWide] = useState(false)

  // Escape closes it, and the body underneath must not scroll while it is open.
  useEffect(() => {
    if (!filtersWide) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFiltersWide(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filtersWide])

  useEffect(() => {
    window.localStorage.setItem('reports.filters', filtersOpen ? 'open' : 'closed')
  }, [filtersOpen])
  useEffect(() => {
    window.localStorage.setItem('reports.rail', railOpen ? 'open' : 'closed')
  }, [railOpen])
  /* The live card holds its place while the report scrolls under it — the two
     rails already do, and the counts it carries are the reason to leave the
     screen open at all. Remembered like the rails, and OFF by default: pinning
     spends viewport, which should be the reader's choice rather than ours. */
  const [rtPinned, setRtPinned] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('reports.realtimePin') === 'pinned'
  })
  useEffect(() => {
    window.localStorage.setItem('reports.realtimePin', rtPinned ? 'pinned' : 'free')
  }, [rtPinned])
  /* The collapsed rail's flyout: open on hover, no click anywhere in it. Held
     in state rather than done with `group-hover` because a pure-CSS flyout
     closes the instant the pointer is between the rail and the panel — one
     pixel of travel and the list vanishes under the cursor. The close is
     delayed by a grace period so that crossing the gap, or clipping a corner
     on the way to an item, keeps the panel up; entering it cancels the close. */
  const [flyout, setFlyout] = useState(false)
  const flyoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openFlyout = useCallback(() => {
    if (flyoutTimer.current) { clearTimeout(flyoutTimer.current); flyoutTimer.current = null }
    setFlyout(true)
  }, [])
  const closeFlyout = useCallback(() => {
    if (flyoutTimer.current) clearTimeout(flyoutTimer.current)
    flyoutTimer.current = setTimeout(() => setFlyout(false), 180)
  }, [])
  useEffect(() => () => { if (flyoutTimer.current) clearTimeout(flyoutTimer.current) }, [])
  // Expanding the rail retires the flyout; leaving it open would double the list.
  useEffect(() => { if (railOpen) setFlyout(false) }, [railOpen])
  const [health,   setHealth]   = useState<{
    configured: boolean; connected: boolean; host?: string; database?: string
    error?: string; tables?: Record<string, boolean>
  } | null>(null)
  /* Client mode: the server says which company this login reads and whether it
     may read one at all. Held so an unmapped account gets the sentence
     explaining why rather than an empty report it would read as "nothing was
     found". */
  const [scope, setScope] = useState<{
    allowed: boolean; clientId?: string; clientName?: string; reason?: string
    /** Only returned while impersonating — see ReportsScope. */
    diagnostic?: string; portalUserId?: number
  } | null>(null)
  /* Declared before the chart-shape callbacks below, which read it to decide
     whether a rolled-back save still has a component to roll back into. */
  const mounted = useRef(true)

  /* Chart shapes, in two layers, both keyed platform:panel so the same panel can
     be a donut on one report and a table on another.

     vizView is what the reader is looking at RIGHT NOW and is deliberately not
     persisted anywhere — trying a shape out has to be free, and a shape tried
     once should not still be there next week with no memory of choosing it.

     vizDefault is what they asked to keep. It lives on the server against their
     login, so it follows the person rather than the browser: same shapes on a
     laptop, on a phone, after clearing site data. Both sit ABOVE the layout's
     configured shape and below nothing — one person's preference never re-shapes
     anyone else's page. See go-server/handlers/reportvizprefs.go. */
  const [vizView, setVizView] = useState<Record<string, string>>({})
  const [vizDefault, setVizDefault] = useState<Record<string, string>>({})

  const setViz = useCallback((panelKey: string, viz: string | null) => {
    setVizView(prev => {
      const next = { ...prev }
      if (viz === null) delete next[panelKey]
      else next[panelKey] = viz
      return next
    })
  }, [])

  /** The shape a panel should be drawn as, strongest layer first. */
  const vizFor = useCallback(
    (panelKey: string, configured: string) =>
      vizView[panelKey] || vizDefault[panelKey] || configured,
    [vizView, vizDefault])

  /* Keep a shape, or forget it. Applied locally first so the menu closes on the
     click rather than on the round trip, and rolled back if the server refuses —
     which it does while impersonating, so staff diagnosing a client's report
     cannot silently rewrite that person's saved shapes. Resolves to an error
     message for the menu to show, or null on success. */
  const saveVizDefault = useCallback(async (panelKey: string, viz: string | null): Promise<string | null> => {
    const before = vizDefault
    setVizDefault(prev => {
      const next = { ...prev }
      if (viz === null) delete next[panelKey]
      else next[panelKey] = viz
      return next
    })
    // A kept shape and a temporary view of the same panel would fight; keeping
    // one is the more considered statement, so the temporary view stands down.
    setViz(panelKey, null)
    try {
      const r = await fetch('/api/reports/viz-prefs', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panelKey, viz: viz ?? '' }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        if (mounted.current) setVizDefault(before)
        return d?.error || d?.message || 'Could not save this chart type'
      }
      return null
    } catch {
      if (mounted.current) setVizDefault(before)
      return 'Could not reach the server'
    }
  }, [vizDefault, setViz])

  const isDark  = useIsDark()
  const m       = isDark ? MARKS.dark : MARKS.light

  /* Column budget: 12 across, each rail costs 2 open and 1 collapsed. The main
     area absorbs whatever the rails hand back, so collapsing both is a genuinely
     full-width report rather than a wider gutter. Spans are spelled out rather
     than built from a template string — Tailwind only ships classes it can see. */
  const mainSpan =
    railOpen && filtersOpen ? 'col-span-12 xl:col-span-8'
    : railOpen || filtersOpen ? 'col-span-12 xl:col-span-9'
    : 'col-span-12 xl:col-span-10'

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  /* The shapes this login has kept, in one request rather than one per panel.
     Failure is silent on purpose: a reading preference that cannot be read is
     not worth an error banner, and every panel still renders in the shape the
     layout configures. */
  useEffect(() => {
    fetch('/api/reports/viz-prefs', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (mounted.current && d?.prefs) setVizDefault(d.prefs)
      })
      .catch(() => { /* configured shapes stand */ })
  }, [])

  const activeSection = sections.find(s => s.key === section) ?? null

  /* Whether this report is a SPORTS one, which decides if the live counts card
     belongs above it.

     Read from the platform's own name — the qualifier splitLabel already pulls
     out for the navigation, "Open Web — Sports" — rather than from a list of
     keys held here. The keys are configuration an admin edits on Report
     Configuration; a hardcoded list would go quietly wrong the day somebody
     added a platform, and the symptom would be a card that is simply absent. */
  const isSportsSection = useMemo(() => {
    if (!activeSection) return false
    const [, qualifier] = splitLabel(activeSection.label)
    return (qualifier ?? '').trim().toLowerCase() === 'sports'
  }, [activeSection])

  /*
  Whether the live card is on the page at all.

  Named because it is read in two places that must agree: the card's own render,
  and the sticky offset the rails are given — a rail held down for a band that is
  not there would leave a gap at the top of the page with nothing in it.

  ── Why it now waits for a narrowing filter ────────────────────────────────

  A client, a sports section, AND one of Match Day / Asset / Franchise.

  Unfiltered, the card counted the client's entire configured season on every
  visit — the most expensive query in the product, run to answer a question
  nobody had asked yet, above a report the reader had not finished setting up.
  It is a LIVE figure, and a live figure is worth its cost when it is about
  something specific: this fixture, this title, this team. "Everything, ever" is
  not a live number, it is a total, and the report below already carries it.

  The three that qualify are the ones that name a THING rather than narrow a
  list. Country or language would leave the card counting most of the season
  anyway; a match day, an asset or a franchise cuts it to something a reader is
  actively watching.
  */
  const REALTIME_FILTERS = ['matchDay', 'assetId', 'franchiseName'] as const
  const realtimeNarrowed = REALTIME_FILTERS.some(k => !!filters[k])
  const showRealtime = !!filters.clientId && isSportsSection && realtimeNarrowed

  /*
  How far down the two rails start sticking.

  The live card runs the full width of the page, so when it is pinned it sits
  across the top of BOTH rails rather than beside them, and a rail sticking at
  its usual 8px would slide up underneath it — or over it, since the navigation
  rail carries a z-index to keep its flyout above the charts. Neither is a
  layout; it is two sticky things claiming the same strip.

  So the rails are held below the band, and the offset is MEASURED rather than
  guessed. The card's height is not a constant: it grows a removed figure and
  its share bar where the view reports one, a partial-reading warning when a
  platform did not answer, and it reflows from one row of platforms to three
  as the window narrows. A hard-coded inset would be wrong on most readings.

  Zero when the card is unpinned or absent, which is the whole of the rest of
  the product's behaviour — the rails then stick where they always did.

  `showRealtime` is a dependency, and it is the one that matters. The card is
  not on screen when this page mounts — there is no client yet, and the section
  may not be a sports one — so the first run finds a null ref, and an effect
  keyed on the pin alone would never run again once the card appeared. The
  measurement stayed at zero, both rails kept their old 8px threshold, and the
  pinned card had the navigation rail riding up over it and the filter rail
  sliding under it. Nothing was wrong with the arithmetic; it was never asked
  to do any.

  useLayoutEffect, not useEffect: this measures a thing in order to position
  another thing beside it, so it has to settle before the browser paints.
  Deferred, the first frame after each pin draws the rails at the old offset —
  a visible jump on exactly the interaction this exists to serve.
  */
  const rtBandRef = useRef<HTMLDivElement>(null)
  const [rtBandH, setRtBandH] = useState(0)
  useLayoutEffect(() => {
    const el = rtBandRef.current
    if (!el || !rtPinned) { setRtBandH(0); return }
    // getBoundingClientRect, not offsetHeight: the latter rounds to whole
    // pixels, and a rail one pixel short of clearing the card shows a hairline
    // of chart scrolling through the gap.
    const measure = () => setRtBandH(el.getBoundingClientRect().height)
    measure()
    /* ResizeObserver rather than a resize listener: most of what changes this
       height is not a window resize at all — the first reading landing, the
       removed row and its share bar appearing, a platform dropping out of the
       grid, a partial-reading warning arriving — and none of those fire one. */
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rtPinned, showRealtime])
  /* What a rail's `top` and max height are written against. Both are `calc`
     against this, so the unpinned case resolves to exactly the values that
     were hard-coded before it existed. */
  const railInset = { '--rt-band': `${rtBandH}px` } as React.CSSProperties

  /* The asset scope the live counts card is given.

     The ONE slicer that moves that card. Its window is the configured season
     and no filter on this page can change it, so passing the rest would be
     controls that appear to act on a figure they cannot touch — the asset is
     different, because the endpoint counts per asset and genuinely narrows.

     An array of one, or empty for "every asset", which is what the endpoint
     reads an absent scope as. useMemo because the card takes it as an effect
     dependency: a fresh [] on every render would refetch on every render. */
  const realtimeAssetIds = useMemo(
    () => (filters.assetId ? [filters.assetId] : []),
    [filters.assetId],
  )

  /* ── Connection state ─────────────────────────────────────────────────── */
  const loadHealth = useCallback(() => {
    fetch('/api/reports/health', { credentials: 'include' })
      .then(async r => {
        if (r.status === 401 || r.status === 403) throw new Error(AUTH_MSG)
        return r.json()
      })
      .then(d => { if (mounted.current) setHealth(d) })
      .catch(e => {
        if (!mounted.current) return
        if (e.message === AUTH_MSG) setAuthError(e.message)
        else setHealth({ configured: false, connected: false, error: e.message })
      })
  }, [])

  // Staff keep the connection banner; a client has nothing to do about the
  // warehouse being down and should not be told its hostname.
  useEffect(() => { if (!scoped) loadHealth() }, [loadHealth, scoped])

  /* The client this login reads. Fetched before anything else in scoped mode —
     every other request needs the id, and without a mapping there is no report
     to ask for. */
  useEffect(() => {
    if (!scoped) return
    fetch('/api/reports/scope', { credentials: 'include' })
      .then(async r => {
        if (r.status === 401 || r.status === 403) throw new Error(AUTH_MSG)
        return r.json()
      })
      .then(d => {
        if (!mounted.current) return
        setScope({
          allowed: !!d.allowed, clientId: d.clientId, clientName: d.clientName,
          reason: d.reason, diagnostic: d.diagnostic, portalUserId: d.portalUserId,
        })
        if (d.clientId) setFilters(f => ({ ...f, clientId: String(d.clientId) }))
      })
      .catch(e => {
        if (!mounted.current) return
        if (e.message === AUTH_MSG) setAuthError(e.message)
        else setScope({ allowed: false, reason: e.message })
      })
  }, [scoped])

  /* Whether this login may rearrange its own report.

     Only asked in scoped mode. Staff have Report Configuration, which edits
     any client's layout and the shared default besides; this drawer writes
     exactly one client's, so offering it to them would be the narrower tool
     in the place the wider one belongs. A failed request leaves it false —
     the control is simply not offered, and the server refuses the write
     regardless. */
  useEffect(() => {
    if (!scoped) return
    fetch('/api/user/layout-access', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (mounted.current) setCanArrange(!!d?.canChangeLayout) })
      .catch(() => {})
  }, [scoped])

  /* ── Sidebar: the section list is the server's registry ───────────────── */
  /* Re-asked when the client changes: the panel layout can be configured per
     client, so which visuals a section has and how wide they are depends on who
     is being reported on. The section LIST itself does not. */
  useEffect(() => {
    const p = new URLSearchParams()
    if (filters.clientId) p.set('clientId', filters.clientId)
    fetch(`/api/reports/sections?${p}`, { credentials: 'include' })
      .then(async r => {
        if (r.status === 401 || r.status === 403) throw new Error(AUTH_MSG)
        return r.json()
      })
      .then(d => {
        if (!mounted.current || !Array.isArray(d.sections)) return
        setSections(d.sections)

        /* Open the first platform straight away, for a CLIENT.

           Staff arrive here to choose — platform, then client — so an empty
           state is the honest first step for them, and it stays.

           A client has no such choice: their company is fixed by the mapping,
           the window already defaults to the last thirty days, and everything
           needed to draw a report is known before the page renders. Asking them
           to pick a platform was a step that existed only because this screen
           is shared with staff.

           `prev || ...` so a section restored from the URL wins: this is a
           default for an empty page, not a redirect over a real choice. */
        if (scoped && d.sections.length > 0) {
          setSection(prev => prev || d.sections[0].key)
        }

        /* The section on screen when the list arrives has not been through
           switchSection — it came from the URL, or it is the client default
           picked just above — so its period has never been applied. Without
           this the first render of a governed report asks for the generic last
           thirty days and gets back a window the server clamped, which is the
           one case a reader sees dates they did not choose.

           Only a range that actually falls OUTSIDE the period is replaced. This
           effect also re-runs on every client change, and a reader who has
           picked a window inside the period must keep it — resetting them to
           the default week for switching company would be the same fault this
           is here to prevent, in the other direction. */
        setFilters(f => {
          const cur = d.sections.find((s: Section) =>
            s.key === (section || (scoped ? d.sections[0]?.key : '')))
          if (!cur?.period) return f
          const { start, end } = cur.period
          if (f.from >= start && f.from <= end && f.to >= start && f.to <= end) return f
          return { ...f, ...periodDefaultRange(cur.period) }
        })
      })
      .catch(e => {
        if (!mounted.current) return
        if (e.message === AUTH_MSG) setAuthError(e.message)
        else setUnavailable(e.message)
      })
  }, [filters.clientId, layoutRev])

  /* ── Slicer values for the active section ─────────────────────────────── */
  /* Re-listed whenever the SCOPE moves, not just when the client changes.
     A slicer is a list of choices that lead somewhere, and what leads somewhere
     depends on the window and on the other slicers: a language with no rows in
     the chosen month is a choice that empties the page, and the page cannot then
     explain itself, because "this filter matched nothing" and "this value does
     not occur in this window" look the same once it has been picked.

     The server drops each parameter's own value from the scope it lists that
     parameter under, so choosing one never collapses its own dropdown to the one
     already chosen.

     Debounced on the same 350ms as the report itself, and the two fire together:
     dragging a date range should cost one round of requests at the end, not one
     per day passed over. */
  useEffect(() => {
    if (!section) return
    let active = true
    const t = setTimeout(() => {
      const p = new URLSearchParams({ type: section })
      if (filters.clientId) p.set('clientId', filters.clientId)
      if (filters.from) p.set('from', filters.from)
      if (filters.to) p.set('to', filters.to)
      // Only what this section declares, so a stale filter from another section
      // cannot narrow a list on a table that has no such column.
      for (const key of activeSection?.filters ?? []) {
        if (filters[key]) p.set(key, filters[key])
      }
      fetch(`/api/reports/options?${p}`, { credentials: 'include' })
        .then(async r => {
          if (r.status === 401 || r.status === 403) throw new Error(AUTH_MSG)
          if (!r.ok) throw new Error(`Options request failed (${r.status})`)
          return r.json()
        })
        .then(d => {
          if (!mounted.current || !active) return
          if (d.available === false) { setUnavailable(d.error || 'Reports database unavailable'); return }
          setUnavailable('')
          setOpts(d)
        })
        .catch(e => {
          if (!mounted.current || !active) return
          if (e.message === AUTH_MSG) setAuthError(e.message)
          else setUnavailable(e.message)
        })
    }, 350)
    return () => { active = false; clearTimeout(t) }
  }, [section, activeSection, filters])

  /* ── Auto-run on any filter change, debounced ─────────────────────────── */
  useEffect(() => {
    if (!section || !activeSection) { setData(null); return }
    if (!filters.clientId) { setData(null); setLoading(false); return }
    setLoading(true)
    let active = true
    const t = setTimeout(async () => {
      try {
        const p = new URLSearchParams({ type: section, clientId: filters.clientId, from: filters.from, to: filters.to })
        // Only send what this section declares, so a stale filter from another
        // section cannot leak into a query that has no such column.
        for (const key of activeSection.filters) {
          if (filters[key]) p.set(key, filters[key])
        }
        const res  = await fetch(`/api/reports/data?${p}`, { credentials: 'include' })
        const json = await res.json()
        if (!active) return
        if (json.available === false) { setUnavailable(json.error || 'Reports database unavailable'); return }
        if (res.status === 401 || res.status === 403) { setAuthError(AUTH_MSG); return }
        if (json.ok) { setData(json); setLastRun(new Date()); setErr(''); setUnavailable(''); setAuthError('') }
        else setErr(json.error || 'Query failed')
      } catch (e: any) {
        if (active) setErr(e.message)
      } finally {
        if (active) setLoading(false)
      }
    }, 350)
    return () => { active = false; clearTimeout(t) }
  }, [filters, section, activeSection])

  const setF = useCallback((k: string) => (v: string) =>
    setFilters(f => ({ ...f, [k]: v })), [])

  /** Panel click → toggle that value as a filter. */
  const cross = (k: string) => (label: string) =>
    setFilters(f => ({ ...f, [k]: f[k] === label ? '' : label }))

  /* ── Clicking a date ───────────────────────────────────────────────────────

     A dated chart cross-filters by moving the report's RANGE, because that is
     what a date filter is here — there is no per-day slicer, and inventing one
     would give the page two ways of saying "August 11th" that could disagree.

     Which means the click needs a way back, and the range it replaced is the
     one thing nothing else on the page remembers. A day is also the range that
     collapses the trend to a single figure, so without this the reader lands on
     a card with no chart left to click and no clue what the range had been. */
  const [drill, setDrill] = useState<{ label: string; from: string; to: string } | null>(null)

  /* Live only while the range still IS the drilled period. Derived rather than
     cleared by every setter that touches a date — the picker, the section
     switch, a preset — because one of those will be added later without this
     being remembered, and a stale "back to" offering a range nobody was on is
     worse than none. */
  const drillSpan = drill ? periodSpan(drill.label) : null
  const drilled = !!drillSpan && filters.from === drillSpan.from && filters.to === drillSpan.to

  /** A dated mark or table row → narrow the report to that period. */
  const pickPeriod = (label: string) => {
    const span = periodSpan(label)
    if (!span) return
    // Clicking the period you are already in is the way out of it — the same
    // toggle every other panel on this page uses for its own values.
    if (drilled && drill!.label === label) {
      setFilters(f => ({ ...f, from: drill!.from, to: drill!.to }))
      setDrill(null)
      return
    }
    /* Month first, then a day inside it: the escape stays the range the reader
       CHOSE, not the month they passed through. One step back, always to
       somewhere they recognise. */
    setDrill({ label, from: drilled ? drill!.from : filters.from, to: drilled ? drill!.to : filters.to })
    setFilters(f => ({ ...f, from: span.from, to: span.to }))
  }

  function switchSection(key: string) {
    setSection(key)
    setData(null)
    setErr('')
    // The dates are about to be replaced wholesale; a way back to the previous
    // platform's range would be a way back to nothing.
    setDrill(null)
    /* Keep client + dates. The dates are the exception when the section being
       ENTERED has a period of its own: a range carried in from an unbounded
       report is very likely outside it, and the server would clamp it to
       something the reader never chose and cannot see the reason for. So a
       governed section opens on its own default week instead.

       ── And every slicer the target section ALSO declares ─────────────────

       Every other slicer used to be dropped, on the grounds that it belonged to
       the section being left. That is right about a slicer the new section has
       no column for and wrong about the rest, and the difference matters most
       for exactly the filters a reader sets deliberately: picking Match Day 14
       and then opening Open Web to see that fixture there threw the fixture
       away and answered for the whole season instead.

       So a filter travels if the section being entered NAMES it. `filters` is
       that section's own parameter list — the same list the query is built from
       a few hundred lines below — so a slicer that survives is one the new
       report can actually apply, and one that cannot is still dropped rather
       than sent to a table with no such column.

       It is also what makes the navigation usable as a comparison: the rail
       stops being "start again somewhere else" and becomes "the same question,
       asked of another platform". */
    const to = sections.find(s => s.key === key)
    const carried = new Set<string>(to?.filters ?? [])
    setFilters(f => {
      const kept: Filters = { clientId: f.clientId }
      for (const [k, v] of Object.entries(f)) {
        if (v && carried.has(k)) kept[k] = v
      }
      return {
        ...kept,
        // The reader's dates survive the move where the target can show them.
        ...carriedRange(to?.period, f.from, f.to),
      }
    })
  }

  /* The server sends {id, name, count}; a few lists are still plain strings.
     `count` is carried through so the dropdown can say what is behind each
     choice — see the Asset slicer, which lists a client's whole catalogue and
     would otherwise offer a thousand titles with nothing in the window and no
     way to tell which. */
  const asOpts = (arr: any[]) =>
    (arr || []).map((o: any) => typeof o === 'string'
      ? { key: o, label: o }
      : {
          key: String(o.id), label: String(o.name ?? o.id),
          ...(typeof o.count === 'number' ? { count: o.count } : {}),
        })

  const clientOpts = useMemo(() => asOpts(opts.clients), [opts.clients])

  /* Every name a value has been seen under, kept across option refreshes.
     Now that the lists are scoped, narrowing the window can drop a value the
     reader has already chosen out of its own list — the report is then correctly
     empty, but the chip saying WHAT is filtering it should still read as the
     title they picked rather than reverting to a GUID. */
  const seenNames = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const [key, val] of Object.entries(opts)) {
      if (!Array.isArray(val)) continue
      for (const o of asOpts(val)) seenNames.current[`${key} ${o.key}`] = o.label
    }
  }, [opts])

  const kpi = data?.kpi

  /* The same figures over the window immediately before this one, and the name
     of that window (go-server/handlers/reportsrun.go → previousWindow). Absent
     whenever the request had no dates to shift, and the tiles then render
     without a change line rather than with a fabricated one. */
  const kpiPrev = data?.kpiPrev as Record<string, any> | undefined
  const prevWindowLabel = useMemo(() => {
    if (!kpiPrev?.from || !kpiPrev?.to) return undefined
    return `${shortDateFull(kpiPrev.from)} – ${shortDateFull(kpiPrev.to)}`
  }, [kpiPrev])

  /**
   * The trend series.
   *
   * Daily rows are kept when the range is short enough to read one point per
   * day; past that they roll up by month. Rolling up unconditionally — which is
   * what this page used to do — turns the default 30-day range into one or two
   * columns, which is not a trend.
   *
   * The rate is derived per period, never averaged across periods: averaging
   * rates weights a quiet day the same as a busy one.
   */
  const trend = useMemo(() => toTrend(data?.daily || []), [data])

  const trendGrain = trend.length > 0 && trend[0].label.length === 7 ? 'month' : 'day'

  /**
   * Per-source trends, where a platform's tables describe different things.
   *
   * Open Web is two halves — the pages that LINK to infringing content and the
   * ones that HOST it — and their enforcement is not the same event: a link is
   * delisted from search results, a host is taken down. Adding them into one
   * line loses exactly the comparison the report is built on, so the server
   * carries each separately (see runPlatform's `sources`) and they replace the
   * merged trend card when there is more than one.
   */
  const sourceTrends = useMemo(() => {
    const sources = (data?.sources || []) as any[]
    /* Present at all is enough. It used to take TWO, which was the same
       mistaken assumption the server made in runPlatform: that one side means a
       single-sided platform, which wants the merged card instead. The Source
       Type slicer broke that — pick one side of Open Web and the server
       legitimately answers with one — and both guards then threw the data away,
       so the card the reader had just selected read "No host data for this
       period" over a table holding rows for the window on screen.

       The server decides whether these belong on the page, from how many sides
       the PLATFORM has rather than how many survived the filter. Second-guessing
       it here is what made a backend fix alone not show anything. */
    if (sources.length === 0) return []
    return sources
      .map(s => {
        const second = s.secondSeries === 'delisted' ? 'delisted' : 'removed'
        const daily = (data?.dailyBySource?.[s.role] || []) as any[]
        /* No action series here any more. What each side SENT, day by day, is a
           breakdown panel now (byNoticeDay / byDelistingBatchDay) rather than a
           trend drawn off these daily rows — which never carried the action ids,
           so the card it fed read a flat zero. See enforcementactions.go. */
        return {
          role: String(s.role),
          label: String(s.label || s.role),
          // The word the chart, its legend and its card title all use.
          secondName: second === 'delisted' ? 'De-Indexing' : 'Removal',
          /* The series itself, carried beside the word for it. The card title
             below used to recover this by matching secondName against a
             literal, so renaming the label retitled every card to the measure
             it does not show, with nothing failing to say so. */
          secondKey: second,
          rows: toTrend(daily, second),
        }
      })
      .filter(s => s.rows.length > 0)
  }, [data])

  const isSummary = activeSection?.key === SUMMARY

  /**
   * One headline figure, by the metric it shows.
   *
   * Each tile is its own panel now — positioned, sized and switched on or off in
   * Report Configuration → Page layout — so this turns a metric key into what
   * that tile draws, and nothing here decides WHICH tiles appear or in what
   * order. Two of them are not plain counts: the removal tile carries its own
   * numerator and denominator, and saved revenue is a range.
   *
   * A metric this result set does not carry returns null, and the panel is
   * skipped rather than printed as a zero the reader cannot distinguish from a
   * real one.
   */
  const tileFor = useCallback((metric: string, label: string) => {
    if (!kpi) return null
    // Every tile carries its metric key through, for the chip glyph and for the
    // figure the change is measured against.
    const d = (key = metric) => kpiDelta(key, kpi[key], kpiPrev?.[key], prevWindowLabel)
    const icon = metric
    switch (metric) {
      case 'identified':
        return { label, icon, delta: d(), value: kpiFmt(kpi.identified), foot: 'Identified', accent: m.ident, spark: 'urls' }
      case 'removed':
        return { label, icon, delta: d(), value: kpiFmt(kpi.removed), foot: 'Taken down', accent: m.removed, spark: 'removed' }
      case 'removalPct':
        return { label, icon, delta: d(), value: `${kpi.removalPct}%`, accent: m.removed, spark: 'removed',
          foot: `${kpiFmt(kpi.removed)} of ${kpiFmt(kpi.identified)} taken down` }
      case 'pending':
        return { label, icon, delta: d(), value: kpiFmt(kpi.pending), foot: 'Still live', accent: m.ident }
      case 'savedRevenue': {
        if (kpi.savedRevenueLow === undefined) return null
        // A range, and the rate that produced it: the multiplier is a commercial
        // assumption set in the server environment, not something the warehouse
        // knows, so the tile says which one it used rather than presenting the
        // figure as measured.
        const rate = data?.revenueRate as { min: number; max: number; currency?: string } | undefined
        const cur = rate?.currency ?? ''
        return {
          label, dense: true, accent: m.removed, icon,
          // The change on the floor of the range: both ends are the same views
          // multiplied by two fixed rates, so they move together and one figure
          // says it.
          delta: kpiDelta('savedRevenue', kpi.savedRevenueLow, kpiPrev?.savedRevenueLow, prevWindowLabel),
          value: `${cur}${kpiFmt(Number(kpi.savedRevenueLow))} – ${cur}${kpiFmt(Number(kpi.savedRevenueHigh))}`,
          foot: rate ? `at ${rate.min}–${rate.max} per view saved` : 'from views saved',
        }
      }
      default: {
        if (kpi[metric] === undefined) return null
        // Figures that describe enforcement wear the removal colour; figures that
        // describe the infringement wear the identification one.
        const enforcement = ['channelsSuspended', 'suspendedWebsites', 'viewsSaved',
          'googleDelisted', 'bingDelisted', 'delisted', 'notices'].includes(metric)
        return {
          label, icon, delta: d(),
          // Asset and site counts are whole things, not magnitudes — "1.2K
          // titles" reads as an estimate where 1,193 is the number.
          value: kpiFmt(Number(kpi[metric]), metric === 'totalAssets' ? 0 : 1),
          foot: KPI_FOOT[metric],
          accent: enforcement ? m.removed : m.ident,
        }
      }
    }
  }, [kpi, kpiPrev, prevWindowLabel, data, m])

  /* Active cross-filter chips, from whatever the section declares. */
  /* The chip shows the NAME, not the value the filter carries. Most slicers now
     send an id — the warehouse groups by AssetId and labels it AssetName — so
     reading the raw filter back would put a GUID on screen for a title the
     reader picked by name a moment earlier. Falls back to the value when the
     option list has not loaded, which is a chip that is briefly ugly rather
     than a chip that is briefly absent. */
  const chips = (activeSection?.filters ?? [])
    .filter(k => filters[k])
    .map(k => ({
      /* The RENAMED name where there is one, so a chip matches the slicer it
         came from instead of reverting to this page's own wording. */
      key: k, label: activeSection?.slicerMeta?.[k]?.label || FILTER_LABELS[k] || k,
      display: asOpts(opts[k]).find(o => o.key === filters[k])?.label
        ?? seenNames.current[`${k} ${filters[k]}`]
        ?? filters[k],
    }))

  /* The asset TITLE for the realtime card's caption, not the GUID the filter
     carries.

     The card said "1 asset" and never which one, so a reader comparing it with
     the tiles below could not tell whether the two were even answering about
     the same fixture. Resolved exactly as the chips above are — option list
     first, then the seenNames cache, then the raw value — so the card and the
     chip cannot end up calling one filter two things.

     An array because the prop takes several; the sports rail filters to one
     asset at a time, so it is an array of one or none. */
  const realtimeAssetNames = useMemo(() => {
    const id = filters.assetId
    if (!id) return []
    const name = asOpts(opts.assetId).find(o => o.key === id)?.label
      ?? seenNames.current[`assetId ${id}`]
    // No name yet: the caption falls back to the asset COUNT rather than
    // printing a GUID at a reader — see scopeBits.
    return name ? [name] : []
  }, [filters.assetId, opts.assetId])

  /* The page's shape comes from the server: every visual, in the order and at
     the width this platform is configured for (Report Configuration → Layout,
     served by go-server/handlers/reportlayout.go). The fallback is the panel
     list this page used to hardcode, so a server that has not been restarted
     still renders. */
  const panels: SectionPanel[] = useMemo(() => {
    if (activeSection?.panels?.length) return activeSection.panels
    const dims = activeSection?.dimensions ?? []
    const metrics = activeSection?.kpiTiles
      ?? ['identified', 'removed', 'removalPct', 'pending', ...(activeSection?.extraKpi ?? [])]
    return [
      ...metrics.map(metric => ({
        key: `kpi:${metric}`, kind: 'tile' as const, metric,
        label: KPI_LABELS[metric] ?? metric, span: 'quarter' as const,
      })),
      { key: 'head:volume', kind: 'heading', label: 'Volume and enforcement',
        sub: 'How much was found, how much came down, and how that rate moved', span: 'full' },
      ...(sourceTrends.length > 0
        ? sourceTrends.map(s => ({ key: `trend:${s.role}`, kind: 'trend' as const, role: s.role, span: 'half' as const }))
        : [{ key: 'trend', kind: 'trend' as const, span: 'full' as const }]),
      /* No action trends here either — what each side SENT is a breakdown panel
         now, and it arrives with `dims` below. Mirrors defaultPanels in
         go-server/handlers/reportlayout.go, which this list is the fallback for. */
      { key: 'rate', kind: 'rate', span: 'full' },
      { key: 'head:breakdowns', kind: 'heading', label: 'Breakdowns',
        sub: 'Views of the same result set — click any row to cross-filter every panel', span: 'full' },
      ...dims.map(d => ({ key: d.key, kind: 'dim' as const, label: d.label, viz: d.viz, span: d.span })),
    ]
  }, [activeSection, sourceTrends])

  /** Every breakdown panel's table twin has the same five columns. */
  const dimTable = (rows: any[], onPick?: (v: string) => void, activeVal = '') => (
    <DataTable head={['Name', 'Identified', 'Removed', 'Rate', 'Share']}
      onPick={onPick} activeVal={activeVal}
      /* The row's own label, not the cell text: the cell falls back to an em
         dash for a blank name, and filtering by "—" would find nothing while
         looking like it had worked. */
      pickValues={rows.map(r => String(r.label ?? ''))}
      rows={rows.map(r => {
        const urls = Number(r.urls) || 0
        const removed = Number(r.removed) || 0
        const total = rows.reduce((a, x) => a + (Number(x.urls) || 0), 0)
        return [String(r.label ?? '—'), urls, removed, `${pct(removed, urls)}%`, `${pct(urls, total)}%`]
      })} />
  )

  /**
   * One breakdown panel, drawn as the shape the server picked for it — a share
   * split as a donut, a turnaround split as an ordered ramp, a long name list as
   * a ranked table. Extracted so the promoted headline panel and the ones in the
   * grid below are the same component and cannot drift apart.
   */
  const renderDim = (dim: SectionDim, spanClass: string) => {
    const rows = orderRows(dim.key, (data?.breakdowns?.[dim.key] || []) as any[])
    const param = DIM_FILTER[dim.key]
    const filterable = !!param && !!activeSection?.filters.includes(param)
    const pick = filterable ? cross(param!) : undefined
    const active = filterable ? (filters[param!] || '') : ''
    const configured = dim.viz || 'bars'
    // The reader's choice for this panel on this platform, falling back to the
    // shape the layout configures.
    const vizKey = `${section}:${dim.key}`
    const viz = vizFor(vizKey, configured)
    /* A map is only offered where the dimension is geographic; everywhere else
       it would draw an empty world and a list of things that are not countries.
       Repeat offenders is the same rule for the same reason — it is the only
       panel whose rows carry the day count that shape draws. */
    const options = configured === 'map' ? [MAP_VIZ, ...DIM_VIZ]
      : configured === 'repeat' ? [REPEAT_VIZ, ...DIM_VIZ]
      : DIM_VIZ
    return (
      <Card key={dim.key} title={dim.label} info={dim.desc}
        action={<VizPicker options={options} value={viz} fallback={configured}
          saved={vizDefault[vizKey]}
          onPick={v => setViz(vizKey, v)}
          onSetDefault={v => saveVizDefault(vizKey, v)} />}
        /* No per-panel "click a row to filter" caption. It said the same thing
           on every one of a dozen cards and cost each of them a line of height;
           the section heading above them says it once. The affordance is still
           there — the rows take a pointer cursor and highlight on hover. */
        chartTitle={undefined}
        table={viz === 'table' ? undefined
          /* The repeat panel's table twin carries the day count and the full
             URL — the two things the chart had to shorten or move off the mark
             to stay readable. Keyed off the DIMENSION, not off `viz`: switching
             this panel to bars does not stop its rows being accounts. */
          : dim.key === 'byRepeatOffender'
            ? <DataTable head={['Channel / Profile URL', 'Days', 'Identified', 'Removed', 'Rate']}
                onPick={pick} activeVal={active}
                pickValues={rows.map(r => String(r.label ?? ''))}
                rows={rows.map(r => {
                  const urls = Number(r.urls) || 0
                  const removed = Number(r.removed) || 0
                  return [String(r.label ?? '—'), Number(r.repeats) || 0, urls, removed,
                    `${pct(removed, urls)}%`]
                })} />
          : viz === 'value' || viz === 'ordinal'
            // Single-series panels have no removal figure to show — a bucket's
            // rows have all come down by definition.
            ? <DataTable head={[dim.label, 'Count']}
                onPick={pick} activeVal={active}
                pickValues={rows.map(r => String(r.label ?? ''))}
                rows={rows.map(r => [String(r.label ?? '—'), Number(r.urls) || 0])} />
            : dimTable(rows, pick, active)}
        className={spanClass}>
        {viz === 'donut'   && <Donut rows={rows} m={m} onPick={pick} activeVal={active} />}
        {viz === 'share'   && <Donut rows={rows} m={m} onPick={pick} activeVal={active} ramp="ordinal" />}
        {viz === 'stacked' && <StackedBars rows={rows} m={m} onPick={pick} activeVal={active} />}
        {viz === 'hbar'    && <HBarChart rows={rows} m={m} onPick={pick} activeVal={active} />}
        {viz === 'column'  && (FULL_SET_DIMS.has(dim.key)
          ? <SeasonColumns rows={rows} m={m} onPick={pick} activeVal={active} />
          : <ColumnChart rows={rows} m={m} onPick={pick} activeVal={active} />)}
        {viz === 'repeat'  && <RepeatOffenders rows={rows} m={m} onPick={pick} activeVal={active} />}
        {viz === 'table'   && <RankTable rows={rows} onPick={pick} activeVal={active} />}
        {viz === 'value'   && <ValueBars rows={rows} m={m} onPick={pick} activeVal={active} />}
        {viz === 'ordinal' && <ValueBars rows={rows} m={m} onPick={pick} activeVal={active} ordered />}
        {viz === 'map'     && <WorldMap rows={rows} m={m} onPick={pick} activeVal={active} />}
        {viz === 'heat'    && <HeatGrid rows={rows} m={m} onPick={pick} activeVal={active} />}
        {!['donut', 'share', 'stacked', 'table', 'heat', 'map', 'hbar', 'column',
           'value', 'ordinal', 'repeat'].includes(viz) && (
          <SegmentBars rows={rows} m={m} activeVal={active} onPick={pick} />
        )}
      </Card>
    )
  }

  /**
   * One panel, whatever kind it is. The layout decides what goes where and how
   * wide it is; this decides what each one draws. Keeping the two apart is the
   * point of the whole exercise — a panel moved in the configuration screen
   * changes nothing about how it is rendered.
   */
  const renderPanel = (p: SectionPanel) => {
    /* Below the xl breakpoint the grid is two columns, where a tile takes one
       and everything else takes both — a chart at half a phone's width is not a
       chart. The configured width only applies from xl up, which is the only
       place a three- or four-panel row is legible anyway. */
    const spanClass = `${p.kind === 'tile' ? 'col-span-1' : 'col-span-2'} ${
      SPAN_CLASS[p.span ?? ''] ?? SPAN_CLASS.half}`
    /* No "Day-on-Day" prefix on any card title any more. It was the one part of
       a panel's name that the configuration screen could not know, so a card was
       listed there under a different name from the one it wore here. Each
       chart's own subtitle still says "by day" / "by month". */

    switch (p.kind) {
      case 'tile': {
        const metric = p.metric ?? ''
        const label = p.label ?? KPI_LABELS[metric] ?? metric
        const t = tileFor(metric, label)
        /* Wrapped rather than spanning directly, because the tile itself is
           `h-full` — so tiles sharing a row with a taller panel stretch to it
           instead of leaving the row ragged. */
        return (
          <div key={p.key} className={spanClass}>
            {t
              ? <Kpi {...t} sparkData={trend} info={p.desc} />
              /* No figure in this result set — a platform whose tables COULD
                 produce this metric but whose run did not. The tile still
                 draws, because the layout put it here; an em dash is the
                 honest value and hiding the card is the layout's call. */
              : <Kpi label={label} value="—" foot="No figure for this period"
                  accent={m.identSoft} icon={metric} info={p.desc} />}
          </div>
        )
      }

      case 'heading':
        return (
          <div key={p.key} className={spanClass}>
            <SectionHead title={p.label ?? ''} sub={p.sub} />
          </div>
        )

      case 'trend': {
        // A per-source trend draws one half of a two-halved report; without a
        // role it is the merged one.
        const src = p.role ? sourceTrends.find(s => s.role === p.role) : undefined
        /* That half returned nothing — its tables answered no rows for this
           window, or ran and failed. The card still draws: the layout put this
           panel on the page, and vanishing left Report Configuration listing a
           trend that was nowhere to be found on the report. */
        if (p.role && !src) {
          const roleName = ROLE_LABELS[p.role] ?? p.role
          return (
            <Card key={p.key} title={p.label || `${roleName} Identification & Removal`}
              info={p.desc} className={spanClass}>
              <NoData note={`No ${roleName.toLowerCase()} data for this period`} />
            </Card>
          )
        }

        const rows = src ? src.rows : trend
        const first = src ? `${src.label} URLs` : 'Identified'
        const second = src ? src.secondName : 'Removed'
        /* The fallback name only — the server sends this card's title as
           `label`, computed by trendPanelLabel so that Report Configuration
           lists it under exactly the name it wears here. Kept in step with that
           function, and deliberately WITHOUT the grain: "Day-on-Day" flips to
           "Month-on-Month" under the reader, which no stored layout can track,
           and the subtitle below already says which. */
        const title = src
          ? `${src.label} Identification & ${second}`
          : isSummary ? 'Infringement Identification & Removal' : 'Identification & Removal'
        const trendKey = `${section}:${p.key}`
        const trendMode = vizFor(trendKey, 'auto') as 'auto' | 'column' | 'line' | 'area'
        return (
          <Card key={p.key} title={p.label || title} info={p.desc} className={spanClass}
            action={<VizPicker options={TREND_VIZ} value={trendMode} fallback="auto"
              saved={vizDefault[trendKey]}
              onPick={v => setViz(trendKey, v)}
              onSetDefault={v => saveVizDefault(trendKey, v)} />}
            chartTitle={src
              ? `${src.label} URLs found against those ${src.secondKey === 'delisted' ? 'de-indexed' : 'removed'}, by ${trendGrain}`
              : `Links found against links taken down, by ${trendGrain}`}
            table={<DataTable head={[trendGrain === 'month' ? 'Month' : 'Date', first, second, 'Rate']}
              onPick={pickPeriod} activeVal={drilled ? drill!.label : ''}
              /* The raw label, not the printed one: the column reads "11 Aug"
                 and the range needs "2026-08-11". */
              pickValues={rows.map(t => String(t.label ?? ''))}
              rows={rows.map(t => [shortDate(t.label), t.urls, t.removed, `${t.rate}%`])} />}>
            <Trend data={rows} m={m} firstName={first} secondName={second} mode={trendMode}
              onPick={pickPeriod} />
          </Card>
        )
      }

      /* Rate on its own card, not a second axis on the trend: two scales sharing
         a plot make the reader believe a correlation that is really just where
         the axes were pinned. */
      case 'rate': {
        const rateKey = `${section}:${p.key}`
        const rateMode = vizFor(rateKey, 'line') as 'line' | 'area' | 'column'
        return (
          <Card key={p.key} title={p.label || 'Removal rate'} info={p.desc} className={spanClass}
            action={<VizPicker options={RATE_VIZ} value={rateMode} fallback="line"
              saved={vizDefault[rateKey]}
              onPick={v => setViz(rateKey, v)}
              onSetDefault={v => saveVizDefault(rateKey, v)} />}
            chartTitle={`Share of that ${trendGrain}'s identified links that came down`}
            table={<DataTable head={[trendGrain === 'month' ? 'Month' : 'Date', 'Removal rate']}
              onPick={pickPeriod} activeVal={drilled ? drill!.label : ''}
              pickValues={trend.map(t => String(t.label ?? ''))}
              rows={trend.map(t => [shortDate(t.label), `${t.rate}%`])} />}>
            <RateTrend data={trend} m={m} mode={rateMode} onPick={pickPeriod} />
          </Card>
        )
      }

      default:
        return renderDim({ key: p.key, label: p.label ?? p.key, viz: p.viz, desc: p.desc }, spanClass)
    }
  }

  /* One list of platform buttons, rendered in the rail when it is open and in
     the hover flyout when it is collapsed. Two copies would have drifted the
     first time an item gained a badge or a count. */
  const navItems = (
    <>
      {sections.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-gray-400">Loading…</p>
      )}
      {sections.map(s => {
        const on = section === s.key
        const [subject, cut] = splitLabel(s.label)
        /* The qualifier — "Sports" on "Open Web Sports" — is dropped from the
           item, which is what makes the rail a clean list of platform names. It
           comes back the moment it is load-bearing: two platforms sharing a
           subject would otherwise render as two identical rows. The full label
           is always on the tooltip. */
        const showCut = !!cut && sections.some(o =>
          o.key !== s.key && splitLabel(o.label)[0] === subject)
        return (
          /* One line per report, qualifier included.

             The qualifier used to sit on a second line, which made four of the
             eleven items twice the height of the rest for a word that is never
             read on its own — it is only ever read as "the Sports one". Set
             beside the subject it says the same thing in half the space, and
             the list stops needing the full column to show eleven entries.

             `items-baseline` rather than `items-center`: the chip is smaller
             text, and centring it against the subject sits it visibly high. */
          <button key={s.key} title={s.label}
            onClick={() => { switchSection(s.key); setFlyout(false) }}
            aria-current={on ? 'page' : undefined}
            className={`flex items-baseline gap-1.5 rounded-lg transition-all whitespace-nowrap
              text-left px-3 py-2 text-sm ${
              on
                ? 'font-semibold text-white shadow-[0_4px_12px_-4px_rgba(252,147,76,0.7)]'
                : 'font-medium text-[#14254A]/65 hover:bg-[#14254A]/[0.05] dark:text-white/65 dark:hover:bg-white/5'
            }`}
            style={on ? { background: 'linear-gradient(135deg,#FDA65A,#FC934C)' } : undefined}>
            {/* min-w-0 + truncate so a long subject shortens itself instead of
                widening the rail or pushing the qualifier out of the box. */}
            <span className="min-w-0 truncate leading-snug">{subject}</span>
            {showCut && (
              <span className={`flex-none text-[10px] leading-snug font-semibold uppercase tracking-wide ${
                on ? 'text-white/75' : 'text-[#14254A]/40 dark:text-white/35'}`}>
                {cut}
              </span>
            )}
          </button>
        )
      })}
    </>
  )

  /*
  The filter pane's controls, rendered in BOTH places that show them.

  One function rather than two blocks, for the reason written on navItems a few
  hundred lines up: two copies drift the first time one of them gains a slicer,
  a chip or an ⓘ. Everything here reads the same `filters` state and the same
  `opts` lists, so the rail and the wide pane are two views of one control set —
  a value changed in either is changed in both, with no syncing to get wrong.

  `wide` is the only difference: it turns off the compact rendering that makes a
  dozen slicers fit a 244px rail and, in doing so, truncates the asset names.
  */
  const filterControls = (wide: boolean) => (
    <>
    {/* One control owns both ends of the range, with its quick ranges
        inside — two separate pickers let an invalid window be set and
        said nothing about which preset produced the dates. */}
    {/* Clamped to the report's own period where it has one, so a
        range outside the data cannot be picked in the first place. The
        server clamps too and is the authority — this is the half that
        keeps a reader from choosing a window and then being shown a
        different one. `max` stays today for an ungoverned report, and
        for a governed one whose period runs past today: there is no
        data ahead of now either way. */}
    <DateRangePicker
      value={{ from: filters.from, to: filters.to }}
      onChange={r => setFilters(f => ({ ...f, from: r.from, to: r.to }))}
      min={activeSection?.period?.start}
      max={activeSection?.period && activeSection.period.end < today()
        ? activeSection.period.end
        : today()}
      /* The quick ranges count back from the newest day the report can
         show, not from a today the period may have ended before —
         otherwise "Last 7 days" on a closed season resolves to seven
         days with nothing in them. */
      anchor={activeSection?.period && activeSection.period.end < today()
        ? activeSection.period.end
        : undefined}
      compact={!wide} />

    {/* No Platform slicer here. The navigation rail on the left is the
        same control over the same value — two copies of it meant two
        places to look for the answer to "which platform am I reading",
        and the one on the left is the one that reads as navigation. */}

    {/* Step 1 — client. The list is scoped to the platform picked in
        the rail, so it cannot be populated before one is chosen. */}
    {/* Staff pick a client; a client login has one, forced by the
        server from the mapping. Rendering the slicer for them would be
        a control that changes nothing. */}
    {!scoped && (
    <>
      <Slicer label="1 · Client" value={filters.clientId} onChange={setF('clientId')}
        options={clientOpts}
        placeholder={section ? 'Select client' : 'Select platform first'}
        disabled={!section}
        required />
      {/* An empty slicer that means "the call failed" looks exactly like
          one that means "there are no clients", and the reader has no
          way to tell which — so when the list could not be fetched, say
          so instead of leaving a dropdown that opens onto nothing. */}
      {opts.clientsError && clientOpts.length === 0 && (
        <p className="text-[11px] mt-1 leading-snug" style={{ color: '#b45309' }}>
          The client list could not be loaded — {String(opts.clientsError)}
        </p>
      )}
    </>
    )}

    {/* The filter pane, as Report Configuration arranged it for this
        platform and this client: which slicers are here at all, and in
        what order. An older server sends no pane, so fall back to every
        filter the section understands less the panel-only ones — which
        is the arrangement this page used to hardcode. */}
    {(activeSection?.slicers
      ?? (activeSection?.filters ?? []).filter(k => !PANEL_ONLY_FILTERS.has(k))
    ).map(key => {
      /* Renamed and described in Report Configuration → Page Layout,
         same as any chart. Absent for a slicer nobody touched, which
         falls back to this page's own label and no ⓘ. */
      const meta = (activeSection?.slicerMeta ?? {})[key]
      return (
        <Slicer key={key} label={meta?.label || FILTER_LABELS[key] || key}
          info={meta?.desc}
          value={filters[key] || ''} onChange={setF(key)}
          options={asOpts(opts[key])} wide={wide} />
      )
    })}

    {chips.length > 0 && (
      <div className="pt-3 border-t border-[#14254A]/10 dark:border-white/10">
        <div className="flex flex-wrap gap-1.5">
          {chips.map(c => <Chip key={c.key} label={c.label} value={c.display} onClear={() => setF(c.key)('')} />)}
        </div>
        <button onClick={() => setFilters(f => ({ clientId: f.clientId, from: f.from, to: f.to }))}
          className="mt-2 text-[10px] font-bold text-gray-400 hover:text-[#FC934C]">
          Reset filters
        </button>
      </div>
    )}

    {lastRun && <p className="text-[10px] text-gray-400 pt-1">Last run {lastRun.toLocaleTimeString()}</p>}
    </>
  )

  return (
    <div className="p-3 sm:p-4 fade-in">
      {/* No progress bar pinned to the top of the window any more. It sat above
          the app chrome, far from the panels it described, and on a re-run the
          only other signal was the report dimming to 60% — which reads as
          "disabled" rather than "reloading". The loader below takes over for
          every run, first and subsequent. */}

      <nav className="flex items-center gap-1 text-xs mb-3">
        <Link to={scoped ? '/dashboard' : '/admin/home'}
          className="font-medium text-[#14254A]/45 hover:text-[#14254A] dark:text-white/40 dark:hover:text-white">Home</Link>
        <span className="text-[#14254A]/25 dark:text-white/25">›</span>
        {!scoped && (
          <>
            <span className="font-medium text-[#14254A]/45 dark:text-white/40">Reporting</span>
            <span className="text-[#14254A]/25 dark:text-white/25">›</span>
          </>
        )}
        <span className="font-semibold text-[#14254A] dark:text-white">Reports</span>
        {/* Whose numbers these are. Staff pick a client and can see which one is
            loaded in the slicer; a client login has no slicer, so the scope is
            stated here instead of being invisible. */}
        {scoped && scope?.clientName && (
          <>
            <span className="text-[#14254A]/25 dark:text-white/25">·</span>
            <span className="font-semibold text-[#FC934C]">{scope.clientName}</span>
          </>
        )}

        {/* Beside the report's own name rather than in the filter rail: this
            changes what the page IS, not what it is showing, and the rail is
            entirely questions about the latter. Hidden without the grant —
            there is no disabled state, because the reason it is unavailable is
            on a screen the reader cannot open. */}
        {scoped && canArrange && section && (
          <button type="button" onClick={() => setLayoutOpen(true)}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg
              text-[11px] font-semibold border border-gray-200 text-gray-600
              hover:bg-white hover:text-[#14254A] transition-colors
              dark:border-white/15 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="9" rx="1.5" />
              <rect x="14" y="3" width="7" height="5" rx="1.5" />
              <rect x="3" y="16" width="7" height="5" rx="1.5" />
              <rect x="14" y="12" width="7" height="9" rx="1.5" />
            </svg>
            Arrange
          </button>
        )}
      </nav>

      {/* A login the module reaches but the mapping does not. Stated plainly:
          an empty report here would be read as "no infringements were found",
          which is a different and much worse answer. */}
      {scoped && scope && !scope.allowed && (
        <div className="rounded-2xl px-5 py-8 text-center bg-white dark:bg-[#1a2d55] shadow-card
          border border-gray-100 dark:border-white/10">
          <p className="font-bold text-[#14254A] dark:text-white mb-1.5">Reports are not available yet</p>
          <p className="text-sm text-gray-500 dark:text-white/45 max-w-md mx-auto leading-relaxed">
            {scope.reason || 'This account is not linked to a reporting client yet.'}
          </p>
          {/* Impersonating staff get the actual fault; a client never does. */}
          {scope.diagnostic && (
            <div className="mt-4 mx-auto max-w-xl rounded-xl px-4 py-3 text-left border
              bg-amber-50 border-amber-200 text-amber-800">
              <p className="text-[10px] font-bold uppercase tracking-widest mb-1">Staff diagnostic</p>
              <p className="text-[11px] leading-relaxed">{scope.diagnostic}</p>
              {scope.portalUserId !== undefined && (
                <p className="text-[11px] mt-1 opacity-80">
                  Portal client userId <b>{scope.portalUserId}</b> — set its Reporting Client ID at{' '}
                  <code>/admin/clients/{scope.portalUserId}/edit</code>.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Rails are sized to their contents rather than to twelfths of the page:
          a list of report names and a column of slicers need a fixed, modest
          width, and on a wide screen a 2/12 rail spends 100px of the report's
          width on air. `items-start` keeps each rail as tall as its own card so
          `sticky` has somewhere to travel — otherwise a stretched rail leaves
          an empty gutter beside the charts as soon as the page scrolls. */}
      {!(scoped && scope && !scope.allowed) && (
      <>

      {/* ── Live discovery counts, across the whole page ─────────────────────

          The report is a window someone chose — thirty days, a year — and says
          nothing about what arrived while they were reading it. This does, and
          it is the reason to keep the screen open.

          FULL WIDTH, and so a sibling of the rails rather than a child of the
          centre column. It used to sit inside `main`, which made it as wide as
          the charts and no wider: a horizontal strip of thirteen platforms,
          squeezed between two rails, wrapping to three rows while the gutters
          either side of it held nothing. The card is the one thing on this page
          that is about the client rather than about the report, so it reads
          across the top of both rails instead of lining up with one column of
          it. Same for a client login, which renders this very component — see
          app/(client)/reports/page.tsx.

          Only on the sports sections: the endpoint behind it counts the sports
          tables, and showing it over a non-sports report would put a number on
          screen that does not describe what is under it.

          ── What the card is scoped by ──────────────────────────────────────
          The CLIENT and the ASSET, and nothing else.

          No dates: the sports count covers the client's configured season,
          resolved server-side from Report Configuration → Sports period — see
          scopeFromRequest. Passing `filters.from/to` would not change the
          answer, but it WOULD re-request on every move of the date slicer and
          file each one under its own cache key, so the card spent the page's
          request budget re-fetching a figure it already had.

          The asset does change it, which is why it is the one slicer that
          travels. Sent as a GUID — the reports screens carry ids, and the card
          resolves names only for the War Room. */}
      {showRealtime && (
        /* ── Pinned: an OPAQUE gutter, not just a sticky card ────────────────
           Sticking the card alone left the strip above it transparent, so the
           report scrolled up through the gap and KPI figures appeared to float
           over the card's top edge.

           So what sticks is a band painted in the scroll container's own
           background (AdminShell's `main`, #eef2f7 / #0f1f3d), running from the
           very top of the viewport to just below the card. Content passing
           underneath is hidden before it ever reaches the card.

           ── The stacking ladder, which this band sits in the middle of ──────

             10  chart tooltips, inside their own cards
             12  the two rails — above the KPI tiles, whose accent bar makes
                 them `relative` and so contenders
             15  THIS BAND, above both rails
             20  AdminShell's header
             40  ClientNavbar's header
             69/70  the Arrange panel, which is meant to cover the chrome
             9999+  anything portalled to <body>: the date picker, the selects

           The two header rows are the ceiling this band must stay under, and
           the reason it is 15 rather than the 50 it briefly was. `main` in
           both shells carries no z-index of its own, so it opens no stacking
           context — a z-index in here is not scoped to the page, it competes
           with the chrome directly. At 50 this band won, and the notification
           panel hanging down out of the navbar was drawn behind the live
           counts.

           Above both rails, though, and that is the point of 15. Full width
           means they share this band's horizontal space, which they never did
           while it sat in the centre column. The offset below is what keeps
           them clear of it in the first place; the z-index is what makes the
           failure a hidden rail rather than a mangled one, if the measurement
           is ever a frame behind.

           The collapsed nav's flyout used to have to cover this band and no
           longer does — it opens at the rail's own top edge, which is now
           under the band, not across it. */

        /* ── One card, in one position, whichever state it is in ─────────────
           Pinned and unpinned used to be the two branches of a ternary: a card
           inside a sticky band, or a bare card. They render the same component,
           which is exactly why that was wrong — React identifies an element by
           its TYPE AND POSITION in the tree, not by what it is called, and those
           two branches put a different type at the slot. So the toggle did not
           restyle the card, it unmounted one and mounted another.

           Everything the card holds went with it: the last reading, the
           last-good copy kept for a failed refresh, the paused flag — and the
           fresh instance ran its load effect, which is why pinning re-read the
           counts, reset the "x ago" stamp and re-animated the total from zero.

           The wrapper is unconditional now and only its classes change, so
           pinning is a style change. The card is never torn down, its refresh
           timer keeps its own cadence, and the number on screen is the same
           reading it was a moment ago. */
        <div ref={rtBandRef}
          className={`mb-3 ${rtPinned
            ? 'sticky top-0 z-[15] pt-2 pb-2 bg-[#eef2f7] dark:bg-[#0f1f3d]'
            : ''}`}>
          <RealtimeCard view="sports" clientId={filters.clientId}
            assetIds={realtimeAssetIds}
            /* The narrowing filters that put the card on screen at all — see
               showRealtime. Sending only the asset was the bug: picking Serie A
               narrowed every panel below to 22,007 rows and left the card
               reporting 103,512 for the whole season. */
            franchise={filters.franchiseName || undefined}
            matchDay={filters.matchDay || undefined}
            /* Names for the caption in the card's corner. The filters above
               narrow the count; this is what tells the reader what it was
               narrowed TO. */
            assetNames={realtimeAssetNames}
            pinned={rtPinned} onTogglePin={() => setRtPinned(p => !p)}
            className={rtPinned ? 'shadow-lg' : ''} />
        </div>
      )}

      <div className="flex flex-col xl:flex-row xl:items-start gap-3">

        {/* ── Left: report navigation, collapsible ─────────────────────────── */}
        {/* Collapsed, the rail is its toggle and nothing else. A column of
            two-letter badges was the worst of both: not a readable list, and
            not narrow enough to be worth the width it kept. The platform names
            come back on hover as a flyout, so a collapsed rail is still one
            click from any report. `group-focus-within` keeps that reachable by
            keyboard — tabbing into the hidden list opens it. The flyout is
            xl-only: below that the rail is a full-width strip with no room to
            fly out and no hover to open it, so the list simply stays inline. */}
        <aside
          onMouseEnter={railOpen ? undefined : openFlyout}
          onMouseLeave={railOpen ? undefined : closeFlyout}
          onFocus={railOpen ? undefined : openFlyout}
          onBlur={railOpen ? undefined : closeFlyout}
          /* A z-index on the RAIL, not on the flyout. `sticky` makes this
             element its own stacking context, so the flyout's z-30 only ever
             sorts it against its siblings inside the rail — never against the
             report. The KPI tiles are `relative` for their accent bar, which
             puts them in the same paint layer as this rail and later in
             document order, so without a z-index here the flyout opens
             *underneath* the cards and all that shows is a sliver of it in the
             gap between two KPI rows.

             12, not the 40 this used to be: see the ladder on the live card's
             band. It clears the chart tooltips at z-10 and stays well under the
             shell chrome. */
          /* `top` against the live card's band rather than a flat 8px — see
             railInset. It resolves to 8px whenever the band is not there. */
          style={railInset}
          className={`relative z-[12] w-full xl:flex-none xl:sticky
            xl:top-[calc(0.5rem_+_var(--rt-band,0px))] ${
            railOpen ? 'xl:w-[196px]' : 'xl:w-[52px]'}`}>
          <div className={`bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border transition-colors
            ${!railOpen && flyout
              ? 'border-[#FC934C]/40 dark:border-[#FC934C]/40'
              : 'border-gray-100 dark:border-white/10'} p-3 xl:p-2`}>
            <div className={`flex items-center justify-between gap-1 px-1.5 pt-0.5 pb-2 ${
              railOpen ? '' : 'xl:px-0 xl:pb-0'}`}>
              {railOpen && (
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400">Navigation</p>
              )}
              {/* Collapsed, the arrow is the only thing in the rail, so it is
                  also the thing being hovered — it lights up with the panel
                  rather than waiting for the pointer to land on the 24px
                  button itself. */}
              {/* No `title` while collapsed. The native tooltip is drawn by the
                  browser, cannot be moved, and lands on exactly the spot the
                  flyout opens into — so hovering the rail to see the report
                  list covers the report list. It is also redundant there: the
                  flyout names every platform, which is more than the tooltip
                  was going to say. `aria-label` keeps the button named for
                  screen readers either way. */}
              <button onClick={() => setRailOpen(o => !o)}
                aria-label={railOpen ? 'Hide the report list' : 'Show the report list'}
                title={railOpen ? 'Hide the report list' : undefined}
                aria-expanded={railOpen}
                className={`w-6 h-6 grid place-items-center rounded-lg transition-colors
                  hover:text-[#14254A] hover:bg-[#14254A]/[0.06]
                  dark:hover:text-white dark:hover:bg-white/10 ${
                  railOpen ? 'ml-auto text-gray-400' : 'ml-auto xl:mx-auto'} ${
                  !railOpen && flyout ? 'text-[#FC934C]' : 'text-gray-400'}`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"
                  className={railOpen ? '' : 'rotate-180'}>
                  <path d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            </div>
            {/* The scroll goes on the LIST, never on the <aside>: the flyout is
                an absolutely-positioned child that sits outside the rail's box,
                and an overflow on the aside would clip it away entirely. The
                negative margin/padding pair gives the active item's glow room
                inside the scroll box — an overflow clips it whether or not the
                list is long enough to actually scroll. */}
            <nav className={`flex gap-1.5 xl:flex-col xl:gap-0.5 overflow-x-auto
              xl:max-h-[calc(100dvh_-_10rem_-_var(--rt-band,0px))]
              xl:overflow-y-auto xl:p-1.5 xl:-m-1.5 ${
              railOpen ? '' : 'xl:hidden'}`}>
              {navItems}
            </nav>
          </div>

          {/* The hover flyout. The wrapper's left padding is the gap between
              rail and panel *and* part of the hover target, so the pointer
              crosses it without ever leaving the region that keeps it open.
              Hidden with opacity rather than `hidden`, so the buttons stay in
              the tab order and focus can open the panel too. */}
          {!railOpen && (
            <div
              onMouseEnter={openFlyout}
              onMouseLeave={closeFlyout}
              className={`hidden xl:block absolute left-full top-0 z-30 pl-2.5
                origin-left transition-[opacity,transform] duration-150 ease-out ${
                flyout
                  ? 'opacity-100 translate-x-0 scale-100 pointer-events-auto'
                  : 'opacity-0 -translate-x-1.5 scale-[0.98] pointer-events-none'}`}>
              <div className="w-[196px] bg-white dark:bg-[#1a2d55] rounded-2xl border border-gray-100 dark:border-white/10
                shadow-[0_18px_44px_-14px_rgba(20,37,74,0.35)] dark:shadow-[0_18px_44px_-14px_rgba(0,0,0,0.65)] p-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400 px-2 pt-1 pb-1.5">Navigation</p>
                <nav className="flex flex-col gap-0.5">{navItems}</nav>
              </div>
            </div>
          )}

          {/* The connection badge that used to sit here is gone. A healthy
              backend is not news — it said "Database connected" on every visit
              of every working day, and the report itself is the better signal
              that the connection works.

              The health CHECK stays: when it is not connected, the empty state
              in the centre says so and names the reason, which is where a
              reader is already looking when nothing has rendered. */}
        </aside>

        {/* ── Centre: KPI band + panels ────────────────────────────────────── */}
        {/* The centre takes everything the two rails do not, so collapsing
            either one widens the charts instead of leaving a gap. */}
        <main className="w-full xl:flex-1 xl:min-w-0 space-y-3 sm:space-y-4">

          {/* The KPI band is a panel like any other now — it is drawn inside the
              layout below, so it can be moved or hidden along with the charts
              rather than being pinned above them. */}
          {!activeSection ? (
            <Notice cardTitle="Reports"
              title={sections.length === 0 ? 'Loading reports…' : 'Choose a platform to begin'}
              body={sections.length === 0
                ? 'Fetching the available reports from the analytics warehouse.'
                : 'Pick a platform from the navigation on the left, then a client. The report then runs itself over the last 30 days.'} />
          ) : !filters.clientId ? (
            <Notice
              cardTitle={activeSection.label}
              title={scoped
                ? 'Loading your report…'
                : health && !health.connected ? 'Reports aren’t available right now' : 'Pick a client to load the report'}
              body={scoped
                /* A client has no slicer to act on, so this is a wait, not an
                   instruction. */
                ? 'Fetching the figures for your account.'
                : health && !health.connected
                  /* Not the server's own text. It named the host, the database
                     and sometimes the user that was refused, on a screen whose
                     reader cannot act on any of it. */
                  ? 'The client list can’t be loaded at the moment. Please try again in a few minutes.'
                  : 'Use the Client slicer on the right. The report runs automatically and re-runs on every filter change.'}
            />
          ) : loading ? (
            /* EVERY run, not just the first. A re-run used to leave the old
               numbers on screen at 60% opacity, which is indistinguishable from
               a disabled panel and — worse — shows figures for the PREVIOUS
               filter set as though they answered the new one. */
            <Card title={activeSection.label}>
              <ReportLoader
                fill
                label="Running the report"
                sublabel={`${activeSection.label} · querying the analytics warehouse`}
              />
            </Card>
          ) : !data ? (
            /* clientId is set but the query has not returned — switching section
               clears `data` while the client stays selected, and every panel
               below dereferences it. */
            <Notice
              cardTitle={activeSection.label}
              title={err ? 'The report could not be loaded' : 'No data yet'}
              body={err || 'Adjust the filters on the right to load a result set.'}
            />
          ) : (
            <>
              {/* The summary totals several reports at once, so it has to say
                  which — a figure whose scope the reader has to guess is worse
                  than one they cannot see. */}
              {isSummary && Array.isArray(data.platforms) && data.platforms.length > 0 && (
                <p className="text-[11px] text-gray-400 -mb-1">
                  Across{' '}
                  <span className="font-semibold text-gray-500 dark:text-white/60">
                    {data.platforms.join(' · ')}
                  </span>
                </p>
              )}

              {/* A slicer that only one platform's tables carry — Platform is a
                  social-media column — cannot be applied to the rest, and a table
                  that cannot apply it would otherwise contribute its full,
                  unfiltered total to a number the reader believes is filtered. So
                  those platforms are left out, and named. */}
              {isSummary && Array.isArray(data.outOfScopePlatforms) && data.outOfScopePlatforms.length > 0 && (
                <div className="rounded-xl px-4 py-3 text-sm border bg-amber-50 border-amber-200 text-amber-800
                  dark:bg-amber-500/10 dark:border-amber-400/25 dark:text-amber-200">
                  <strong>Not included in these totals:</strong> {data.outOfScopePlatforms.join(', ')}.
                  <p className="text-[11px] mt-1 opacity-80">
                    None of their tables carry a column for one of the active filters, so they are left out
                    rather than added unfiltered. Clear that filter to bring them back.
                  </p>
                </div>
              )}

              {/* ── The way back out of a date click ──────────────────────
                  A click on a day sets the range to that day, which is the
                  right thing and also the one filter on this page that HIDES
                  its own undo: the trend it was clicked on collapses to a
                  single figure, so there is no mark left to click again. The
                  slicers do not have that problem — their chips sit in the rail
                  and their charts stay drawn.

                  Above the panels rather than in the rail with the chips,
                  because it is a different kind of statement: not "one value of
                  one dimension" but "the whole report is on a narrower range
                  than the one you picked". */}
              {drilled && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-4 py-2.5 text-sm border
                  bg-[#FC934C]/[0.08] border-[#FC934C]/30 text-[#14254A]
                  dark:bg-[#FC934C]/10 dark:border-[#FC934C]/25 dark:text-white">
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: BRAND_ORANGE }} />
                  <span>
                    <strong>{drill!.label.length === 7
                      ? shortDate(drill!.label) : shortDateFull(drill!.label)}</strong> only — every panel below is
                    filtered to {drill!.label.length === 7 ? 'this month' : 'this day'}.
                  </span>
                  <button onClick={() => pickPeriod(drill!.label)}
                    className="ml-auto text-[11px] font-bold uppercase tracking-wider
                      text-[#14254A]/60 hover:text-[#14254A] dark:text-white/60 dark:hover:text-white
                      transition-colors">
                    ← Back to {shortDate(drill!.from)} – {shortDate(drill!.to)}
                  </button>
                </div>
              )}

              {/* Every visual on the page, in the order and at the widths this
                  platform — and this client — is configured for. Twelve columns,
                  so a row holds one panel, two, three or four; a row whose widths
                  do not add up simply wraps, which is the honest result of that
                  choice rather than something to be silently corrected here. */}
              <div className="grid grid-cols-2 xl:grid-cols-12 gap-3 xl:gap-4">
                {panels.map(renderPanel)}
              </div>
            </>
          )}

          {authError && (
            <div className="rounded-xl px-4 py-3 text-sm border bg-red-50 border-red-200 text-red-700
              dark:bg-red-500/10 dark:border-red-400/25 dark:text-red-300">
              <strong>Your session is no longer valid.</strong>
              <p className="text-[11px] mt-1 leading-relaxed">
                The reports API rejected this request as unauthenticated. Reload the page and sign in
                again — nothing about the report configuration needs changing.
              </p>
              <button onClick={() => window.location.reload()}
                className="mt-2 px-3 py-1.5 rounded-lg text-[11px] font-bold border
                  border-red-300 text-red-700 hover:bg-red-100
                  dark:border-red-400/30 dark:text-red-200 dark:hover:bg-red-500/20">
                Reload
              </button>
            </div>
          )}

          {/* That some panels are missing IS the reader's business — it says
              the report in front of them is short, which they would otherwise
              have to infer from an empty card. Why is not: the reason is a
              failed statement naming the column and the table it ran against,
              and the fix is an endpoint no reader of a report is going to call.
              Both are in the server log for the person who can act on them. */}
          {data?.queryWarning && (
            <div className="rounded-xl px-4 py-3 text-sm border bg-amber-50 border-amber-200 text-amber-800
              dark:bg-amber-500/10 dark:border-amber-400/25 dark:text-amber-200">
              <strong>Some panels could not be loaded.</strong>
              <p className="text-[11px] mt-1 opacity-80">
                The rest of this report is complete and the figures shown are accurate.
              </p>
            </div>
          )}

          {/* CAVEATS, NOT FAILURES — and deliberately a different colour and a
              different noun from the block above.

              A panel folded from a partial list drew fine and holds real
              numbers; it just needs a sentence saying what it covers. Putting
              that under "Some panels could not be loaded" was both untrue and
              corrosive: a banner that cries failure over a working report is a
              banner people learn to scroll past, including on the day something
              has actually broken. */}
          {Array.isArray(data?.notices) && data.notices.length > 0 && (
            <div className="rounded-xl px-4 py-3 text-sm border bg-gray-50 border-gray-200 text-gray-600
              dark:bg-white/5 dark:border-white/10 dark:text-white/70">
              <strong className="font-semibold">Worth knowing about this run.</strong>
              <ul className="mt-1 space-y-0.5">
                {data.notices.map((n: string, i: number) => (
                  <li key={i} className="text-[11px] opacity-90">{n}</li>
                ))}
              </ul>
            </div>
          )}

          {err && (
            <div className="rounded-xl px-4 py-3 text-sm border bg-red-50 border-red-200 text-red-700
              dark:bg-red-500/10 dark:border-red-400/25 dark:text-red-300">
              <strong>Error:</strong> {err}
            </div>
          )}
          {/* A sentence, and nothing folded away beneath it.

              This panel used to carry the server's own words — "no report
              backend is configured — set REPORTS_API_URL …" — behind a
              Technical details toggle. That was noise in place of an answer for
              everyone who opened it, and for the one person who could act on it
              the same text is in the server log, with the part this screen
              could never show: which hop actually failed. */}
          {unavailable && !authError && (
            <div className="rounded-2xl border bg-white dark:bg-[#1a2d55] border-gray-100 dark:border-white/10
              shadow-card px-5 py-6 sm:px-7 sm:py-8">
              <div className="flex flex-col items-center text-center gap-3">
                <span className="w-11 h-11 grid place-items-center rounded-full
                  bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <ellipse cx="12" cy="5" rx="8" ry="3" />
                    <path d="M4 5v14c0 1.7 3.6 3 8 3M20 5v6" />
                    <path d="M18 14v3.5M18 21h.01" />
                  </svg>
                </span>

                {/* One message, for staff and clients alike.

                    It used to fork: a client was told to wait, while staff got
                    the server's raw text and the four environment variables to
                    set it in. None of that belonged on a page — it named the
                    warehouse, the config file and the boot sequence to anyone
                    who opened the panel, and it is not something a reader of a
                    report acts on even when they understand it. The detail is
                    in the server log, which is where the person who can fix it
                    is already looking. */}
                <div>
                  <p className="font-bold text-[#14254A] dark:text-white">
                    Reports aren’t available right now
                  </p>
                  <p className="text-sm mt-1.5 max-w-md mx-auto leading-relaxed text-gray-500 dark:text-white/45">
                    We can’t load your reports at the moment. Nothing is wrong with your data —
                    please try again in a few minutes.
                  </p>
                </div>

                <button
                  onClick={() => { setUnavailable(''); loadHealth(); setFilters(f => ({ ...f })) }}
                  className="mt-1 px-4 py-2 rounded-lg text-xs font-bold text-white bg-[#14254A]
                    hover:opacity-90 transition-opacity">
                  Try again
                </button>
              </div>
            </div>
          )}
        </main>

        {/* ── Right: slicers ───────────────────────────────────────────────── */}
        {/* Same inset as the navigation rail, and for the same reason — the
            live card above spans both of them now. See railInset. */}
        <aside style={railInset}
          className={`w-full xl:flex-none xl:sticky
            xl:top-[calc(0.5rem_+_var(--rt-band,0px))] ${
          filtersOpen ? 'xl:w-[244px]' : 'xl:w-[60px]'}`}>
          {!filtersOpen ? (
            /* Collapsed: one button back to the filters, so the charts get the
               width once a filter set is settled — which is most of the time. */
            <button onClick={() => setFiltersOpen(true)} title="Show filters"
              className="w-full bg-white dark:bg-[#1a2d55] rounded-xl shadow-card border
                border-gray-100 dark:border-white/10 p-3 flex flex-col items-center gap-2
                text-gray-400 hover:text-[#14254A] dark:hover:text-white transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 5h18M6 12h12M10 19h4" />
              </svg>
              <span className="text-[9px] font-bold uppercase tracking-widest">Filters</span>
            </button>
          ) : (
          /* Pinned, so a filter set that is taller than the screen has to be
             able to scroll on its own — otherwise the slicers past the fold
             become unreachable, which a rail that scrolled with the page never
             was. The height is bounded by the viewport less the shell's header;
             being a few pixels out only means it starts scrolling slightly
             early, which is invisible. */
          <div className="bg-white dark:bg-[#1a2d55] rounded-xl shadow-card border border-gray-100 dark:border-white/10 p-3 space-y-2.5
            xl:max-h-[calc(100dvh_-_8.5rem_-_var(--rt-band,0px))] xl:overflow-y-auto">
            <div className="flex items-center justify-between gap-2">
              {/* Numbered only where there is a sequence to be in. A client
                  login has no client slicer, so the date range is the only
                  step and "2 ·" would be counting something invisible. */}
              <p className="text-[13px] font-bold text-[#14254A] dark:text-white">
                {scoped ? 'Date Range' : '2 · Date Range'}
              </p>
              <span className="flex items-center gap-1">
                <button onClick={() => { loadHealth(); setFilters(f => ({ ...f })) }} title="Refresh"
                  className="text-sm font-bold text-gray-400 hover:text-[#FC934C]">↻</button>
                {/* Into the wide pane. Between refresh and hide because that is
                    the order they are reached in: re-run what is set, open it
                    up to change something, or put it away. */}
                <button onClick={() => setFiltersWide(true)}
                  title="Open the filters in a wider pane" aria-label="Open the filters in a wider pane"
                  className="w-6 h-6 grid place-items-center rounded-md text-gray-400
                    hover:text-[#FC934C] hover:bg-[#FC934C]/10 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7" />
                  </svg>
                </button>
                <button onClick={() => setFiltersOpen(false)} title="Hide filters" aria-label="Hide filters"
                  className="w-6 h-6 grid place-items-center rounded-md text-gray-400
                    hover:text-[#14254A] hover:bg-[#14254A]/[0.06]
                    dark:hover:text-white dark:hover:bg-white/10 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </span>
            </div>

            {filterControls(false)}
          </div>
          )}
        </aside>
      </div>
      </>
      )}

      {/* ── The filters, in a pane wide enough to read them ─────────────────

          Off-canvas from the right, over the report rather than beside it. The
          rail keeps its place and its state; this is the same controls at a
          width where an asset name is a name rather than a prefix.

          Portalled for the reason every overlay in this product is: the page
          wrapper carries `.fade-in`, whose fill-mode leaves a permanent
          transform behind, and a transformed ancestor makes `position: fixed`
          resolve against the content box instead of the viewport.

          z-[80]: over the report, the rails and the pinned live card, and under
          the Arrange panel at 69/70 — no, ABOVE it, which is why 80 and not 60:
          the two never open together, and if they ever did the one the reader
          just asked for should be the one in front. Portalled selects and date
          pickers sit at 9999 and stay reachable from inside it. */}
      {filtersWide && (
        <Portal>
          <style>{`@keyframes fpIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
          <div className="fixed inset-0 z-[80] flex justify-end backdrop-blur-[2px]"
            style={{ background: 'rgba(20,37,74,0.45)' }}
            role="dialog" aria-modal="true" aria-label="Report filters"
            onClick={() => setFiltersWide(false)}>
            {/* 520px on a desktop, the whole width on a phone. The number is
                the point of the feature: a fixture label runs to about sixty
                characters and this is what shows them. */}
            <aside
              className="h-full w-full sm:w-[460px] lg:w-[520px] flex flex-col shadow-2xl
                bg-white dark:bg-[#1a2d55] border-l border-gray-200 dark:border-white/10"
              style={{ animation: 'fpIn .22s ease-out' }}
              onClick={e => e.stopPropagation()}>

              <header className="px-5 py-4 flex items-start justify-between gap-3 flex-shrink-0
                border-b border-gray-100 dark:border-white/10
                bg-gradient-to-r from-[#14254A]/[0.04] to-transparent dark:from-white/[0.06]">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[#FC934C]">
                    {activeSection?.label ?? 'Report'}
                  </p>
                  <h2 className="text-base font-extrabold text-[#14254A] dark:text-white leading-tight mt-0.5">
                    Filters
                  </h2>
                  {/* Said once, here: a reader who has just moved a slicer in a
                      panel covering the report needs to know the report behind
                      it has already followed. */}
                  <p className="text-[11px] text-gray-500 dark:text-white/50 mt-1">
                    The same filters as the rail. Changes apply to the report as you make them.
                  </p>
                </div>
                <button onClick={() => setFiltersWide(false)} aria-label="Close"
                  className="w-8 h-8 grid place-items-center rounded-lg text-gray-400 flex-shrink-0 text-sm
                    hover:text-[#14254A] hover:bg-[#14254A]/[0.06]
                    dark:hover:text-white dark:hover:bg-white/10">
                  ✕
                </button>
              </header>

              {/* The controls scroll, the header and footer do not — a filter
                  set taller than the panel must not put its Done button past
                  the fold. */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3.5">
                {filterControls(true)}
              </div>

              <div className="px-5 py-3 flex-shrink-0 border-t border-gray-100 dark:border-white/10
                bg-gray-50/70 dark:bg-white/[0.03] flex items-center justify-between gap-3">
                <span className="text-[11px] text-gray-400">
                  {loading ? 'Running…' : lastRun ? `Last run ${lastRun.toLocaleTimeString()}` : ''}
                </span>
                <button onClick={() => setFiltersWide(false)}
                  className="px-5 py-2 rounded-xl text-xs font-bold text-white hover:opacity-90"
                  style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                  Done
                </button>
              </div>
            </aside>
          </div>
        </Portal>
      )}

      {scoped && canArrange && (
        <ReportLayoutEditor
          platform={section}
          /* Every section this login can open, so all of its reports are
             arranged from one screen rather than by closing the editor,
             switching report and opening it again. */
          sections={sections.map(s => ({ key: s.key, label: s.label }))}
          open={layoutOpen}
          onClose={() => setLayoutOpen(false)}
          onSaved={() => setLayoutRev(v => v + 1)} />
      )}
    </div>
  )
}
