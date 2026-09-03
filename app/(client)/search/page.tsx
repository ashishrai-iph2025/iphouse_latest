'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Breadcrumb from '@/components/ui/Breadcrumb'
import { platformLabel, isOpenWebPlatform } from '@/lib/platformCategories'
import ReportLoader from '@/components/shared/ReportLoader'
/* The same thumbnail, the same "screenshot expired" mark and the same full-size
   viewer the results lists use. Imported rather than rewritten: a screenshot
   that renders one way on a list and another way here is two behaviours to keep
   in step, and the expiry handling is the part worth having only once. */
import {
  RecordDetail, ScreenshotPreview, TimeZoneNote, statusTone, isHiddenField, isEclipsed,
} from '@/components/infringement/ResultsView'

const INTERNET_FIELDS: [string, string[]][] = [
  ['Asset Name',        ['assetName',           'AssetName']],
  ['Host URL',          ['sourceURL',            'SourceURL',         'sourceUrl']],
  ['Host Domain',       ['sourceDomain',         'SourceDomain']],
  ['Linking URL',       ['infringingURL',        'InfringingURL',     'infringingUrl']],
  ['Linking Domain',    ['infringingDomain',     'InfringingDomain']],
  ['Infringement Type', ['infringementType',     'InfringementType']],
  ['Quality of Print',  ['qualityOfPrint',       'QualityOfPrint']],
  ['Country',           ['country',              'Country']],
  ['Upload Date',       ['urlUploadDate',        'URLUploadDate']],
  ['Removal Status',    ['removalStatus',        'RemovalStatus']],
  ['Removal Time',      ['removalTime',          'removed_at']],
  ['De-Indexed Status', ['delistingremovalstatus']],
  ['De-Indexing Time',  ['delistingTime']],
  ['DMCA Status',       ['dmcaremovalstatus']],
  ['DMCA Removal Time', ['dmcaRemovalTime']],
  ['Search Engine',     ['searchEngine']],
  ['Language',          ['audioLanguage',        'AudioLanguage']],
  ['Media File',        ['videoURL',             'VideoURL']],
]

const SOCIAL_FIELDS: [string, string[]][] = [
  ['Asset Name',        ['assetName',       'AssetName']],
  ['Platform',          ['platform',        'Platform']],
  ['Media File',        ['videoURL',        'VideoURL']],
  ['Profile URL',       ['profileURL',      'ProfileURL']],
  ['Media File Title',  ['videoTitle',      'VideoTitle']],
  ['Like Count',        ['likeCount',       'LikeCount',       'like_count']],
  ['Subscriber Count',  ['subscriberCount', 'SubscriberCount', 'subscrbers']],
  ['Views Count',       ['viewCount',       'ViewCount',       'views']],
  ['Comment Count',     ['commentCount',    'CommentCount',    'comment_count']],
  ['Season',            ['season',          'Season']],
  ['Episode',           ['episode',         'Episode']],
  ['Language',          ['language',        'Language',        'audioLanguage']],
  ['Country',           ['country',         'Country']],
  ['Infringement Type', ['infringementType','InfringementType']],
  ['Quality of Print',  ['qualityOfPrint',  'QualityOfPrint']],
  ['Removal Status',    ['removalStatus',   'RemovalStatus']],
  ['Upload Date',       ['uploadDate',      'UploadDate',      'urlUploadDate']],
]

function pick(obj: any, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k]
    if (v != null && String(v).trim() !== '' && String(v) !== 'null') return String(v)
  }
  return ''
}

/* ── Everything the schema above did not claim ──────────────────────────────
   The two lists are a vocabulary, not a schema: good labels for keys this
   screen knows better names for. They are NOT the record.
   /SearchandRetriveapi returns whatever that platform's pipeline filled in,
   each platform fills a different subset, and the warehouse keeps adding
   columns — channel name, video length, keywords, screenshot, enforcement
   timestamps and the record's own id are all things a row can carry that no
   list here names.

   So WHICH fields appear is the response's answer and nothing else; the lists
   only supply names for the ones it sent, and RecordDetail groups and draws
   them. A record is never shown as larger than it is, and the fields nobody
   here named are grouped with the rest rather than dumped underneath them. */

/** Run-on and abbreviated keys whose humanised form would be unreadable. */
const EXTRA_LABELS: Record<string, string> = {
  id:                     'Record ID',
  delistingremovalstatus: 'De-Indexed Status',
  dmcaremovalstatus:      'DMCA Status',
  subscrbers:             'Subscriber Count',
  issource:               'Is Host URL',
  issourceurl:            'Is Host URL',
  language1:              'Language',
  tat:                    'TAT (Days)',
}

/** Tokens that are abbreviations, not words, once a key is split up. */
const ACRONYMS: Record<string, string> = {
  url: 'URL', id: 'ID', dmca: 'DMCA', ugc: 'UGC', qc: 'QC', tat: 'TAT', api: 'API',
}

function humanise(key: string): string {
  const override = EXTRA_LABELS[key.toLowerCase()]
  if (override) return override
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // camelCase → camel Case
    .replace(/[_\-.]+/g, ' ')                 // snake_case, kebab-case
    .trim()
    .split(/\s+/)
    .map(w => ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/* The search is by URL alone — no platform is chosen here, so the shape of the
   answer comes from the platform the server resolved the URL to, then from the
   record itself. Open Web rows are the ones that carry a host/linking pair or
   the delisting columns; everything else is a social/UGC row. */
function looksOpenWeb(result: any, matched: string): boolean {
  if (!result) return false
  if (/internet|open web/i.test(matched)) return true
  if (/internet|open web/i.test(pick(result, ['platform', 'Platform']))) return true
  const openWebOnly = [
    ['sourceURL', 'SourceURL', 'sourceUrl'],
    ['sourceDomain', 'SourceDomain'],
    ['infringingURL', 'InfringingURL', 'infringingUrl'],
    ['infringingDomain', 'InfringingDomain'],
    ['delistingremovalstatus'],
    ['dmcaremovalstatus'],
    ['searchEngine'],
  ]
  return openWebOnly.some(keys => pick(result, keys) !== '')
}

export default function SearchPage() {
  const [url,     setUrl]     = useState('')
  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState<any>(null)
  // The platform the server resolved the URL to and found the record under —
  // the record itself does not always name one.
  const [matched, setMatched] = useState('')
  const [error,   setError]   = useState('')
  // The screenshot being viewed full size, if any.
  const [preview, setPreview] = useState('')

  // Escape closes the viewer. Bound here rather than inside it, for the same
  // reason the results screens do: one handler, one overlay, no argument about
  // which one a keypress meant.
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview('') }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  /*
    Which SIDE of an Open Web pair to look up.

    An Open Web record is a pair — the page linking to the file, and the host
    serving it — and /SearchandRetriveapi asks for one of them at a time through
    `isSrcUrl`. A lookup that names no platform tries the linking side and then
    the host side, so the first search finds whichever exists and answers with
    the side it found; from then on this is what asks for the other one.

    Null until a search has resolved. It CANNOT be offered before that: which
    side a URL is on is only a question once the URL is known to be Open Web,
    and that is decided from its host by the server — see PlatformForURL, the
    one place that holds MarkScan's platform vocabulary. Mirroring that host
    list in the browser to light up a control a fraction of a second earlier is
    how the two copies start disagreeing about what Open Web is.
  */
  const [side, setSide] = useState<null | boolean>(null)

  async function runSearch(isSrcUrl: boolean | null) {
    if (!url.trim()) { setError('Please enter a URL.'); return }
    setError(''); setResult(null); setMatched(''); setLoading(true)
    try {
      /* URL alone on the first look: the platform and the side are derived
         server-side (go-server/handlers/search.go), which is the only place
         that knows MarkScan's vocabulary.

         Once a side is CHOSEN, the platform travels with it. searchAttempts
         takes an explicit platform as given and tries it alone, which is the
         point — "show me the host record" must not quietly fall back to the
         linking one and report a hit. */
      const body: Record<string, unknown> = { url: url.trim() }
      if (isSrcUrl !== null) {
        body.platform = 'internet'
        body.isSrcUrl = isSrcUrl
      }
      const res  = await fetch('/api/search', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) {
        setResult(data.data)
        setMatched(data.platform || '')
        /* The side the server actually answered on — from the response rather
           than from what was asked for, because the first search asks for
           neither and reports which one it found.

           Null off Open Web, and that is what hides the control: every other
           platform has one record and no side to pick, so a toggle there would
           be a choice between a record and nothing. */
        setSide(isOpenWebPlatform(data.platform || '')
          ? (typeof data.isSrcUrl === 'boolean' ? data.isSrcUrl : isSrcUrl)
          : null)
      } else {
        setError(data.error || 'No results found or API error')
        /* The side that found nothing is still the side being looked at, so the
           control stays where the reader put it. Losing it here would be the
           worst moment to: "no host record for this URL" is exactly when
           somebody wants to look at the linking one, and a control that
           disappears on an empty answer strands them on it.

           Still null on a FIRST search that found nothing — there, the URL was
           never identified as Open Web, so there is no pair to offer. */
        setSide(isSrcUrl)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    // A fresh URL is looked up from scratch: the side that matched the last one
    // says nothing about this one, and may not even be a question for it.
    setSide(null)
    runSearch(null)
  }

  const fields = looksOpenWeb(result, matched) ? INTERNET_FIELDS : SOCIAL_FIELDS
  const openWeb = looksOpenWeb(result, matched)

  /* The curated schema, reduced to the one job worth keeping: NAMING.

     Those two lists name a field better than humanising its key can — "Host
     URL" over "Source URL", "De-Indexed Status" over "Delistingremovalstatus" —
     and that is what they are still for.

     What they no longer do is decide which fields exist. They used to declare
     an expected set and the order to draw it in, which is what made the result
     a fixed grid padded with fields the response never sent. Which fields
     appear is the API's answer now, and how they are laid out is RecordDetail's
     job. */
  const labelBy = useMemo(() => {
    const m = new Map<string, string>()
    for (const [label, keys] of fields) for (const k of keys) m.set(k, label)
    for (const [k, label] of Object.entries(EXTRA_LABELS)) m.set(k, label)
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields])

  const labelFor = useCallback(
    (key: string) => labelBy.get(key) ?? labelBy.get(key.toLowerCase()) ?? humanise(key),
    [labelBy])

  /* The record, exactly as the API answered.

     It used to be seeded first: every field the curated schema expected but the
     response did not carry was added back as an empty string, so the screen
     drew a card and a dash for it. The intent was to say "we expected this and
     the platform did not send it" — but a reader cannot tell that apart from a
     field that came back empty, and the result was a record padded out with
     rows that were never in the data. Each platform fills a different subset,
     so on most searches the padding outnumbered the answer.

     What is on screen is now what came back, and nothing else. The schema below
     still supplies NAMES for the keys the response does carry — that is
     labelling, not inventing. */
  /* What the header calls the record, and what it says happened to it — the
     same two facts the results drawer leads with, read from the same fields. */
  const recordTitle = result
    ? String(pick(result, ['assetName', 'AssetName', 'videoTitle', 'VideoTitle']) || 'Record found')
    : ''
  const recordStatus = result
    ? pick(result, ['removalStatus', 'RemovalStatus', 'currentStatusName']).trim()
    : ''

  /* How many fields the record actually carries, for the header count. */
  /* Counted the same way RecordDetail draws them, so the header's number is the
     number of cards below it rather than a count of raw JSON keys. */
  const fieldCount = result
    ? Object.keys(result).filter(k => !isHiddenField(k) && !isEclipsed(k, result)).length
    : 0
  const foundPlatform = result ? platformLabel(pick(result, ['platform', 'Platform']) || matched) : ''

  return (
    <div className="fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 sm:mb-6">
        <Breadcrumb items={[{ label: 'Find Infringements', href: '/infringement' }, { label: 'Search & Retrieve' }]} />
        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A]">Search &amp; Retrieve</h1>
          <p className="text-brand-muted text-sm">Look up an infringement record by its URL.</p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-5 lg:items-start">

        {/* ── Left Panel ── */}
        <div className="w-full lg:w-72 xl:w-80 lg:flex-shrink-0 bg-white rounded-2xl border border-gray-100 shadow-card lg:self-start lg:sticky lg:top-5">
          <div className="h-1 rounded-t-2xl" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />

          <div className="p-5">
            {/* Panel header */}
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#14254A,#FC934C)' }}>
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="8"/><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35"/>
                </svg>
              </div>
              <div>
                <div className="font-bold text-[#14254A] text-sm">Search &amp; Retrieve</div>
                <div className="text-[10px] text-gray-400">Query platform metadata</div>
              </div>
            </div>

            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4">Query Parameters</div>

            <form onSubmit={handleSearch} className="flex flex-col gap-4">
              {/* Target URL */}
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Target URL <span className="text-red-400">*</span>
                </label>
                <textarea
                  required
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  rows={4}
                  placeholder="https://example.com/content/…"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A] resize-none"
                />
                <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">
                  The platform is resolved from the URL — nothing else to pick.
                </p>
              </div>

              {/* ── Which side of an Open Web pair ──────────────────────────
                  Only on Open Web, and only once a search has said so: an
                  Open Web record is a page linking to a file and a host serving
                  it, and the endpoint answers for one at a time. Every other
                  platform has a single record and no side to choose, which is
                  why this is not a permanent control.

                  Switching re-runs the lookup rather than filtering what is
                  already here — the other side is a different record, not a
                  hidden part of this one. */}
              {side !== null && (
                <div>
                  <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                    URL type
                  </label>
                  <div className="flex items-center gap-1 rounded-xl border border-gray-200 p-1">
                    {[
                      { label: 'Linking URL', src: false, hint: 'The page that links to the infringing file' },
                      { label: 'Host URL',    src: true,  hint: 'The host page carrying the file itself' },
                    ].map(o => (
                      <button key={o.label} type="button" title={o.hint}
                        disabled={loading}
                        onClick={() => { if (side !== o.src) runSearch(o.src) }}
                        aria-pressed={side === o.src}
                        className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors disabled:opacity-50 ${
                          side === o.src
                            ? 'bg-[#14254A] text-white'
                            : 'text-gray-500 hover:text-[#14254A] hover:bg-[#14254A]/[0.06]'}`}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">
                    Open Web records come in pairs. Switching looks the other one up.
                  </p>
                </div>
              )}

              <button type="submit" disabled={loading}
                className="w-full py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 flex items-center justify-center gap-2"
                style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                {loading
                  ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Analyzing…</>
                  : <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35"/></svg>Run Analysis</>
                }
              </button>
            </form>
          </div>
        </div>

        {/* ── Right Panel ── */}
        <div className="flex-1 min-w-0 rounded-2xl border border-gray-100 shadow-card overflow-hidden min-h-[300px] lg:min-h-[520px]">
          {!result && !error && !loading && (
            <div className="flex flex-col items-center justify-center min-h-[520px] gap-3 text-center p-10">
              <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 grid place-items-center text-2xl text-gray-400">
                ⬡
              </div>
              <p className="font-bold text-gray-800 text-base">Awaiting Input</p>
              <p className="text-sm text-gray-400 max-w-[240px] leading-relaxed">
                Paste a URL and run an analysis to extract its platform metadata.
              </p>
            </div>
          )}

          {loading && (
            <ReportLoader
              fill
              className="min-h-[520px]"
              size={170}
              label="Analyzing URL"
              sublabel="Fetching metadata from platform…"
            />
          )}

          {error && !loading && (
            <div className="m-5 flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
              <span className="mt-0.5 flex-shrink-0">✕</span>
              <span><strong>Error:</strong> {error}</span>
            </div>
          )}

          {result && !loading && (
            <>
              {/* ── The record ───────────────────────────────────────────────

                  A header that identifies it, then the record itself in the
                  same grouped layout the results drawer uses — see RecordDetail.

                  It was one flat grid of thirty-four grey boxes in alphabetical
                  order, and everything wrong with that followed from the order:
                  a removal status sat between a record id and a report type, the
                  asset name was somewhere in the middle, and the fields that
                  answer "what happened to this" were scattered across three
                  screens of scrolling. Nothing was missing; it just could not be
                  read. Grouped, the same fields answer in the order somebody
                  asks: what is it, where is it, how far did it get, what have we
                  done about it. */}
              <div className="px-5 py-4 flex items-start justify-between flex-wrap gap-3"
                style={{ background: '#14254A' }}>
                <div className="min-w-0">
                  {foundPlatform && (
                    <p className="text-[10px] font-bold uppercase tracking-widest text-[#FC934C]">
                      {foundPlatform}
                    </p>
                  )}
                  {/* The record's own name leads, not the words "Analysis
                      Results" — the reader knows they ran a search, and what
                      they need confirmed is WHICH record came back. */}
                  <h2 className="text-base font-extrabold text-white leading-tight mt-0.5 break-words">
                    {recordTitle}
                  </h2>
                  <div className="flex items-center gap-2 flex-wrap mt-2">
                    {recordStatus && (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md border
                        text-[11px] font-semibold ${statusTone(recordStatus)}`}>
                        {recordStatus}
                      </span>
                    )}
                    <span className="text-[11px] text-white/40">{fieldCount} fields</span>
                    <span className="text-white/20">·</span>
                    <TimeZoneNote />
                  </div>
                </div>
              </div>

              <RecordDetail row={result} openWeb={openWeb} labelFor={labelFor}
                onPreview={setPreview} />
            </>
          )}
        </div>
      </div>

      <ScreenshotPreview src={preview} onClose={() => setPreview('')} />
    </div>
  )
}
