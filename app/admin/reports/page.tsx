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
import { downloadWorkbook, type Sheet } from '@/lib/xlsx'
import { downloadChartPng } from '@/lib/chartImage'
import { printReport, PRINT_HIDE_ATTR } from '@/lib/printReport'
import Portal from '@/components/ui/Portal'
import { Link } from 'react-router-dom'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DateRangePicker from '@/components/ui/DateRangePicker'
import { WORLD_SHAPES, WORLD_VIEWBOX } from './worldShapes'
import RealtimeCard from '@/components/shared/RealtimeCard'
import ReportLoader from '@/components/shared/ReportLoader'
import PowerBIReport from '@/components/shared/PowerBIReport'
import ReportLayoutEditor from '@/components/reports/ReportLayoutEditor'
import { DEFAULT_THEME, themeFor, type CustomPalette, type MarkTheme } from '@/lib/reportTheme'
import { EngineChart, NATIVE } from '@/lib/charts/engines'
import type { ChartForm, ChartSpec } from '@/lib/charts/spec'
import { durationMinutes, foldTatRows } from '@/lib/tatBuckets'

/* ── Palette ───────────────────────────────────────────────────────────────────
   Two families, deliberately kept apart:

   · CHROME — brand navy/orange/gold. Headings, the active rail item, chips, the
     progress bar. This is the product's identity and it matches War Room. It is
     fixed, and the three constants below are all of it.

   · MARKS  — the colours data is drawn in. Six palettes, in lib/reportTheme.ts,
     with the reader choosing between them from the Appearance control in this
     page's toolbar. Every one of them keeps identification navy and removal
     orange; what they vary is the categorical ramp, the sequential ramp and how
     loud the grid and axis are. `m` below is whichever one is in force.

     One rule survives the move and applies to any new visual added here: these
     ramps separate neighbouring steps as much by LIGHTNESS as by hue, so a mark
     is only safe next to its number. Every component on this page prints the
     value beside the mark — the bar lists, the donut legend, the table and the
     heat grid all do — and that is what makes a low-separation set readable.

   · ENGINE — which library actually draws a chart is a separate choice again,
     also in the toolbar. See lib/charts/engines.tsx; the components in this file
     are the built-in engine and the fallback for every panel the others decline.
*/

const BRAND_NAVY   = '#14254A'
const BRAND_ORANGE = '#FC934C'
const BRAND_GOLD   = '#FFC82B'

/* The palettes themselves moved to lib/reportTheme.ts when the report gained a
   theme picker: there are six of them now, they have to be reachable from the
   chart-engine adapters in lib/charts (which know nothing about this page), and
   a runtime choice between them is no longer a thing a `const` can express.

   What has NOT changed is the rule they all keep — identification is navy,
   removal is orange, in every theme and on every page of this product. The
   three brand constants above stay here because the page's CHROME uses them:
   a section rule, a legend key, a bullet. Those are identity, not data. */

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

/**
 * Whether a section is a SPORTS report, read off its own name.
 *
 * Lifted out of the component so the two things that ask it — the window a
 * report opens on, and whether the live counts card belongs above it — ask it
 * the same way. They were one expression inside one memo, which is fine until a
 * second caller needs the answer and writes its own slightly different test.
 *
 * The qualifier, not a list of keys: "Open Web — Sports" is a sports report and
 * "Open Web" is not, and which platforms exist is configuration an admin edits
 * on Report Configuration. A hardcoded list would go quietly wrong the day
 * somebody adds one.
 */
function isSportsLabel(label: string | undefined): boolean {
  const [, qualifier] = splitLabel(String(label ?? ''))
  return (qualifier ?? '').trim().toLowerCase() === 'sports'
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
  /* The top tick must clear the real max, not just come close to it. Stopping
     at the last multiple of `step` within half a step of `max` — the previous
     rule — can land BELOW max: at max=10900 and step=5000 it stops at 10000,
     900 short. The axis domain is [0, this array's last value], so that bar
     draws taller than the plot it is on and is cut off at the top edge —
     taking its value label, drawn above it, with it. Rounding up to the next
     whole step instead guarantees the domain always contains every bar. */
  const top = Math.ceil(max / step) * step
  const out: number[] = []
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v * 100) / 100)
  return out
}

/** The first number in a bucket label — "11-20" → 11 — so ordered buckets can
    be put back in their own order after the server sorted them by size.
    Labels with no number sort last, which keeps an "Unknown" bucket at the end. */
function leadingNum(s: string): number {
  const hit = /(-?\d+(?:\.\d+)?)/.exec(String(s))
  return hit ? Number(hit[1]) : Number.POSITIVE_INFINITY
}

/**
 * Where a row sits on an ORDERED bucket axis.
 *
 * A duration is placed on the minute axis; anything else falls back to its
 * leading number, which is what a page-number or a tier bucket needs.
 *
 * The fallback is not cosmetic. leadingNum alone is UNIT-BLIND, and on the
 * turnaround bands that is the difference between a ramp and nonsense: it reads
 * "1-2 hr" as 1 and "15-30 min" as 15, so the hours sort ahead of the minutes
 * and the panel comes out 0-15 min, 1-2 hr, 2 hr+, 15-30 min, 30 min-1 hr —
 * five bands in an order whose shading asserts a sequence the labels contradict.
 *
 * A bucket set is homogeneous in practice, so the two scales never mix within
 * one panel: every turnaround label parses as a duration, and no page-number
 * label does.
 */
const ordinalKey = (s: string) => durationMinutes(s) ?? leadingNum(s)

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

/*
textPx is the rendered width of a chart label, in pixels.

Exists because two charts here decide LAYOUT from label width — whether two
value labels in a pair would overlap — and a per-character estimate is not
accurate enough to answer that. Digits, "." and "K" differ enough in this face
that an average is wrong by 20% on a three-digit number, which is the difference
between a readable pair and an overlapping one.

One canvas, created once and reused, with a cache: the same handful of formatted
values recur on every render and across every panel. The font is read off the
document so it follows whatever the page is actually set in rather than naming a
family here that a theme change would leave behind.

Returns a conservative fallback where there is no canvas — a headless render, or
a browser that refuses the context — so a chart still decides something sensible
rather than throwing inside a render.
*/
const textPxCache = new Map<string, number>()
let textPxCtx: CanvasRenderingContext2D | null | undefined
function textPx(s: string, weight = 700, size = 10): number {
  const key = `${weight}/${size}/${s}`
  const hit = textPxCache.get(key)
  if (hit !== undefined) return hit
  if (textPxCtx === undefined) {
    try {
      textPxCtx = document.createElement('canvas').getContext('2d')
    } catch { textPxCtx = null }
  }
  let px: number
  if (textPxCtx) {
    const fam = getComputedStyle(document.body).fontFamily || 'sans-serif'
    textPxCtx.font = `${weight} ${size}px ${fam}`
    px = Math.ceil(textPxCtx.measureText(s).width)
  } else {
    // 0.72em per character is wider than any glyph this formatter produces, so
    // a fallback errs toward hiding a label rather than overlapping one.
    px = Math.ceil(s.length * size * 0.72)
  }
  textPxCache.set(key, px)
  return px
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
  /** What a THIRD figure on each row is called, where the panel carries one —
      "Websites" on the two hosting-provider panels, absent everywhere else. The
      server names it because only the server knows which panels have it; see
      dimension.APIExtra in go-server/handlers/reportspecs.go. */
  extraLabel?: string
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
  /** `realtime` is the live counts strip — RealtimeCard. It is a panel like the
      rest now, so Report Configuration can move it, resize it, switch it off,
      rename it and give it a note; where it SITS still decides one thing no
      other panel's position does, which is whether the reader can pin it. See
      rtLeads below. */
  kind: 'tile' | 'heading' | 'trend' | 'rate' | 'dim' | 'realtime'
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
  /**
   * What this report IS: a warehouse query, or an embedded Power BI report.
   *
   * Known from the SECTION list rather than discovered in the data response,
   * and that ordering is the point: a Power BI report has no panels, no slicers
   * and no date range to honour, so a page that found out from the data would
   * already have drawn a filter rail and a KPI band for it.
   *
   * Absent from an older server, and read as a queried report — which is what
   * every section was before this existed.
   */
  sourceKind?: 'table' | 'powerbi'
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

/* And what every OTHER report opens on. A month reads as a month on a page
   about volume over time, and none of the non-sports reports is scoped to a
   fixture the way a sports one is. */
const GENERIC_DAYS = 30

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
  target: Section | undefined,
  from: string,
  to: string,
  picked: boolean,
): { from: string; to: string } {
  /* An untouched window is not a choice to carry. It is whatever the page
     opened with, and where the section being entered has a default of its own —
     seven days on a sports report — that default is the better answer than a
     number nobody picked. This is what stopped a sports report opening on a
     month: the generic thirty days sat inside the season, so the test below
     said "inside, keep it" and the seven-day rule never ran. */
  if (!picked) return sectionDefaultRange(target)
  if (!target?.period) return { from, to }
  const { start, end } = target.period
  const inside = from >= start && from <= end && to >= start && to <= end
  return inside ? { from, to } : sectionDefaultRange(target)
}

/**
 * The window a section OPENS on, before the reader has chosen anything.
 *
 * Three answers, narrowest first:
 *
 *   · a governed sports report opens on its period's last week — see
 *     periodDefaultRange, which counts back from the season's END rather than
 *     from today;
 *   · an ungoverned sports report opens on the last seven days. Same rule, no
 *     period to clip it to: a sports platform whose client has no configured
 *     season still reads a fixture at a time, and a month of it is a slow query
 *     over a question nobody asked;
 *   · everything else opens on the last thirty days, which is what every report
 *     on this page did before sports had a rule of its own.
 */
function sectionDefaultRange(s: Section | undefined | null): { from: string; to: string } {
  if (s?.period) return periodDefaultRange(s.period)
  return { from: rangeFrom(isSportsLabel(s?.label) ? DEFAULT_DAYS : GENERIC_DAYS), to: today() }
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
  /* How far into the takedown workflow the report reads — monitoring alone, or
     the whole engagement. The other slicer whose options the server supplies
     itself, and one that appears only for clients switched on for it in Report
     Configuration → Client mapping. The two values overlap: End to End is all
     six process stages, which is every title, so it narrows nothing. See
     go-server/handlers/monitoringscope.go. */
  monitoringScope: 'Monitoring Scope',
  /* One pirate operator, however many hostnames it runs — a site and its mirrors
     picked together. The values are folded from the hostname list rather than
     listed from a column, so the server supplies them; and it narrows the LINKING
     side only, because the host table records no linking domain. See
     go-server/handlers/piratebrand.go. */
  pirateBrand: 'Pirate Brand',
  /* The only slicer that narrows ONE PANEL rather than the page — the platform
     behind the repeat-offender ranking. See go-server/handlers/repeatoffenders.go. */
  repeatPlatform: 'Platform (Repeat Offenders)',
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
  /* The two-sided open-web split. Each is one HALF of a figure the band already
     shows whole, so each name says which half. Mirrors kpiTileLabels in
     go-server/handlers/reportlayout.go. */
  linkingIdentified: 'Total Linking Identification',
  hostIdentified:    'Total Host Identification',
  linkingDomains:    'Total Linking Domains',
  hostDomains:       'Total Host Domains',
  linkingBrands:     'Pirate Brands',
  hostBrands:        'Host Pirate Brands',
  /* The social reports' audience figure. Its pair is impactedSubscribers, which
     counts the same thing on SUSPENDED accounts only — so this is the reach that
     is out there and that one is the reach enforcement removed. */
  totalSubscribers:  'Total Subscribers',
  // Mobile apps.
  totalApps: 'Total Apps', totalCategories: 'Categories', totalDevelopers: 'Developers',
  installs: 'Total Installs', ratings: 'Total Ratings', reviews: 'Total Reviews',
  avgStars: 'Average Rating', enforced: 'Enforced',
  sourceRemoved: 'Listings Removed', infringingRemoved: 'Downloads Removed',
}

/* THE TILES CARRY NO FOOTNOTE LINE. There was a KPI_FOOT map here — a line
   under each tile's number saying what it counted ("Sites carrying it", "Views
   the infringement took", "Dropped by Google") — and it is gone from every tile
   on every platform and every report, by request.

   Where a figure genuinely needs explaining, the place for it is the ⓘ beside
   the label: it is admin-editable per panel from Report Configuration, it does
   not cost every tile a line of height, and it does not repeat a heading that
   already says the same thing one word longer. See InfoDot and `p.desc`. */

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
/* Filters the RAIL never draws.
 *
 * Two kinds, and they are here for opposite reasons. tatBucket, keyword and
 * channelUrl are set by clicking a panel and have no sensible dropdown — a list
 * of raw URLs is not a control anyone can pick from. repeatPlatform has a
 * perfectly good dropdown and is excluded because of what it NARROWS: one card
 * rather than the page, which makes the rail the wrong place for it. It is
 * drawn on the repeat-offenders card instead — see REPEAT_PLATFORM_PARAM.
 *
 * The server says the same thing in sectionSlicers; this is the fallback for an
 * older server that sends no arranged pane. */
export const PANEL_ONLY_FILTERS = new Set(['tatBucket', 'keyword', 'channelUrl', 'repeatPlatform'])

/** The repeat-offender panel's own platform filter, and the panel it belongs
 *  to. Same strings as repeatPlatformParam and dimRepeatOffender in
 *  go-server/handlers/repeatoffenders.go. */
const REPEAT_PLATFORM_PARAM = 'repeatPlatform'
const REPEAT_DIM = 'byRepeatOffender'

/*
Filters that narrow ONE PANEL rather than the scope — the server's
panelScopedParams, mirrored.

NOT the same set as PANEL_ONLY_FILTERS above, and the difference is the whole
reason both exist. That set is about having no DROPDOWN: tatBucket, keyword and
channelUrl are set by clicking a panel, and a list of raw URLs is not a control
anyone could pick from. They still narrow the entire report.

This set is about REACH. Only repeatPlatform is in it, and it is the only filter
whose change leaves every other panel answering the question it already
answered — which is what lets the report stay on screen while it runs. Reusing
the other set here would have kept a stale report up after a TAT bucket click,
showing figures for the previous filter set as though they answered the new one:
precisely the thing the loader was put there to stop.
*/
export const PANEL_SCOPED_FILTERS = new Set([REPEAT_PLATFORM_PARAM])

/**
 * The slicers the LIVE card's count is actually narrowed by.
 *
 * Three of a dozen. The card reads the raw mediascan capture tables, which
 * carry the asset and the two attributes hung off its title master; country,
 * language, quality and the rest exist only in the curated tables the report
 * below is built from.
 *
 * Named here rather than left implicit because the card now appears unfiltered
 * and states this to the reader — see realtimeScopeFilters, and realtimeDims in
 * go-server/handlers/realtime.go, which is the server's half of the same list.
 * A filter added to one and not the other is a card silently ignoring a slicer
 * the reader can see it beside.
 */
const REALTIME_COUNT_FILTERS = new Set(['assetId', 'franchiseName', 'matchDay'])

/**
 * The windows the live card offers, in hours: a day, then a day at a time to a
 * week.
 *
 * A DAY first, because that is what "live" means on this page — and because it
 * is what lets the card be drawn before the reader has filtered anything, which
 * a season-wide count could not be. A WEEK last, because that is the ceiling
 * the server enforces (realtimeLiveWindowMaxHours); an eighth day here would be
 * a control that quietly answered for seven.
 *
 * Every day in between rather than a chosen few. It was 24h / 3d / 7d, which
 * was three named spans a reader had to pick BETWEEN — and the two gaps in it
 * were the ones people actually ask about, since a fixture is not three days
 * old or seven but however many days ago it was played. As a slider the cost of
 * carrying all seven is nothing: the control is the same width and the stops
 * are evenly spaced either way, where as buttons seven of them would have been
 * a second row across a 256px column.
 *
 * Every value passes the server unchanged — rollingHoursFromRequest clamps to
 * 1…168 and does not whitelist — so nothing here needs the service to agree
 * with it beyond staying under the week.
 *
 * Module scope, so the array is one identity for the life of the page rather
 * than a new one per render. WHICH of them is selected is the card's own state,
 * because it is a property of how one person is reading one strip and not a
 * setting on the report — see the note on `hours` in RealtimeCard.
 */
const REALTIME_WINDOWS = [24, 48, 72, 96, 120, 144, 168]

/** Printed small along the bottom of every exported chart. A picture in a
    deck should say what produced it without anybody having to remember. */
const EXPORT_FOOTER = 'IP House · Reports'

/*
── Rows that name nothing ───────────────────────────────────────────────────

A breakdown row whose label is "Unknown" or "(none)" is not a finding, it is the
absence of one: the pipeline could not attribute those rows to a website, a
broadcaster or a country, and they were grouped under a placeholder. On a chart
that placeholder behaves like a category and usually the biggest one — 17.1K
"Unknown" against 2.2K for the largest real source — so it sets the axis, and
every genuine bar beside it is squashed into the first tenth of the panel.

HIDDEN FROM THE PANEL ONLY. Nothing here touches a KPI, a total or a removal
rate: those are computed server-side from the whole result set and still count
every row, attributed or not. This is a drawing rule, which is also why it is
applied where the rows reach the panel rather than anywhere upstream of it.

Two consequences worth knowing rather than discovering:

  · a "Top 10" panel can now draw nine. The server already cut the list to the
    top N before sending it, so dropping one here leaves a gap that cannot be
    back-filled without asking for more rows.
  · the panel's TABLE and its download drop them too, because they are built
    from the same rows. A chart and its own table disagreeing about what is in
    it is worse than either answer alone.

"No Logo" is deliberately NOT here. It reads like a placeholder and is not one:
on Source of Piracy it means the stream carried no broadcaster mark, which is a
real property of the capture and a real thing to enforce against.
*/
const PLACEHOLDER_ROW =
  /^(unknown|none|n\/?a|na|null|nil|undefined|unspecified|blank|empty|not\s*(available|specified|set|found)|-{1,2}|—|–|\(\s*(none|blank|empty|unknown|null)\s*\))$/i

const isPlaceholderRow = (r: any) => {
  const label = String(r?.label ?? '').trim()
  return label === '' || PLACEHOLDER_ROW.test(label)
}

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

/** The turnaround panel's key, matched by orderRows below. Spelled once —
 *  the server uses the same string (dimTAT in tatbuckets.go). */
const TAT_DIM = 'byTAT'

/*
 * The combined root-domain cards — volume, success AND the mirror count, per
 * brand. TWO of them, one per side of the enforcement: linking domains (the
 * pages that point at infringing content) and host domains (the ones serving
 * it). Same strings as dimDomainRootAll and dimDomainRootSource in
 * go-server/handlers/domainroot.go.
 *
 * They are never one card. The two sides are different populations measured on
 * different facts — a link is DE-INDEXED from search results, a host is TAKEN
 * DOWN — so adding them would sum unlike things and double-count any operator
 * appearing on both. The server pins each panel to its own column; this file
 * only has to name the second measure correctly on each.
 */
const DOMAIN_ROOT_ALL = 'byDomainRootAll'
const DOMAIN_ROOT_SOURCE = 'byDomainRootSource'
const ROOT_ALL_DIMS = new Set([DOMAIN_ROOT_ALL, DOMAIN_ROOT_SOURCE])

/** What each side calls the measure beside "Identified", what a rate over it is
 *  a rate OF, and what its rows are. The linking card counts delistings Google
 *  approved; the host card counts URLs the host actually took down. */
const ROOT_SIDE: Record<string, { name: string; rate: string; head: string }> = {
  [DOMAIN_ROOT_ALL]: {
    name: 'De-indexed', rate: 'De-indexing rate', head: 'Linking domain',
  },
  [DOMAIN_ROOT_SOURCE]: {
    name: 'Removed', rate: 'Removal rate', head: 'Host domain',
  },
}

/*
 * EVERY PANEL DRAWN ON THE COUNT SHAPE, named here and nowhere else.
 *
 * Four panels use it: the two root-domain cards and the two hosting-provider
 * cards. They share a shape and share nothing else — different rows, different
 * second measure, different counts beside it — so each one says what its own
 * columns are rather than inheriting a default.
 *
 * WRITTEN OUT RATHER THAN DERIVED, because deriving it is what went wrong. The
 * naming used to fall back to the root-domain card's when a panel did not
 * declare an extra label, so the two provider cards — which never carry that
 * label until the server publishing it is deployed — both drew "Linking domain"
 * over their rows and "De-indexed" over their orange bars. Two cards headed
 * Linking and Host, labelled identically, both wrong on one of the two. A
 * fallback that silently answers for a panel it knows nothing about is worse
 * than no answer: it cannot be seen to be wrong.
 */
const COUNT_PANELS: Record<string, {
  nameHead: string
  removedName: string
  /* `list` is the row field holding the NAMES this count is counting, where the
     server sends them. A count without one draws a gauge and no drawer, which is
     what every count did before the drawers existed — so leaving it off is the
     safe default rather than an omission. */
  counts: Array<{ key: string; name: string; list?: string }>
  /* Off for the one panel whose second bar duplicates a figure another panel
     already owns. Undefined elsewhere means "show it" — every other card's
     removal bar is the only place its number appears. */
  showRemoved?: boolean
}> = {
  [DOMAIN_ROOT_ALL]: {
    nameHead: 'Linking domain', removedName: 'Google de-indexed',
    counts: [{ key: 'mirrors', name: 'Mirror domains', list: 'mirrorDomains' }],
  },
  [DOMAIN_ROOT_SOURCE]: {
    nameHead: 'Host domain', removedName: 'Removed',
    counts: [{ key: 'mirrors', name: 'Mirror domains', list: 'mirrorDomains' }],
  },
  /* The LINKING provider card. Its second measure is de-indexing — a link is
     dropped from search results, not taken down — and the count beside it is
     how many distinct linking domains that provider carries. */
  byDelistingBatchHSP: {
    nameHead: 'Hosting provider', removedName: 'De-indexed',
    counts: [{ key: 'extra', name: 'Linking domains', list: 'extraDomains' }],
    /* De-indexing submissions per engine are already their own panel
       (dimEngineDelistingBatches) and their own day-wise trend — this card is
       the one place a reader compares providers by estate size, and a second
       bar repeating the engine-side figure only competes with the domain
       count for the same row's attention. */
    showRemoved: false,
  },
  /* The HOST provider card, which has one figure more than any other panel on
     the page: notices. A host is sent a notice and takes content down, so both
     the count of sites it carries and the count of notices it received belong
     here — and they get separate gauges, because 188 websites and 3 notices on
     one scale draws the notices as nothing. */
  byHSPNotices: {
    nameHead: 'Hosting provider', removedName: 'Removed',
    counts: [
      { key: 'extra', name: 'Host domains', list: 'extraDomains' },
      /* NO LIST on the notices gauge, and not for want of one: the rows carry
         the notice ids and a drawer of GUIDs is not something a reader can act
         on. The domains are names of things; the notices are keys. */
      { key: 'extra2', name: 'Notices' },
    ],
  },
  /* The accounts ranked by REACH — see topprofiles.go. No list on the
     subscriber gauge: it is one number per profile, not a set of names to
     expand. Status comes from the row itself (`profileStatus`), the same
     field the repeat-offender panel reads, and MirrorBars only draws that
     column where the rows carry it. */
  byTopProfiles: {
    nameHead: 'Profile', removedName: 'Removed',
    counts: [{ key: 'extra', name: 'Subscribers' }],
  },
}

/** The root-domain naming, for the two panels that still read it directly. */
const rootSide = (key: string) => ROOT_SIDE[key] ?? ROOT_SIDE[DOMAIN_ROOT_ALL]

/**
 * Rows in the order their panel should read them — and, for turnaround, in the
 * bands it is allowed to have.
 *
 * ── Turnaround ───────────────────────────────────────────────────────────
 *
 * Folded into the five fixed bands and stripped of anything that is not a
 * duration. The server does this too (go-server/handlers/tatbuckets.go) and
 * that is where it belongs — only the server can MEASURE a turnaround off two
 * timestamps rather than re-read somebody's banding of it.
 *
 * It is done again here because this panel is assembled from several platforms
 * over several code paths — measured, folded, the summary's merge of both, and
 * a Redis payload that may have been written by an older build — and one path
 * letting a "Pending" row through puts it back on the page. This is the single
 * point every one of them passes through on the way to being drawn, and doing
 * it here also fixes the exports and the table twin, which read the same rows.
 *
 * ── Everything else ──────────────────────────────────────────────────────
 *
 * Numeric collation, so "Match 2" comes before "Match 10" — the plain string
 * comparison puts 10 second, which is the classic way a fixture list ends up in
 * an order that looks deliberate and is not. Applied to the CHART and its table
 * twin together: they are two views of one panel and reordering only one of
 * them is worse than reordering neither.
 */
const orderRows = (key: string, rows: any[]) => {
  if (key === TAT_DIM) return foldTatRows(rows)
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
const emptyFilters = (): Filters => ({ clientId: '', from: rangeFrom(GENERIC_DAYS), to: today() })

/* ── Chart chrome ─────────────────────────────────────────────────────────── */

/** Legend: always present for two or more series, so identity never rests on
    colour-matching alone. Circle keys, muted text — the mark carries the hue,
    the label stays in ink. */
/* ── The tables the panels draw, as DATA ──────────────────────────────────────

   One builder per panel shape, returning head and rows rather than JSX.

   They exist because each table is now needed twice: as the twin behind a
   card's TABLE toggle, and as a sheet in the workbook the report exports. Built
   separately, those two drift inside a release — a column added to one and not
   the other, or a figure rounded one way on screen and another in Excel — and
   the export's whole claim is that it is the numbers that were on the page.

   `pickValues` rides along for the on-screen twin, where clicking a row filters
   by it. A sheet ignores it. */
export interface PanelTable {
  head: string[]
  rows: (string | number)[][]
  /** The value each row filters BY, one per row, in row order. See DataTable. */
  pickValues?: string[]
  /* Columns holding LONG TEXT rather than a figure — today, the mirror-domain
     list on the root cards.

     Every column but the first is right-aligned tabular numerals, which is right
     for the measures that made up every column but the first until now. A list of
     twelve hostnames rendered that way is unreadable AND unbounded: nothing
     truncates it, so one brand's mirrors push the table's other columns off the
     card. Named here so the on-screen twin can left-align and clip them. The
     export ignores this and writes the full string, the same way it ignores
     pickValues — a sheet has no width to run out of. */
  textCols?: number[]
}

/** Date or Month, depending on what the trend is grained by. */
const grainHead = (grain: string) => (grain === 'month' ? 'Month' : 'Date')

function trendTableData(rows: any[], first: string, second: string, grain: string): PanelTable {
  return {
    /* The rate column is named for the SERIES it divides, not "Removal rate"
       flat. On most panels `second` is Removal and it reads "Removal rate"; on
       an open-web source whose second series is delisting it is "De-Indexing",
       and `t.rate` is then a de-indexing rate. Calling that one a removal rate
       would put the wrong measure's name on a real number — the same mistake
       the De-Indexing / De-Indexed pair is kept apart to avoid. */
    head: [grainHead(grain), first, second, `${second} rate`],
    /* Numbers as NUMBERS. On screen the difference is invisible; in the
       workbook it is whether the column can be summed, sorted or charted, and
       a count that arrives as text is a count somebody has to clean before
       they can use it. The rate stays a string because it is a formatted
       percentage and Excel would read "76" as seventy-six. */
    rows: rows.map(t => [shortDate(t.label), Number(t.urls) || 0, Number(t.removed) || 0, `${t.rate}%`]),
    /* The raw label, not the printed one: the column reads "11 Aug" and the
       range needs "2026-08-11". */
    pickValues: rows.map(t => String(t.label ?? '')),
  }
}

function rateTableData(rows: any[], grain: string): PanelTable {
  return {
    head: [grainHead(grain), 'Removal rate'],
    rows: rows.map(t => [shortDate(t.label), `${t.rate}%`]),
    pickValues: rows.map(t => String(t.label ?? '')),
  }
}

/* The NAMES behind a count a card draws on its own gauge.

   Two panels' worth: `mirrorDomains` is the hostnames a brand's mirror count is
   counting (foldDomainRows), `extraDomains` the domains a hosting provider's
   domain count is (the row walk in reportsapi_bridge.go). Both are absent on
   every other panel, and absent again on a row whose count the server could not
   vouch for the list of — see applyBreakdownSets, which drops a list it cannot
   reconcile rather than showing a fragment.

   So this answers with an empty array rather than undefined, and every caller
   can ask without checking first. */
function listOf(r: any, key: string): string[] {
  const v = r?.[key]
  return Array.isArray(v) ? v.map((x: any) => String(x)).filter(Boolean) : []
}

/** The mirror list specifically — the one the two root-domain cards read. */
const mirrorList = (r: any) => listOf(r, 'mirrorDomains')

/* A count's own name, agreeing with the number in front of it.

   The gauges are named in the plural because that is what a column heading over
   ten rows is — "Mirror domains", "Host domains" — and a drawer holding one of
   them then read "1 mirror domains". Only the trailing s is touched: these names
   are all regular, and a general pluraliser for three fixed strings would be a
   library nobody asked for. */
const countNoun = (name: string, n: number) => {
  const lower = name.toLowerCase()
  return n === 1 && lower.endsWith('s') ? lower.slice(0, -1) : lower
}

/** A breakdown, in whichever of its three shapes the panel is drawing.
 *
 *  Keyed off the DIMENSION for the repeat-offender columns, not off `viz`:
 *  switching that panel to bars does not stop its rows being accounts. */
function dimTableData(key: string, label: string, viz: string, rows: any[],
                      extraLabel = ''): PanelTable {
  const pickValues = rows.map(r => String(r.label ?? ''))

  /* The third figure as a COLUMN, where the chart shows it beside the name.

     The chart has room for one number per row and the table has room for all of
     them, which is the division of labour between the two views — so this is
     where a reader who wants to sort providers by site count goes. Only for the
     panels that carry one; every other table keeps the four columns it had. */
  if (extraLabel && rows.some(r => r.extra !== undefined && r.extra !== null)) {
    const total = rows.reduce((a, x) => a + (Number(x.urls) || 0), 0)
    /* The ACCOUNT's own state, where the panel carries one. A post can come down
       while the account stays up, so this is a column of its own rather than
       anything inferable from the removal figure beside it. Only the panels that
       report it get the column; everything else keeps the five it had. */
    const status = rows.some(r => r.profileStatus)
    // Which social platform the account is on — same "only the panels that
    // carry it get the column" rule as Status, right beside it.
    const platform = rows.some(r => r.platform)
    /* WHICH domains the provider's count is counting, next to the count.

       The chart answers this by opening the gauge; this is the same list where
       it can be read all at once and, more to the point, where it leaves in the
       download. Named after the count it belongs to — "Host domains list" beside
       "Host domains" — because a provider card can carry two estates and a
       column headed plain "Domains" would not say which. */
    const lists = rows.some(r => listOf(r, 'extraDomains').length > 0)
    return {
      head: ['Name', ...(platform ? ['Platform'] : []), extraLabel,
        ...(lists ? [`${extraLabel} list`] : []),
        'Identified', 'Removed', 'Removal rate',
        ...(status ? ['Status'] : []), 'Share'],
      rows: rows.map(r => {
        const urls = Number(r.urls) || 0
        const removed = Number(r.removed) || 0
        const domains = listOf(r, 'extraDomains')
        return [String(r.label ?? '—'),
          ...(platform ? [String(r.platform ?? '—')] : []),
          /* Counted off the list wherever there is one, so the figure and the
             names behind it are read from the same array — the server already
             guarantees they agree, and this is what keeps them agreeing here. */
          domains.length || Number(r.extra) || 0,
          ...(lists ? [domains.join(', ')] : []),
          urls, removed,
          `${pct(removed, urls)}%`,
          ...(status ? [String(r.profileStatus ?? '—')] : []),
          `${pct(urls, total)}%`]
      }),
      pickValues,
      // The joined list, where there is one: shifted a column by Platform when
      // that is also showing, straight after its count either way.
      textCols: lists ? [platform ? 3 : 2] : [],
    }
  }

  if (key === 'byRepeatOffender') {
    return {
      head: ['Channel / Profile URL', 'Repeat offences', 'Identified', 'Removed',
             'Removal rate', 'Profile status'],
      rows: rows.map(r => {
        const urls = Number(r.urls) || 0
        const removed = Number(r.removed) || 0
        return [String(r.label ?? '—'), Number(r.repeats) || 0, urls, removed,
                `${pct(removed, urls)}%`,
                String(r.profileStatus ?? '').trim() || 'Not Available']
      }),
      pickValues,
    }
  }

  /* The combined root-domain cards: everything this report holds per brand, one
     card per side of the enforcement.

     Their own shape because of the MIRRORS column, which is the reason the
     cards exist — volume and mirror-domain count are orders of magnitude apart,
     so they cannot share a chart's axis, and a table is the one place they can
     sit beside each other without one of them lying about the other's scale.

     The second column is NAMED FOR THE SIDE: the linking card's is the count
     Google approved for de-indexing, the host card's is what came down. Two
     different facts, so never one heading over both. */
  if (ROOT_ALL_DIMS.has(key)) {
    const side = rootSide(key)
    const t = rows.reduce((a, x) => a + (Number(x.urls) || 0), 0)
    /* WHICH domains the mirror count is counting.

       The count on its own tells a reader their operator is running twelve
       domains and gives them no way to find out which twelve — which is the
       next question every one of them asks. The chart answers it by expanding
       a row (see MirrorBars); this is the same list where it can be read all at
       once and, more to the point, where it leaves in the download.

       Its own column rather than a line under the name, because the export is
       this table: a sheet with one cell per fact is one somebody can filter,
       and a joined string wedged into the name column is not. */
    const lists = rows.some(r => mirrorList(r).length > 0)
    return {
      head: [side.head, 'Identified', side.name, side.rate, 'Mirror domains',
        ...(lists ? ['Mirror domain list'] : []), 'Share'],
      rows: rows.map(r => {
        const urls = Number(r.urls) || 0
        const removed = Number(r.removed) || 0
        const mirrors = mirrorList(r)
        return [String(r.label ?? '—'), urls, removed, `${pct(removed, urls)}%`,
          /* The LIST's length wherever there is one, never the carried count.
             The two agree by construction — the server re-derives the count
             from the list it sends (see applyBreakdownSets) — and reading both
             off one array is what keeps a column of names beside a number that
             contradicts it impossible rather than merely unlikely. */
          mirrors.length || Number(r.mirrors) || 0,
          ...(lists ? [mirrors.join(', ')] : []),
          `${pct(urls, t)}%`]
      }),
      pickValues,
      // The joined list, where there is one: column 5, after the four figures.
      textCols: lists ? [5] : [],
    }
  }

  if (viz === 'value' || viz === 'ordinal') {
    /* Single-series panels have no removal figure to show — a bucket's rows
       have all come down by definition.

       The mirror-count card is one of these: its bars ARE the hostname count,
       so its rows carry the same list the two combined cards do and it gets the
       same column. Nothing else that lands here has one. */
    const lists = rows.some(r => mirrorList(r).length > 0)
    return {
      head: [label, 'Count', ...(lists ? ['Mirror domain list'] : [])],
      rows: rows.map(r => [String(r.label ?? '—'), Number(r.urls) || 0,
        ...(lists ? [mirrorList(r).join(', ')] : [])]),
      pickValues,
      textCols: lists ? [2] : [],
    }
  }

  const total = rows.reduce((a, x) => a + (Number(x.urls) || 0), 0)
  /* WHETHER THE HOST HAS EVER HONOURED A NOTICE — on the panels whose rows are
     host domains, and on no others.

     Carried by the server only where it means something (see
     complianceDomainPanels in go-server/handlers/domaincompliance.go), so the
     column appears exactly where a row IS a domain rather than wherever this
     generic shape happens to be drawn. A report whose warehouse could not answer
     carries no status at all and keeps the five columns it had — an absent
     column reads as a column that was not asked for, where a full one of "Not
     recorded" would read as a finding about the client's hosts. */
  const compliance = rows.some(r => r.complianceStatus)
  return {
    head: ['Name', 'Identified', 'Removed', 'Removal rate',
      ...(compliance ? ['Compliance'] : []), 'Share'],
    rows: rows.map(r => {
      const urls = Number(r.urls) || 0
      const removed = Number(r.removed) || 0
      return [String(r.label ?? '—'), urls, removed, `${pct(removed, urls)}%`,
        ...(compliance ? [String(r.complianceStatus ?? '—')] : []),
        `${pct(urls, total)}%`]
    }),
    pickValues,
    // A word, not a figure — left with the names rather than the numerals.
    textCols: compliance ? [4] : [],
  }
}

/* ── PANELS, AS SOMETHING OTHER ENGINES CAN DRAW ───────────────────────────

   Everything below this comment and above Legend turns a panel's rows into a
   ChartSpec — the engine-neutral description in lib/charts/spec.ts. The
   components further down this file remain the built-in engine and the
   fallback for every panel the others decline; these two functions are the
   translation layer for the ones they do not.

   THE COLOUR DECISIONS ARE MADE HERE, NOT IN THE ENGINE. A spec carries
   finished hex strings, so identification is navy and removal is orange
   whichever library ends up drawing them, and an adapter that guessed at a
   palette could not put them back.

   THE ARITHMETIC IS ALSO MADE HERE. The 100% split is the clearest case:
   ApexCharts, ECharts and Toast each normalise a stack differently — or not at
   all — so the shares are computed once, and every engine is handed the same
   numbers to draw rather than the same numbers to re-derive.
*/

/**
 * Which neutral form a breakdown's chart type maps to.
 *
 * Absent means "no engine draws this one". Four shapes are deliberately not in
 * here: the ranked TABLE and the repeat-offender LIST are not charts, the HEAT
 * grid is a layout as much as a mark, and the world MAP needs a projection and
 * a set of country shapes no general charting library is carrying. All four
 * keep the components in this file whichever engine is selected.
 *
 * `bars` and `hbar` land on the same form on purpose. They are the same picture
 * — a pair of horizontal bars per row — and differ today only because one was
 * built in HTML and the other in recharts. An engine has one way to draw that.
 */
const DIM_FORM: Record<string, ChartForm> = {
  bars:    'group-bar',
  hbar:    'group-bar',
  column:  'group-column',
  value:   'single-bar',
  ordinal: 'single-bar',
  stacked: 'stack-100',
  donut:   'donut',
  share:   'donut',
}

/**
 * How tall a delegated panel is drawn.
 *
 * The built-in components each work this out for themselves, from the rules
 * their own marks need — see the note on HBarChart's row height for the
 * measuring that went into one of them. An engine cannot ask those questions,
 * so the answer is given: a row-per-category shape grows with its rows, and
 * everything else is a fixed plot.
 */
function dimHeight(form: ChartForm, rows: number): number {
  const n = Math.max(1, rows)
  switch (form) {
    // Two bars and a gap per row, plus the legend under the plot.
    case 'group-bar':  return Math.min(560, Math.max(190, n * 40 + 44))
    // One bar per row, so the band can be tighter.
    case 'single-bar': return Math.min(520, Math.max(180, n * 28 + 24))
    case 'stack-100':  return Math.min(520, Math.max(190, n * 32 + 44))
    case 'donut':      return 220
    default:           return 240   // columns and dated runs
  }
}

/**
 * The trend and rate cards' own chart types, as neutral forms.
 *
 * `auto` is the trend card's default and is not a shape at all — it is a rule:
 * a dozen periods or fewer are columns, because each period is a discrete thing
 * you compare; more than that is an area, because the shape of the run is the
 * story and columns turn into a picket fence. Resolved here so every engine
 * draws the same decision.
 */
function trendForm(mode: string, points: number): ChartForm {
  if (mode === 'column') return 'group-column'
  if (mode === 'area') return 'area'
  if (mode === 'line') return 'line'
  return points <= 12 ? 'group-column' : 'area'
}

/** How long a category label may be before it is cut, by the room the form gives it. */
const LABEL_CAP: Partial<Record<ChartForm, number>> = {
  'group-column': 14,   // an axis tick, upright, under a column
  donut: 26,            // a legend row beside the ring
  line: 14,
  area: 14,
}

/**
 * One breakdown panel as a spec.
 *
 * `ordered` is the ordinal case — buckets that have a sequence, like turnaround
 * bands. They are sorted by their leading number and stepped through the
 * one-hue ramp, so the colour carries the order; identity hues would say these
 * are unrelated things.
 */
function dimSpec(form: ChartForm, rows: any[], o: {
  m: MarkTheme; dark: boolean; height: number
  limit?: number
  onPick?: (v: string) => void
  activeVal?: string
  ordered?: boolean
}): ChartSpec {
  const { m, dark } = o
  const cap = LABEL_CAP[form] ?? 24

  /* A ring folds its tail into "Other"; every other shape simply stops at the
     limit. Same rule and same cap as the built-in Donut, because the two have
     to be the same picture — a reader switching engine is checking a rendering,
     not being shown a different sixth slice. */
  if (form === 'donut') {
    const palette = o.ordered ? m.seq : m.cat
    const keep = o.ordered ? m.seq.length : CAT_LIMIT
    const all = rows.map(r => ({
      title: String(r.label ?? '—'),
      pick: String(r.value ?? r.label ?? ''),
      value: Number(r.urls) || 0,
    }))
    if (o.ordered) all.sort((a, b) => ordinalKey(a.title) - ordinalKey(b.title))
    const tail = all.slice(keep)
    const slices = tail.length > 0
      ? [...all.slice(0, keep), {
          title: `Other (${tail.length})`, pick: '',
          value: tail.reduce((a, b) => a + b.value, 0),
        }]
      : all
    return {
      form, m, dark, height: o.height,
      categories: slices.map(d => midCut(d.title, cap)),
      titles: slices.map(d => d.title),
      picks: slices.map(d => d.pick),
      // The folded tail is neutral, never the next colour in the ramp: "Other"
      // is not a category, and giving it one makes it look like one.
      sliceColors: slices.map((d, i) =>
        d.pick === '' && tail.length > 0 ? m.other : palette[i % palette.length]),
      series: [{ name: 'Identified', color: m.ident, data: slices.map(d => d.value) }],
      activeVal: o.activeVal,
      onPick: o.onPick,
    }
  }

  const picked = (o.ordered
    ? [...rows].sort((a, b) => ordinalKey(String(a.label)) - ordinalKey(String(b.label)))
    : rows
  ).slice(0, o.limit ?? 12)

  const titles = picked.map(r => String(r.label ?? '—'))
  const urls = picked.map(r => Number(r.urls) || 0)
  const removed = picked.map(r => Number(r.removed) || 0)
  const common = {
    form, m, dark, height: o.height,
    categories: titles.map(t => midCut(t, cap)),
    titles,
    // Lookup dimensions carry the id in `value` and the name in `label`: the
    // report narrows by the id, the reader reads the name.
    picks: picked.map(r => String(r.value ?? r.label ?? '')),
    activeVal: o.activeVal,
    onPick: o.onPick,
  }

  if (form === 'stack-100') {
    const share = urls.map((u, i) => pct(removed[i], u))
    return {
      ...common, suffix: '%',
      series: [
        { name: 'Removed', color: m.removed, data: share },
        { name: 'Active', color: m.identSoft, data: share.map(v => 100 - v) },
      ],
    }
  }

  if (form === 'single-bar') {
    // One measure, so nothing is competing for the colour and an ordered set can
    // spend it on the sequence instead. Labelled, because a lone bar next to a
    // number is the whole point of this shape.
    return {
      ...common, labels: true,
      sliceColors: o.ordered
        ? picked.map((_, i) => m.seq[Math.min(m.seq.length - 1, i)])
        : undefined,
      series: [{ name: 'Identified', color: m.ident, data: urls }],
    }
  }

  return {
    ...common,
    // Labels only where the marks are far enough apart to carry one. Ten
    // horizontal rows have room at the tip of each bar; a dozen column pairs
    // do not.
    labels: form === 'group-bar' && picked.length <= 10,
    series: [
      { name: 'Identified', color: m.ident, data: urls },
      { name: 'Removed', color: m.removed, data: removed },
    ],
  }
}

/**
 * A dated run — the trend card, or the rate card — as a spec.
 *
 * Three label sets, and they are three different things: the AXIS gets the
 * short form that fits a tick, the TOOLTIP gets the full date, and the CLICK
 * carries the raw key, because narrowing the report to a period is done by
 * parsing that key back into a span (see periodSpan).
 */
function trendSpec(form: ChartForm, data: any[], series: {
  key: string; name: string; color: string
}[], o: {
  m: MarkTheme; dark: boolean; height: number
  suffix?: string
  onPick?: (label: string) => void
}): ChartSpec {
  return {
    form,
    m: o.m,
    dark: o.dark,
    height: o.height,
    categories: data.map(d => shortDate(String(d.label ?? ''))),
    titles: data.map(d => shortDateFull(String(d.label ?? ''))),
    picks: data.map(d => String(d.label ?? '')),
    series: series.map(s => ({
      name: s.name, color: s.color, data: data.map(d => Number(d[s.key]) || 0),
    })),
    suffix: o.suffix,
    onPick: o.onPick,
    // A dozen periods or fewer can each carry their figure; past that the
    // labels touch and the run is read as a shape instead.
    labels: form === 'group-column' && data.length <= 12,
  }
}

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
  { key: 'stacked', label: 'Stacked 100%',    hint: 'Removed against what is still active, as a share of each row' },
  { key: 'donut',   label: 'Donut',           hint: 'Share of the total — best under six slices' },
  { key: 'share',   label: 'Donut (ordered)', hint: 'Share on a one-hue ramp, in bucket order' },
  { key: 'table',   label: 'Ranked table',    hint: 'Every row with its rate and share' },
  { key: 'heat',    label: 'Heat grid',       hint: 'Tinted tiles, ranked by volume' },
]

/** Offered only where the dimension is geographic — a map of channel names is
    not a map of anything. */
const MAP_VIZ: VizOption = { key: 'map', label: 'World map', hint: 'Countries tinted by volume' }

/** Offered only on the combined root-domain card — the one breakdown whose
    rows carry a mirror-domain count, and the reason that card exists. Listed first
    there, because it is the only shape on the menu that draws all three of its
    measures; every other one silently leaves the mirror count out. */
/* Named for the SHAPE, not for the measure that first needed it.

   It was "Volume & mirrors", because mirror domains per brand was the first
   panel to want a third figure that could not share the volume axis. The
   hosting-provider cards now use it for their distinct-website count, and a
   card headed "Hosting Providers" offering a chart type called "mirrors" reads
   as though it were counting mirrors. The shape is "two bars and a count on its
   own scale"; what the count IS belongs to the panel. */
const MIRROR_VIZ: VizOption = {
  key: 'mirror', label: 'Volume & count',
  hint: 'Found and removed as bars, with the panel\'s own count measure beside them on its own scale',
}

/** Offered only on the repeat-offenders panel — it is the one breakdown whose
    rows carry a repeat count, and on any other panel this shape has nothing to
    rank by. */
const REPEAT_VIZ: VizOption = {
  key: 'repeat', label: 'Repeat offenders',
  hint: 'Ranked by how many times each account came back after a takedown',
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

/**
 * A card's download control.
 *
 * Two things a reader wants out of a panel and cannot get from the screen: the
 * picture, to put in a deck, and the numbers, to work on. Both, behind one
 * icon, because the card header already carries a title, an ⓘ, a chart-type
 * picker and a Table toggle, and a sixth and seventh control across it would
 * cost more width than the panel has.
 *
 * The PNG is offered only where there IS a picture. A panel switched to Table
 * view, or a breakdown whose chart is a ranked list, has no chart to render —
 * and an option that produces a blank image is worse than one that is absent,
 * because the reader has to open the file to find out.
 */
function CardDownload({ bodyRef, name, table, subtitle, footer }: {
  bodyRef: React.RefObject<HTMLDivElement>
  name: string
  table?: PanelTable
  subtitle?: string
  footer?: string
}) {
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  /* Where to draw it, in VIEWPORT coordinates.

     The menu is portalled to <body>, for the reason InfoDot is: every Card on
     this page is `overflow-hidden`, so a menu positioned inside one is clipped
     at the card's edge — and on a short panel that means half of it is simply
     not there. Fixed coordinates, measured off the trigger. */
  const [at, setAt] = useState<{ right: number; top?: number; bottom?: number } | null>(null)

  useEffect(() => {
    if (!open) return
    /* Both the trigger AND the menu, because the menu is no longer inside the
       trigger's subtree — checking only `wrap` would treat a click on
       "PNG image" as a click away, unmount the menu on mousedown, and the
       click would never reach the button. */
    const away = (e: MouseEvent) => {
      const t = e.target as Node
      if (!wrap.current?.contains(t) && !menu.current?.contains(t)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // Closed rather than repositioned on a scroll. A two-item menu is not worth
    // a measure-per-frame, and a menu that has drifted off its button is worse
    // than one that has gone.
    const gone = () => setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    window.addEventListener('scroll', gone, true)
    window.addEventListener('resize', gone)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
      window.removeEventListener('scroll', gone, true)
      window.removeEventListener('resize', gone)
    }
  }, [open])

  const toggle = () => {
    setErr('')
    if (open) { setOpen(false); return }
    const r = wrap.current?.getBoundingClientRect()
    if (r) {
      /* Below the button, unless the button is near the foot of the window —
         a card at the bottom of a long report would otherwise open its menu
         off the screen. Right-aligned either way, because the trigger is. */
      const room = window.innerHeight - r.bottom
      setAt(room > 130
        ? { right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 6 }
        : { right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 6 })
    }
    setOpen(true)
  }

  const png = async () => {
    if (!bodyRef.current) return
    setBusy(true); setErr('')
    try {
      await downloadChartPng(bodyRef.current, name, {
        title: name, subtitle, footer,
        // Read at export time rather than held in state: the theme is a class
        // on <html> and nothing here subscribes to it changing.
        dark: document.documentElement.classList.contains('dark'),
      })
      setOpen(false)
    } catch (e: any) {
      setErr(e?.message || 'The image could not be produced.')
    } finally {
      setBusy(false)
    }
  }

  const xlsx = async () => {
    if (!table) return
    setBusy(true); setErr('')
    try {
      await downloadWorkbook(name, [{ name, title: name, subtitle, head: table.head, rows: table.rows }])
      setOpen(false)
    } catch (e: any) {
      setErr(e?.message || 'The workbook could not be produced.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={wrap} className="relative">
      <button type="button" onClick={toggle} aria-expanded={open} aria-haspopup="menu"
        title="Download this panel"
        className={`w-6 h-6 grid place-items-center rounded-md border transition-colors ${
          open
            ? 'border-[#FC934C] text-[#FC934C] bg-[#FC934C]/10'
            : 'border-gray-200 text-gray-400 hover:text-[#14254A] hover:border-gray-300 dark:border-white/15 dark:text-white/50 dark:hover:text-white'
        }`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" />
        </svg>
      </button>

      {open && at && createPortal(
        <div ref={menu} role="menu"
          style={{ position: 'fixed', right: at.right, top: at.top, bottom: at.bottom, zIndex: 70 }}
          className="w-44 rounded-xl border border-gray-100 bg-white
            shadow-lg2 overflow-hidden dark:border-white/10 dark:bg-[#1a2d55]">
          {/* Never disabled. What is captured is the panel BODY, whatever it
              happens to be made of — Recharts, hand-drawn SVG, the grouped bars
              that are plain HTML, or the table twin if that is what is on
              screen. There is no panel this cannot photograph, so there is no
              state in which the option should be greyed out. */}
          <button type="button" role="menuitem" onClick={png} disabled={busy}
            title="This panel as a picture, captioned with what it is of"
            className="w-full text-left px-3 py-2 text-[12px] flex items-center gap-2
              text-[#14254A] hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed
              dark:text-white dark:hover:bg-white/5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 15l-5-5L5 20" />
            </svg>
            {busy ? 'Rendering…' : 'PNG image'}
          </button>
          <button type="button" role="menuitem" onClick={xlsx} disabled={!table?.rows.length}
            title={table?.rows.length
              ? 'This panel\u2019s table, as a spreadsheet'
              : 'This panel has no rows for the window on screen'}
            className="w-full text-left px-3 py-2 text-[12px] flex items-center gap-2
              text-[#14254A] hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed
              dark:text-white dark:hover:bg-white/5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M9 3v18" />
            </svg>
            Excel (.xlsx)
          </button>
          {err && (
            <p className="px-3 py-2 text-[10.5px] leading-snug text-amber-700 border-t
              border-gray-100 dark:border-white/10 dark:text-amber-400">
              {err}
            </p>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

function Card({ title, info, chartTitle, action, table, exportTable, exportSubtitle,
  exportFooter, className = '', children }: {
  title?: string; info?: string; chartTitle?: string; action?: React.ReactNode
  table?: React.ReactNode; className?: string; children: React.ReactNode
  /** The panel's rows, for the download control — the SAME table the toggle
      above shows, so the file and the screen cannot disagree. A card with
      none still offers its picture. */
  exportTable?: PanelTable
  /** What the panel is OF — the client, the window, the filters. Printed
      into the image and into the sheet, because a chart in a deck a month
      later has no page around it to say. */
  exportSubtitle?: string
  exportFooter?: string
}) {
  const [asTable, setAsTable] = useState(false)
  /* The card's BODY, not the card. What is exported is the chart and the
     legend under it; the header is this application's chrome — a title, an
     ⓘ and two controls that do nothing in a picture. */
  const bodyRef = useRef<HTMLDivElement>(null)
  return (
    <div className={`h-full flex flex-col bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card
      border border-gray-100 dark:border-white/10 overflow-hidden ${className}`}>
      {title && (
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-white/10">
          {/* title attribute because the heading TRUNCATES. "Identification &
            Removal - Top 10 Assets" does not fit a half-width card beside three
            action buttons, and a truncated heading with no tooltip is a name the
            reader cannot recover by any means. */}
        <h3 title={title}
          className="text-[14px] font-bold text-[#14254A] dark:text-white truncate">{title}</h3>
          <InfoDot text={info} />
          {/* Three controls that do nothing in a document: whatever the panel
              offered, the chart/table toggle, and the panel's own download. */}
          <span {...{ [PRINT_HIDE_ATTR]: '' }} className="ml-auto flex items-center gap-1.5">
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
            <CardDownload bodyRef={bodyRef} name={title} table={exportTable}
              subtitle={exportSubtitle} footer={exportFooter} />
          </span>
        </div>
      )}
      <div ref={bodyRef} className="flex-1 p-4 pt-3">
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
function DataTable({ head, rows, onPick, pickValues, activeVal = '', textCols = [] }: {
  head: string[]; rows: (string | number)[][]
  /** See PanelTable.textCols — the columns that are prose, not figures. */
  textCols?: number[]
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
  // Column 0 is always prose — it is the row's name.
  const text = new Set<number>([0, ...textCols])
  return (
    <div className="overflow-x-auto max-h-[320px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-white dark:bg-[#1a2d55]">
          <tr className="text-gray-400">
            {head.map((h, i) => (
              <th key={h} className={`font-bold uppercase tracking-widest text-[9px] px-2 pb-2 ${
                text.has(i) ? 'text-left' : 'text-right'}`}>{h}</th>
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
                  text.has(j)
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
  // Same glyph as impactedSubscribers: the same audience, differently narrowed.
  totalSubscribers: 'M16 19v-2a4 4 0 0 0-8 0v2M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  impactedTraffic: 'M16 19v-2a4 4 0 0 0-8 0v2M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  views: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  viewsSaved: 'M12 21s7-4 7-9V6l-7-3-7 3v6c0 5 7 9 7 9z',                  // shield
  savedRevenue: 'M12 4v16M8 8h6a2.5 2.5 0 0 1 0 5H9a2.5 2.5 0 0 0 0 5h7',  // currency
  delisted: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM8 11h6M20 20l-4.2-4.2',
  googleDelisted: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM8 11h6M20 20l-4.2-4.2',
  bingDelisted: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM8 11h6M20 20l-4.2-4.2',
  notices: 'M3 6h18v12H3zM3 7l9 6 9-6',                                    // envelope
  crawled: 'M4 18V9M10 18V5M16 18v-6M22 18h-20',                           // bars

  /* The two-sided open-web split. The pair within each row shares a glyph —
     they are the same measure on two sides, and giving each its own icon would
     say they were different things. What tells them apart is the label. */
  linkingIdentified: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1', // chain
  hostIdentified: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',            // server
  linkingDomains: 'M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z',      // globe
  hostDomains: 'M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z',
  linkingBrands: 'M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z', // estate
  hostBrands: 'M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z',
}
const KPI_ICON_FALLBACK = 'M6 12h.01M12 12h.01M18 12h.01'

/**
 * The change on a tile, against the same-length window before this one.
 *
 * `tone` is the deliberate part. A rise is not automatically good news here:
 * more links taken down is, more links left active is not, and more links
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
function Kpi({ label, value, accent, spark, sparkData, dense, delta, icon, info }: {
  label: string; value: string; accent: string
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
     the sparkline at the bottom, with the value and its change taking the slack
     between them — so a tile with a trend and a tile without still line up,
     instead of the row with sparklines standing taller than the row below it.
     The flex-1 spacer below is what absorbs the difference, and it is why
     dropping the footnote line loosens the tiles rather than ragging the row. */
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
 * How wide the chart actually is, measured.
 *
 * Not knowable from props: the same panel is full-width on a platform page and
 * half-width in the summary, and the layout editor can make it either. Same
 * measurement SeasonColumns makes, and for the same reason — see the note on
 * `avail` there.
 *
 * useLayoutEffect rather than useEffect: the value decides how wide the marks
 * are drawn, so measuring after paint would show one frame of the wrong chart
 * and then resize it.
 */
function useChartWidth() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    setWidth(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(e => { const w = e[0]?.contentRect.width; if (w) setWidth(w) })
    ro.observe(node)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/*
── HOW WIDE A GROUPED COLUMN IS DRAWN ────────────────────────────────────────

  `maxBarSize` is the wrong tool and this is what it was doing. Recharts caps
  the MARK but keeps the SLOT: with the cap in force each bar is drawn at 24px
  centred in the slot it would otherwise have filled (ChartUtils.getBarPosition,
  the `(originalSize - size) / 2` term). Seven days across a full-width card
  gives a slot of ~118px a bar, so the two bars of one day were drawn 118px
  apart — the pair split into two lone marks with a hole between them, and the
  category gap on top of that. Fourteen isolated bars where there should be
  seven pairs, which is what "the gaps are too much" is describing.

  Given an explicit barSize recharts takes the other branch and lays the group
  out contiguously from a centred offset, so a pair is a pair. The size then has
  to come from somewhere, and the only honest source is the room the card has.

  SHARE, then CEILING — the same ordering SeasonColumns uses. The group takes a
  fixed share of its slot, so the gap between days is a constant fraction of the
  band at any width and any point count rather than whatever is left over after
  a fixed cap. The ceiling is what stops two periods in a full-width card
  becoming a pair of slabs: past roughly this width extra room stops reading as
  emphasis and starts reading as a rendering fault.
*/
/** How much of a category's slot the group of bars fills. The remaining 38% is
    the gap between one period and the next — enough to group at a glance, not
    enough to hunt across. */
const GROUP_SHARE = 0.62
/** Wide enough to carry a direct label, narrow enough that three periods do not
    become slabs. */
const MAX_COLUMN = 64
/** Below this a column stops being a mark and becomes a tick. */
const MIN_COLUMN = 6

/**
 * The bar width for one grouped-column chart.
 *
 * `avail` is the WRAPPER's width, so the axis gutter and the right margin come
 * off it first — bars sized against the whole card are consistently too wide
 * for the plot they are drawn in.
 *
 * Returns undefined while unmeasured, which leaves recharts to size the bars
 * itself for that render rather than committing to a number picked from
 * nothing.
 */
function columnWidth(avail: number, categories: number, seriesCount: number, inset: number, gap: number) {
  const plot = avail - inset
  if (plot <= 0 || categories <= 0 || seriesCount <= 0) return undefined
  const slot = plot / categories
  const group = slot * GROUP_SHARE - gap * (seriesCount - 1)
  return Math.max(MIN_COLUMN, Math.min(MAX_COLUMN, Math.floor(group / seriesCount)))
}

/**
 * Trend — identification against removal over time.
 *
 * The form follows the point count, because neither shape works at both ends:
 * a dozen periods or fewer are columns (each period is a discrete thing you
 * compare), more than that is an area (the shape of the run is the story and
 * columns turn into a picket fence). Every COLUMN is direct-labelled, both
 * series; on the area it is still the last point only, because sixty labels
 * along a line is a grey smear and there are no discrete marks to hang them on.
 */
/* Exported for .preview-trend.tsx, which renders THIS component rather than a
   copy of it — see the note on MirrorBars. */
export function Trend({ data, m, firstName = 'Identified', secondName = 'Removed', mode = 'auto',
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
  /* Above the early returns, deliberately: React identifies a hook by call
     order, and one placed after them would change that order on the render a
     range first becomes plottable. */
  const [wrapRef, avail] = useChartWidth()

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
      </div>
    )
  }

  const axis = { tickLine: false, axisLine: false, tick: { fill: m.axis, fontSize: 11 } }
  const series = [
    { key: 'urls', name: firstName, color: color ?? m.ident },
    ...(single ? [] : [{ key: 'removed', name: secondName, color: m.removed }]),
  ]

  /* EVERY column carries its figure, both series.

     It used to be the tallest column of each series and nothing else, on the
     reasoning that the axis and the tooltip carry the rest. What that actually
     produced was a chart with two numbers printed out of twenty, and the two
     that were printed looked as though they had been singled out for a reason
     rather than for being the biggest. Comparing 17 Aug with 18 Aug meant
     hovering twice.

     Both labels sit ABOVE their own bar. The old rule tucked removal's under
     the cap because two labels for one peak would otherwise collide; grouped
     bars stand side by side, so each label is already clear of the other
     horizontally and neither has to be hidden inside a mark. */
  const barLabel = (props: any) => {
    const v = Number(props.value)
    // A column with nothing in it has no bar to label — the figure would be a
    // "0" floating on the axis line, in among the date ticks.
    if (!isFinite(v) || v === 0) return null
    return (
      <text x={props.x + props.width / 2} y={props.y - 5}
        textAnchor="middle" fontSize={9} fontWeight={700}
        className="fill-[#14254A] dark:fill-white">
        {fmt(v)}
      </text>
    )
  }

  /*
    ── THE END LABELS, AND WHY ONE RENDERER DRAWS BOTH ──────────────────────

    The last value of each series, set in the right margin rather than over the
    plot — an end-label placed inside lands on top of its own line.

    Drawn together, because the two labels have to know about each other. Each
    used to be positioned at its own series' last point, which is correct right
    up until the lines CONVERGE at the right edge — and they converge exactly
    when removal is keeping pace with identification, which is the good case and
    the one a reader looks at hardest. On a 15K axis a day ending 1.9K found
    against 1.4K removed puts the two labels four pixels apart: "1.9K" and
    "1.4K" print through each other and the reader gets one smudge, which is
    worse than no label at all.

    So they are laid out as a stack: natural positions first, then anything too
    close to the label above it is pushed down to clear it, and if that pushes
    the last one past the baseline the whole stack lifts instead — a label must
    never end up in among the date ticks.

    THE Y-SCALE IS RECOVERED FROM THE POINTS THIS RENDERER IS ALREADY HANDED.
    LabelList calls it once per index, so by the time it reaches the last one it
    has seen enough (value, y) pairs to solve y = a·v + b exactly. That is worth
    a sentence because the obvious alternative — recomputing the scale from the
    axis domain and the card's own margins — hardcodes recharts' axis height and
    silently drifts the day anything about the axis changes. This cannot drift:
    it is measured off the line the chart actually drew.

    Attached to the FIRST series only. A second copy would draw the same pair
    again, over itself.
  */
  const END_GAP = 11          // the least two 10px figures can be apart and stay legible
  const END_DY = 3.5          // baseline offset that centres a 10px figure on its line
  const endSeen: Array<[number, number]> = []

  const endLabels = (props: any) => {
    const v = Number(props.value)
    if (isFinite(v) && isFinite(props.y)) endSeen.push([v, props.y])
    if (props.index !== data.length - 1) return null

    /* y = a·v + b. Any two points with DIFFERENT values determine it; a series
       that held one value all window gives none, and then every label sits at
       the y this one was handed and the stacking below separates them. */
    let a = 0
    let b = props.y
    for (let i = 1; i < endSeen.length; i++) {
      const [v0, y0] = endSeen[0]
      const [v1, y1] = endSeen[i]
      if (v1 !== v0) {
        a = (y1 - y0) / (v1 - v0)
        b = y0 - a * v0
        break
      }
    }

    const last = data[data.length - 1] ?? {}
    const marks = series.map(sr => {
      const val = Number(last[sr.key]) || 0
      return { key: sr.key, color: sr.color, val, y: a !== 0 ? a * val + b : props.y }
    }).sort((p, q) => p.y - q.y)

    // Top down, each clearing the one above it.
    for (let i = 1; i < marks.length; i++) {
      if (marks[i].y - marks[i - 1].y < END_GAP) marks[i].y = marks[i - 1].y + END_GAP
    }
    /* `b` is the y of value zero — the plot's own baseline. A stack that has
       grown past it moves up as a whole rather than letting its last figure
       hang below the axis into the date ticks.

       Measured on the BASELINE the text will actually be drawn at, END_DY below
       the mark: testing the mark itself leaves the figure hanging that far into
       the axis, which is where this sat until the rendered geometry was read
       back off the DOM rather than eyeballed. */
    if (a !== 0) {
      const over = marks[marks.length - 1].y + END_DY - b
      if (over > 0) for (const mk of marks) mk.y -= over
    }

    return (
      <g>
        {marks.map(mk => (
          /* In the SERIES' OWN COLOUR, not the ink the other figures use. A
             label that has been nudged off its line is no longer identified by
             where it sits, so it has to be identified by what it looks like. */
          <text key={mk.key} x={props.x + 7} y={mk.y + END_DY} textAnchor="start"
            fontSize={10} fontWeight={700} fill={mk.color}>
            {fmt(mk.val)}
          </text>
        ))}
      </g>
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
      <div ref={wrapRef} style={{ height: 168, cursor: onPick ? 'pointer' : undefined }}>
        <ResponsiveContainer width="100%" height="100%">
          {(mode === 'column' || (mode === 'auto' && data.length <= 12)) ? (
            /* Columns: sized from the room the card actually has, 2px apart
               within a period — see columnWidth for why this is a width and not
               a maxBarSize. The 54 is the axis gutter (46) plus the right
               margin (8), which is card width the plot never gets. */
            <BarChart data={data} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barGap={2}
              {...clickable}>
              <CartesianGrid vertical={false} stroke={m.grid} />
              <XAxis dataKey="label" {...axis} tickFormatter={shortDate} />
              <YAxis {...yAxis} />
              <Tooltip cursor={{ fill: m.grid, fillOpacity: 0.5 }} content={<ChartTip />} />
              {series.map(s => (
                <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color}
                  barSize={columnWidth(avail, data.length, series.length, 54, 2)}
                  radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  <LabelList dataKey={s.key} content={barLabel} />
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
                  {/* Both end labels come off this one list — see endLabels. */}
                  {s.key === series[0].key && <LabelList dataKey={s.key} content={endLabels} />}
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
  // Above the early return, for the reason given on the same hook in Trend.
  const [wrapRef, avail] = useChartWidth()

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
  /* Every column, on the column shape — which carried no direct labels at all,
     so a reader who switched to it from the line lost the one figure the line
     was printing.

     Zero IS drawn here, unlike the volume trend beside it. A removal rate of
     nothing is a reading rather than an absence: the period had links found and
     none taken down, and that is the period a reader most wants named. */
  const colLabel = (props: any) => {
    const v = Number(props.value)
    if (!isFinite(v)) return null
    return (
      <text x={props.x + props.width / 2} y={props.y - 5}
        textAnchor="middle" fontSize={9} fontWeight={700}
        className="fill-[#14254A] dark:fill-white">
        {v}%
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
    <div ref={wrapRef} style={{ height: 200, cursor: onPick ? 'pointer' : undefined }}>
      <ResponsiveContainer width="100%" height="100%">
        {mode === 'column' ? (
          <BarChart data={data} margin={margin} {...clickable}>
            {frame}
            {/* One series, so the group IS the bar — but the sparse-card
                problem is the trend's exactly, and a reader switching between
                the two cards should not find one dense and one strung out. 48
                is this chart's axis gutter (40) plus its column-mode right
                margin (8). */}
            <Bar dataKey="rate" name="Removal rate" fill={m.removed}
              barSize={columnWidth(avail, data.length, 1, 48, 0)}
              radius={[4, 4, 0, 0]} isAnimationActive={false}>
              <LabelList dataKey="rate" content={colLabel} />
            </Bar>
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
  if (ordered) all.sort((a, b) => ordinalKey(a.name) - ordinalKey(b.name))

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
 * 100% stacked bars — removed against what is still active, as a share of each
 * row, so
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
        { label: 'Active', color: m.identSoft },
      ]} />
    </>
  )
}

/**
 * Single-series bars.
 *
 * For a dimension where there is no second measure to draw: channels suspended
 * per platform, or the count that landed in each turnaround bucket — a bucket's
 * rows have all been removed by definition, so "removed vs active" is a bar
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
    ? [...rows].sort((a, b) => ordinalKey(String(a.label)) - ordinalKey(String(b.label)))
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
function RankTable({ rows, onPick, activeVal = '', limit = 12, mirrors = false,
  nameHead = 'Name', removedHead }: {
  rows: any[]; onPick?: (v: string) => void; activeVal?: string; limit?: number
  /** Show the distinct mirror-domain count beside the volume. The root-domain rows
      have always carried it; only the combined cards ask for it, because on the
      other two it would repeat a figure the panel is already plotting. */
  mirrors?: boolean
  nameHead?: string
  /** What this panel's second measure IS, where it is not plain removal — the
      linking card counts delistings Google approved. Named rather than assumed:
      the column holds whichever measure the server resolved, and a fixed
      "Removed" over a de-indexing count is the one mislabel it invites. */
  removedHead?: string
}) {
  const data = rows.slice(0, limit)
  const total = data.reduce((a, r) => a + (Number(r.urls) || 0), 0)
  if (data.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>
  const took = removedHead || 'Removed'
  const rate = removedHead ? removedHead + ' rate' : 'Removal rate'
  const head = mirrors
    ? ['#', nameHead, 'Identified', took, rate, 'Mirror domains', 'Share']
    : ['#', nameHead, 'Identified', took, rate, 'Share']
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400">
            {head.map((h, i) => (
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
                {mirrors && (() => {
                  /* The operator's footprint, not their volume. Set in the ink
                     the figures use rather than the muted grey of the two
                     percentages beside it — it is a COUNT, and reading it as a
                     rate is the one mistake this column invites. */
                  const list = mirrorList(r)
                  return (
                    /* THE NAMES ARE ON THE CELL. This shape is what a panel
                       configured as a ranked table draws INSTEAD of the TABLE
                       twin, so the drawer on the bar card and the list column in
                       that twin are both out of reach here — the tooltip is the
                       one place left to put them, and a count nothing can be
                       checked against is what the list exists to end.

                       Counted off the list wherever there is one, so the figure
                       and the names behind it are read from the same array. */
                    <td title={list.length ? list.join(', ') : undefined}
                      className={`px-1.5 py-1.5 text-right font-bold tabular-nums text-[#14254A] dark:text-white ${
                        list.length ? 'cursor-help underline decoration-dotted underline-offset-4' : ''}`}>
                      {full(list.length || Number(r.mirrors) || 0)}
                    </td>
                  )
                })()}
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
 * One bar per measure, on the volume scale. The figure sits at the tip rather
 * than inside, so a short bar still carries its number.
 */
function VolumeBar({ v, max, color }: { v: number; max: number; color: string }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="h-2.5 rounded-r-[3px]"
        style={{ width: `${Math.max(0.4, (v / max) * 100)}%`, minWidth: 2, background: color }} />
      <span className="text-[10px] font-bold tabular-nums text-[#14254A] dark:text-white whitespace-nowrap">
        {fmt(v, v >= 1000 ? 1 : 0)}
      </span>
    </span>
  )
}

/*
── THE COMBINED ROOT-DOMAIN CARD, AS A CHART ─────────────────────────────────

   Three measures per brand, and the third is nowhere near the other two: a
   brand with 1,900 identified URLs is running perhaps a dozen mirror domains. As a
   third bar on the volume axis that dozen is a third of a pixel — which is why
   this card shipped as a table, and why the chart beside it drew two of its
   three figures and silently dropped the one the card exists for.

   The fix is not a second y-axis. Two axes in one plot are aligned by nothing,
   so every crossing a reader sees is an artefact of where the scales were
   pinned. What the two halves share here is the BRAND ROWS, not a number line:
   volume bars on the left against the largest volume, a mirror gauge on the
   right against the largest mirror count, and a row you read across without
   being invited to compare a length here with a length there.

   Three things keep the two scales from reading as one. The mirror column has
   its own heading, in domains. Its mark is a gauge in a well, and nothing
   else on the card is drawn in a well, so nothing else reads as a share of its
   own column's maximum. And its exact count is printed on every row, which is
   the figure a reader actually takes away.

   Built in this file, like the ranked table, the repeat list, the heat grid and
   the map — the shapes no engine is offered, because a general charting library
   has no way to put two scales side by side except by putting them in one plot.
*/
/* Exported for .preview-rootcard.tsx, which renders THIS component rather than
   a copy of its markup. A preview that reimplements the thing it previews
   agrees with the page exactly once — on the day it is written. */
export function MirrorBars({ rows, m, onPick, activeVal = '', limit = 10,
  removedName = 'Removed', nameHead = 'Root domain', showRemoved = true,
  counts = [{ key: 'mirrors', name: 'Mirror domains', list: 'mirrorDomains' }] }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string; limit?: number
  /** What the rows ARE. The same words the TABLE toggle uses, so switching
      between the two views of one card does not rename its rows. */
  nameHead?: string
  /** Off for a card whose removal figure belongs to another panel — see
      COUNT_PANELS. The row keeps only its identified bar; the count gauges
      beside it are unaffected. */
  showRemoved?: boolean
  /* WHICH KEY HOLDS THE THIRD FIGURE, and what it is called.

     This shape — two volume bars and a small count on its own gauge — was built
     for mirror domains per brand, and it turns out to be the answer to a second
     question the report was failing to draw: how many distinct websites each
     hosting provider carries. The panels already had the number (APIExtra
     "totalDomains"), and the hbar shape they were drawn as had nowhere to put
     it, so it lived in the `<title>` of an axis tick where nobody would find it.

     The key is a parameter rather than a second component because the reason
     the count needs its own scale is identical in both cases: 9.9K URLs beside
     19 websites cannot share an axis, and a third bar would be a third of a
     pixel. One shape, two callers, one rule about scales. */
  counts?: Array<{ key: string; name: string; list?: string }>
  /** What the second bar counts on this card. The linking side's is the count
      Google approved for de-indexing, the host side's is what came down — two
      different facts about two different tables, and the legend has to say
      which one the reader is looking at. */
  removedName?: string
}) {
  const data = rows.slice(0, limit).map(r => ({
    label: String(r.label ?? '—'),
    val: String(r.value ?? r.label ?? ''),
    urls: Number(r.urls) || 0,
    removed: Number(r.removed) || 0,
    /* The account's OWN state, as against what was found on it — see
       topProfileStatusLabel in go-server/handlers/topprofiles.go, which is
       THREE words ('Suspended' / 'Active' / 'Not Available'), unlike the two the
       repeat-offender panel prints from its own profileStatusLabel. Empty on
       every card that isn't ranking profiles, which is what `hasStatus` reads. */
    status: String(r.profileStatus ?? '').trim(),
    /* Which social platform the account is on — YouTube, Facebook, a
       third-party feed. Empty on a single-brand table (nothing to
       disambiguate) or a card that isn't ranking profiles, which is what
       `hasPlatform` reads — same "absence over a well of nothing" rule the
       status column follows. */
    platform: String(r.platform ?? '').trim(),
    counts: counts.map(c => Number(r[c.key]) || 0),
    /* The NAMES behind each count, where that count has any — the brand's mirror
       hostnames, the provider's domains. Empty for a count whose caller declared
       no list field, and empty again where the server dropped a list it could
       not reconcile against the count, so the expander below appears exactly
       where there is something whole to expand. */
    lists: counts.map(c => (c.list ? listOf(r, c.list) : [])),
  }))
  if (data.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>

  // Dropped, column and all, on a card whose rows carry no such field — the
  // same "absence over a well of nothing" rule `showMirrors` applies below.
  const hasStatus = data.some(d => d.status !== '')
  const hasPlatform = data.some(d => d.platform !== '')
  const maxVol = Math.max(1, ...data.map(d => showRemoved ? Math.max(d.urls, d.removed) : d.urls))
  /* One scale PER COUNT, not one shared between them.

     The host card carries distinct websites and notices sent, and those are no
     more comparable with each other than either is with the URL volume — 188
     websites beside 3 notices on one gauge draws the notices as nothing. Each
     count is read down its own column against its own top. */
  const tops = counts.map((_, i) => Math.max(0, ...data.map(d => d.counts[i])))
  /* A count nothing in this window has is dropped, column and all. An empty
     well reads as a column that failed rather than as a measure the data does
     not carry, and a caption explaining the absence is noise on a card whose
     other figures are fine. */
  const shown = counts.map((c, i) => ({ ...c, i })).filter(c => tops[c.i] > 0)
  const showMirrors = shown.length > 0
  /* A hue per count, starting at the palette's third — the first that is
     neither of the two series drawn beside it. Two counts on one card must not
     share a colour, or the legend names two things the eye reads as one. */
  const countInk = (i: number) => m.cat[(i + 2) % Math.max(1, m.cat.length)] || m.removed
  const hasActive = !!activeVal
  /* The mirror track is a FRACTION of the volume track, never a fixed width.

     Sized at half, and that is a correctness rule rather than a taste: with the
     mirror column fixed, a narrow card squeezed the elastic volume column below
     it and the gauge came out LONGER than the bars beside it — the small
     measure drawn as the big one, which is the exact misreading the separate
     scale exists to prevent. As a fraction the two shrink together and the
     ordering holds at every width. */
  /* Wide enough for "NOT AVAILABLE", the longest of the three words this
     column ever prints — 64px fit "SUSPENDED" but clipped the unknown case. */
  const cols = ['128px', ...(hasStatus ? ['92px'] : []), 'minmax(0,2fr)',
    ...shown.map(() => 'minmax(0,1fr)')].join(' ')

  /* ONE drawer open at a time, keyed by the row's VALUE and the COLUMN it was
     opened from.

     By value rather than index so the drawer follows its row when the ranking
     moves under it: a poll that lifts owledge from third to second must not
     leave owledge's domains sitting open beneath whatever is third now. A row
     that drops out of the top ten closes, which is the right answer — its list
     is no longer on the card.

     And by column because the host provider card has two gauges. Keyed on the
     row alone, clicking its domain count would have re-opened whatever was last
     shown for that provider. */
  const [openRow, setOpenRow] = useState('')
  const drawerKey = (val: string, countKey: string) => `${val}\u0000${countKey}`

  return (
    <div className="py-1">
      {/* The headings do the work a legend cannot: they say which column is
          counted in URLs and which in domains BEFORE a single bar is read. */}
      <div className="grid items-end gap-3 px-1.5 pb-1.5 text-[9px] font-bold uppercase tracking-widest text-gray-400"
        style={{ gridTemplateColumns: cols }}>
        <span>{nameHead}</span>
        {hasStatus && <span>Status</span>}
        <span>{showRemoved ? `Identified / ${removedName}` : 'Identified'}</span>
        {shown.map(c => <span key={c.key} className="text-right">{c.name}</span>)}
      </div>

      <div className="flex flex-col gap-1">
        {data.map((d, i) => {
          const isActive = activeVal === d.val || activeVal === d.label
          // Which of this row's gauges is open, if any.
          const openCount = shown.find(c => openRow === drawerKey(d.val, c.key))
          const rowTitle = `${d.label}${d.platform ? ` (${d.platform})` : ''}: ${full(d.urls)} identified${
            showRemoved ? `, ${full(d.removed)} ${removedName.toLowerCase()}` : ''}${
            hasStatus ? `, profile ${d.status.toLowerCase()}` : ''}${
            shown.map(c => `, ${full(d.counts[c.i])} ${c.name.toLowerCase()}`).join('')}`
          return (
            <div key={d.val + i}>
              {/* THREE CONTROLS IN THE ROW, not one.

                  It was a single button wrapping the whole row, which is the
                  right shape while the row does one thing. It does two now: the
                  name and the bars narrow the report to this brand, and the
                  mirror count opens the list of domains behind it. A button
                  inside a button is not markup a browser will render, and a div
                  with an onClick would take the keyboard away from an action
                  that had it — so the row is a plain grid and each of its cells
                  is its own control. The row highlight moved here with them. */}
              <div className={`grid items-center gap-3 rounded-md px-1.5 py-1 text-left transition-all ${
                onPick ? 'hover:bg-[#14254A]/[0.04] dark:hover:bg-white/5' : ''} ${
                isActive ? 'bg-[#14254A]/[0.05] ring-1 ring-[#14254A]/30 dark:bg-white/5 dark:ring-white/20' : ''} ${
                hasActive && !isActive ? 'opacity-40' : ''}`}
                style={{ gridTemplateColumns: cols }}>
                <button type="button" disabled={!onPick} onClick={() => onPick?.(d.val)}
                  title={rowTitle}
                  className="min-w-0 text-left disabled:cursor-default">
                  <span className="block text-xs text-gray-600 dark:text-gray-300 truncate">
                    {d.label}
                  </span>
                  {/* THE PLATFORM, under the name rather than beside it — the
                      name is already a shortening of a URL and has no room to
                      share a line with a second fact. Muted: it identifies the
                      row, it does not rank it, and colouring it like a measure
                      would draw the eye to a fourth thing on a card about two. */}
                  {hasPlatform && d.platform && (
                    <span className="block text-[9px] text-gray-400 dark:text-white/40 truncate">
                      {d.platform}
                    </span>
                  )}
                </button>
                {/* THE ACCOUNT'S OWN STATE, beside its name — three colours, not
                    two, unlike the repeat-offender panel's badge. That one folds
                    Active and "never told" together on purpose (profileStatusLabel);
                    this panel ranks by reach, where a reader comparing two accounts
                    with the same audience wants to know whether one is CONFIRMED
                    live and the other simply unmeasured — see topProfileStatusLabel
                    (go-server/handlers/topprofiles.go). "Not Available" stays muted,
                    same reasoning as the fold it replaces and the same words the
                    repeat-offender panel uses for its own unknown case: it is not a
                    live status and must not be coloured like one. */}
                {hasStatus && (
                  <span title={rowTitle}
                    className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded text-center
                      whitespace-nowrap justify-self-start ${
                      d.status === 'Suspended' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                      : d.status === 'Active' ? 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300'
                      : 'bg-gray-100 text-gray-400 dark:bg-white/5 dark:text-white/40'}`}>
                    {d.status === 'Suspended' ? 'Suspended' : d.status === 'Active' ? 'Active' : 'Not Available'}
                  </span>
                )}
                <button type="button" disabled={!onPick} onClick={() => onPick?.(d.val)}
                  title={rowTitle}
                  className="flex flex-col gap-1 min-w-0 disabled:cursor-default">
                  <VolumeBar v={d.urls} max={maxVol} color={m.ident} />
                  {showRemoved && <VolumeBar v={d.removed} max={maxVol} color={m.removed} />}
                </button>
                {shown.map(c => {
                  const open = openRow === drawerKey(d.val, c.key)
                  const gauge = (
                    <>
                      {/* Capped, so a full-width card does not spend 400 pixels
                          drawing a count of nine. Past the cap the column's slack
                          turns into distance between the scales, which is the
                          better use for it. */}
                      <span className="relative h-2.5 flex-1 rounded-full overflow-hidden"
                        style={{ background: m.grid, maxWidth: 180 }}>
                        {/* A floor of 4% so a row with ONE still shows a mark. Zero
                            gets nothing: an empty well and a printed 0 is the honest
                            picture of a row this measure found none for. */}
                        <span className="absolute inset-y-0 left-0 rounded-full"
                          style={{
                            width: d.counts[c.i] > 0
                              ? `${Math.max(4, (d.counts[c.i] / tops[c.i]) * 100)}%` : 0,
                            background: countInk(c.i),
                          }} />
                      </span>
                      <span className="text-[10px] font-bold tabular-nums text-[#14254A] dark:text-white w-8 text-right">
                        {full(d.counts[c.i])}
                      </span>
                    </>
                  )
                  /* A gauge opens on whatever list came with it, complete or
                     not — see reconciledList in enforcementactions.go, which
                     now hands back a short list as a lower bound rather than
                     withholding it. Silent only for a count that never
                     carries names at all (Notices — no `list` declared), and
                     for the rarer case where the row-scan cap fell before it
                     reached even one of this group's rows. */
                  const list = d.lists[c.i]
                  const partial = list.length > 0 && list.length < d.counts[c.i]
                  if (list.length === 0) {
                    const why = c.list && d.counts[c.i] > 0
                      ? 'The list behind this count could not be shown for this window — see "Worth knowing about this run" above.'
                      : undefined
                    return (
                      <span key={c.key} title={why} className="flex items-center gap-2 justify-end">{gauge}</span>
                    )
                  }
                  return (
                    <button key={c.key} type="button" aria-expanded={open}
                      onClick={() => setOpenRow(open ? '' : drawerKey(d.val, c.key))}
                      title={open ? `Hide the ${countNoun(c.name, list.length)} behind this count`
                        : partial
                          ? `Show the ${full(list.length)} ${countNoun(c.name, list.length)} this window's row scan found — a lower bound, not the full ${full(d.counts[c.i])}`
                          : `Show the ${full(list.length)} ${countNoun(c.name, list.length)} behind this count`}
                      className="flex items-center gap-2 justify-end">
                      {gauge}
                      <svg viewBox="0 0 10 6" width="8" height="5" aria-hidden="true"
                        className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
                        style={{ fill: 'none', stroke: m.axis, strokeWidth: 1.6 }}>
                        <path d="M1 1l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )
                })}
              </div>
              {/* THE LIST ITSELF.

                  Under the row rather than in a popover. A popover is the shape
                  for something you glance at and dismiss; this is a list somebody
                  is going to read down and copy out, and a block that pushes the
                  rows below it apart is the one that can be selected.

                  Every name in full. This drawer exists because the count on its
                  own was not enough, so truncating its answer would put the
                  reader back where they started. */}
              {openCount && (() => {
                const shownLen = d.lists[openCount.i].length
                const total = d.counts[openCount.i]
                const short = total > shownLen
                return (
                  <div className="mt-0.5 mb-1.5 ml-1.5 rounded-md px-3 py-2"
                    style={{ background: m.grid }}>
                    {/* Named for the GAUGE it was opened from, not for domains in
                        general: "17 host domains" and "29 linking domains" are two
                        different estates, and a provider card can show both.

                        "At least" only where the row-scan cap made this list
                        shorter than the gauge's own exact count — see
                        reconciledList. Plain otherwise: most windows are not
                        capped, and hedging a complete list would train a reader
                        to doubt every drawer on the page. */}
                    <div className="text-[9px] font-bold uppercase tracking-widest text-gray-400 pb-1.5">
                      {short ? `At least ${full(shownLen)} of ${full(total)}` : full(shownLen)}{' '}
                      {countNoun(openCount.name, total)} · {d.label}
                    </div>
                    <ul className="flex flex-wrap gap-x-4 gap-y-1">
                      {d.lists[openCount.i].map(h => (
                        <li key={h} className="text-[11px] text-gray-600 dark:text-gray-300 break-all">{h}</li>
                      ))}
                    </ul>
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>

      <Legend items={[
        { label: 'Identified', color: m.ident },
        { label: removedName, color: m.removed },
        // The scale is named in the legend as well as over the column: this is
        // the one entry a reader must not take as another bar on the left.
        ...shown.map(c => ({ label: c.name, color: countInk(c.i) })),
      ]} />
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
/* Exported for .preview-rootcard.tsx, for the same reason MirrorBars is: the
   preview renders THIS component rather than a copy of its markup, and a copy
   agrees with the page exactly once — on the day it is written. */
export function HBarChart({ rows, m, onPick, activeVal = '', limit = 10, extraLabel = '' }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string; limit?: number
  /* What a THIRD figure on each row is called, where the panel carries one —
     "Websites" on the two hosting-provider panels. Empty everywhere else, which
     is every panel that has only the two bars. */
  extraLabel?: string
}) {
  const data = rows.slice(0, limit).map(r => ({
    label: String(r.label ?? '—'),
    value_: String(r.value ?? r.label ?? ''),
    urls: Number(r.urls) || 0,
    removed: Number(r.removed) || 0,
    extra: r.extra === undefined || r.extra === null ? null : Number(r.extra),
    /* Whether this host has ever honoured a notice. Only the host-domain panels
       carry one — see domaincompliance.go — and '' everywhere else, which draws
       nothing at all rather than a second tick line saying "—". */
    status: String(r.complianceStatus ?? '').trim(),
  }))
  if (data.length === 0) return <div className="text-sm text-gray-400 py-3">No data.</div>

  const axis = { tickLine: false, axisLine: false, tick: { fill: m.axis, fontSize: 11 } }
  /*
    ── ROW HEIGHT, AND WHY IT IS 46 ────────────────────────────────────────

    Each row holds BOTH bars, the gap between them, and the gap separating it
    from the next category. Sized from the LABELS rather than the bars, because
    the labels are taller than the marks they sit on.

    Recharts centres a value label on its bar, so two labels in a pair sit
    exactly maxBarSize + barGap apart. At the old barGap of 2 that is 12px, and
    the label text box is bigger than that: drawing the real rows from a live
    report at those positions and measuring the boxes gave FIVE overlapping
    pairs, with the tightest at MINUS two pixels. "739 / 644" was not reading as
    a smudge, it was genuinely overlapping.

    Measured alternatives, same rows, same font:

        band  gap   overlaps  clearance  bar slack  height
          38    2       5        -2px       3px      404   ← was
          46    6       0        +2px       4px      484
          50    8       0        +4px       5px      524   ← is
          52   10       0        +6px       4px      544

    50/8 rather than 52/10 because barGap has to stay clearly under the gap
    BETWEEN categories or the grouping disappears — at band 50 that gap is 17px,
    so a pair gap of 8 reads as half of it, while 10 is close enough to make the
    ten rows one striped block.

    The bar slack column matters as much as the clearance: barCategoryGap 34%
    leaves 66% of the band for bars, and a pair that does not fit is not an
    error — recharts silently shrinks the bars instead.
  */
  const height = Math.max(180, data.length * 50 + 24)
  const hasActive = !!activeVal

  /* Ticks are drawn one to a line and truncated, never wrapped.
     Recharts wraps a category label that does not fit its axis width, which
     turns a long asset title into two lines inside a band sized for one — and
     two of those in a row collide. The full title stays reachable: it is on the
     tick as a tooltip, in the chart's own tooltip, and in the table view. */
  /* The third figure, by the row it belongs to.

     On the TICK rather than as a third bar, and that is a reading of the data
     rather than a shortcut: a provider with 29 sites and 27,057 identifications
     puts the two three orders of magnitude apart, so a third bar is either
     invisible or forces a log scale onto a panel whose other two bars are read
     by length. The count is a fact about the provider; the bars are the
     comparison. Kept as a number beside the name, where a reader ranking
     providers can see it without a second card. */
  const extraBy = new Map(data.map(d => [d.label, d.extra]))
  const hasExtra = !!extraLabel && data.some(d => d.extra !== null)
  /* The compliance word, by the row it belongs to.

     ON A SECOND LINE UNDER THE NAME, not appended to it. "Non-Compliant" is
     thirteen characters and the axis is 172px wide — appended, it either pushes
     the domain down to a stub or overruns the plot, and the domain is the part
     being read. Under it there is room for both at full length, and the 50px
     band each row already has (see the note on height above) holds two lines of
     text without touching its neighbour.

     NO COLOUR CODE. Every other mark on this page is navy for identification and
     orange for removal, and minting a third meaning for one of those hues here
     would have the same colour saying two things on one card. The word is the
     signal; weight is what makes the one worth acting on findable. */
  const statusBy = new Map(data.map(d => [d.label, d.status]))
  const hasStatus = data.some(d => !!d.status)

  const Tick = ({ x, y, payload }: any) => {
    const full = String(payload?.value ?? '')
    const n = extraBy.get(full)
    const status = statusBy.get(full) || ''
    // Shorter truncation where a figure follows it, so the two never collide in
    // the fixed 172px the axis is given.
    const cap = hasExtra && n !== null && n !== undefined ? 20 : 26
    const short = full.length > cap ? full.slice(0, cap) + '…' : full
    const suffix = hasExtra && n !== null && n !== undefined ? `  ${axisNum(n)}` : ''
    // Lifted by the height of the line that follows, so the PAIR stays centred
    // on the band rather than the name sitting where the pair should be.
    const dy = hasStatus ? -1 : 4
    return (
      <text x={x} y={y} dy={dy} textAnchor="end" fill={m.axis} fontSize={11}>
        <title>{[full,
          suffix ? `${axisNum(n as number)} ${extraLabel.toLowerCase()}` : '',
          status].filter(Boolean).join(' — ')}</title>
        {short}
        {suffix && <tspan fontWeight={700} fill={m.ident}>{suffix}</tspan>}
        {hasStatus && (
          <tspan x={x} dy={12} fontSize={9}
            fontWeight={status === 'Non-Compliant' ? 700 : 400}>
            {status || '—'}
          </tspan>
        )}
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
        <BarChart data={data} layout="vertical" barGap={8} barCategoryGap="34%"
          /*
            right 52: the widest value label this formatter produces is 33px
            ("123.4K", "999.9K", measured in Poppins 700 10px) plus the 5px the
            label sits off the bar tip — so 38 is the floor and the rest is slack
            for a longer format. A label that does not fit is not clipped by
            recharts, it is drawn over the card's edge.

            left 6: a bar of value ZERO has no width, so its label is drawn at
            the plot's left edge — hard against the category name beside it.
            Rows like "owledge  0" and "ninguno  0" are exactly that. Six pixels
            is what separates the number from the name it is not part of.
          */
          margin={{ top: 4, right: 52, left: 6, bottom: 0 }}
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
            {/* Removal carries its figure too. One labelled series above an
                unlabelled one reads as the second having no value rather than as
                a chart that only prints half of what it draws — and removal is
                the half the page is about. */}
            <LabelList dataKey="removed" position="right" formatter={(v: any) => axisNum(Number(v))}
              style={{ fill: m.axis, fontSize: 10, fontWeight: 700 }} />
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

  /*
    ── WHETHER THE COLUMNS CAN CARRY THEIR VALUES ──────────────────────────

    A label here sits ABOVE its column and is centred on it, so two labels in a
    pair collide horizontally once their half-widths meet. The available room is
    barSize + barGap, centre to centre.

    Measured (Poppins 700 10px, the style below) against real report values:

        columns  centre gap   "1.6K/1K"  "12.3K/9.8K"  "123.4K/99.9K"
          22px      24px          ok          ok        overlaps  6px
          12px      14px     overlaps 1px  overlaps 10px  overlaps 16px

    So the narrow variant could not carry them at all, and the wide one failed
    on six-character values — printed anyway, they overlapped into an unreadable
    smear where the exact figures matter most.

    A 12px column cannot be widened enough to fit two numbers without the gap
    inside a pair exceeding the gap between pairs, which is the one thing that
    must not happen — the grouping is the chart. So the labels are drawn only
    when they FIT, and the values stay reachable through the tooltip and the
    TABLE toggle on the card, the same relief the truncated axis labels use.

    Widths are MEASURED, not estimated per character. The first version of this
    used an average of 5.6px per character and got it wrong in the one direction
    that matters: plain digits are 7px in this face while "." and "K" are much
    narrower, so "445" came out as 17px against a real 21px — and a pair that
    overlapped was labelled anyway. An estimate for a rule about overlapping is
    the wrong tool when the exact answer costs one canvas call.
  */
  const columnGap = 6
  const roomForLabels = data.every(d =>
    textPx(axisNum(d.urls)) / 2 + textPx(axisNum(d.removed)) / 2 <= barSize + columnGap)

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
          <BarChart data={data} barGap={columnGap}
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
              {roomForLabels && (
                <LabelList dataKey="urls" position="top" formatter={(v: any) => axisNum(Number(v))}
                  style={{ fill: m.axis, fontSize: 10, fontWeight: 700 }} />
              )}
              {data.map(d => <Cell key={d.value_} opacity={dim(d)} />)}
            </Bar>
            <Bar dataKey="removed" name="Removed" fill={m.removed} radius={[4, 4, 0, 0]}
              barSize={barSize} isAnimationActive={false} cursor={onPick ? 'pointer' : 'default'} onClick={pickFrom}>
              {/* Both columns of a pair or neither — see roomForLabels. One
                  labelled column beside an unlabelled one reads as the second
                  having no value, which is the reason HBarChart labels both. */}
              {roomForLabels && (
                <LabelList dataKey="removed" position="top" formatter={(v: any) => axisNum(Number(v))}
                  style={{ fill: m.axis, fontSize: 10, fontWeight: 700 }} />
              )}
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
 *   EVERY COLUMN CARRIES ITS FIGURE, and the SLOT is what makes that legible.
 *   This drew one label — the busiest category — on the grounds that seventy
 *   values is chaos. True of seventy values crammed into a card; not true here,
 *   because this chart already scrolls rather than compressing. So the floor on
 *   a category's slot now reserves room for a pair of numbers, and a set too
 *   wide to fit gets a longer scroller instead of fewer labels. Printing two
 *   figures out of a hundred and forty is the worse failure: it reads as those
 *   two having been singled out, and every other column as having no value.
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
  /* Room for a pair of direct labels, which is now the binding constraint on a
     dense set: at eight pixels a column the marks would fit in 28px and the two
     figures above them would overlap. `axisNum` compacts to four characters at
     the worst ("3.5K"), so ~24px each is enough at fontSize 9. */
  const VALUE_W = 24
  const minSlot = Math.max(baseBar * 2 + 12, VALUE_W * 2 + 8, mayAngle ? 48 : 30)

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
  const TOP = 22                      // room for the direct labels
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

                  {/* Each figure over its own bar. A category with nothing in
                      it draws no mark, so it gets no label either — the number
                      would sit on the baseline among the category names. */}
                  {d.urls > 0 && (
                    <text x={xI + barW / 2} y={y(d.urls) - 6} textAnchor="middle" fontSize={9}
                      fontWeight={700} fill={m.axis} opacity={o}
                      style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {axisNum(d.urls)}
                    </text>
                  )}
                  {d.removed > 0 && (
                    <text x={xR + barW / 2} y={y(d.removed) - 6} textAnchor="middle" fontSize={9}
                      fontWeight={700} fill={m.axis} opacity={o}
                      style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {axisNum(d.removed)}
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

/* Exported for .preview-repeat.tsx, which renders THIS component rather than
   a copy of it — see the note on MirrorBars. */
export function RepeatOffenders({ rows, m, onPick, activeVal = '', limit = 10 }: {
  rows: any[]; m: MarkTheme; onPick?: (v: string) => void; activeVal?: string; limit?: number
}) {
  const segs = rows.slice(0, limit)
  /* Not "No data.", which reads as a card that failed. An empty repeat-offender
     list is a FINDING — every account this window found, it found once — and the
     panel says which of the two it is looking at. */
  if (segs.length === 0) {
    return (
      <div className="text-sm text-gray-400 dark:text-white/45 py-6 text-center">
        No channel or profile came back after a takedown in this window.
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
          const repeats = Number(r.repeats) || 0
          /* The account's OWN state, as against its posts'. The server sends
             the two words this shows — see profileStatusLabel — so a status
             the warehouse spells some third way cannot arrive here as a third
             thing the layout has no room for. */
          const status = String(r.profileStatus ?? '').trim() || 'Not Available'
          const suspended = status === 'Suspended'
          const isActive = activeVal === filterVal || activeVal === url
          const dimmed = hasActive && !isActive
          return (
            <button key={filterVal + i} type="button" disabled={!onPick} onClick={() => onPick?.(filterVal)}
              title={`${url}\nCame back ${repeats} time${repeats === 1 ? '' : 's'} after a takedown · `
                + `${full(urls)} URLs identified · ${full(removed)} removed · Profile: ${status}`}
              className={`grid items-center gap-3 rounded-md px-1.5 py-1 text-left transition-all ${
                onPick ? 'hover:bg-[#14254A]/[0.04] dark:hover:bg-white/5' : 'cursor-default'} ${
                isActive ? 'bg-[#14254A]/[0.05] ring-1 ring-[#14254A]/30 dark:bg-white/5 dark:ring-white/20' : ''} ${
                dimmed ? 'opacity-40' : ''}`}
              /* The label column is given real room — these are URLs, and the
                 whole complaint a top-ten of accounts answers is "which
                 account". The bars take a share rather than a fixed width, so
                 the same panel works full-width here and half-width in a
                 summary. */
              style={{ gridTemplateColumns: '18px 52px minmax(90px, 1fr) 108px minmax(150px, 34%)' }}>

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
                <span className="text-[13px] font-extrabold leading-none">{repeats}</span>
                <span className="text-[9px] font-bold uppercase tracking-wide">
                  {repeats === 1 ? 'time' : 'times'}
                </span>
              </span>

              <span className="text-xs text-gray-600 dark:text-gray-300 truncate" title={url}>
                {midCut(prettyURL(url), 56)}
              </span>

              {/* THE PROFILE'S OWN STATE, beside the count of what it did.
                  The pairing is the finding: a profile we removed four times
                  that is STILL not suspended is a different problem from one
                  that was, and reading the two together is the whole reason
                  the column is here rather than in the tooltip.

                  "Not Available" is muted on purpose — it covers both "Active"
                  and "never told", which are the same amount of evidence, and
                  colouring it like a live status would make the weaker claim
                  look like the stronger one. */}
              <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded text-center
                whitespace-nowrap ${suspended
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : 'bg-gray-100 text-gray-400 dark:bg-white/5 dark:text-white/40'}`}>
                {suspended ? 'Suspended' : 'Not Available'}
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
        { label: 'Re-Uploaded', color: BRAND_GOLD },
        { label: 'URLs identified', color: m.ident },
        { label: 'Removed', color: m.removed },
      ]} />
    </>
  )
}

/** Slicer in the right rail. */
/*
A filter that lives on a CARD rather than in the rail.

Sized and worded to read as part of the card's header strip, beside the chart
type — the two controls there are the two things a reader changes about this one
panel, and they look alike because they are the same kind of decision. The rail's
Slicer is a different animal: stacked label over box, a dozen of them, each one
moving the whole page.

── WHY IT IS NOT A <select> ─────────────────────────────────────────────────

	It was one, and the list it dropped was the operating system's: system font,
	system blue highlight, system metrics, sitting under a card whose every other
	surface is this product's. A native select styles its BOX and nothing else —
	the options are drawn by the platform and cannot be reached from CSS at all,
	so the mismatch was not a matter of trying harder with the stylesheet.

	So the list is ours, built on the same portal-and-outside-click pattern as
	the VizPicker it sits beside: one popover behaviour on this card rather than
	two that merely look similar. Portalled because the card clips its own
	overflow — a menu rendered in place would be cut off by the chart below it.

	The keyboard behaviour a native select gives free is put back deliberately:
	Escape closes, the trigger is a real button with aria-haspopup, and each
	option is a button in the tab order. What is NOT put back is type-ahead;
	these lists are a dozen platforms and a reader can see all of them.
*/
/* Exported for .preview-panelsel.tsx — see the note on MirrorBars. */
export function PanelSelect({ label, value, options, onChange }: {
  label: string
  value: string
  options: { key: string; label: string }[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
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

  const active = value !== ''
  const current = options.find(o => o.key === value)
  const MENU_W = 190

  const pick = (v: string) => { onChange(v); setOpen(false) }

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox" aria-expanded={open}
        title={`${label}: ${current?.label ?? 'All'}`}
        className={`flex items-center gap-1.5 rounded-md border h-6 pl-2 pr-1.5 transition-colors ${
          active
            ? 'border-[#FC934C]/60 bg-[#FC934C]/10 text-[#FC934C]'
            : 'border-gray-200 text-gray-400 hover:text-[#14254A] hover:border-gray-300 dark:border-white/15 dark:text-white/50 dark:hover:text-white'
        }`}>
        <span className="text-[9px] font-bold uppercase tracking-widest opacity-70">{label}</span>
        <span className="text-[11px] font-bold max-w-[110px] truncate">
          {current?.label ?? 'All'}
        </span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && rect && createPortal(
        <div ref={menuRef} role="listbox"
          className="fixed z-[9999] rounded-xl border shadow-2xl overflow-hidden py-1
            bg-white border-gray-200 dark:bg-[#1a2d55] dark:border-white/15"
          style={{
            width: MENU_W,
            /* Flipped above the trigger when there is no room below, and never
               off the bottom — these lists run to a dozen or more rows and the
               card often sits low on a long page. */
            top: Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 320)),
            left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_W - 8)),
          }}>
          <p className="px-3 pt-1.5 pb-1 text-[9px] font-bold uppercase tracking-widest text-gray-400">
            {label}
          </p>
          <div className="max-h-[280px] overflow-y-auto">
            {/* "All" is an option rather than a separate clear button: it is
                what the control reads when nothing is chosen, so it has to be
                choosable by the same gesture. */}
            {[{ key: '', label: 'All' }, ...options].map(o => {
              const on = o.key === value
              return (
                <button key={o.key || '__all'} type="button" role="option" aria-selected={on}
                  onClick={() => pick(o.key)}
                  className={`w-full text-left px-3 py-1.5 text-xs truncate transition-colors ${
                    on
                      ? 'font-bold text-[#14254A] bg-[#14254A]/[0.06] dark:text-white dark:bg-white/10'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5'
                  }`}>
                  {o.label}
                </button>
              )
            })}
          </div>
        </div>,
        document.body)}
    </>
  )
}

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
 * `vod` is the VOD Reports page — again the SAME component rather than a
 * second copy, for the same reason. It sends `scope=vod` on every request
 * that can be asked for either page (sections, options, data), which is what
 * makes the server resolve the VOD grant and the VOD-only platform backstop
 * instead of the original Reports grant — see dashAccessScope's twin,
 * mayOpenReport/reportsAllowedForClaims, in go-server/handlers. `scoped` and
 * `vod` are independent: a client reads their own VOD Reports scoped this
 * way, and staff can preview it unscoped from /admin/report-vod.
 *
 * Nothing here is the access control. The server forces the client id for any
 * login that is not staff and refuses the request without the module grant
 * (go-server/handlers/reportclientmap.go); this only decides what to draw.
 */
export default function ReportsPage({ scoped = false, vod = false }: { scoped?: boolean; vod?: boolean }) {
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
  /* Whether the range on screen is the READER'S, or still the one the page
     opened with.

     Needed because the two are indistinguishable by value. The generic thirty
     days lands inside a running season perfectly often, so "is this window
     inside the period" — the only test there used to be — answered yes for a
     window nobody had chosen, and a sports report opened on a month.

     A ref rather than state: nothing renders from it, and the sections effect
     reads it inside a fetch callback, where a captured state value would be the
     one from when the request went out rather than the one from when it came
     back. */
  const rangePicked = useRef(false)
  const [opts,     setOpts]     = useState<Record<string, any>>({})
  /* In flight for a PANEL-SCOPED filter only — see the run effect. The global
     `loading` replaces the report; this one marks a single card. */
  const [panelBusy, setPanelBusy] = useState(false)
  /* What the filters were on the last run, so a change can be classified before
     it is acted on. A ref rather than state: reading it must not itself be a
     reason to run again. */
  const prevFilters = useRef<Record<string, string>>({})
  const [data,     setData]     = useState<any>(null)
  const [loading,  setLoading]  = useState(false)
  const [err,      setErr]      = useState('')
  const [unavailable, setUnavailable] = useState('')
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

  /* The two halves of the PDF export — see lib/printReport.

     `printRoot` is WHAT is printed: the page less its breadcrumb row, with the
     two rails inside it marked as chrome and dropped from the clone.
     `printMain` is what the PAGE IS MEASURED FROM, and it is the centre column
     rather than the root on purpose — the charts are cloned at the width they
     were drawn at, so the paper has to be cut to that width or every one of
     them lands in a container it does not fill. */
  const printRoot = useRef<HTMLDivElement>(null)
  const printMain = useRef<HTMLElement>(null)
  const [printError, setPrintError] = useState('')

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

  /** What Report Configuration says this client's report is drawn with and in. */
  const [appearance, setAppearance] = useState<{
    engine: string; theme: string; custom?: Partial<CustomPalette> | null
  }>({ engine: NATIVE, theme: DEFAULT_THEME })

  /* ── HOW THE REPORT LOOKS, AS OPPOSED TO WHAT IT SHOWS ───────────────────

     Two report-wide choices, and unlike the per-panel chart shapes above,
     NEITHER of them belongs to the reader:

       engine · which library draws the charts. `native` is this file's own
                components, and is also the fallback for every panel the chosen
                library declines — the world map, the heat grid, the ranked
                table, the repeat-offender list.
       theme  · which of lib/reportTheme.ts's palettes every mark is drawn in,
                including `custom`, whose colours arrive in `custom` below.

     Both are configured per client in Report Configuration → Appearance, and
     arrive with the section list because they are keyed on the same client the
     section list already is. The reason they are configuration rather than a
     preference is in go-server/handlers/reportappearance.go, and it is not
     tidiness: a palette carries MEANING here — orange is the part we took down
     — so a reader who could recolour it would be reading a different document
     from everyone else looking at the same page. */
  const engine = appearance.engine || NATIVE
  const m: MarkTheme = themeFor(appearance.theme, isDark, appearance.custom)

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
  const isSportsSection = useMemo(
    () => !!activeSection && isSportsLabel(activeSection.label),
    [activeSection])

  /*
  Whether the live card is on the page at all.

  Named because it is read in two places that must agree: the card's own render,
  and the sticky offset the rails are given — a rail held down for a band that is
  not there would leave a gap at the top of the page with nothing in it.

  ── Why it no longer waits for a narrowing filter ──────────────────

  A client, and the panel still on the page. Both are configuration; nothing is
  asked of the reader any more.

  It wanted one of Match Day / Asset / Franchise as well, and the reason was
  cost rather than taste. Unfiltered, the card counted the client's entire
  configured season on every visit — the most expensive query in the product,
  measured at 14.5s against production — run to answer a question nobody had
  asked yet, above a report the reader had not finished setting up.

  What fixed that is the WINDOW, not the filters. The card opens on the last 24
  hours and can be widened to a week and no further (REALTIME_WINDOWS above; the
  ceiling is the server's and is enforced in scopeFromRequest, not here), and a
  week of one client's captures measures at 1.4s against the season's 14.5s.
  There is nothing left to defer the card for — and deferring it was never what
  a reader wanted. A live card that appears three clicks into setting up a
  report is one most people never see, on the page where "what is happening
  right now" is the first question asked.

  The three filters still matter, they just no longer gate it: they are what the
  count is narrowed BY as the reader picks them, and the strip along the bottom
  of the card names them — along with the ones the live tables cannot honour,
  which is the part a reader could not otherwise know.
  */

  /* ── The card as Report Configuration arranged it ──────────────────────────

     The live strip is a PANEL now — its title, its ⓘ note, its width and
     whether it is on the page at all come from the layout, alongside every
     chart below it (Report Configuration → Page Layout, served by
     go-server/handlers/reportlayout.go). Switched off there, the server simply
     leaves it out of the list and the card is gone.

     Read off the section rather than out of `panels` further down, because the
     sticky offset the rails are given is measured up here and cannot wait for
     it.

     An older server sends no panel list at all. There the card is on every
     sports report at full width and under its own name, which is exactly what
     it was before it could be arranged. */
  const rtPanel: SectionPanel | null = useMemo(() => {
    const list = activeSection?.panels
    if (!list?.length) {
      return isSportsSection ? { key: 'realtime', kind: 'realtime', span: 'full' } : null
    }
    return list.find(p => p.kind === 'realtime') ?? null
  }, [activeSection, isSportsSection])

  /* Whether it LEADS the page, which is the one thing its position decides
     beyond where it is drawn.

     First, it is the full-width band across both rails — the thing a reader can
     pin, so live counts hold their place while the report scrolls under them.
     Moved below any other panel it is an ordinary card inside the centre grid,
     and the pin goes with the position: a card pinned from the middle of a page
     has nothing to stick to, and the band it would need is the width of a page
     it is no longer at the top of. */
  const rtLeads = (activeSection?.panels?.[0]?.kind ?? 'realtime') === 'realtime'

  /*
    The card is DRAWN whenever the layout has one, client or no client.

    This used to require filters.clientId, which meant the live counts appeared
    only once a company had been resolved — a beat after load for a client login,
    and not until a staff reader had picked one. Either way the reader could not
    see that the strip existed, and the page reflowed when it arrived.

    Whether it can COUNT is a separate question, and the card answers it itself:
    rtWaitingFor below hands it a reason instead of a scope, and it draws its
    frame without calling anything.
  */
  const showRealtime = !!rtPanel

  /* Empty once a client is known, which is when the card starts counting.
     A client login resolves its own company on load, so this is momentary
     there; for staff it stands until they choose one. */
  const rtWaitingFor = filters.clientId
    ? undefined
    : (scoped
        ? 'Loading your live figures…'
        : 'Choose a client to see live figures. The window selected here applies to them.')

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
  }, [rtPinned, showRealtime, rtLeads])
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

  /* ── What the live card's own three slicers are set to ────────────────────

     The card may be counting something other than the report — that is what its
     pickers are for — and when it is, the option lists it was handed no longer
     describe it. See the rtOpts effect below.

     Reported by the card through a STABLE callback, and stored only when a
     value actually moved: the card fires on every change of its effective
     three, and a setState that always wrote a new object would re-render the
     card, which would fire it again. */
  const [rtDims, setRtDims] = useState({ franchiseName: '', matchDay: '', assetId: '' })
  /* The lists re-listed under those three. Null while the card is following the
     report, which is when the rail's own lists already describe it. */
  const [rtOpts, setRtOpts] = useState<Record<string, any> | null>(null)
  const onRtDimsChange = useCallback(
    (d: { franchiseName: string; matchDay: string; assetId: string }) =>
      setRtDims(p => (p.franchiseName === d.franchiseName && p.matchDay === d.matchDay
        && p.assetId === d.assetId ? p : d)),
    [])

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
    if (vod) p.set('scope', 'vod')
    fetch(`/api/reports/sections?${p}`, { credentials: 'include' })
      .then(async r => {
        if (r.status === 401 || r.status === 403) throw new Error(AUTH_MSG)
        return r.json()
      })
      .then(d => {
        if (!mounted.current) return
        /* Before the sections, and outside the Array guard: a portal whose
           registry is empty still has an appearance, and a report drawn in the
           house palette because the section list happened to be empty would
           flip colours the moment somebody configured a platform. */
        if (d?.appearance) {
          setAppearance({
            engine: String(d.appearance.engine || NATIVE),
            theme: String(d.appearance.theme || DEFAULT_THEME),
            custom: d.appearance.custom ?? null,
          })
        }
        if (!Array.isArray(d.sections)) return
        setSections(d.sections)

        /* Open the first platform straight away, for a CLIENT.

           Staff arrive here to choose — platform, then client — so an empty
           state is the honest first step for them, and it stays.

           A client has no such choice: their company is fixed by the mapping,
           the window already has a default of its own, and everything
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
          if (!cur) return f
          /* Untouched, so the section decides — seven days on a sports report,
             thirty elsewhere, clipped to the season where there is one. The
             page cannot know which section it is on until this list arrives, so
             this is the first moment the right default can be applied. */
          if (!rangePicked.current) {
            const def = sectionDefaultRange(cur)
            return def.from === f.from && def.to === f.to ? f : { ...f, ...def }
          }
          if (!cur.period) return f
          const { start, end } = cur.period
          if (f.from >= start && f.from <= end && f.to >= start && f.to <= end) return f
          return { ...f, ...sectionDefaultRange(cur) }
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
      if (vod) p.set('scope', 'vod')
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

  /* ── The same lists again, under the LIVE CARD's own scope ────────────────

     Only while the card has been moved off the report, which is the whole of
     when this is needed and is why it usually costs nothing: with the card
     following the rail the two requests would be identical, so `rtOpts` stays
     null and the card is handed the rail's lists exactly as before.

     Why it is needed at all. The card's three pickers narrow the LIVE figure
     and deliberately never touch the report — but the values they offer came
     from a request scoped to the report, so the moment the two part company the
     list stops describing what the card is counting. Move the card to Belgian
     Pro League while the rail is unfiltered and the Asset list still offers all
     34 fixtures, Serie A included; pick one and the count asks the warehouse
     for a Serie A fixture inside Belgian Pro League, which cannot exist. The
     card reads 0, correctly, having been picked out of a list that was still
     advertising rows against it. Re-listed here, that fixture is simply not
     offered — and the Franchise list, scoped by the card's asset in the same
     pass, shows the competition that asset IS in.

     Failures are swallowed. These are a second copy of lists the page already
     has; blanking the report or raising a banner because the card's copy could
     not be refreshed would turn a cosmetic gap into an outage, and the card
     falls back to the rail's lists on its own. */
  const rtDimsMoved = (rtDims.franchiseName || '') !== (filters.franchiseName || '')
    || (rtDims.matchDay || '') !== (filters.matchDay || '')
    || (rtDims.assetId || '') !== (filters.assetId || '')
  useEffect(() => {
    if (!section || !activeSection || !rtDimsMoved) { setRtOpts(null); return }
    let active = true
    const t = setTimeout(() => {
      const p = new URLSearchParams({ type: section })
      if (filters.clientId) p.set('clientId', filters.clientId)
      if (filters.from) p.set('from', filters.from)
      if (filters.to) p.set('to', filters.to)
      for (const key of activeSection.filters ?? []) {
        /* The card's value for the three it owns, the rail's for the rest —
           the same substitution the count itself makes, off the same list that
           decides which filters the count can honour at all. */
        const v = REALTIME_COUNT_FILTERS.has(key)
          ? (rtDims as Record<string, string>)[key]
          : filters[key]
        if (v) p.set(key, v)
      }
      if (vod) p.set('scope', 'vod')
      fetch(`/api/reports/options?${p}`, { credentials: 'include' })
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (!mounted.current || !active) return
          if (d && d.available !== false) setRtOpts(d)
        })
        .catch(() => {})
    }, 350)
    return () => { active = false; clearTimeout(t) }
  }, [section, activeSection, filters, rtDims, rtDimsMoved])

  /* ── Auto-run on any filter change, debounced ─────────────────────────── */
  useEffect(() => {
    if (!section || !activeSection) { setData(null); return }
    if (!filters.clientId) { setData(null); setLoading(false); return }

    /*
      A PANEL-SCOPED change does not replace the report.

      The loader below takes the whole report off screen on every run, and for a
      scope change that is right: the numbers on screen answer the previous
      filter set, and leaving them up under a new one shows the reader figures
      that do not belong to the question they just asked.

      That reasoning does not reach a panel-scoped filter. Narrowing the
      repeat-offender ranking to one platform leaves every other panel, the KPI
      band and the trends answering exactly the question they already answered —
      so blanking them says a change happened where none did, and costs the
      reader the whole page to look at one card.

      The request still goes to the server, and it has to: the panel is a TOP
      TEN, and the ten it holds for one platform are not a subset of the ten it
      holds for all of them. Filtering the rows already on screen would quietly
      answer "which of the overall top ten are on TikTok", which is a different
      question with a smaller answer. So the fetch happens and the page simply
      does not tear itself down for it — the affected card marks itself busy and
      everything else keeps the answer it already had.
    */
    const changed = Object.keys({ ...prevFilters.current, ...filters })
      .filter(k => (prevFilters.current[k] || '') !== (filters[k] || ''))
    const panelOnly = changed.length > 0 && changed.every(k => PANEL_SCOPED_FILTERS.has(k))
    prevFilters.current = filters

    if (panelOnly) setPanelBusy(true)
    else setLoading(true)
    let active = true
    const t = setTimeout(async () => {
      try {
        const p = new URLSearchParams({ type: section, clientId: filters.clientId, from: filters.from, to: filters.to })
        // Only send what this section declares, so a stale filter from another
        // section cannot leak into a query that has no such column.
        for (const key of activeSection.filters) {
          if (filters[key]) p.set(key, filters[key])
        }
        if (vod) p.set('scope', 'vod')
        const res  = await fetch(`/api/reports/data?${p}`, { credentials: 'include' })
        const json = await res.json()
        if (!active) return
        if (json.available === false) { setUnavailable(json.error || 'Reports database unavailable'); return }
        if (res.status === 401 || res.status === 403) { setAuthError(AUTH_MSG); return }
        if (json.ok) { setData(json); setErr(''); setUnavailable(''); setAuthError('') }
        else setErr(json.error || 'Query failed')
      } catch (e: any) {
        if (active) setErr(e.message)
      } finally {
        if (active) { setLoading(false); setPanelBusy(false) }
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
    // Clicking a day IS choosing a range — and so is the click back out of it,
    // which restores the one they were on. Either way the window stops being
    // the page's opening default.
    rangePicked.current = true
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
        ...carriedRange(to, f.from, f.to, rangePicked.current),
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
        return { label, icon, delta: d(), value: kpiFmt(kpi.identified), accent: m.ident, spark: 'urls' }
      case 'removed':
        return { label, icon, delta: d(), value: kpiFmt(kpi.removed), accent: m.removed, spark: 'removed' }
      /* The numerator and denominator used to ride under this one — "16,824 of
         27,294 taken down". It is the one footnote that said something the
         label did not, and it is gone with the rest; both figures are tiles of
         their own in the same band, which is where a reader can now get them.
         The ⓘ is where to put it back if it is missed. */
      case 'removalPct':
        return { label, icon, delta: d(), value: `${kpi.removalPct}%`, accent: m.removed, spark: 'removed' }
      case 'pending':
        return { label, icon, delta: d(), value: kpiFmt(kpi.pending), accent: m.ident }
      case 'savedRevenue': {
        if (kpi.savedRevenueLow === undefined) return null
        /* A RANGE, and it no longer names the rate that produced it.

           WORTH KNOWING, because this is the one tile where the footnote was
           not a restatement of the label: the multiplier is a commercial
           assumption set in the server environment, not something the
           warehouse measured, and "at 0.02–0.05 per view saved" was the only
           thing on screen saying so. Removed with the rest by request. The
           range itself still signals an estimate rather than a count, and the
           ⓘ on the panel is where the rate belongs if it needs stating. */
        const cur = (data?.revenueRate as { currency?: string } | undefined)?.currency ?? ''
        return {
          label, dense: true, accent: m.removed, icon,
          // The change on the floor of the range: both ends are the same views
          // multiplied by two fixed rates, so they move together and one figure
          // says it.
          delta: kpiDelta('savedRevenue', kpi.savedRevenueLow, kpiPrev?.savedRevenueLow, prevWindowLabel),
          value: `${cur}${kpiFmt(Number(kpi.savedRevenueLow))} – ${cur}${kpiFmt(Number(kpi.savedRevenueHigh))}`,
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

  /* ── What the live card's bottom strip says the rail holds ────────────────

     Every active slicer, with each one saying whether the LIVE count could
     honour it. The two lists are not the same and the gap is invisible on the
     numbers: the card counts by asset, franchise and match day, the rail
     carries a dozen, and an unfiltered live total under a rail set to Spain and
     Spanish looks like a Spanish figure while being out by an order of
     magnitude. Nothing on the card said so, because until now the card was not
     on screen unless one of the three it honours had been picked.

     Built from `chips`, not from `filters`, so the strip and the chips above
     the report cannot end up calling one selection two different things — the
     display names are resolved once, in one place.

     Deliberately NOT memoised. It is passed for RENDERING only, never as an
     effect dependency, so a fresh array per render costs a shallow diff and
     nothing else; memoising it on `chips`, which is itself rebuilt every
     render, would be the appearance of care and none of it. */
  const realtimeScopeFilters = chips.map(c => ({
    key: c.key, label: c.label, value: c.display,
    applied: REALTIME_COUNT_FILTERS.has(c.key),
  }))

  /* ── The option lists the live card's own slicers are drawn from ──────────

     The rail's own lists, handed over rather than fetched again. They are
     SCOPED — narrowed by the client, the window and each other (see the
     `/api/reports/distinct` effect) — so a card fetching its own would offer
     franchises this client does not have and fixtures the report has already
     ruled out, and picking one would produce a live figure of zero under a
     report that never mentioned it.

     Only the three the live tables can be narrowed by; the same three
     REALTIME_COUNT_FILTERS names, and for the same reason. A slicer the section
     does not declare is left undefined and the card draws no control for it —
     which is what happens on a sports report configured without a Match Day
     slicer, where offering one here would be the card inventing a filter the
     rail deliberately does not have. */
  const realtimeDimOptions = useMemo(() => {
    /* The card's own lists where it has moved off the report, the rail's
       otherwise — see the rtOpts effect. */
    const src = rtOpts ?? opts
    const forKey = (k: string) =>
      activeSection?.filters?.includes(k) ? asOpts(src[k]) : undefined
    return {
      franchiseName: forKey('franchiseName'),
      matchDay: forKey('matchDay'),
      assetId: forKey('assetId'),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, rtOpts, opts.franchiseName, opts.matchDay, opts.assetId])

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
      /* The live strip leads the page, which is where it was drawn before it
         was a panel at all. Mirrors defaultPanels in
         go-server/handlers/reportlayout.go, which this list is the fallback
         for. */
      ...(isSportsSection
        ? [{ key: 'realtime', kind: 'realtime' as const, label: 'Realtime', span: 'full' as const }]
        : []),
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
  }, [activeSection, sourceTrends, isSportsSection])

  /* ── The report, as a workbook ─────────────────────────────────────────────

     One sheet per panel, in the order the panels are on the page, behind a
     cover sheet that says what the numbers are OF.

     Why a workbook rather than a file per chart: a report is a dozen panels
     that answer one question between them, and a dozen CSVs in a downloads
     folder is a set somebody has to reassemble. Tabs keep them together, named,
     in reading order — which is the "structured" part of the ask.

     Why a COVER sheet: a grid of numbers with no window and no filters on it
     will be read wrong within a month. The scope is on every sheet as a
     subtitle and set out in full on the first one, so no tab can be forwarded
     on its own and lose it.

     Built on demand, in the click handler, from exactly the state the panels
     render from — never held in a ref written during render. A registry filled
     as cards mount is a second copy of the page's contents that is stale
     whenever a panel has not re-rendered, and the one thing this file has to
     guarantee is that the download IS what is on the screen. */

  /** The scope, in one line. Printed under every sheet's title and into every
      exported image. */
  const exportScope = useMemo(() => [
    scope?.clientName && `Client: ${scope.clientName}`,
    activeSection?.label && `Report: ${activeSection.label}`,
    filters.from && filters.to && `Window: ${shortDateFull(filters.from)} – ${shortDateFull(filters.to)}`,
    ...chips.map(c => `${c.label}: ${c.display}`),
  ].filter(Boolean).join('  ·  '),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [scope?.clientName, activeSection?.label, filters.from, filters.to, chips.map(c => c.key + c.display).join('|')])

  /** The name a panel wears on the page.
   *
   *  The same fallbacks renderPanel uses, in one place, so a sheet cannot end
   *  up under a different name from the card it came from. `label` is the
   *  server's — set in Report Configuration — and wins wherever it exists. */
  const panelLabel = useCallback((p: SectionPanel): string => {
    if (p.label) return p.label
    switch (p.kind) {
      case 'trend': {
        const src = p.role ? sourceTrends.find(x => x.role === p.role) : undefined
        return src
          ? `${src.label} Identification & ${src.secondName}`
          : isSummary ? 'Infringement Identification & Removal' : 'Identification & Removal'
      }
      case 'rate': return 'Removal rate'
      case 'dim': return (activeSection?.dimensions ?? []).find(d => d.key === p.key)?.label ?? p.key
      default: return p.key
    }
  }, [sourceTrends, isSummary, activeSection])

  /** The table a panel is showing, for the panels that have one. Null for a
      tile, a heading, the live strip, and for a trend whose source returned
      nothing — none of which is a table, and a sheet for each would be a tab
      the reader opens to find empty. */
  const panelTableFor = useCallback((p: SectionPanel): PanelTable | null => {
    switch (p.kind) {
      case 'trend': {
        const src = p.role ? sourceTrends.find(x => x.role === p.role) : undefined
        if (p.role && !src) return null
        const rows = src ? src.rows : trend
        return trendTableData(rows,
          src ? `${src.label} URLs` : 'Identified',
          src ? src.secondName : 'Removed', trendGrain)
      }
      case 'rate':
        return rateTableData(trend, trendGrain)
      case 'dim': {
        const rows = orderRows(p.key, (data?.breakdowns?.[p.key] || []) as any[])
        const dim = (activeSection?.dimensions ?? []).find(d => d.key === p.key)
        return dimTableData(p.key, dim?.label ?? p.label ?? p.key,
          vizFor(`${section}:${p.key}`, p.viz || dim?.viz || 'bars'), rows)
      }
      default:
        return null
    }
  }, [sourceTrends, trend, trendGrain, data, activeSection, section, vizFor])

  const exportReport = useCallback(async () => {
    const stamp = new Date()
    const sheets: Sheet[] = [{
      name: 'Report',
      title: activeSection?.label || 'Report',
      subtitle: `Taken ${stamp.toLocaleString()}`,
      head: ['Field', 'Value'],
      rows: [
        ['Client', scope?.clientName ?? ''],
        ['Report', activeSection?.label ?? section],
        ['From', filters.from ?? ''],
        ['To', filters.to ?? ''],
        ['Grain', trendGrain],
        /* Every slicer that was set, by name. The sheet after this one is a
           column of counts, and the difference between "all assets" and "one
           fixture" is invisible in it. */
        ...chips.map(c => [c.label, c.display] as (string | number)[]),
        ['Taken', stamp.toLocaleString()],
      ],
    }]

    /* The headline figures, as their own sheet. They are panels on the page but
       not tables — four to ten single numbers — so one sheet holds the lot
       rather than each getting a tab with one row on it. */
    const tiles = panels.filter(p => p.kind === 'tile')
    const tileRows = tiles.map(p => {
      const metric = p.metric ?? ''
      const label = p.label ?? KPI_LABELS[metric] ?? metric
      const t = tileFor(metric, label)
      // The em dash the tile itself shows, not a zero: a metric this run did
      // not produce is missing, and 0 is a different claim.
      //
      // The tile's FOOT does not come with it. On screen it is a caption under
      // a figure - "of 12,043 identified", "vs the 30 days before" - written to
      // be read against the number above it and against the window the page
      // states. In a column called Note, one cell down from a heading, it read
      // as a qualification OF the figure, and a sheet somebody sorts or filters
      // separates the two entirely. The sheet keeps the figure, which is the
      // thing the workbook is for; the caption belongs to the page.
      return [label, t ? String(t.value) : '—'] as (string | number)[]
    })
    if (tileRows.length) {
      sheets.push({
        name: 'Headline figures', title: 'Headline figures', subtitle: exportScope,
        head: ['Figure', 'Value'], rows: tileRows,
      })
    }

    for (const p of panels) {
      const td = panelTableFor(p)
      // An empty panel is skipped rather than given a tab with a header and no
      // rows. The cover names the window; a reader who wants to know why a
      // chart is missing is asking about the window, not about the file.
      if (!td || !td.rows.length) continue
      sheets.push({
        name: panelLabel(p), title: panelLabel(p), subtitle: exportScope,
        head: td.head, rows: td.rows,
      })
    }

    const who = scope?.clientName ? `${scope.clientName} — ` : ''
    /* Not awaited by a caller — this is a click handler and there is nothing
       after it. Awaited HERE so a failure to build the workbook surfaces as a
       rejected promise in the console rather than as a download that silently
       never arrives. */
    await downloadWorkbook(
      `${who}${activeSection?.label ?? section} — ${filters.from ?? ''} to ${filters.to ?? ''}`,
      sheets)
  }, [panels, panelTableFor, panelLabel, tileFor, activeSection, section, scope,
      filters.from, filters.to, trendGrain, chips, exportScope])

  /**
   * The same report, as a document.
   *
   * The workbook above takes the NUMBERS away — one sheet per panel, no charts,
   * nothing about how the page was laid out. This takes the PAGE away: every
   * panel at the size and in the position it is on screen, which is what gets
   * pasted into a deck or sent to somebody who is never going to open a
   * spreadsheet.
   *
   * What it drops is the application around it — the breadcrumb, the report
   * navigation and the filter rail — because none of those is the report and a
   * pane of controls nobody can click is worse than no pane at all.
   *
   * What it KEEPS from the filter rail is the only part that survives leaving
   * the screen: the selections themselves, printed as a block under the title.
   * A dashboard with no statement of what it was filtered to is a set of numbers
   * that cannot be checked, and the reader of the PDF is exactly the person who
   * was not there when the slicers were set.
   */
  const printPdf = useCallback(async () => {
    if (!printRoot.current) return
    const who = scope?.clientName ? `${scope.clientName} — ` : ''
    const name = activeSection?.label ?? section
    const win = filters.from && filters.to
      ? `${shortDateFull(filters.from)} – ${shortDateFull(filters.to)}`
      : undefined
    setPrintError(await printReport(printRoot.current, {
      fileName: `${who}${name} — ${filters.from ?? ''} to ${filters.to ?? ''}`,
      title: name,
      client: scope?.clientName,
      window: win,
      /* The rail's selections, resolved to their display names by `chips` —
         the same list the workbook's cover sheet and every exported chart
         carry, so three exports of one reading cannot describe it three ways. */
      filters: chips.map(c => ({ label: c.label, value: c.display })),
      measureFrom: printMain.current,
    }) ?? '')
  }, [activeSection, section, scope, filters.from, filters.to, chips])


  /* What the GRID draws, which is the panel list less the live strip in the two
     cases where the strip is not one of its cells:

       · it leads the page, and is therefore the band above both rails — the
         same element it has always been, so pinning stays a style change on a
         card that is never torn down;
       · it is not on screen at all, because no client or no narrowing filter
         has been chosen yet. The panel is still in the layout; this reading
         simply has nothing to put in it, and an empty full-width cell in the
         middle of the report is worse than no cell.

     Anywhere else it is an ordinary panel and renderPanel draws it in place. */
  const gridPanels = useMemo(
    () => panels.filter(p => p.kind !== 'realtime' || (showRealtime && !rtLeads)),
    [panels, showRealtime, rtLeads])

  /** Every breakdown panel's table twin has the same five columns. */
  const dimTable = (rows: any[], onPick?: (v: string) => void, activeVal = '') => (
    <DataTable head={['Name', 'Identified', 'Removed', 'Removal rate', 'Share']}
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
  /* The values the repeat-offender platform control offers.

     Served under the panel's own parameter and only where the panel can honour
     it — see the note in go-server/handlers/reports.go — so an empty list is
     this report having no platform column rather than a dropdown worth drawing
     empty. Read here rather than inside renderDim so the card does not re-derive
     it on every panel it draws. */
  const repeatPlatformOpts = useMemo(
    () => asOpts(opts[REPEAT_PLATFORM_PARAM]), [opts])

  const renderDim = (dim: SectionDim, spanClass: string) => {
    /*
      TWO row sets, and the difference between them is the whole of "hide for
      visibility only".

      `rows` is what is DRAWN — the chart, and the table twin behind the TABLE
      toggle, which is another way of looking at the same panel. Placeholders are
      out of it: see isPlaceholderRow.

      `rowsAll` is what is EXPORTED. A download is not a view, it is the data
      leaving the building, and a row this panel declined to draw is still a row
      the client's numbers include. Dropping it from the file would make the
      export disagree with the report's own totals, which is the one thing the
      instruction was explicit about not doing.

      The whole-report export already reads the unfiltered rows for the same
      reason — see dimTableData's other caller.
    */
    const rowsAll = orderRows(dim.key, (data?.breakdowns?.[dim.key] || []) as any[])
    const rows = rowsAll.filter(r => !isPlaceholderRow(r))
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
    const options = ROOT_ALL_DIMS.has(dim.key) ? [MIRROR_VIZ, ...DIM_VIZ]
      /* Report Configuration can put the mirror shape on any panel — the Go
         vocabulary does not know which dimension carries the count. Offering it
         back where it was configured keeps the picker able to name the shape
         the card is currently in, which is the whole of what `fallback` reads. */
      : configured === 'mirror' ? [MIRROR_VIZ, ...DIM_VIZ]
      : configured === 'map' ? [MAP_VIZ, ...DIM_VIZ]
      : configured === 'repeat' ? [REPEAT_VIZ, ...DIM_VIZ]
      : DIM_VIZ
    /* Built once. The toggle below draws it and the download hands it over —
       and a panel showing its chart as a ranked TABLE still has rows worth
       exporting, which is why this is not inside the conditional under it. */
    const td = dimTableData(dim.key, dim.label, viz, rows, dim.extraLabel)
    const tdExport = dimTableData(dim.key, dim.label, viz, rowsAll, dim.extraLabel)

    /* This file's own rendering of the panel. Always built, because it is what
       the card shows on the built-in engine AND what every other engine falls
       back to — for a shape it does not claim, and for a library that will not
       load. Building the element is cheap; React only renders the branch that
       is used. */
    const builtIn = (
      <>
        {viz === 'donut'   && <Donut rows={rows} m={m} onPick={pick} activeVal={active} />}
        {viz === 'share'   && <Donut rows={rows} m={m} onPick={pick} activeVal={active} ramp="ordinal" />}
        {viz === 'stacked' && <StackedBars rows={rows} m={m} onPick={pick} activeVal={active} />}
        {viz === 'hbar'    && <HBarChart rows={rows} m={m} onPick={pick} activeVal={active}
          extraLabel={dim.extraLabel} />}
        {viz === 'column'  && (FULL_SET_DIMS.has(dim.key)
          ? <SeasonColumns rows={rows} m={m} onPick={pick} activeVal={active} />
          : <ColumnChart rows={rows} m={m} onPick={pick} activeVal={active} />)}
        {viz === 'repeat'  && (
          /* Dimmed, not replaced. The ranking on screen is the previous
             platform's and is about to change — saying so is honest — but it is
             still a real answer, and swapping it for a skeleton would cost the
             reader their place for the length of one request. */
          <div className={panelBusy ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
            <RepeatOffenders rows={rows} m={m} onPick={pick} activeVal={active} />
          </div>
        )}
        {/* Named from COUNT_PANELS, which knows all four by key. A panel the
            shape was picked for from Report Configuration and that is not in
            that table gets the neutral wording rather than another panel's —
            see the note there. */}
        {viz === 'mirror'  && (() => {
          const c = COUNT_PANELS[dim.key]
          return <MirrorBars rows={rows} m={m} onPick={pick} activeVal={active}
            nameHead={c?.nameHead ?? 'Name'}
            removedName={c?.removedName ?? 'Removed'}
            showRemoved={c?.showRemoved ?? true}
            /* The fallback for a panel Report Configuration put on this shape
               without COUNT_PANELS knowing about it. `list` is named on the
               chance the row carries one; where it does not, listOf answers
               empty and the gauge draws without a drawer, exactly as before. */
            counts={c?.counts ?? [{ key: 'extra', name: dim.extraLabel || 'Count',
              list: 'extraDomains' }]} />
        })()}
        {viz === 'table'   && <RankTable rows={rows} onPick={pick} activeVal={active}
          mirrors={ROOT_ALL_DIMS.has(dim.key)}
          removedHead={ROOT_ALL_DIMS.has(dim.key) ? rootSide(dim.key).name : undefined}
          nameHead={ROOT_ALL_DIMS.has(dim.key) ? rootSide(dim.key).head : 'Name'} />}
        {viz === 'value'   && <ValueBars rows={rows} m={m} onPick={pick} activeVal={active} />}
        {viz === 'ordinal' && <ValueBars rows={rows} m={m} onPick={pick} activeVal={active} ordered />}
        {viz === 'map'     && <WorldMap rows={rows} m={m} onPick={pick} activeVal={active} />}
        {viz === 'heat'    && <HeatGrid rows={rows} m={m} onPick={pick} activeVal={active} />}
        {!['donut', 'share', 'stacked', 'table', 'heat', 'map', 'hbar', 'column',
           'value', 'ordinal', 'repeat', 'mirror'].includes(viz) && (
          <SegmentBars rows={rows} m={m} activeVal={active} onPick={pick} />
        )}
      </>
    )
    /* Undefined for the four shapes no engine is offered — EngineChart then
       renders `builtIn` unchanged, which is the whole of "an engine re-draws
       what it can and leaves the rest alone". */
    const form = DIM_FORM[viz]

    return (
      <Card key={dim.key} title={dim.label} info={dim.desc}
        exportTable={tdExport} exportSubtitle={exportScope} exportFooter={EXPORT_FOOTER}
        action={<div className="flex items-center gap-1.5">
          {/* THE PLATFORM, on the card it narrows.

              Only on the repeat-offender panel, and only where the source
              records a platform to pick from — the server serves the values
              under this parameter exactly where the panel can honour it, so an
              empty list is the sign that this report has no such column rather
              than a dropdown worth drawing.

              On the card rather than in the rail because of its REACH: every
              control in the pane moves the whole page, and this one moves one
              ranking. Beside the chart it acts on, that is obvious without a
              sentence explaining it. */}
          {dim.key === REPEAT_DIM && repeatPlatformOpts.length > 0 && (
            <>
              {/* Busy on THIS card, because this card is the only thing the
                  change affects. A spinner over the whole report would say a
                  page-wide thing had happened, which is the impression the
                  panel-scoped path exists to avoid. */}
              {panelBusy && (
                <span className="w-3 h-3 rounded-full border-2 border-[#FC934C]/30
                  border-t-[#FC934C] animate-spin" aria-label="Updating" />
              )}
              <PanelSelect label="Platform"
                value={filters[REPEAT_PLATFORM_PARAM] || ''}
                options={repeatPlatformOpts}
                onChange={v => setF(REPEAT_PLATFORM_PARAM)(v)} />
            </>
          )}
          <VizPicker options={options} value={viz} fallback={configured}
            saved={vizDefault[vizKey]}
            onPick={v => setViz(vizKey, v)}
            onSetDefault={v => saveVizDefault(vizKey, v)} />
        </div>}
        /* No per-panel "click a row to filter" caption. It said the same thing
           on every one of a dozen cards and cost each of them a line of height;
           the section heading above them says it once. The affordance is still
           there — the rows take a pointer cursor and highlight on hover. */
        chartTitle={undefined}
        /* No twin where the chart already IS the table. The shapes it takes —
           the repeat panel's day count and full URL, a single-series panel's
           one count, a breakdown's five columns — are dimTableData's, so the
           twin and the download are the same table by construction. */
        table={viz === 'table' ? undefined
          : <DataTable head={td.head} rows={td.rows} textCols={td.textCols}
              onPick={pick} activeVal={active} pickValues={td.pickValues} />}
        className={spanClass}>
        {/* The panel's chart, drawn by whichever engine is selected — or by the
            components in this file, which is what `builtIn` is and what every
            engine falls back to.

            A panel with NO form is not handed to EngineChart at all. That is
            not the same as handing it one and letting it decline: a spec has to
            name a shape, and any shape it named would be one the engines claim,
            so the world map would come back as a bar chart of country names. */}
        {/* An empty panel is also the built-in's job. Every component in this
            file says "No data." in the card; an engine handed no rows draws an
            empty plot with an axis on it, which reads as a chart that failed
            rather than as a window with nothing in it. */}
        {form && rows.length > 0
          ? <EngineChart engine={engine} fallback={builtIn}
              spec={dimSpec(form, rows, {
                m, dark: isDark, height: dimHeight(form, rows.length),
                onPick: pick, activeVal: active,
                // `share` and `ordinal` are the two ordered breakdowns: bucket
                // sequences, coloured by a one-hue ramp in their own order.
                ordered: viz === 'share' || viz === 'ordinal',
              })} />
          : builtIn}
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
                 honest value and hiding the card is the layout's call.

                 It said "No figure for this period" underneath, and that line
                 went with every other tile footnote. The em dash carries it
                 alone now: it is the mark for "no value", it is visibly not a
                 zero, and it is the same mark this report uses for an absent
                 figure everywhere else. */
              : <Kpi label={label} value="—"
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

      /* The live counts strip, drawn where the layout put it.

         Only reached once the panel has been moved off the top of the page —
         leading it, the same card is the band above both rails instead, which is
         what the reader can pin. See gridPanels, which is where that choice is
         made rather than here: a component that appears in two branches of one
         render is a component React tears down and rebuilds every time the
         branch flips, and this one holds the reading, the last good copy kept
         for a failed refresh and its own refresh timer.

         It carries no pin here, deliberately. Everything above it would have to
         scroll under it for pinning to mean anything, and it is not above them
         any more. */
      case 'realtime':
        return (
          <div key={p.key} className={spanClass}>
            <RealtimeCard view="sports" clientId={filters.clientId}
              assetIds={realtimeAssetIds}
              franchise={filters.franchiseName || undefined}
              matchDay={filters.matchDay || undefined}
              assetNames={realtimeAssetNames}
              windowOptions={REALTIME_WINDOWS}
              scopeFilters={realtimeScopeFilters}
              dimOptions={realtimeDimOptions}
              onDimsChange={onRtDimsChange}
              platformKey={section}
              waitingFor={rtWaitingFor}
              title={p.label || undefined}
              desc={p.desc} />
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
        const td = trendTableData(rows, first, second, trendGrain)
        return (
          <Card key={p.key} title={p.label || title} info={p.desc} className={spanClass}
            exportTable={td} exportSubtitle={exportScope} exportFooter={EXPORT_FOOTER}
            action={<VizPicker options={TREND_VIZ} value={trendMode} fallback="auto"
              saved={vizDefault[trendKey]}
              onPick={v => setViz(trendKey, v)}
              onSetDefault={v => saveVizDefault(trendKey, v)} />}
            table={<DataTable head={td.head} rows={td.rows}
              onPick={pickPeriod} activeVal={drilled ? drill!.label : ''}
              pickValues={td.pickValues} />}>
            {/* Two things happen here.

                "Automatic" is resolved BEFORE the engine sees it: the rule —
                columns for a dozen periods or fewer, an area for more — is this
                report's, not a library's, and an engine that had to be told
                about it would be told four times. The built-in Trend still
                takes the raw mode, because resolving `auto` is its own job.

                And under two periods nothing is delegated at all. The built-in
                says so in words there — "no dated rows in this range", or the
                single period's figure with an invitation to widen the window —
                where any engine would draw an axis with one dot on it. */}
            {rows.length < 2
              ? <Trend data={rows} m={m} firstName={first} secondName={second}
                  mode={trendMode} onPick={pickPeriod} />
              : <EngineChart engine={engine}
                  fallback={<Trend data={rows} m={m} firstName={first} secondName={second}
                    mode={trendMode} onPick={pickPeriod} />}
                  spec={trendSpec(
                    trendForm(trendMode, rows.length), rows,
                    [{ key: 'urls', name: first, color: m.ident },
                     { key: 'removed', name: second, color: m.removed }],
                    { m, dark: isDark, height: 190, onPick: pickPeriod })} />}
          </Card>
        )
      }

      /* Rate on its own card, not a second axis on the trend: two scales sharing
         a plot make the reader believe a correlation that is really just where
         the axes were pinned. */
      case 'rate': {
        const rateKey = `${section}:${p.key}`
        const rateMode = vizFor(rateKey, 'line') as 'line' | 'area' | 'column'
        const rateTd = rateTableData(trend, trendGrain)
        return (
          <Card key={p.key} title={p.label || 'Removal rate'} info={p.desc} className={spanClass}
            exportTable={rateTd} exportSubtitle={exportScope} exportFooter={EXPORT_FOOTER}
            action={<VizPicker options={RATE_VIZ} value={rateMode} fallback="line"
              saved={vizDefault[rateKey]}
              onPick={v => setViz(rateKey, v)}
              onSetDefault={v => saveVizDefault(rateKey, v)} />}
            table={<DataTable head={rateTd.head} rows={rateTd.rows}
              onPick={pickPeriod} activeVal={drilled ? drill!.label : ''}
              pickValues={rateTd.pickValues} />}>
            {/* Same rule as the trend beside it: a rate needs two periods to be
                a rate, and the built-in is the one that says so. */}
            {trend.length < 2
              ? <RateTrend data={trend} m={m} mode={rateMode} onPick={pickPeriod} />
              : <EngineChart engine={engine}
                  fallback={<RateTrend data={trend} m={m} mode={rateMode} onPick={pickPeriod} />}
                  spec={trendSpec(
                    trendForm(rateMode, trend.length), trend,
                    // One series, and it is a percentage — which is why the rate
                    // has a card of its own rather than a second axis on the trend.
                    [{ key: 'rate', name: 'Removal rate', color: m.removed }],
                    { m, dark: isDark, height: 210, suffix: '%', onPick: pickPeriod })} />}
          </Card>
        )
      }

      /* A BREAKDOWN, and only a breakdown.

         This was the `default:` arm, and that is how a ghost card got onto the
         report. The server gained the `realtime` kind before this bundle did;
         an older build had no case for it, fell through to here, and drew the
         live strip as an empty breakdown — a second card headed "Realtime"
         with a chart/table toggle and "No data." in it, directly under the real
         one. Nothing was wrong with either half. The catch-all simply answered
         a question it had not been asked.

         So an unknown kind now draws NOTHING. A panel this build does not
         understand is one the server knows about and it does not, which happens
         on every deploy where the two move apart — and a missing card while a
         bundle catches up is a great deal better than a plausible empty one
         that a reader will report as broken data. */
      case 'dim':
        return renderDim({ key: p.key, label: p.label ?? p.key, viz: p.viz, desc: p.desc }, spanClass)

      default:
        return null
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
      onChange={r => {
        // From here on the window is theirs — see rangePicked. Switching
        // platform will carry it rather than replacing it with a default.
        rangePicked.current = true
        setFilters(f => ({ ...f, from: r.from, to: r.to }))
      }}
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

    </>
  )

  return (
    <div ref={printRoot} className="p-3 sm:p-4 fade-in">
      {/* No progress bar pinned to the top of the window any more. It sat above
          the app chrome, far from the panels it described, and on a re-run the
          only other signal was the report dimming to 60% — which reads as
          "disabled" rather than "reloading". The loader below takes over for
          every run, first and subsequent. */}

      {/* Chrome, not report: a trail back to Home and three controls, none of
          which means anything once the page is a document. The PDF states the
          report's name and scope in its own header instead — see printPdf. */}
      <nav {...{ [PRINT_HIDE_ATTR]: '' }} className="flex items-center gap-1 text-xs mb-3">
        <Link to={scoped ? '/dashboard' : '/admin/home'}
          className="font-medium text-[#14254A]/45 hover:text-[#14254A] dark:text-white/40 dark:hover:text-white">Home</Link>
        <span className="text-[#14254A]/25 dark:text-white/25">›</span>
        {!scoped && (
          <>
            <span className="font-medium text-[#14254A]/45 dark:text-white/40">Reporting</span>
            <span className="text-[#14254A]/25 dark:text-white/25">›</span>
          </>
        )}
        <span className="font-semibold text-[#14254A] dark:text-white">{vod ? 'VOD Reports' : 'Reports'}</span>
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
        {/* Both to the right, in one group. "Export" takes the report away and
            "Arrange" changes what the report IS — neither is a question about
            what is on screen, which is what the filter rail is for. */}
        {/* No appearance control here. Which library draws the charts and which
            palette they are drawn in are set per client in Report Configuration
            → Appearance, and arrive with the section list; a reader's own switch
            would let two people read the same page in colours that mean
            different things. */}
        <span className="ml-auto flex items-center gap-2">
        {section && (
          <button type="button" onClick={exportReport} disabled={loading || !data}
            title="Every chart on this report, one sheet per chart, as a spreadsheet"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg
              text-[11px] font-semibold border border-gray-200 text-gray-600
              hover:bg-white hover:text-[#14254A] transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
              dark:border-white/15 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" />
            </svg>
            Export
          </button>
        )}
        {/* The page itself, rather than the numbers out of it. Beside Export
            because they are the same act — taking the report away — and the
            difference is only what the reader is going to do with it: a
            spreadsheet to work in, a document to send on. */}
        {section && (
          <button type="button" onClick={printPdf} disabled={loading || !data}
            title="The whole page as a PDF, without the navigation or filter panes — the filters you set are printed under the title"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg
              text-[11px] font-semibold border border-gray-200 text-gray-600
              hover:bg-white hover:text-[#14254A] transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
              dark:border-white/15 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9V3h12v6" />
              <path d="M6 18H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-2" />
              <rect x="7" y="15" width="10" height="6" rx="1" />
            </svg>
            PDF
          </button>
        )}
        {scoped && canArrange && section && (
          <button type="button" onClick={() => setLayoutOpen(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg
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
        </span>
      </nav>

      {/* The one way the PDF export fails is a blocked pop-up, and it fails
          invisibly — a button that appears to do nothing. Said out loud, with
          the fix, because it is the reader's own browser setting. */}
      {printError && (
        <div {...{ [PRINT_HIDE_ATTR]: '' }}
          className="mb-3 rounded-xl px-4 py-2.5 text-[12px] border flex items-center gap-3
            bg-amber-50 border-amber-200 text-amber-800
            dark:bg-amber-500/10 dark:border-amber-400/25 dark:text-amber-200">
          <span className="flex-1">{printError}</span>
          <button onClick={() => setPrintError('')}
            className="text-[11px] font-bold uppercase tracking-wider opacity-70 hover:opacity-100">
            Dismiss
          </button>
        </div>
      )}

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
      {showRealtime && rtLeads && (
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
            /* The narrowing filters, as the reader sets them. Sending only the
               asset was the bug: picking Serie A narrowed every panel below to
               22,007 rows and left the card reporting 103,512 for the whole
               season. */
            franchise={filters.franchiseName || undefined}
            matchDay={filters.matchDay || undefined}
            /* Names for the caption in the card's corner. The filters above
               narrow the count; this is what tells the reader what it was
               narrowed TO. */
            assetNames={realtimeAssetNames}
            /* The window control on the card, and the strip along its bottom.
               Together they are what lets the card be on screen from the first
               paint: a day's count is cheap, and the strip is how a reader
               still knows what it does and does not cover. */
            windowOptions={REALTIME_WINDOWS}
            scopeFilters={realtimeScopeFilters}
            dimOptions={realtimeDimOptions}
            /* And back the other way: what the card's own pickers hold, so
               those lists can be re-listed under the scope the count actually
               has rather than the report's. */
            onDimsChange={onRtDimsChange}
            /* Which report this is, so the card is folded the way THIS
               section's layout says — the platform list is a per-report
               setting, like the width and the title below. */
            platformKey={section}
            waitingFor={rtWaitingFor}
            /* The name and the note Report Configuration gave it. `title` falls
               back to the card's own heading and `desc` to nothing, which is
               what an unconfigured panel — and an older server — sends. */
            title={rtPanel?.label || undefined}
            desc={rtPanel?.desc}
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
          {...{ [PRINT_HIDE_ATTR]: '' }}
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
        <main ref={printMain} className="w-full xl:flex-1 xl:min-w-0 space-y-3 sm:space-y-4">

          {/* The KPI band is a panel like any other now — it is drawn inside the
              layout below, so it can be moved or hidden along with the charts
              rather than being pinned above them. */}
          {!activeSection ? (
            <Notice cardTitle="Reports"
              title={sections.length === 0 ? 'Loading reports…' : 'Choose a platform to begin'}
              body={sections.length === 0
                ? 'Fetching the available reports from the analytics warehouse.'
                : 'Pick a platform from the navigation on the left, then a client. The report then runs itself over the window that platform opens on.'} />
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
          ) : activeSection.sourceKind === 'powerbi' ? (
            /*
              ── AN EMBEDDED REPORT, AND NOTHING ELSE ──────────────────────

              Ahead of the loading branch and every panel below it, because this
              report has none of what they draw. A Power BI report is not a
              result set: there are no KPI tiles to fill, no breakdowns to
              cross-filter and no window to honour, so drawing the band and the
              charts produced a page of "No figure for this period" over a
              report that was never going to answer them.

              The server has already resolved WHICH report — see
              handlers/reportpowerbi.go — out of the assignment made for this
              client under Dashboards. What arrives here is the reference, or a
              reason there is not one.
            */
            <Card title={activeSection.label}>
              {loading ? (
                <ReportLoader fill label="Opening the report"
                  sublabel={activeSection.label} />
              ) : data?.powerbi?.link ? (
                <PowerBIReport reportRef={String(data.powerbi.link)}
                  title={String(data.powerbi.moduleName || activeSection.label)} />
              ) : (
                /* The two ways this has nothing to show are different problems
                   with different owners — no dashboard chosen for the platform,
                   or none assigned to this client — and the server says which.
                   Printed as sent rather than replaced with one sentence
                   covering both. */
                <div className="px-5 py-12 text-center">
                  <p className="font-bold text-[#14254A] dark:text-white mb-1.5">
                    This report is not available yet
                  </p>
                  <p className="text-sm max-w-md mx-auto leading-relaxed text-gray-500 dark:text-white/45">
                    {err || 'No Power BI report has been assigned for this client.'}
                  </p>
                </div>
              )}
            </Card>
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
                {gridPanels.map(renderPanel)}
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
            /* The REASON rides on the title attribute rather than the face of
               the card. It is already in the payload — redacted of warehouse
               names by reportsources.go — so hiding it from the markup was
               hiding it from the one person on the page who might act on it,
               while still shipping it to the browser. On the title it is a hover
               away for whoever needs it and absent from the report for everyone
               else, and it is now in the server log as well. */
            <div title={String(data.queryWarning)}
              className="rounded-xl px-4 py-3 text-sm border bg-amber-50 border-amber-200 text-amber-800
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
        {/*
            NOT DRAWN FOR AN EMBEDDED REPORT.

            A Power BI report honours none of this: the date range and every
            slicer here become a query string the server discards, so a rail
            offering them would be a set of controls whose only visible effect
            is nothing. The report carries its own filters — see the panes
            settings in PowerBIReport — and two sets that do not know about each
            other is worse than one.

            Same inset as the navigation rail otherwise, and for the same reason
            — the live card above spans both of them. See railInset.
        */}
        {activeSection?.sourceKind !== 'powerbi' && (
        <aside {...{ [PRINT_HIDE_ATTR]: '' }} style={railInset}
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
        )}
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
                {/* In-flight only. The clock time of the last run used to sit
                    here once the run finished, and it answered a question
                    nobody was asking: the figures are re-fetched as the
                    slicers move, so "now" is the only answer it ever had. */}
                <span className="text-[11px] text-gray-400">
                  {loading ? 'Running…' : ''}
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
