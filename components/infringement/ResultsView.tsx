'use client'

/*
 * The infringement results view — one record card, one detail drawer, one
 * screenshot lightbox, shared by every screen that lists infringements.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * There were two of these. The category screen
 * (app/(client)/infringement/category/page.tsx) grew the version below; the
 * single-platform screen (app/(client)/infringement/[platform]/page.tsx) kept an
 * older one, and the two drifted in the way two copies always do — not by
 * looking slightly different, but by SAYING DIFFERENT THINGS about the same row:
 *
 *   · the drawer. The category drawer shows every field the row carries,
 *     grouped into Overview / Links / Enforcement / Reach / Content / Discovery
 *     and derived from the row itself. The platform drawer showed a hand-written
 *     list of seventeen named fields, so anything a platform returned that was
 *     not on that list — and each platform returns a different subset — simply
 *     was not on the screen. Facebook, Instagram, X, Telegram and Open Web each
 *     lost a different set of columns, which is exactly the report of "data
 *     points differ per platform".
 *   · the card. The category card shows the post title, the published date, the
 *     country and the comment count; the platform card showed none of them and
 *     showed a "Post URL" row that repeated the link already above it.
 *   · the screenshot. The category card opens it full size; the platform card
 *     opened the raw S3 link in a tab, which is a credential-length URL and,
 *     once the signature expires, a 403 page.
 *
 * lib/infringementFields.ts already exists because the two screens must READ a
 * row the same way. This is the other half of that argument: they must DRAW it
 * the same way too.
 *
 * ── What each screen still owns ──────────────────────────────────────────────
 *
 * Fetching, and the page around the list. The category screen asks several
 * platforms at once and tabs between them; the single-platform screen asks one
 * and filters it by Open Web URL type. Neither of those is presentation, and
 * neither is here.
 *
 * ── Two things this version does that the category page did not ──────────────
 *
 * Dark mode, and time zones. Both came from the single-platform screen and both
 * are corrections rather than preferences, so unifying on the category design
 * without them would have been a regression for one screen dressed up as
 * consistency:
 *
 *   · Every surface here carries its `dark:` pair. The category page was written
 *     light-only, and on a dark theme it was white cards on a navy page.
 *   · Dates go through the portal's time-zone preference (lib/timezone.tsx).
 *     The category page called `new Date(s)` on a zone-less warehouse stamp,
 *     which the browser reads as LOCAL — so a discovery logged at 09:00 UTC
 *     read as 09:00 in Delhi and 09:00 in London, and one of those is four and
 *     a half hours wrong.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Portal from '@/components/ui/Portal'
import InfoDot from '@/components/shared/InfoDot'
import AlertDialog from '@/components/ui/AlertDialog'
import { useTimeZone } from '@/lib/timezone'
import { resolveFields, isLiveStatus } from '@/lib/infringementFields'
/* The turnaround a record took, measured by exactly the rule the War Room's
   TAT charts measure by — including Open Web's de-indexing/removal split.
   Imported rather than reimplemented: a drawer that disagreed with the chart
   about the same row would be two answers to one question. */
import { diffTatMins, effectiveRemovalTime } from '@/lib/warroom'
import { isOpenWebPlatform } from '@/lib/platformCategories'
import { downloadCsv, type CsvColumn } from '@/lib/exportCsv'
import { downloadXlsx } from '@/lib/exportXlsx'

export const PAGE_SIZES = [10, 25, 50, 100]

/** One platform's answer to a search. The category screen holds several of
    these; the single-platform screen builds one. */
export interface PlatformResult {
  platform: string
  items: Record<string, any>[]
  total?: number
  error?: string
}

/* ── Column derivation ──────────────────────────────────────────────────────
   A platform's fields are whatever its rows actually carry. Three rules make
   that readable rather than a raw dump:

   · a key only counts if SOME row has a value for it — every endpoint returns a
     wide envelope of nulls, and counting those would promise fields that are
     never there,
   · objects and arrays are skipped at column level, because a cell is one
     value; the drawer shows them in full,
   · the fields a reader looks for first are pulled to the front, and everything
     else keeps the order the API sent, which is usually meaningful. */

export const LEAD_COLUMNS = [
  'assetName', 'infringementType', 'removalStatus', 'currentStatusName',
  // The URLs stay together wherever they are drawn. A row's links are read as a
  // set: the page, the file, and whose account posted it.
  'infringingURL', 'sourceURL', 'videoURL', 'postURL', 'listingUrl',
  'profileURL', 'profileUrl', 'channelURL', 'channelOrProfileURL', 'shopUrl',
  'infringingDomain', 'sourceDomain', 'channelName', 'profileName', 'videoTitle',
  'urlUploadDate', 'publishedDate',
]

/** Never shown, anywhere. Internal ids carry nothing a client can act on, and
    `isComplete` is a pipeline flag rather than a fact about the infringement. */
export const HIDDEN_COLUMN =
  /^(id|.*guid|clientId|clientMasterId|assetId|rowNo|rowNumber|isComplete)$/i

/*
WHO did it, inside IP House — never shown either.

discoveryDoneBy, enforcementDoneBy, enforcementQCDoneBy and removalDoneBy name
the analyst who actioned a record, or the bot that did: "Deepanshu Kumar
(DEEPANSHU.KUMAR)", "Facebook Platform Enforcement BOT". That is our staffing,
on a client's screen, next to their infringement — a named employee and their
internal username, published to an outside company by a field nobody decided to
publish. It also tells a reader nothing they can act on.

The matching TIMES stay. enforcementDoneAt and removalTime are the record of
what happened and when, which is exactly what a client is entitled to; only the
name attached to it goes.

Matched on the PATTERN rather than by listing the keys, so a stage added
upstream is hidden the day it appears rather than the day somebody notices.

Anchored at the end once, and no longer. Enumerated across this repo and the
analytics one the platform tables live in, the known set is discoveryDoneBy,
discoveryQCDoneBy, enforcementDoneBy, enforcementQCDoneBy and removalDoneBy —
all of which the anchored version caught. But `discoveryQCDoneBy` appears only
in the other repo, which is the point: this list is not ours to know in full. A
`doneByBot` or an `enforcementDoneByName` would have walked straight past a
suffix match and published a colleague's name to a client, so the match is now
anywhere in the key.
*/
export const OPERATOR_COLUMN = /done_?by/i

/*
The QC gate, which is ours and not the record's.

enforcementQCDoneAt is when an IP House reviewer checked a notice before it went
out. Its "By" half is already hidden by the rule above; the timestamp is the
other half of the same internal step, and on its own it is worse than useless —
a bare date in the Enforcement section, between "found" and "sent", describing
an event the reader has no name for and cannot act on.

The stages that ARE the record's story all stay: discoveryDoneAt (found),
enforcementDoneAt (notice sent), removalTime (came down). Those are the audit
trail a client is owed. Our internal review of our own work is not part of it.
*/
export const QC_COLUMN = /qc_?done/i

/** Whether a field is kept from the reader entirely. */
export const isHiddenField = (key: string) =>
  HIDDEN_COLUMN.test(key) || OPERATOR_COLUMN.test(key) || QC_COLUMN.test(key)

/*
── One arrival date, not two ────────────────────────────────────────────────

	discoveryDoneAt and urlUploadDate both answer "when did this show up", within
	minutes of each other, and a record showing both makes a reader work out
	which one they are meant to read — and then wonder what the difference is
	between two timestamps the screen is presenting as equals.

	urlUploadDate wins where a row has one. It is the record's own date rather
	than our pipeline's, it is what resolveFields reads for `discovered`, and it
	is what the results lists already print under the word "Discovered" — so the
	drawer and the list agree about which timestamp that word refers to.

	CONDITIONAL, not a blanket hide, which is the whole point of doing it here
	rather than in isHiddenField: a row carrying only the pipeline stamp still
	shows it, because the alternative is a record with no arrival date at all.
	The rule is "whichever one you have, and the better one if you have both".
*/
const ECLIPSED_BY: Record<string, string[]> = {
  discoveryDoneAt: ['urlUploadDate', 'URLUploadDate'],
}

/** Whether a field is dropped because a better field on the SAME row says it. */
export function isEclipsed(key: string, row: Record<string, any>): boolean {
  const preferred = ECLIPSED_BY[key]
  return !!preferred && preferred.some(k => hasValue(row?.[k]))
}

export const isScalar = (v: any) =>
  v === null || v === undefined || (typeof v !== 'object' && typeof v !== 'function')

export const hasValue = (v: any) =>
  v !== null && v !== undefined && String(v).trim() !== '' &&
  String(v) !== 'null' && String(v) !== 'undefined'

export const isUrl = (v: any) => typeof v === 'string' && /^https?:\/\//i.test(v.trim())

/** Fields that hold a picture rather than a link to read. Matched on the KEY,
    because the value is a signed S3 URL — several hundred characters of
    credential and signature that say nothing about what it points at. */
export const isImageKey = (key: string) =>
  /screenshot|thumbnail|thumb|image|snapshot/i.test(key)

export function deriveColumns(rows: Record<string, any>[]): string[] {
  const order: string[] = []
  const useful = new Set<string>()
  // Sampling the first 50 rows is enough to learn a shape and keeps a
  // thousand-row page from walking every key of every row.
  for (const row of rows.slice(0, 50)) {
    for (const k of Object.keys(row)) {
      if (isHiddenField(k)) continue
      if (!order.includes(k)) order.push(k)
      if (isScalar(row[k]) && hasValue(row[k])) useful.add(k)
    }
  }
  const cols = order.filter(k => useful.has(k))
  const images = cols.filter(isImageKey)
  const lead = LEAD_COLUMNS.filter(k => cols.includes(k) && !isImageKey(k))
  const rest = cols.filter(k => !images.includes(k) && !lead.includes(k))
  return [...images, ...lead, ...rest]
}

/** "infringingURL" → "Infringing URL". Upstream names are camelCase and the
    acronyms in them (URL, DMCA, TAT, UGC) must survive the split. */
export function humanise(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/*
── Open Web's own vocabulary ────────────────────────────────────────────────

	Open Web is the one place where the warehouse's field names are actively
	misleading, because a result there is a PAIR of pages: the page carrying the
	link, and the host serving the file behind it. The upstream names describe
	that pair from the pipeline's point of view rather than the reader's:

	  infringingURL / postURL  → the page holding the link      → Linking URL
	  sourceURL                → the host serving the file      → Host URL
	  infringingDomain         → the domain of the linking page → Linking Domain
	  sourceDomain             → the domain of the host         → Host Domain

	"Post URL" is worse than merely vague here: on Open Web there is no post.
	And "Source URL" reads as "where this came from" when it means the opposite
	end of the pair from the one that word suggests — which is exactly the
	confusion the Open Web report's own linking/host split exists to avoid.

	OPEN WEB ONLY. On Facebook or TikTok a post really is a post and there is no
	host behind it, so the same rename there would replace one true name with
	another platform's. Keyed lowercase because the same field arrives as
	`infringingURL`, `InfringingURL` and `infringingUrl` depending on the
	endpoint.
*/
const OPEN_WEB_FIELD_LABELS: Record<string, string> = {
  infringingurl: 'Linking URL',
  posturl: 'Linking URL',
  url: 'Linking URL',
  sourceurl: 'Host URL',
  hosturl: 'Host URL',
  infringingdomain: 'Linking Domain',
  infringinghost: 'Linking Domain',
  sourcedomain: 'Host Domain',
  sourcehost: 'Host Domain',
}

/*
── Names the warehouse sends as one word ────────────────────────────────────

	Open Web's columns arrive lowercased and unseparated — `removalstatus`,
	`dmcaremovalstatus`, `delistingremovalstatus` — and humanise() splits on a
	case change, so with no case to change it handed the label straight back:
	"Removalstatus", "Dmcaremovalstatus", "Delistingremovalstatus". Those are not
	words, and they were the label on a drawer card, a table header and a column
	in every CSV and XLSX this screen exports.

	Keyed lowercase because the SAME column arrives as `removalStatus` from the
	social endpoints and `RemovalStatus` from others; all three spellings landing
	on one label is the point of doing it here rather than per platform.
*/
const RUN_ON_LABELS: Record<string, string> = {
  removalstatus:          'Removal Status',
  dmcaremovalstatus:      'DMCA Removal Status',
  delistingremovalstatus: 'Delisting Removal Status',
  profileremovalstatus:   'Profile Removal Status',
}

/** What the card calls the linking page, per platform. Open Web has no "post". */
export function postUrlLabel(openWeb: boolean, mediaOnly: boolean): string {
  if (mediaOnly) return 'Media File'
  return openWeb ? 'Linking URL' : 'Post URL'
}

/**
 * What the card calls `sourceURL`.
 *
 * The card said "Host URL" on every platform while the drawer, which names
 * fields through columnTitle, said "Source URL" on everything but Open Web — so
 * a Telegram record showed the same t.me link under two different names half a
 * click apart. "Host" is Open Web's word for the far end of its pair; on
 * Telegram there is no pair and no host, and the field is just what MarkScan
 * calls it. Routed through columnTitle so the two can only ever agree.
 */
export function hostUrlLabel(openWeb: boolean): string {
  return columnTitle('sourceURL', openWeb)
}

/** The label a field shows. An image field drops its "URL" suffix — the value
    is a picture here, and "Screenshot URL" over a thumbnail names the wrong
    thing. `openWeb` switches in the vocabulary above. */
export function columnTitle(key: string, openWeb = false): string {
  if (openWeb) {
    const renamed = OPEN_WEB_FIELD_LABELS[key.toLowerCase()]
    if (renamed) return renamed
  }
  const runOn = RUN_ON_LABELS[key.toLowerCase()]
  if (runOn) return runOn
  const label = humanise(key)
  return isImageKey(key) ? label.replace(/\s*urls?$/i, '') : label
}

/**
 * Turning a raw value into text, with dates in the reader's own zone.
 *
 * A hook rather than a bare function because the zone is context — see the note
 * at the top of this file. `formatUtc` parses the warehouse's zone-less stamp AS
 * UTC and renders it in the country the header is set to, which is the whole
 * difference between this and the `new Date(s)` the category page used to do.
 *
 * Everything that is not a date is passed through untouched: guessing at a
 * format loses information, and these values are the record.
 */
export function useCellText() {
  const { formatUtc } = useTimeZone()
  return (v: any): string => {
    if (!hasValue(v)) return '—'
    if (typeof v === 'boolean') return v ? 'Yes' : 'No'
    const s = String(v)
    if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(s)) return formatUtc(s, { fallback: s })
    return s
  }
}

/**
 * What zone the dates on this screen are in, said out loud.
 *
 * Every timestamp the API returns is UTC. This screen converts them — see
 * useCellText — and until now that conversion was invisible: a reader in Delhi
 * and a reader in London saw different clock times against the same record with
 * nothing on the page to say why, and neither could tell whether they were
 * looking at a local time or at the warehouse's own.
 *
 * So the zone is named, with the full statement behind the ⓘ: the data is UTC,
 * this is what it is being shown in, and this is where that came from — a
 * country picked by hand, the network, the device, or the browser's own setting.
 * Naming the SOURCE matters as much as naming the zone: "IST" is a fact about
 * the display, "detected from your network" is what tells a reader whether it is
 * the zone they meant.
 */
export function TimeZoneNote({ className = '' }: { className?: string }) {
  const { zone, country, source } = useTimeZone()

  /* The short name, from the zone itself rather than a table: "IST", "BST",
     "PDT" — and it follows daylight saving, which a stored abbreviation would
     not. Computed against today, since that is the reading it labels. */
  const abbr = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(new Date())
        .find(p => p.type === 'timeZoneName')?.value ?? ''
    } catch {
      return ''
    }
  }, [zone])

  const how: Record<string, string> = {
    picked: 'the country chosen in the site header',
    network: 'your network location',
    located: 'your device location',
    browser: "this browser's own time-zone setting",
  }
  const where = country?.name ? `${country.name} — ${zone}` : zone
  const shown = abbr && abbr !== zone ? `${abbr}` : zone

  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold text-gray-400 ${className}`}>
      Times in {shown}
      <InfoDot text={
        'Every date and time on this page comes from the API in UTC.\n\n' +
        `They are shown converted to ${where}${abbr ? ` (${abbr})` : ''}, ` +
        `taken from ${how[source] ?? 'your browser'}.\n\n` +
        'Change it with the globe in the site header — the underlying data is ' +
        'unchanged, only how it is displayed.'
      } />
    </span>
  )
}

/*
── Flags, read as answers rather than as storage ────────────────────────────

	isClientShared and isInvalid came back as "true" and "false", and before that
	as 1 and 0 depending on which endpoint answered — three spellings of two
	answers, none of which is how anyone asks the question. "Is Client Shared:
	true" is a database row printed on a screen; "Is Client Shared: Yes" is the
	answer to it.

	Both encodings are accepted because both arrive: MarkScan's JSON carries
	real booleans on some platforms and 1/0 on others for the same field, and a
	renderer that understood only one of them would print "Yes" on Facebook and
	"1" on Telegram for the same fact.

	Only fields that ASK something are converted — a key beginning "is" or
	"has". A bare 1 elsewhere is a count, an id or a rating, and answering "Yes"
	to it would be worse than leaving it alone.
*/
export const isFlagKey = (key: string) => /^(is|has)[A-Z_]/.test(key) || /^(is|has)[a-z]+$/i.test(key)

/** "Yes", "No", or null when the value is not one of the two encodings. */
export function flagText(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true' || s === '1') return 'Yes'
  if (s === 'false' || s === '0') return 'No'
  return null
}

/* ── Detail grouping ────────────────────────────────────────────────────────
   A flat list of twenty key/value pairs is a data dump, not a record. These
   sections are the questions someone actually asks of a row, in the order they
   ask them: what is it, where is it, how big was it, what have we done about
   it. First match wins, so the order below is the classification. */
export const FIELD_GROUPS: { title: string; match: RegExp }[] = [
  { title: 'Overview',    match: /^(assetName|infringementType|infringementTypeName|platform|isSourceURL)$/i },
  { title: 'Links',       match: /(url|uri|link)$/i },
  /* `enforce` earns its place here: enforcementTime is the stamp saying a
     notice actually went out, and without the word it fell through to Discovery
     — which matches on "time" — and sat among the upload and creation dates as
     though it described when the row was found. It is the first step of the
     enforcement funnel, not a discovery date. */
  { title: 'Enforcement', match: /(removal|delist|dmca|takedown|notice|status|enforce)/i },
  { title: 'Reach',       match: /(view|like|comment|subscriber|follower|member|share|rating|review|buy)/i },
  { title: 'Content',     match: /(title|type|language|quality|duration|length|keyword|genre|caption|description|price|currency)/i },
  /* `discover` earns its place for the same reason `enforce` did in the line
     above: discoveryDoneAt carries neither "date" nor "time" in its name, so it
     landed in Other — the stamp saying when a record was FOUND, filed under
     "unclassified", two sections below the stamp saying when it was actioned. */
  { title: 'Discovery',   match: /(date|time|country|domain|host|engine|channel|profile|seller|page|discover)/i },
]

export function groupOf(key: string): string {
  for (const g of FIELD_GROUPS) {
    if (!g.match.test(key)) continue
    /* A yes/no flag is never a REACH metric, whatever words are in its name.
       "isClientShared" contains "share" and was therefore filed among the view
       counts and the subscriber totals — as though whether a record had been
       shared with the client were a measure of how far the infringement had
       travelled. Reach is counts; a flag is a fact about the record. */
    if (g.title === 'Reach' && isFlagKey(key)) continue
    return g.title
  }
  return 'Other'
}

/** Sections in reading order, with anything unclassified last. */
export const GROUP_ORDER = [...FIELD_GROUPS.map(g => g.title), 'Other']

export const isCountKey = (key: string) =>
  /(count|views|likes|comments|subscribers|followers|members|shares)$/i.test(key)

/* ── The record's chronology ────────────────────────────────────────────────

	Five stamps tell a row's whole story — found, notice sent, de-indexed, DMCA
	answered, taken down — and until now they were scattered across two sections:
	the arrival dates in Discovery among the country and the search engine, the
	action dates in Enforcement among the statuses. A reader who wanted the order
	of events had to assemble it from opposite ends of the panel, and know which
	word belonged to which stage.

	So the times come out of both groups into one, in two lanes — when it showed
	up, and what we did about it — followed by the gaps between them, which is the
	number anyone actually asks for.

	Matched on the KEY rather than by listing columns, because each platform
	spells its stamps differently and a fixed list would quietly drop the ones it
	had not been told about — which is the failure this whole file exists to
	avoid.
*/
/* A bare "at"/"on" suffix is not enough: `takedownReason` ends in "on" and is
   an Enforcement field, so a looser test filed a sentence in the timeline. The
   suffix only counts across a case or underscore boundary — `discoveryDoneAt`,
   `updatedOn`, `created_at` — which is how a stamp is actually spelled. */
export const isTimestampKey = (key: string) =>
  /(time|date)/i.test(key) || /_(at|on)$/i.test(key) || /[a-z](At|On)$/.test(key)

/** When the record arrived: uploaded, published, discovered, created. */
export const isDiscoveryTimeKey = (key: string) =>
  isTimestampKey(key) && /(upload|publish|discover|detect|created)/i.test(key)

/** What we did about it, and when. A status is an outcome rather than a time
    — see isOutcomeStatusKey, which puts those beside the screenshot instead. */
export const isEnforcementTimeKey = (key: string) =>
  isTimestampKey(key) && groupOf(key) === 'Enforcement' && !/status$/i.test(key)

/*
	The outcome statuses — de-indexing, DMCA, removal.

	These ride BESIDE the screenshot rather than waiting in a section three
	scrolls down. They are the answer to the only question a reader opens a
	record to ask — did anything happen to this — and setting them level
	with the evidence means the picture and the verdict are read in one glance.
*/
export const isOutcomeStatusKey = (key: string) =>
  groupOf(key) === 'Enforcement' && /(status|statusname)$/i.test(key)

/** De-indexing first, then DMCA, then removal: the order the pipeline runs. */
const OUTCOME_ORDER = [/delist/i, /dmca/i, /removal/i]
export const outcomeRank = (key: string): number => {
  const i = OUTCOME_ORDER.findIndex(re => re.test(key))
  return i === -1 ? OUTCOME_ORDER.length : i
}

/*
	The order the stamps go in, which is not the order they arrive in.

	The endpoint serialises its columns however it serialises them, and on Open
	Web that put Delisting Time, DMCA Removal Time, Enforcement Time, Removal
	Time in exactly that order — the notice third, two stages after the outcome
	it caused. A section calling itself a timeline has to be in time order or it
	is a list with a misleading heading, so the lanes rank their fields by the
	stage each one names.

	Ranked by NAME rather than by sorting on the values, because the values are
	mostly absent: an unenforced row has one stamp and four blanks, and sorting
	those would shuffle the blanks to one end and lose the shape of the funnel.
*/
const DISCOVERY_TIME_ORDER = [/publish|created/i, /upload/i, /discover|detect/i]
export const discoveryTimeRank = (key: string): number => {
  const i = DISCOVERY_TIME_ORDER.findIndex(re => re.test(key))
  return i === -1 ? DISCOVERY_TIME_ORDER.length : i
}

const ENFORCEMENT_TIME_ORDER = [/enforce|notice/i, /delist/i, /dmca/i, /removal|takedown/i]
export const enforcementTimeRank = (key: string): number => {
  const i = ENFORCEMENT_TIME_ORDER.findIndex(re => re.test(key))
  return i === -1 ? ENFORCEMENT_TIME_ORDER.length : i
}

/** First key on the row carrying a real value, as trimmed text. */
const firstVal = (row: Record<string, any>, ...keys: string[]): string | null => {
  for (const k of keys) if (hasValue(row?.[k])) return String(row[k]).trim()
  return null
}

export interface RecordTat {
  discoveredAt: string | null
  enforcedAt: string | null
  /** The stamp that CLOSES the row, and only once the outcome it names has
      actually happened: an Open Web linking URL closes on de-indexing (and only
      where that was approved), a host URL and every other platform on removal.
      Null while the row is still open — which is a different fact from a
      missing timestamp, and is why the card reads "In progress". */
  closedAt: string | null
  /** What that closing stamp is called on THIS row. */
  closeLabel: string
  /** Minutes, or null when an end of the span is not there to measure from. */
  toEnforcement: number | null
  toClose: number | null
}

/**
 * The two turnarounds a single record took.
 *
 * Discovery → Enforcement is how long it sat before a notice went out.
 * Enforcement → close is how long that notice took to land, and WHAT counts as
 * landing depends on the row: an Open Web linking URL is de-indexed rather than
 * removed, so its clock stops at the de-indexing time. That is the rule
 * lib/warroom.effectiveRemovalTime already states for the aggregate charts, and
 * it is called here rather than restated so the two can only ever agree.
 */
export function recordTat(row: Record<string, any>, openWeb: boolean): RecordTat {
  const discoveredAt = firstVal(row,
    'urlUploadDate', 'URLUploadDate', 'urluploaddate',
    'discoveryDoneAt', 'publishedDate', 'PublishedDate', 'uploadDate', 'createdAt')
  const enforcedAt = firstVal(row,
    'enforcementTime', 'EnforcementTime', 'enforcementtime', 'enforcementDoneAt')

  // An Open Web row with no host URL is a linking URL — the pair's other end.
  const isSource = hasValue(firstVal(row, 'sourceURL', 'SourceURL', 'sourceUrl'))

  const closedAt = effectiveRemovalTime({
    platform: openWeb ? 'internet' : String(row['platform'] ?? ''),
    isSource,
    removalStatus: firstVal(row, 'removalStatus', 'removalstatus', 'RemovalStatus'),
    removalTime: firstVal(row, 'removalTime', 'RemovalTime'),
    delistingStatus: firstVal(row,
      'delistingStatus', 'delistingremovalstatus', 'delistingRemovalStatus'),
    delistingTime: firstVal(row, 'delistingTime', 'delistingDate'),
  } as any) ?? null

  return {
    discoveredAt,
    enforcedAt,
    closedAt,
    closeLabel: openWeb && !isSource ? 'De-Indexing' : 'Removal',
    toEnforcement: diffTatMins(discoveredAt, enforcedAt),
    toClose: diffTatMins(enforcedAt, closedAt),
  }
}

/** A span in the largest unit that still reads as a duration rather than as a
    number: minutes inside the hour, hours inside the day, days past it. */
export function formatDuration(mins: number): string {
  const m = Math.round(mins)
  if (m < 60) return `${m} min`
  if (m < 1440) {
    const h = Math.floor(m / 60), r = m % 60
    return r ? `${h} hr ${r} min` : `${h} hr`
  }
  let d = Math.floor(m / 1440)
  let h = Math.round((m % 1440) / 60)
  if (h === 24) { d += 1; h = 0 }
  return h ? `${d} d ${h} hr` : `${d} d`
}

/**
 * A measured gap, or the reason there is not one.
 *
 * A bare dash would say all three of "nothing has happened yet", "this stage
 * does not apply here" and "the figure failed to load" in the same mark, and
 * only one of those is ever true of a given row. So each is written out: a span
 * still open reads "In progress", a row not yet actioned reads what it is
 * waiting on, and a pair of stamps in the wrong order — a data fault rather
 * than a turnaround — refuses to be read as a duration at all.
 */
export function TatValue({ mins, start, end, pending }: {
  mins: number | null
  start: string | null
  end: string | null
  pending: string
}) {
  const muted = 'text-gray-300 dark:text-white/25'
  if (mins === null) return <span className={muted}>{start ? pending : 'Not recorded'}</span>
  if (mins < 0) {
    return (
      <span className={muted} title="The closing timestamp is earlier than the one it is measured from.">
        Not measurable
      </span>
    )
  }
  return <span className="tabular-nums" title={`${start} → ${end}`}>{formatDuration(mins)}</span>
}


/**
 * Tone for a status value.
 *
 * Deliberately conservative: only the vocabularies this pipeline actually uses
 * are coloured, and everything else stays neutral. A wrong colour on a status is
 * worse than no colour — green on a live infringement reads as "handled".
 */
export function statusTone(value: string): string {
  const v = value.toLowerCase()
  if (/\b(removed|dead|delisted|taken\s*down|complete|closed)\b/.test(v)) {
    return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-400/30'
  }
  if (/\b(pending|in\s*progress|processing|sent|submitted|awaiting|queued)\b/.test(v)) {
    return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-400/30'
  }
  return 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-white/5 dark:text-white/70 dark:border-white/15'
}

/** The image-off mark, at the same size a thumbnail occupies so rows stay
    aligned whether or not their screenshot survived. */
export function NoShot({ title = 'Screenshot not available' }: { title?: string }) {
  return (
    <span title={title}
      className="w-12 h-12 rounded-xl border border-dashed border-gray-200 bg-gray-50/80
        dark:border-white/15 dark:bg-white/[0.04]
        flex flex-col items-center justify-center gap-0.5 text-gray-300 dark:text-white/25 flex-shrink-0">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5-4 4" />
        <path d="m3 3 18 18" />
      </svg>
      <span className="text-[7.5px] font-bold uppercase tracking-wider leading-none">N/A</span>
    </span>
  )
}

/**
 * Screenshot thumbnail.
 *
 * These URLs are pre-signed and expire, so one that worked when the row was
 * fetched can fail an hour later — and a bare <img> renders that identically to
 * having no screenshot at all: an empty box. A failed load therefore becomes the
 * "not available" mark rather than falling back to the link, because the link is
 * several hundred characters of credential and signature that tell a reader
 * nothing and are not a screenshot worth putting on screen.
 *
 * `loading="lazy"` matters here — a hundred-row page would otherwise pull a
 * hundred full-size screenshots from S3 the moment it renders.
 */
export function Thumb({ src, onOpen }: { src: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false)
  // Reset when the row changes: a failed screenshot must not mark the next
  // record's as broken when the component is reused at the same position.
  useEffect(() => { setFailed(false) }, [src])

  if (!src || src === '—' || !isUrl(src)) return <NoShot title="No screenshot for this record" />
  if (failed) return <NoShot title="Screenshot expired or unavailable" />

  return (
    /* The row underneath opens the detail drawer, so a click meant for the
       screenshot must not also open it. */
    <button type="button" onClick={e => { e.stopPropagation(); onOpen() }} title="View screenshot"
      className="block w-12 h-12 rounded-xl overflow-hidden border border-gray-200 bg-gray-50
        dark:border-white/15 dark:bg-white/5
        hover:ring-2 hover:ring-[#FC934C]/60 transition-all flex-shrink-0">
      <img src={src} alt="Screenshot" loading="lazy" referrerPolicy="no-referrer"
        onError={() => setFailed(true)} className="w-full h-full object-cover" />
    </button>
  )
}

/**
 * One labelled URL on a card.
 *
 * Truncated at 80 characters with the whole thing on hover. These are share
 * links carrying tracking segments — the first eighty characters identify the
 * post, and the remaining two hundred push every other field off the row.
 *
 * The click is stopped: the card underneath opens the detail drawer, and a
 * reader clicking a link means the link.
 */
export function CardLink({ label, href }: { label: string; href: string }) {
  if (href === '—' || !href) return null
  return (
    <p className="text-xs truncate">
      <span className="text-gray-400">{label}: </span>
      <a href={href} target="_blank" rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        className="text-blue-600 dark:text-[#7cc0ff] hover:underline" title={href}>
        {href.length > 80 ? href.slice(0, 80) + '…' : href}
      </a>
    </p>
  )
}

/** One field in the drawer, drawn as what it is rather than as a string. */
export function DetailValue({ fieldKey, value, onPreview }: {
  fieldKey: string; value: any; onPreview?: (src: string) => void
}) {
  const cellText = useCellText()

  // Same rule as the card: a picture, or the mark saying there isn't one.
  if (isImageKey(fieldKey)) {
    if (!isUrl(value)) return <NoShot />
    const src = String(value).trim()
    return <Thumb src={src} onOpen={() => onPreview?.(src)} />
  }
  if (!isScalar(value)) {
    return <code className="text-[10px] text-gray-500 dark:text-white/50 break-all">{JSON.stringify(value)}</code>
  }
  if (isUrl(value)) {
    return (
      <a href={String(value)} target="_blank" rel="noopener noreferrer"
        className="text-[#0078D4] dark:text-[#7cc0ff] hover:underline break-all">{String(value)}</a>
    )
  }
  /* A yes/no field, answered — see isFlagKey. Set in the same muted weight as
     the rest rather than as a coloured chip: these are facts about the record's
     handling, not a status anyone is meant to scan for. */
  if (isFlagKey(fieldKey)) {
    const yn = flagText(value)
    if (yn) return <span className={yn === 'Yes' ? '' : 'text-gray-400 dark:text-white/40'}>{yn}</span>
  }
  const text = cellText(value)
  if (text === '—') {
    /* An enforcement field is kept when it is empty — see the drawer's entry
       filter — so it needs to say what empty MEANS. A bare dash beside
       "Enforcement Time" reads as a value that failed to load; "Not recorded"
       reads as the fact it is, which is that nothing has happened yet. */
    return (
      <span className="text-gray-300 dark:text-white/25">
        {groupOf(fieldKey) === 'Enforcement' ? 'Not recorded' : '—'}
      </span>
    )
  }

  if (/status$/i.test(fieldKey) && text.length <= 28) {
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-semibold ${statusTone(text)}`}>
        {text}
      </span>
    )
  }
  // Counts are compared, so they get separators and tabular figures; everything
  // else is left exactly as the platform sent it. No weight is set here — the
  // card around it decides how loud a figure should be.
  if (isCountKey(fieldKey) && isFinite(Number(value))) {
    return <span className="tabular-nums">{Number(value).toLocaleString()}</span>
  }
  return <span className="break-words">{text}</span>
}

/**
 * One field, as a card.
 *
 * The drawer used to be a two-column definition list, which reads as a form and
 * makes every field look equally important — a country and a view count sat at
 * the same weight. Cards separate them: a figure is set large enough to be read
 * across the panel, everything else stays at reading size, and each value has a
 * box of its own so a long one cannot be mistaken for the next field's label.
 */
export function FieldCard({ label, big, wide, children }: {
  label: string
  /** A countable figure — set large, because these are what get compared. */
  big?: boolean
  /** Takes the whole row: URLs and long text have nothing to gain from a third
      of the width and everything to lose to wrapping. */
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`rounded-xl border border-gray-100 bg-white dark:border-white/10 dark:bg-white/[0.04]
      px-3.5 py-2.5 min-w-0 shadow-sm ${wide ? 'col-span-2 md:col-span-3' : ''}`}>
      <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1 truncate" title={label}>
        {label}
      </p>
      <div className={`text-[#14254A] dark:text-white min-w-0 ${
        big ? 'text-lg font-extrabold leading-tight' : 'text-[13px] font-semibold break-words'}`}>
        {children}
      </div>
    </div>
  )
}

/**
 * The whole record, every field it carries.
 *
 * Derived from the row rather than from a written-out list, which is the point:
 * each platform's endpoint returns its own shape, and a fixed list can only ever
 * show the intersection. Anything the row holds and this file does not know
 * about still lands in a section — "Other" if nothing claims it — instead of
 * being dropped on the floor.
 */
/**
 * ONE RECORD, laid out.
 *
 * Split out of DetailDrawer so the Search & Retrieve screen can render the same
 * thing inline. That screen showed a record as one flat grid of grey boxes in
 * alphabetical order — thirty-four of them, a removal status sitting between a
 * record id and a report type, with no way to tell what the record SAYS from how
 * it was filed. It is the same record the drawer already knows how to present,
 * and presenting it twice in two ways was the only reason the two looked
 * different.
 *
 * The layout is: the evidence and the headline figures side by side, then the
 * fields grouped into the questions somebody actually asks of a row — what is it,
 * where is it, how big was it, what have we done about it.
 */
export function RecordDetail({ row, openWeb = false, onPreview, labelFor, hideField }: {
  row: Record<string, any>
  openWeb?: boolean
  onPreview: (src: string) => void
  /** A screen with its own vocabulary for a field. Search & Retrieve has a
      curated one ("Host URL", "De-Indexed Status") that beats humanising the
      raw key; anything it does not name falls back to columnTitle.

      NAMES ONLY. It cannot add a field, and there is no way to ask for one that
      the row does not carry — what is on screen is what the API answered, and
      nothing here can pad that out. */
  labelFor?: (key: string) => string | undefined
  /*
    A screen that hides MORE than the shared rule does.

    isHiddenField is the floor — internal ids, operator names, our own QC — and
    every screen honours it. This is a screen's own addition on top, for fields
    that are real and legitimate somewhere else but noise here.

    A predicate rather than a list, and additive rather than a replacement: a
    caller can only ever hide further, never un-hide something the shared rule
    keeps from a client. That direction is deliberate — the floor exists because
    of what happened when a field nobody had decided to publish reached a
    client's screen, and a prop that could lift it would be a way to do that
    again by accident.
  */
  hideField?: (key: string) => boolean
}) {
  const [shotFailed, setShotFailed] = useState(false)

  /*
    An empty field is dropped — EXCEPT an enforcement one.

    Everywhere else that rule is right: every endpoint returns a wide envelope
    of nulls, and a drawer listing forty blanks buries the eight fields that
    carry something.

    Enforcement is the exception because there, blank IS the answer. A Telegram
    row with `enforcementTime: null` has been found and not yet acted on, and
    dropping the field makes that indistinguishable from a platform that does
    not report enforcement at all — so the reader concludes the data is missing
    when what it says is "nothing has been sent yet". This is the same rule the
    live counts card states about removals: a figure of nothing is the strongest
    claim on the screen, and it must never be one that a hidden field made by
    accident.

    KEY PRESENCE, not value: a field the row does not carry is still absent, so
    this only ever un-hides something the platform actually reports.
  */
  const label = (k: string) => labelFor?.(k) || columnTitle(k, openWeb)

  const entries = Object.entries(row)
    .filter(([k, v]) => !isHiddenField(k) && !hideField?.(k) && (
      hasValue(v) || (!isScalar(v) && v != null) || groupOf(k) === 'Enforcement'))
    .filter(([k]) => !isEclipsed(k, row))

  const shot = entries.find(([k, v]) => isImageKey(k) && isUrl(v))

  /* What rides BESIDE the screenshot rather than waiting below it.

     A screenshot is tall and narrow — a phone-shaped capture in a half-screen
     panel leaves most of that row empty — so the rail beside it carries whatever
     a reader wants at the same moment as the picture.

     The OUTCOMES come first: de-indexing, DMCA, removal. They are the answer to
     the question a record is opened to ask — did anything happen to this — and
     they used to sit in the Enforcement section, below the fold on Open Web,
     with four timestamps between them. Reach counts fill whatever room is left,
     which on the social platforms is most of it, and a row reporting neither
     falls back to its overview so the rail is never empty beside a picture. */
  const outcomes = entries
    .filter(([k]) => k !== shot?.[0] && isOutcomeStatusKey(k))
    .sort(([a], [b]) => outcomeRank(a) - outcomeRank(b))
  const counts = entries.filter(([k, v]) =>
    k !== shot?.[0] && isCountKey(k) && isFinite(Number(v)))
  const hero = (outcomes.length > 0 || counts.length > 0
    ? [...outcomes, ...counts]
    : entries.filter(([k]) => k !== shot?.[0] && groupOf(k) === 'Overview')
  ).slice(0, 4)
  const heroKeys = new Set(hero.map(([k]) => k))

  /* The chronology, lifted out of Discovery and Enforcement into one section —
     see the note above isTimestampKey. Two lanes and a turnaround, and each
     lane keeps the row's own field order within it. */
  const discoveryTimes = entries
    .filter(([k]) => k !== shot?.[0] && !heroKeys.has(k) && isDiscoveryTimeKey(k))
    .sort(([a], [b]) => discoveryTimeRank(a) - discoveryTimeRank(b))
  const enforcementTimes = entries
    .filter(([k]) => k !== shot?.[0] && !heroKeys.has(k) && isEnforcementTimeKey(k))
    .sort(([a], [b]) => enforcementTimeRank(a) - enforcementTimeRank(b))
  const timeLanes = [
    { title: 'Discovery', fields: discoveryTimes },
    { title: 'Enforcement', fields: enforcementTimes },
  ].filter(l => l.fields.length > 0)
  const timeKeys = new Set([...discoveryTimes, ...enforcementTimes].map(([k]) => k))

  const tat = recordTat(row, openWeb)

  const sections = GROUP_ORDER
    .map(title => ({
      title,
      fields: entries
        // The screenshot at the top IS this field — listing it again below, as a
        // thumbnail of the picture already on screen, is the same thing twice.
        // Same for anything promoted into the rail beside it, and for the stamps
        // the timeline above already lays out in order.
        .filter(([k]) => k !== shot?.[0] && !heroKeys.has(k) && !timeKeys.has(k))
        .filter(([k]) => groupOf(k) === title)
        .sort(([a], [b]) => {
          const ra = LEAD_COLUMNS.indexOf(a), rb = LEAD_COLUMNS.indexOf(b)
          return (ra === -1 ? LEAD_COLUMNS.length : ra) - (rb === -1 ? LEAD_COLUMNS.length : rb)
        }),
    }))
    .filter(s => s.fields.length > 0)

  return (
      <div className="min-w-0">
        {/* The evidence and the headline figures, side by side: the capture
            on the left, the numbers that describe it on the right. Stacked
            below a tablet, where two columns would be two narrow ones. */}
        <div className="border-b border-gray-100 dark:border-white/10 bg-[#14254A]/[0.02] dark:bg-white/[0.02] p-4
          grid grid-cols-1 md:grid-cols-5 gap-3 items-start">
          <div className="md:col-span-3 min-w-0">
            {shot && !shotFailed ? (
              <button type="button" onClick={() => onPreview(String(shot[1]).trim())}
                title="View full size" className="group block w-full relative">
                <img src={String(shot[1]).trim()} alt="Screenshot" loading="lazy"
                  referrerPolicy="no-referrer" onError={() => setShotFailed(true)}
                  className="w-full max-h-80 object-contain rounded-lg" />
                <span className="absolute bottom-2 right-2 px-2 py-1 rounded-lg text-[10px] font-bold
                  bg-[#14254A]/80 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                  View full size
                </span>
              </button>
            ) : (
              /* An expired link is stated, not hidden: "there was never a
                 screenshot" and "we can no longer reach the one there was"
                 are different facts, and neither is a URL to read. */
              <div className="h-full min-h-[160px] rounded-lg border border-dashed border-gray-200 dark:border-white/15
                bg-white/60 dark:bg-white/[0.03] flex flex-col items-center justify-center gap-2 text-gray-300 dark:text-white/25 py-8">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5-4 4" />
                  <path d="m3 3 18 18" />
                </svg>
                <span className="text-[11px] font-semibold text-gray-400 text-center px-4">
                  {shotFailed ? 'Screenshot expired or unavailable' : 'No screenshot for this row'}
                </span>
              </div>
            )}
          </div>

          {hero.length > 0 && (
            <div className="md:col-span-2 grid grid-cols-2 md:grid-cols-1 gap-2.5 content-start">
              {hero.map(([k, v]) => (
                <FieldCard key={k} label={label(k)}
                  big={isCountKey(k) && isFinite(Number(v))}>
                  <DetailValue fieldKey={k} value={v} onPreview={onPreview} />
                </FieldCard>
              ))}
            </div>
          )}
        </div>

        {/* When it showed up, what we did about it, and how long each step took.
            Drawn before the rest because it is the record's spine: every other
            section describes the row, this one describes what happened to it. */}
        {timeLanes.length > 0 && (
          <section className="border-b border-gray-100 dark:border-white/10 bg-gray-50/60 dark:bg-white/[0.02]">
            <h3 className="px-5 pt-4 pb-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
              Timeline
            </h3>
            <div className="px-5 pb-4 space-y-3.5">
              {timeLanes.map(lane => (
                <div key={lane.title}>
                  <p className="text-[9px] font-bold uppercase tracking-widest text-[#FC934C]/80 mb-1.5">
                    {lane.title}
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
                    {lane.fields.map(([k, v]) => (
                      <FieldCard key={k} label={label(k)}>
                        <DetailValue fieldKey={k} value={v} onPreview={onPreview} />
                      </FieldCard>
                    ))}
                  </div>
                </div>
              ))}

              {/* The two gaps between those stamps. Named end to end rather than
                  as one word, because "TAT" alone does not say which two events
                  it spans — and on Open Web the second one ends at de-indexing
                  rather than at removal, which is the whole reason the label is
                  built from the row instead of written out. */}
              <div>
                <p className="text-[9px] font-bold uppercase tracking-widest text-[#FC934C]/80 mb-1.5">
                  Turnaround (TAT)
                </p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
                  <FieldCard label="Discovery → Enforcement">
                    <TatValue mins={tat.toEnforcement} start={tat.discoveredAt}
                      end={tat.enforcedAt} pending="Not enforced yet" />
                  </FieldCard>
                  <FieldCard label={`Enforcement → ${tat.closeLabel}`}>
                    <TatValue mins={tat.toClose} start={tat.enforcedAt}
                      end={tat.closedAt} pending="In progress" />
                  </FieldCard>
                </div>
              </div>
            </div>
          </section>
        )}

        {sections.map(section => (
          <section key={section.title}
            className="border-b border-gray-100 dark:border-white/10 last:border-0 bg-gray-50/60 dark:bg-white/[0.02]">
            <h3 className="px-5 pt-4 pb-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
              {section.title}
            </h3>
            {/* Three cards to a row, so most sections are one row and none is
                more than two. Nothing is truncated inside them — this is the
                place the full value is meant to be readable. */}
            <div className="px-5 pb-4 grid grid-cols-2 md:grid-cols-3 gap-2.5">
              {section.fields.map(([k, v]) => (
                <FieldCard key={k} label={label(k)}
                  big={isCountKey(k) && isFinite(Number(v))}
                  wide={isUrl(v) || (isScalar(v) && String(v ?? '').length > 40)}>
                  <DetailValue fieldKey={k} value={v} onPreview={onPreview} />
                </FieldCard>
              ))}
            </div>
          </section>
        ))}
      </div>
  )
}

export function DetailDrawer({ row, platform, onClose, onPreview }: {
  row: Record<string, any>
  platform: string
  onClose: () => void
  onPreview: (src: string) => void
}) {
  // Escape is handled by the page, not here: the screenshot lightbox can sit on
  // top of this panel, and two independent handlers would close both at once
  // when the reader meant to dismiss only the one in front.

  // Open Web names its two ends differently from every other platform - see
  // OPEN_WEB_FIELD_LABELS.
  const openWeb = isOpenWebPlatform(platform)

  const title = String(row['assetName'] ?? row['videoTitle'] ?? 'Infringement details')
  const status = String(row['removalStatus'] ?? row['currentStatusName'] ?? '').trim()

  return (
    <Portal>
      <style>{`@keyframes drawerIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
      <div className="fixed inset-0 z-[99998] flex justify-end backdrop-blur-[2px]"
        style={{ background: 'rgba(20,37,74,0.45)' }}
        role="dialog" aria-modal="true" aria-label="Infringement details"
        onClick={onClose}>
        {/* Half the viewport on a desktop, the whole of it on a phone - a
            half-width panel on a 380px screen is a column of two-word lines. */}
        <aside
          className="h-full w-full md:w-1/2 bg-white dark:bg-[#1a2d55] shadow-2xl flex flex-col"
          style={{ animation: 'drawerIn .22s ease-out' }}
          onClick={e => e.stopPropagation()}>

          <header className="px-6 py-4 border-b border-gray-100 dark:border-white/10 flex items-start justify-between gap-3
            bg-gradient-to-r from-[#14254A]/[0.04] to-transparent dark:from-white/[0.06]">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#FC934C]">{platform}</p>
              <h2 className="text-base font-extrabold text-[#14254A] dark:text-white leading-tight mt-0.5">{title}</h2>
              <div className="flex items-center gap-2 flex-wrap mt-2">
                {status && (
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md border
                    text-[11px] font-semibold ${statusTone(status)}`}>
                    {status}
                  </span>
                )}
                {/* The drawer is where the dates are read most closely - a
                    discovery, a publication, a removal and two enforcement
                    stamps - so it says which zone they are in rather than
                    leaving the reader to carry it from the list. */}
                <TimeZoneNote />
              </div>
            </div>
            <button onClick={onClose} aria-label="Close"
              className="w-8 h-8 grid place-items-center rounded-lg text-gray-400 hover:text-[#14254A]
                hover:bg-[#14254A]/[0.06] dark:hover:text-white dark:hover:bg-white/10 flex-shrink-0 text-sm">
              ✕
            </button>
          </header>

          {/* The record itself, in the same layout Search & Retrieve renders
              inline - see RecordDetail. The scroll is here, because in a
              full-height panel it is the fields that scroll, not the page. */}
          <div className="flex-1 overflow-y-auto">
            <RecordDetail row={row} openWeb={openWeb} onPreview={onPreview} />
          </div>
        </aside>
      </div>
    </Portal>
  )
}

/**
 * Screenshot at full size.
 *
 * Portalled so the backdrop covers the viewport rather than the page's content
 * box, and closed by the backdrop, the button or Escape — a picture opened by
 * accident should not need aim to get out of.
 */
export function ScreenshotPreview({ src, onClose }: { src: string; onClose: () => void }) {
  if (!src) return null
  return (
    <Portal>
      <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 backdrop-blur-sm"
        style={{ background: 'rgba(20,37,74,0.72)' }}
        role="dialog" aria-modal="true" aria-label="Screenshot"
        onClick={onClose}>
        <div className="max-w-[92vw] max-h-[92vh] flex flex-col items-center gap-3"
          onClick={e => e.stopPropagation()}>
          <img src={src} alt="Screenshot" referrerPolicy="no-referrer"
            className="max-h-[82vh] max-w-full object-contain rounded-xl shadow-2xl bg-white" />
          <div className="flex items-center gap-2">
            <a href={src} target="_blank" rel="noopener noreferrer"
              className="px-4 py-2 rounded-xl text-xs font-bold bg-white/95 text-[#14254A] hover:bg-white">
              Open original
            </a>
            <button onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-bold border border-white/40 text-white hover:bg-white/10">
              Close
            </button>
          </div>
        </div>
      </div>
    </Portal>
  )
}

/*
── Downloading the results ──────────────────────────────────────────────────

	Two different things, and the menu names them as two rather than hiding the
	difference behind one button:

	  LOADED DATA is what is on this screen right now — the rows already
	  fetched, in the columns the drawer shows, filtered exactly as the reader
	  filtered them. It is built in the browser and saved immediately, because
	  there is nothing to ask a server for.

	  COMPLETE DATA is the whole result set for the search, which nobody has
	  fetched — the list pages a thousand rows at a time and "load more" is how
	  it grows. So it cannot be a download at all: it is a REQUEST, prepared by
	  MarkScan in the background and collected later from the Download Data
	  page. The dialog says so, because a button labelled "download" that
	  produces no file is otherwise indistinguishable from one that failed.

	The row count sits on the first option for the same reason. "Download loaded
	data (1,000 rows)" against a search that found forty thousand is the only
	thing on the screen that tells a reader the two options are not two formats
	of the same export.
*/

/** The window a Complete Data request may cover, in days.

    Mirrors the rule the Download Data page enforces with its own date picker
    ("End date cannot be more than 1 month after start date") — a rule that
    lives only in that page's UI, not in POST /api/download, which accepts
    anything. So a request placed from here with a wider range would be taken
    and then, presumably, never come back. Rather than submit that quietly, a
    too-wide range is refused here with the same explanation and a way to the
    page where the picker enforces it. */
const MAX_REQUEST_DAYS = 31

const dayGap = (from: string, to: string): number => {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`)
  return isFinite(a) && isFinite(b) ? Math.round((b - a) / 86400e3) : 0
}

export interface DownloadContext {
  /** The platform as the API names it — what POST /api/download takes. */
  platform: string
  assetName?: string
  startDate?: string
  endDate?: string
}

type Format = 'csv' | 'xlsx'

export function DownloadMenu({ rows, label, openWeb, request }: {
  /** The rows as loaded — already filtered, in the order shown. */
  rows: Record<string, any>[]
  label: string
  openWeb: boolean
  /** What a Complete Data request would ask for. Omitted where a screen has no
      single search behind it, and the option is then not offered rather than
      offered and broken. */
  request?: DownloadContext
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<null | {
    tone: 'success' | 'info' | 'error'; title: string; body: React.ReactNode
    actions?: { label: string; onClick: () => void; primary?: boolean }[]
  }>(null)
  /* Where the button is, so the portalled menu can be placed against it.
     Measured as the menu opens rather than in an effect afterwards, so it never
     paints one frame in the wrong place. */
  const [rect, setRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const cellText = useCellText()

  useEffect(() => {
    if (!open) return
    /* Both refs, because the menu is NOT inside the button's subtree — it is
       portalled to <body>, and a mousedown in it would otherwise read as a
       click outside and close the menu before the item was chosen. */
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    /* The menu is measured once and pinned, so anything that moves the button
       leaves it stranded. Closing is the honest answer — the button is still
       there to reopen. Same rule InfoDot uses. */
    const onMove = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  /* The columns the file carries: every field these rows actually hold, named
     the way the drawer names them — so a column header in Excel matches the
     label on screen, Open Web's vocabulary included.

     Values go through cellText, which means DATES ARE EXPORTED AS DISPLAYED —
     converted into the reader's zone, matching the "Times in …" note above the
     list. The alternative is a file whose timestamps disagree with the screen
     they were exported from, which is the one thing an export must never do.
     The zone is named in the file name for the same reason. */
  const columns = useMemo<CsvColumn<Record<string, any>>[]>(
    () => deriveColumns(rows).map(key => ({
      key,
      label: columnTitle(key, openWeb),
      get: (row: Record<string, any>) => {
        const v = row?.[key]
        if (v === null || v === undefined) return ''
        if (!isScalar(v)) return JSON.stringify(v)
        return cellText(v)
      },
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, openWeb])

  function saveLoaded(format: Format) {
    setOpen(false)
    if (rows.length === 0) return
    const name = `${label}_infringements_loaded`
    if (format === 'csv') downloadCsv(name, columns, rows)
    else downloadXlsx(name, columns, rows, label)
  }

  async function requestComplete() {
    setOpen(false)
    if (!request) return

    const { platform, assetName = '', startDate = '', endDate = '' } = request

    // The same window rule the Download Data page applies — see MAX_REQUEST_DAYS.
    if (startDate && endDate && dayGap(startDate, endDate) > MAX_REQUEST_DAYS) {
      const q = new URLSearchParams({ platform, assetName, startDate, endDate })
      setDialog({
        tone: 'info',
        title: 'That range is too wide to request',
        body: (
          <>
            <p>
              A complete-data request covers at most one month, and this search
              spans {dayGap(startDate, endDate)} days.
            </p>
            <p>Open Download Data to pick a narrower window — your search is carried over.</p>
          </>
        ),
        actions: [
          { label: 'Open Download Data', primary: true,
            onClick: () => { window.location.href = `/download-request?${q}` } },
          { label: 'Cancel', onClick: () => setDialog(null) },
        ],
      })
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, assetName, startDate, endDate }),
      })
      const data = await res.json()
      if (!data?.success) {
        setDialog({
          tone: 'error',
          title: 'The request could not be placed',
          body: <p>{data?.error || 'The download service did not accept the request.'}</p>,
        })
        return
      }
      setDialog({
        tone: 'success',
        title: 'Request initiated',
        body: (
          <>
            <p>
              Your complete {label} data is being prepared. You will be notified
              here once it is ready to download.
            </p>
            <p>You can also track it on the Download Data page.</p>
          </>
        ),
        actions: [
          { label: 'View requests', primary: true,
            onClick: () => { window.location.href = '/download-request' } },
          { label: 'Stay here', onClick: () => setDialog(null) },
        ],
      })
    } catch (e: any) {
      setDialog({
        tone: 'error',
        title: 'The request could not be placed',
        body: <p>{e?.message || 'Network error.'}</p>,
      })
    } finally {
      setBusy(false)
    }
  }

  const item = 'w-full text-left px-3 py-2 rounded-lg text-[11.5px] font-semibold transition-colors ' +
    'text-gray-600 dark:text-white/75 hover:bg-[#14254A]/[0.06] dark:hover:bg-white/10 ' +
    'disabled:opacity-40 disabled:hover:bg-transparent'

  const MENU_W = 248

  return (
    <>
      <button ref={btnRef} type="button"
        onClick={() => {
          setRect(btnRef.current?.getBoundingClientRect() ?? null)
          setOpen(o => !o)
        }}
        aria-haspopup="menu" aria-expanded={open} disabled={busy}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors ${
          open
            ? 'border-transparent bg-[#14254A] text-white dark:bg-white/20'
            : 'border-gray-200 dark:border-white/15 text-[#14254A] dark:text-white/80 hover:border-[#FC934C]/60'}`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" />
        </svg>
        {busy ? 'Requesting…' : 'Download'}
      </button>

      {/* PORTALLED, and that is not decoration: the results card is
          `overflow-hidden` so its rounded corners can clip the divided rows,
          and a menu positioned inside it is cut off at the card edge with most
          of itself invisible. Same reason InfoDot portals its bubble out of the
          same card. Right-aligned to the button and clamped to the viewport, so
          the last platform tab on a narrow window does not open it off-screen. */}
      {open && rect && (
        <Portal>
        <div ref={menuRef} role="menu"
          className="fixed z-[9999] p-1.5 rounded-xl shadow-2xl border
            bg-white border-gray-200 dark:bg-[#1a2d55] dark:border-white/15"
          style={{
            width: MENU_W,
            top: rect.bottom + 6,
            left: Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8)),
          }}>

          <p className="px-3 pt-1.5 pb-1 text-[9px] font-bold uppercase tracking-widest text-gray-400">
            Loaded data · {rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'}
          </p>
          <button type="button" role="menuitem" className={item}
            disabled={rows.length === 0} onClick={() => saveLoaded('csv')}>
            Download CSV
          </button>
          <button type="button" role="menuitem" className={item}
            disabled={rows.length === 0} onClick={() => saveLoaded('xlsx')}>
            Download Excel (.xlsx)
          </button>

          {request && (
            <>
              <p className="px-3 pt-2.5 pb-1 mt-1 border-t border-gray-100 dark:border-white/10
                text-[9px] font-bold uppercase tracking-widest text-gray-400">
                Complete data
              </p>
              <button type="button" role="menuitem" className={item} onClick={requestComplete}>
                Request full export
              </button>
              {/* Said before the click, not only after it. The option costs a
                  wait, and a reader choosing between the two should know that
                  is the difference rather than discovering it in a dialog. */}
              <p className="px-3 pb-1.5 text-[10px] leading-snug text-gray-400">
                Every matching record, prepared in the background and collected
                from Download Data.
              </p>
            </>
          )}
        </div>
        </Portal>
      )}

      <AlertDialog open={!!dialog} tone={dialog?.tone} title={dialog?.title ?? ''}
        body={dialog?.body} actions={dialog?.actions} onClose={() => setDialog(null)} />
    </>
  )
}

export function pgRange(cur: number, tot: number): (number | '…')[] {
  if (tot <= 7) return Array.from({ length: tot }, (_, i) => i + 1)
  const pages: (number | '…')[] = [1]
  if (cur > 3) pages.push('…')
  for (let p = Math.max(2, cur - 1); p <= Math.min(tot - 1, cur + 1); p++) pages.push(p)
  if (cur < tot - 2) pages.push('…')
  pages.push(tot)
  return pages
}

/**
 * One platform's results: a card per record, its own paging, its own empty and
 * error states.
 *
 * A card and not a table. It WAS a wide table of seventeen columns, and at that
 * width every value truncated to nothing: a Facebook URL and a profile name both
 * became "https://www.facebook.com/per…". Platforms barely share columns either,
 * so the table changed shape between them and could not be scanned down a column
 * anyway — the one thing a table is for.
 *
 * The card shows what identifies a record — asset, type, the URLs, who posted
 * it, when it was found — at full width, and puts the status where the eye
 * lands. Everything else is one click away in the drawer.
 */
export function PlatformTable({ result, label, onPreview, onOpenRow, header, download }: {
  result: PlatformResult
  label: string
  onPreview: (src: string) => void
  onOpenRow: (row: Record<string, any>) => void
  /** Extra controls for the card's header bar — the single-platform screen puts
      its Open Web URL-type filter here, where the page it belongs to can own it
      without this component knowing what a URL type is. */
  header?: React.ReactNode
  /** What a Complete Data request would ask for. Absent and the menu offers the
      loaded-data exports alone — see DownloadMenu. */
  download?: DownloadContext
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const cellText = useCellText()
  /* Checked against BOTH names: the category screen hands in a display label
     ("Open Web") and the wire key ("internet") arrives on `result.platform`.
     categoryOf knows all three spellings, but only if it is given one. */
  const openWeb = isOpenWebPlatform(label) || isOpenWebPlatform(result.platform || '')

  /* Still derived, but only to say how many fields the record carries — the
     drawer is what shows them now. The card reads named fields through
     resolveFields rather than whichever columns happened to come back, which is
     what makes one layout work across platforms that share almost no columns. */
  const allColumns = useMemo(() => deriveColumns(result.items), [result.items])
  const totalPages = Math.max(1, Math.ceil(result.items.length / pageSize))
  const start = (page - 1) * pageSize
  const rows = result.items.slice(start, start + pageSize)

  /* Clamped, not reset.
     `result.items` changes identity on "load more" as well as on a new search,
     and snapping to page one there takes the reader back to the top of a list
     they were four pages into — for the sole reason that it got longer. Clamping
     keeps the page they were on whenever it still exists, and only moves them
     when it does not: a smaller result set, or a larger page size. Switching
     platform on the category screen remounts this component anyway (it is keyed
     on the platform), so a genuinely new list still opens at page one. */
  useEffect(() => {
    setPage(p => Math.min(p, Math.max(1, Math.ceil(result.items.length / pageSize))))
  }, [pageSize, result.items])

  return (
    <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-gray-100 dark:border-white/10 flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-bold text-[#14254A] dark:text-white flex items-center gap-2 flex-wrap">
          {label}
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#14254A]/5 text-[#14254A]/70
            dark:bg-white/10 dark:text-white/70 tabular-nums">
            {result.items.length.toLocaleString()} row{result.items.length === 1 ? '' : 's'}
          </span>
          {allColumns.length > 0 && (
            <span className="text-[10px] font-semibold text-gray-400">
              click a record for all {allColumns.length} fields
            </span>
          )}
          {/* Beside the row count rather than under the dates it qualifies: the
              cards each carry two or three timestamps, and a note repeated on
              every one of them is noise. Said once, for the list. */}
          <TimeZoneNote />
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          {header}
          <DownloadMenu rows={result.items} label={label} openWeb={openWeb}
            request={download} />
          {result.items.length > pageSize && (
            <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}
              aria-label={`Rows per page for ${label}`}
              className="text-[11px] font-semibold border border-gray-200 dark:border-white/15 rounded-lg px-2 py-1
                bg-white dark:bg-white/5 text-[#14254A] dark:text-white">
              {PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}
            </select>
          )}
        </div>
      </div>

      {result.error ? (
        <div className="px-5 py-6 text-sm text-red-700 dark:text-red-300 bg-red-50/60 dark:bg-red-500/10">
          <strong>This platform could not be searched.</strong>
          <p className="text-xs mt-1 opacity-90">{result.error}</p>
        </div>
      ) : result.items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-400">No infringements found for this platform.</p>
      ) : (
        <>
          <div className="divide-y divide-gray-100 dark:divide-white/10">
            {rows.map((row, i) => {
              /* The DISPLAY label, not the wire key. resolveFields uses it only
                 to ask isListingPlatform, which matches on "meta ads" and
                 "marketplace" — the names, not whatever slug the endpoint is
                 addressed by. Passing the key would quietly drop the price,
                 seller and rating fields on exactly those two platforms. */
              const f = resolveFields(row, label)
              const live = isLiveStatus(f.status)
              // The page carrying the infringement, whatever this platform calls
              // it — a post on Facebook, a linking page on the open web.
              const postUrl = f.linkUrl !== '—' ? f.linkUrl : f.videoUrl
              const postLabel = postUrlLabel(openWeb, f.videoUrl !== '—' && f.linkUrl === '—')

              return (
                <div key={start + i}
                  onClick={() => onOpenRow(row)}
                  role="button" tabIndex={0}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenRow(row) }
                  }}
                  title="Open the full details"
                  className="group flex items-start gap-4 px-5 py-4 cursor-pointer transition-colors
                    hover:bg-[#FC934C]/[0.06] dark:hover:bg-white/5
                    focus:outline-none focus-visible:bg-[#FC934C]/[0.10] dark:focus-visible:bg-white/10">
                  <Thumb src={f.screenshot} onOpen={() => onPreview(f.screenshot)} />

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#14254A] dark:text-white truncate">
                      {f.asset !== '—' ? f.asset : label}
                      {f.type !== '—' && <span className="text-gray-400 font-normal"> — {f.type}</span>}
                    </p>

                    {/* The title of the post, where there is one and it is not
                        just the asset name repeated. */}
                    {f.videoTitle !== '—' && f.videoTitle !== f.asset && (
                      <p className="text-xs text-gray-500 dark:text-white/50 truncate mt-0.5" title={f.videoTitle}>
                        {f.videoTitle}
                      </p>
                    )}

                    <div className="mt-1 space-y-0.5">
                      <CardLink label={postLabel} href={postUrl} />
                      <CardLink label={hostUrlLabel(openWeb)} href={f.hostUrl} />
                      {/* The account, by name — the URL is a credential-length
                          string that identifies nothing to a reader. */}
                      {f.profileUrl !== '—' && (
                        <p className="text-xs truncate">
                          <span className="text-gray-400">Profile: </span>
                          <a href={f.profileUrl} target="_blank" rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="text-blue-600 dark:text-[#7cc0ff] hover:underline" title={f.profileUrl}>
                            {f.channelName !== '—' ? f.channelName : f.profileUrl.slice(0, 60)}
                          </a>
                        </p>
                      )}
                      {f.profileUrl === '—' && f.channelName !== '—' && (
                        <p className="text-xs text-gray-500 dark:text-white/50 truncate">
                          <span className="text-gray-400">Profile: </span>{f.channelName}
                        </p>
                      )}
                    </div>

                    <p className="text-xs text-gray-400 mt-1.5">
                      {f.discovered !== '—' && <span>Discovered: {cellText(f.discovered)}</span>}
                      {f.published !== '—' && <span className="ml-3">| Published: {cellText(f.published)}</span>}
                      {f.language !== '—' && <span className="ml-3">| Lang: {f.language}</span>}
                      {f.country !== '—' && <span className="ml-3">| {f.country}</span>}
                      {f.subscribers !== '—' && (
                        <span className="ml-3">| Subscribers: {Number(f.subscribers).toLocaleString()}</span>
                      )}
                      {f.price !== '—' && <span className="ml-3">| Price: {f.price}</span>}
                      {f.comments !== '—' && f.comments !== '0' && (
                        <span className="ml-3">| Comments: {f.comments}</span>
                      )}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wide border ${
                      live
                        ? 'bg-green-100 text-green-700 border-green-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-400/30'
                        : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-white/5 dark:text-white/60 dark:border-white/15'}`}>
                      {f.status !== '—' ? f.status : 'Active'}
                    </span>
                    <button type="button"
                      onClick={e => { e.stopPropagation(); onOpenRow(row) }}
                      className="inline-flex items-center gap-1.5 text-xs font-bold whitespace-nowrap px-3 py-1.5
                        rounded-lg border border-[#14254A]/15 text-[#14254A] bg-white transition-all
                        hover:bg-[#14254A] hover:border-[#14254A] hover:text-white group-hover:border-[#14254A]/40
                        dark:bg-white/5 dark:border-white/15 dark:text-white/80 dark:hover:bg-white/15 dark:hover:text-white">
                      View Details
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-gray-100 dark:border-white/10 flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[11px] text-gray-400 tabular-nums">
                {start + 1}–{Math.min(start + pageSize, result.items.length)} of {result.items.length.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-bold border border-gray-200 dark:border-white/15
                    text-gray-500 dark:text-white/60 disabled:opacity-40 hover:text-[#14254A] dark:hover:text-white">
                  Prev
                </button>
                {pgRange(page, totalPages).map((p, i) =>
                  p === '…' ? (
                    <span key={`gap${i}`} className="px-1 text-[11px] text-gray-300 dark:text-white/25">…</span>
                  ) : (
                    <button key={p} onClick={() => setPage(p)}
                      aria-current={p === page ? 'page' : undefined}
                      className={`min-w-[26px] px-2 py-1 rounded-lg text-[11px] font-bold tabular-nums transition-colors ${
                        p === page
                          ? 'bg-[#14254A] text-white dark:bg-white/20'
                          : 'text-gray-500 dark:text-white/60 hover:text-[#14254A] dark:hover:text-white hover:bg-[#14254A]/[0.06] dark:hover:bg-white/10'}`}>
                      {p}
                    </button>
                  ))}
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-bold border border-gray-200 dark:border-white/15
                    text-gray-500 dark:text-white/60 disabled:opacity-40 hover:text-[#14254A] dark:hover:text-white">
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
