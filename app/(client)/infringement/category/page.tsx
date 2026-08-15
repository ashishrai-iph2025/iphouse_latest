'use client'

// Category results — one search, every platform in the category, a table each.
//
// The single-platform page (../[platform]/page.tsx) is unchanged and is still
// what a chosen platform opens. This is the other case: a category with several
// platforms behind it and no choice made.
//
// The rows are NOT merged into one table. Each platform's upstream endpoint
// returns its own shape — YouTube has views and subscribers, Marketplace a price
// and a seller, Open Web a host URL and a linking URL — so a single table would
// mean picking a lowest common denominator and throwing the rest away. Instead
// each platform gets its own table whose COLUMNS ARE DERIVED FROM ITS OWN ROWS,
// which is the only way to show a shape nobody has enumerated in advance.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from '@/lib/router'
import Breadcrumb from '@/components/ui/Breadcrumb'
import Portal from '@/components/ui/Portal'
import { useMasterData } from '@/lib/masterDataContext'
import {
  categorizePlatforms, platformLabel, type PlatformCategoryKey,
} from '@/lib/platformCategories'

const PAGE_SIZES = [10, 25, 50, 100]

/** Platforms in the catalogue that are not searchable yet — see the search page.
    Included here so a category holding one does not report it as a failure. */
const COMING_SOON = new Set(['torrent'])

interface PlatformResult {
  platform: string
  items: Record<string, any>[]
  total: number
  error?: string
}

/* ── Column derivation ──────────────────────────────────────────────────────
   A platform's columns are whatever its rows actually carry. Three rules make
   that readable rather than a raw dump:

   · a key is only a column if SOME row has a value for it — every endpoint
     returns a wide envelope of nulls, and a table of empty columns hides the
     few that matter,
   · objects and arrays are skipped, because a cell is one value; the row
     expander shows them in full,
   · the columns a reader looks for first are pulled to the front, and
     everything else keeps the order the API sent, which is usually meaningful. */

const LEAD_COLUMNS = [
  'assetName', 'infringementType', 'removalStatus', 'currentStatusName',
  // The URLs stay together wherever they are drawn — in the table, and in the
  // drawer where the demoted ones end up. A row's links are read as a set: the
  // page, the file, and whose account posted it.
  'infringingURL', 'sourceURL', 'videoURL', 'postURL', 'listingUrl',
  'profileURL', 'profileUrl', 'channelURL', 'channelOrProfileURL', 'shopUrl',
  'infringingDomain', 'sourceDomain', 'channelName', 'profileName', 'videoTitle',
  'urlUploadDate', 'publishedDate',
]

/** Never shown, anywhere. Internal ids carry nothing a client can act on, and
    `isComplete` is a pipeline flag rather than a fact about the infringement. */
const HIDDEN_COLUMN = /^(id|.*guid|clientId|clientMasterId|assetId|rowNo|rowNumber|isComplete)$/i

/** Shown in the detail drawer only. These are real values, just not ones worth
    a column: an account URL is long, near-identical down the page, and what a
    reader actually wants from it is one row at a time. */
const DRAWER_ONLY = /^(profileURL|profileUrl|channelURL|channelUrl|channelOrProfileURL|channelOrProfileUrl|shopURL|shopUrl)$/i

/** How many columns a table carries before the rest becomes drawer-only. The
    drawer holds every field, so this trades nothing away — it just stops a
    twenty-column table from being scrolled sideways to read one row. */
const MAX_TABLE_COLUMNS = 10

const isScalar = (v: any) =>
  v === null || v === undefined || (typeof v !== 'object' && typeof v !== 'function')

const hasValue = (v: any) =>
  v !== null && v !== undefined && String(v).trim() !== '' &&
  String(v) !== 'null' && String(v) !== 'undefined'

function deriveColumns(rows: Record<string, any>[]): string[] {
  const order: string[] = []
  const useful = new Set<string>()
  // Sampling the first 50 rows is enough to learn a shape and keeps a
  // thousand-row page from walking every key of every row.
  for (const row of rows.slice(0, 50)) {
    for (const k of Object.keys(row)) {
      if (HIDDEN_COLUMN.test(k)) continue
      if (!order.includes(k)) order.push(k)
      if (isScalar(row[k]) && hasValue(row[k])) useful.add(k)
    }
  }
  const cols = order.filter(k => useful.has(k))
  // The screenshot leads the row. It is the only column read as a picture
  // rather than as text, and at the front it gives every row an anchor to scan
  // down — buried at column nine it is just another thing to scroll past.
  const images = cols.filter(isImageKey)
  const lead = LEAD_COLUMNS.filter(k => cols.includes(k) && !isImageKey(k))
  const rest = cols.filter(k => !images.includes(k) && !lead.includes(k))
  return [...images, ...lead, ...rest]
}

/** "infringingURL" → "Infringing URL". Upstream names are camelCase and the
    acronyms in them (URL, DMCA, TAT, UGC) must survive the split. */
function humanise(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const isUrl = (v: any) => typeof v === 'string' && /^https?:\/\//i.test(v.trim())

/** Columns that hold a picture rather than a link to read. Matched on the key,
    because the value is a signed S3 URL — several hundred characters of
    credential and signature that say nothing about what it points at. */
const isImageKey = (key: string) => /screenshot|thumbnail|thumb|image|snapshot/i.test(key)

/** The image-off mark, at the same size a thumbnail occupies so rows stay
    aligned whether or not their screenshot survived. */
function NoShot({ title = 'Screenshot not available' }: { title?: string }) {
  return (
    <span title={title}
      className="w-16 h-11 rounded-lg border border-dashed border-gray-200 bg-gray-50/80
        flex flex-col items-center justify-center gap-0.5 text-gray-300">
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
 * nothing and are not a screenshot URL worth putting on screen.
 *
 * `loading="lazy"` matters here — a hundred-row page would otherwise pull a
 * hundred full-size screenshots from S3 the moment it renders.
 */
function Thumb({ src, onOpen }: { src: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false)

  if (failed) return <NoShot title="Screenshot expired or unavailable" />

  return (
    /* The row underneath opens the detail drawer, so a click meant for the
       screenshot must not also open it. */
    <button type="button" onClick={e => { e.stopPropagation(); onOpen() }} title="View screenshot"
      className="block w-16 h-11 rounded-lg overflow-hidden border border-gray-200 bg-gray-50
        hover:ring-2 hover:ring-[#FC934C]/60 transition-all">
      <img src={src} alt="Screenshot" loading="lazy" onError={() => setFailed(true)}
        className="w-full h-full object-cover" />
    </button>
  )
}

function cellText(v: any): string {
  if (!hasValue(v)) return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const s = String(v)
  // A date-looking value reads better as a date; anything else is passed
  // through untouched, because guessing at a format loses information.
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
    const d = new Date(s)
    if (!isNaN(d.getTime())) {
      return d.toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    }
  }
  return s
}

/**
 * A URL in a table cell.
 *
 * Cells do not wrap, so a link shows as much as its column allows and truncates
 * — but a truncated URL is close to useless, and every row on a platform
 * truncates to the same few characters. Hovering therefore reveals the WHOLE
 * URL in place, wrapped, rather than relying on a native tooltip that takes a
 * second to appear and cannot be read at length.
 */
function UrlCell({ url }: { url: string }) {
  return (
    <span className="group/url relative block">
      <a href={url} target="_blank" rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        className="block truncate text-[#0078D4] hover:underline">
        {url}
      </a>
      <span className="pointer-events-none absolute left-0 top-full mt-1 z-30 hidden group-hover/url:block
        rounded-lg px-2.5 py-1.5 text-[10px] leading-relaxed shadow-xl
        bg-[#14254A] text-white break-all whitespace-normal"
        style={{ width: 'max-content', maxWidth: 'min(460px, 55vw)' }}>
        {url}
      </span>
    </span>
  )
}

function Cell({ value, columnKey, onPreview }: {
  value: any
  /** Given, an image-bearing column renders its picture instead of its URL. */
  columnKey?: string
  onPreview?: (src: string) => void
}) {
  // An image column is ALWAYS drawn as an image or as the "not available" mark —
  // never as its text. A signed screenshot URL in a cell is a wall of credential
  // that pushes every other column off the screen and says nothing.
  if (columnKey && isImageKey(columnKey)) {
    if (!isUrl(value)) return <NoShot />
    const src = String(value).trim()
    return <Thumb src={src} onOpen={() => onPreview?.(src)} />
  }
  if (isUrl(value)) return <UrlCell url={String(value).trim()} />
  const text = cellText(value)
  return <span title={text === '—' ? undefined : text} className="block truncate">{text}</span>
}

/** The whole row, for the fields the table could not fit or could not flatten. */
/**
 * The whole row, in a panel that slides in from the right.
 *
 * The table is deliberately narrow now — ten columns, no account URLs — because
 * a client scanning for the row they want does not need every field to find it.
 * This is where they read it once found: every value the platform returned, in
 * the same reading order the columns use, with nothing truncated.
 */
function DetailDrawer({ row, platform, onClose, onPreview }: {
  row: Record<string, any>
  platform: string
  onClose: () => void
  onPreview: (src: string) => void
}) {
  // Escape is handled by the page, not here: the screenshot lightbox can sit on
  // top of this panel, and two independent handlers would close both at once
  // when the reader meant to dismiss only the one in front.

  const [shotFailed, setShotFailed] = useState(false)

  const entries = Object.entries(row)
    .filter(([k, v]) => !HIDDEN_COLUMN.test(k) && (hasValue(v) || (!isScalar(v) && v != null)))

  // Grouped into sections, and within a section kept in the same order the
  // columns use — so a field sits where the reader expects it rather than
  // wherever the endpoint happened to put it in its JSON.
  const shot = entries.find(([k, v]) => isImageKey(k) && isUrl(v))

  /* The figures that ride BESIDE the screenshot rather than waiting below it.
     A screenshot is tall and narrow — a phone-shaped capture in a half-screen
     panel leaves most of that row empty — and the numbers a reader wants at the
     same moment as the picture are the reach figures: how far this post got.

     Counts first because they are the ones worth reading at a glance; a platform
     that reports none (Open Web has no likes) falls back to its overview, so the
     rail is never empty beside a picture. */
  const counts = entries.filter(([k, v]) =>
    k !== shot?.[0] && isCountKey(k) && isFinite(Number(v)))
  const hero = (counts.length > 0
    ? counts
    : entries.filter(([k]) => k !== shot?.[0] && groupOf(k) === 'Overview')
  ).slice(0, 4)
  const heroKeys = new Set(hero.map(([k]) => k))

  const sections = GROUP_ORDER
    .map(title => ({
      title,
      fields: entries
        // The screenshot at the top IS this field — listing it again below, as a
        // thumbnail of the picture already on screen, is the same thing twice.
        // Same for anything promoted into the rail beside it.
        .filter(([k]) => k !== shot?.[0] && !heroKeys.has(k))
        .filter(([k]) => groupOf(k) === title)
        .sort(([a], [b]) => {
          const ra = LEAD_COLUMNS.indexOf(a), rb = LEAD_COLUMNS.indexOf(b)
          return (ra === -1 ? LEAD_COLUMNS.length : ra) - (rb === -1 ? LEAD_COLUMNS.length : rb)
        }),
    }))
    .filter(s => s.fields.length > 0)

  const title = String(row['assetName'] ?? row['videoTitle'] ?? 'Infringement details')
  const status = String(row['removalStatus'] ?? row['currentStatusName'] ?? '').trim()

  return (
    <Portal>
      <style>{`@keyframes drawerIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
      <div className="fixed inset-0 z-[99998] flex justify-end backdrop-blur-[2px]"
        style={{ background: 'rgba(20,37,74,0.45)' }}
        role="dialog" aria-modal="true" aria-label="Infringement details"
        onClick={onClose}>
        {/* Half the viewport on a desktop, the whole of it on a phone — a
            half-width panel on a 380px screen is a column of two-word lines. */}
        <aside
          className="h-full w-full md:w-1/2 bg-white shadow-2xl flex flex-col"
          style={{ animation: 'drawerIn .22s ease-out' }}
          onClick={e => e.stopPropagation()}>

          <header className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-3
            bg-gradient-to-r from-[#14254A]/[0.04] to-transparent">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#FC934C]">{platform}</p>
              <h2 className="text-base font-extrabold text-[#14254A] leading-tight mt-0.5">{title}</h2>
              {status && (
                <span className={`inline-flex items-center mt-2 px-2 py-0.5 rounded-md border
                  text-[11px] font-semibold ${statusTone(status)}`}>
                  {status}
                </span>
              )}
            </div>
            <button onClick={onClose} aria-label="Close"
              className="w-8 h-8 grid place-items-center rounded-lg text-gray-400 hover:text-[#14254A]
                hover:bg-[#14254A]/[0.06] flex-shrink-0 text-sm">
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-y-auto">
            {/* The evidence and the headline figures, side by side: the capture
                on the left, the numbers that describe it on the right. Stacked
                below a tablet, where two columns would be two narrow ones. */}
            <div className="border-b border-gray-100 bg-[#14254A]/[0.02] p-4
              grid grid-cols-1 md:grid-cols-5 gap-3 items-start">
              <div className="md:col-span-3 min-w-0">
                {shot && !shotFailed ? (
                  <button type="button" onClick={() => onPreview(String(shot[1]).trim())}
                    title="View full size" className="group block w-full relative">
                    <img src={String(shot[1]).trim()} alt="Screenshot" loading="lazy"
                      onError={() => setShotFailed(true)}
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
                  <div className="h-full min-h-[160px] rounded-lg border border-dashed border-gray-200
                    bg-white/60 flex flex-col items-center justify-center gap-2 text-gray-300 py-8">
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
                    <FieldCard key={k} label={columnTitle(k)}
                      big={isCountKey(k) && isFinite(Number(v))}>
                      <DetailValue fieldKey={k} value={v} onPreview={onPreview} />
                    </FieldCard>
                  ))}
                </div>
              )}
            </div>

            {sections.map(section => (
              <section key={section.title} className="border-b border-gray-100 last:border-0 bg-gray-50/60">
                <h3 className="px-5 pt-4 pb-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
                  {section.title}
                </h3>
                {/* Three cards to a row, so most sections are one row and none is
                    more than two. Nothing is truncated inside them — this is the
                    place the full value is meant to be readable. */}
                <div className="px-5 pb-4 grid grid-cols-2 md:grid-cols-3 gap-2.5">
                  {section.fields.map(([k, v]) => (
                    <FieldCard key={k} label={columnTitle(k)}
                      big={isCountKey(k) && isFinite(Number(v))}
                      wide={isUrl(v) || (isScalar(v) && String(v ?? '').length > 40)}>
                      <DetailValue fieldKey={k} value={v} onPreview={onPreview} />
                    </FieldCard>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </aside>
      </div>
    </Portal>
  )
}

/** The header a column shows. An image column drops its "URL" suffix — the cell
    is a picture now, and "Screenshot URL" over a thumbnail names the wrong
    thing. */
function columnTitle(key: string): string {
  const label = humanise(key)
  return isImageKey(key) ? label.replace(/\s*urls?$/i, '') : label
}

/* ── Detail grouping ────────────────────────────────────────────────────────
   A flat list of twenty key/value pairs is a data dump, not a record. These
   sections are the questions someone actually asks of a row, in the order they
   ask them: what is it, where is it, how big was it, what have we done about
   it. First match wins, so the order below is the classification. */
const FIELD_GROUPS: { title: string; match: RegExp }[] = [
  { title: 'Overview',    match: /^(assetName|infringementType|infringementTypeName|platform|isSourceURL)$/i },
  { title: 'Links',       match: /(url|uri|link)$/i },
  { title: 'Enforcement', match: /(removal|delist|dmca|takedown|notice|status)/i },
  { title: 'Reach',       match: /(view|like|comment|subscriber|follower|member|share|rating|review|buy)/i },
  { title: 'Content',     match: /(title|type|language|quality|duration|length|keyword|genre|caption|description|price|currency)/i },
  { title: 'Discovery',   match: /(date|time|country|domain|host|engine|channel|profile|seller|page)/i },
]

function groupOf(key: string): string {
  return FIELD_GROUPS.find(g => g.match.test(key))?.title ?? 'Other'
}

/** Sections in reading order, with anything unclassified last. */
const GROUP_ORDER = [...FIELD_GROUPS.map(g => g.title), 'Other']

const isCountKey = (key: string) =>
  /(count|views|likes|comments|subscribers|followers|members|shares)$/i.test(key)

/**
 * Tone for a status value.
 *
 * Deliberately conservative: only the vocabularies this pipeline actually uses
 * are coloured, and everything else stays neutral. A wrong colour on a status
 * is worse than no colour — green on a live infringement reads as "handled".
 */
function statusTone(value: string): string {
  const v = value.toLowerCase()
  if (/\b(removed|dead|delisted|taken\s*down|complete|closed)\b/.test(v)) {
    return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  }
  if (/\b(pending|in\s*progress|processing|sent|submitted|awaiting|queued)\b/.test(v)) {
    return 'bg-amber-50 text-amber-700 border-amber-200'
  }
  return 'bg-gray-50 text-gray-600 border-gray-200'
}

/** One field in the drawer, drawn as what it is rather than as a string. */
function DetailValue({ fieldKey, value, onPreview }: {
  fieldKey: string; value: any; onPreview?: (src: string) => void
}) {
  // Same rule as the table: a picture, or the mark saying there isn't one.
  if (isImageKey(fieldKey)) {
    if (!isUrl(value)) return <NoShot />
    const src = String(value).trim()
    return <Thumb src={src} onOpen={() => onPreview?.(src)} />
  }
  if (!isScalar(value)) {
    return <code className="text-[10px] text-gray-500 break-all">{JSON.stringify(value)}</code>
  }
  if (isUrl(value)) {
    return (
      <a href={String(value)} target="_blank" rel="noopener noreferrer"
        className="text-[#0078D4] hover:underline break-all">{String(value)}</a>
    )
  }
  const text = cellText(value)
  if (text === '—') return <span className="text-gray-300">—</span>

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
function FieldCard({ label, big, wide, children }: {
  label: string
  /** A countable figure — set large, because these are what get compared. */
  big?: boolean
  /** Takes the whole row: URLs and long text have nothing to gain from a third
      of the width and everything to lose to wrapping. */
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`rounded-xl border border-gray-100 bg-white px-3.5 py-2.5 min-w-0 shadow-sm
      ${wide ? 'col-span-2 md:col-span-3' : ''}`}>
      <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1 truncate" title={label}>
        {label}
      </p>
      <div className={`text-[#14254A] min-w-0 ${
        big ? 'text-lg font-extrabold leading-tight' : 'text-[13px] font-semibold break-words'}`}>
        {children}
      </div>
    </div>
  )
}

function pgRange(cur: number, tot: number): (number | '…')[] {
  if (tot <= 7) return Array.from({ length: tot }, (_, i) => i + 1)
  const pages: (number | '…')[] = [1]
  if (cur > 3) pages.push('…')
  for (let p = Math.max(2, cur - 1); p <= Math.min(tot - 1, cur + 1); p++) pages.push(p)
  if (cur < tot - 2) pages.push('…')
  pages.push(tot)
  return pages
}

/**
 * One platform's results: its own columns, its own paging, its own empty and
 * error states. Self-contained because nothing about it generalises to the
 * platform beside it — that is the whole reason these are separate tables.
 */
function PlatformTable({ result, label, onPreview, onOpenRow }: {
  result: PlatformResult; label: string
  onPreview: (src: string) => void
  onOpenRow: (row: Record<string, any>) => void
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const allColumns = useMemo(() => deriveColumns(result.items), [result.items])
  // The table's columns are the ones worth scanning; the drawer has the rest.
  const columns = useMemo(
    () => allColumns.filter(c => !DRAWER_ONLY.test(c)).slice(0, MAX_TABLE_COLUMNS),
    [allColumns])
  const totalPages = Math.max(1, Math.ceil(result.items.length / pageSize))
  const start = (page - 1) * pageSize
  const rows = result.items.slice(start, start + pageSize)

  useEffect(() => { setPage(1) }, [pageSize, result.items])

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-bold text-[#14254A] flex items-center gap-2">
          {label}
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#14254A]/5 text-[#14254A]/70 tabular-nums">
            {result.items.length.toLocaleString()} row{result.items.length === 1 ? '' : 's'}
          </span>
          {allColumns.length > 0 && (
            <span className="text-[10px] font-semibold text-gray-400">
              {columns.length} of {allColumns.length} fields · click a row for the rest
            </span>
          )}
        </h2>
        {result.items.length > pageSize && (
          <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}
            aria-label={`Rows per page for ${label}`}
            className="text-[11px] font-semibold border border-gray-200 rounded-lg px-2 py-1 text-[#14254A]">
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}
          </select>
        )}
      </div>

      {result.error ? (
        <div className="px-5 py-6 text-sm text-red-700 bg-red-50/60">
          <strong>This platform could not be searched.</strong>
          <p className="text-xs mt-1 opacity-90">{result.error}</p>
        </div>
      ) : result.items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-400">No infringements found for this platform.</p>
      ) : (
        <>
          {/* Cells do not wrap: a row is one line high, so ten rows can be
              compared down a column instead of each one being three lines of
              rewrapped text. What that costs — truncated values — the hover
              reveal and the drawer give back. */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#14254A]/[0.03]">
                  {columns.map(c => (
                    <th key={c} title={c}
                      className="text-left font-bold uppercase tracking-widest text-[9px] text-gray-400
                        px-3 py-2 whitespace-nowrap">
                      {columnTitle(c)}
                    </th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={start + i}
                    onClick={() => onOpenRow(row)}
                    title="Open the full details"
                    className="border-t border-gray-100 cursor-pointer hover:bg-[#FC934C]/[0.06] transition-colors">
                    {columns.map(c => (
                      <td key={c} className="px-3 py-2 text-gray-700 whitespace-nowrap max-w-[220px]">
                        <Cell value={row[c]} columnKey={c} onPreview={onPreview} />
                      </td>
                    ))}
                    {/* A visible affordance for the row click — a whole row being
                        a button is not obvious without one. */}
                    <td className="px-2 py-2 text-right text-gray-300">›</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[11px] text-gray-400 tabular-nums">
                {start + 1}–{Math.min(start + pageSize, result.items.length)} of {result.items.length.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-bold border border-gray-200 text-gray-500 disabled:opacity-40 hover:text-[#14254A]">
                  Prev
                </button>
                {pgRange(page, totalPages).map((p, i) =>
                  p === '…' ? (
                    <span key={`gap${i}`} className="px-1 text-[11px] text-gray-300">…</span>
                  ) : (
                    <button key={p} onClick={() => setPage(p)}
                      aria-current={p === page ? 'page' : undefined}
                      className={`min-w-[26px] px-2 py-1 rounded-lg text-[11px] font-bold tabular-nums transition-colors ${
                        p === page
                          ? 'bg-[#14254A] text-white'
                          : 'text-gray-500 hover:text-[#14254A] hover:bg-[#14254A]/[0.06]'}`}>
                      {p}
                    </button>
                  ))}
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-bold border border-gray-200 text-gray-500 disabled:opacity-40 hover:text-[#14254A]">
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

export default function CategoryResultsPage({ category }: { category: string }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { platforms } = useMasterData()

  const startDate = searchParams.get('startDate') || ''
  const endDate   = searchParams.get('endDate') || ''
  const assetName = searchParams.get('assetName') || ''

  const [results, setResults] = useState<PlatformResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  // Upstream pages are fetched one at a time across every platform at once, the
  // same way the single-platform page does it.
  const [apiPage, setApiPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  // The screenshot being viewed full size, if any.
  const [preview, setPreview] = useState('')
  // The row whose full details are open in the side drawer.
  const [detail, setDetail] = useState<{ row: Record<string, any>; platform: string } | null>(null)

  /* One Escape handler for both overlays, closing the top one only: the
     screenshot sits above the detail drawer, so dismissing a picture must not
     also throw away the row it was opened from. */
  useEffect(() => {
    if (!preview && !detail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (preview) setPreview('')
      else setDetail(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, detail])

  const categories = useMemo(() => categorizePlatforms(platforms), [platforms])
  const cat = categories.find(c => c.key === (category as PlatformCategoryKey))
  const catLabel = cat?.label ?? category

  /* The searchable platforms in this category. The grouping is the browser's
     (lib/platformCategories.ts), so the list is worked out here and sent — the
     server validates each name rather than holding a second copy of the
     vocabulary that could drift from this one. */
  const keys = useMemo(
    () => (cat?.platforms ?? []).map(p => p.key).filter(k => !COMING_SOON.has(k.trim().toLowerCase())),
    [cat])

  const fetchPage = useCallback(async (pageNo: number, append: boolean) => {
    if (keys.length === 0) return
    append ? setLoadingMore(true) : setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/infringement/category', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platforms: keys, startDate, endDate, assetName, page: pageNo }),
      })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to load data'); return }
      const incoming: PlatformResult[] = data.data?.platforms ?? []
      setResults(prev => append
        ? prev.map(p => {
            const more = incoming.find(i => i.platform === p.platform)
            return more ? { ...p, items: [...p.items, ...more.items], error: more.error } : p
          })
        : incoming)
      setApiPage(pageNo)
    } catch (e: any) {
      setError(e.message)
    } finally {
      append ? setLoadingMore(false) : setLoading(false)
    }
  }, [keys, startDate, endDate, assetName])

  useEffect(() => {
    // Master data arrives asynchronously; until it does there is no platform
    // list to search and the effect would fire against an empty category.
    if (keys.length === 0) return
    setResults([])
    fetchPage(1, false)
  }, [keys, fetchPage])

  /* Display names come from master data — the server works in the lowercase
     keys MarkScan's endpoints take, and "facebook" is a wire value, not a name
     to show a client. A platform master data does not know still gets a readable
     label rather than its raw key. */
  const labelOf = useCallback((key: string) => {
    const hit = platforms.find(p => p.key.trim().toLowerCase() === key.trim().toLowerCase())
    if (hit) return platformLabel(hit.label || hit.key)
    const mapped = platformLabel(key)
    return mapped === key ? key.replace(/\b\w/g, c => c.toUpperCase()) : mapped
  }, [platforms])

  const withRows  = results.filter(r => !r.error && r.items.length > 0)
  const totalRows = withRows.reduce((a, r) => a + r.items.length, 0)
  // "Load more" is only meaningful while some platform is still returning rows.
  const canLoadMore = withRows.length > 0 && !loading

  /* One tab per platform, one table at a time. Stacked, the tables ran to a
     dozen screens and every one of them had different columns, so scrolling
     between two meant losing the header you were comparing against.

     The tab that opens is the first with rows: a category where two platforms
     hit and ten did not should not open on an empty one. */
  const [active, setActive] = useState('')
  useEffect(() => {
    setActive(cur => {
      if (results.length === 0) return ''
      // A tab that survived the refetch stays open — "load more" must not throw
      // the reader back to the first platform.
      if (results.some(r => r.platform === cur)) return cur
      return (results.find(r => !r.error && r.items.length > 0) ?? results[0]).platform
    })
  }, [results])

  const activeResult = results.find(r => r.platform === active) ?? null

  return (
    <div className="fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <Breadcrumb items={[
          { label: 'Find Infringements', href: '/infringement' },
          { label: catLabel },
        ]} />
        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A]">{catLabel}</h1>
          <p className="text-brand-muted text-sm">
            {keys.length} platform{keys.length === 1 ? '' : 's'} searched
            {totalRows > 0 && <> · {totalRows.toLocaleString()} rows</>}
          </p>
        </div>
      </div>

      {/* What was asked for, in words — the page has no filter controls of its
          own, so the criteria have to be visible or a stale tab is unreadable. */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        {[
          assetName && { k: 'Asset', v: assetName },
          (startDate || endDate) && { k: 'Dates', v: `${startDate || 'any'} → ${endDate || 'any'}` },
        ].filter(Boolean).map((c: any) => (
          <span key={c.k} className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg
            bg-[#14254A]/5 text-[#14254A]">
            <span className="opacity-50">{c.k}:</span> {c.v}
          </span>
        ))}
        <button onClick={() => router.push('/infringement')}
          className="text-[11px] font-bold text-gray-400 hover:text-[#FC934C] ml-auto">
          ← Change search
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 px-5 py-16 text-center">
          <span className="inline-block w-6 h-6 border-2 border-[#14254A]/20 border-t-[#14254A] rounded-full animate-spin" />
          <p className="text-sm text-gray-400 mt-3">
            Searching {keys.length} platform{keys.length === 1 ? '' : 's'}…
          </p>
        </div>
      ) : results.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 px-5 py-12 text-center">
          <p className="font-bold text-[#14254A]">Nothing to search</p>
          <p className="text-sm text-gray-400 mt-1">
            No searchable platform is configured under {catLabel}.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Every platform is a tab, including the ones that returned nothing
              and the ones that failed — "no results" and "could not be searched"
              are different answers, and a client reading a category report needs
              to see which platforms were actually covered. Each tab carries its
              own count, so the whole picture is readable without opening one. */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-2 overflow-x-auto">
            <div className="flex items-center gap-1.5 min-w-max" role="tablist"
              aria-label="Platforms searched">
              {results.map(r => {
                const on = r.platform === active
                const failed = !!r.error
                const empty = !failed && r.items.length === 0
                return (
                  <button key={r.platform} role="tab" aria-selected={on}
                    onClick={() => setActive(r.platform)}
                    title={failed ? r.error : `${r.items.length} row${r.items.length === 1 ? '' : 's'}`}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold
                      whitespace-nowrap transition-all border ${
                      on
                        ? 'bg-[#14254A] text-white border-[#14254A] shadow-sm'
                        : failed
                          ? 'border-red-200 text-red-600 hover:bg-red-50'
                          : empty
                            ? 'border-gray-100 text-gray-400 hover:text-[#14254A] hover:border-gray-200'
                            : 'border-gray-200 text-[#14254A] hover:border-[#FC934C]/50 hover:bg-[#FC934C]/[0.06]'
                    }`}>
                    {labelOf(r.platform)}
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full tabular-nums ${
                      on ? 'bg-white/15 text-white'
                        : failed ? 'bg-red-100 text-red-600'
                        : 'bg-[#14254A]/[0.07] text-[#14254A]/60'}`}>
                      {failed ? '!' : r.items.length.toLocaleString()}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {activeResult && (
            /* Keyed on the platform so switching tabs starts the new table at
               page one rather than inheriting a page number that meant something
               on a different result set. */
            <PlatformTable key={activeResult.platform} result={activeResult}
              label={labelOf(activeResult.platform)} onPreview={setPreview}
              onOpenRow={row => setDetail({ row, platform: labelOf(activeResult.platform) })} />
          )}

          {canLoadMore && (
            <div className="text-center">
              <button onClick={() => fetchPage(apiPage + 1, true)} disabled={loadingMore}
                className="px-5 py-2 rounded-xl text-xs font-bold border border-dashed border-gray-300
                  text-gray-500 hover:border-[#FC934C] hover:text-[#FC934C] transition-all disabled:opacity-50">
                {loadingMore ? 'Loading…' : `Load page ${apiPage + 1} from every platform`}
              </button>
            </div>
          )}
        </div>
      )}

      {detail && (
        <DetailDrawer row={detail.row} platform={detail.platform}
          onClose={() => setDetail(null)} onPreview={setPreview} />
      )}

      {/* Screenshot at full size. Portalled so the backdrop covers the viewport
          rather than this page's content box, and closed by the backdrop, the
          button or Escape — a picture opened by accident should not need aim to
          get out of. */}
      {preview && (
        <Portal>
          <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 backdrop-blur-sm"
            style={{ background: 'rgba(20,37,74,0.72)' }}
            role="dialog" aria-modal="true" aria-label="Screenshot"
            onClick={() => setPreview('')}>
            <div className="max-w-[92vw] max-h-[92vh] flex flex-col items-center gap-3"
              onClick={e => e.stopPropagation()}>
              <img src={preview} alt="Screenshot"
                className="max-h-[82vh] max-w-full object-contain rounded-xl shadow-2xl bg-white" />
              <div className="flex items-center gap-2">
                <a href={preview} target="_blank" rel="noopener noreferrer"
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-white/95 text-[#14254A] hover:bg-white">
                  Open original
                </a>
                <button onClick={() => setPreview('')}
                  className="px-4 py-2 rounded-xl text-xs font-bold border border-white/40 text-white hover:bg-white/10">
                  Close
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </div>
  )
}
