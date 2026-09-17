'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import Breadcrumb from '@/components/ui/Breadcrumb'
import Portal from '@/components/ui/Portal'
import { useMasterData } from '@/lib/masterDataContext'
import { platformLabel } from '@/lib/platformCategories'

interface HistoryRow {
  id: string
  date: string
  platform: string
  assetName: string
  urlCount: number
  urls: string[]
  /** Distinct logins whose URLs are in this batch — only populated for a
      company-wide view; empty when nothing in it could be attributed. */
  submitters?: string[]
}

const PER_PAGE = 10

/* ── Platform detection ───────────────────────────────────────────────────
   The platform is no longer picked by hand — it is read off each submitted
   URL, whether typed into the textarea or extracted from the Excel file. A
   URL's host maps to a canonical token, and that token is then resolved
   against the account's real platform list (master data) so the value posted
   is exactly what the API expects. Anything unrecognised is Open Web. */

/* The platforms MarkScan serves through an endpoint of their OWN. These are
   tried FIRST and the UGC list below cannot overrule them — t.me is a row in
   that list, and Telegram has its own queue, so a lookup that answered first
   would quietly take every Telegram URL off it. */
const HOST_TOKENS: [RegExp, string][] = [
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/,                         'youtube'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.watch$|(^|\.)fb\.com$/,         'facebook'],
  [/(^|\.)instagram\.com$/,                                        'instagram'],
  [/(^|\.)twitter\.com$|(^|\.)x\.com$/,                            'twitter'],
  [/(^|\.)t\.me$|(^|\.)telegram\.(me|org)$/,                       'telegram'],
  [/(^|\.)(itunes|music|apps)\.apple\.com$/,                       'itunes'],
  [/(^|\.)play\.google\.com$/,                                     'play store'],
]

/* The UGC sites this page knew by heart before it could ask.

   Consulted ONLY when the live list could not be fetched at all — see detect().
   It is a standby for an unreachable reports_api, not a second opinion: a list
   that answered has already said whether a host is enrolled, and overriding that
   with a guess is how es.vk.com came to be submitted as UGC when upstream has
   never heard of it.

   A SET OF EXACT HOSTS, not the regex this used to be. That regex was anchored
   `(^|\.)vk\.com$`, so it matched every subdomain of every entry — and an
   unenrolled subdomain is precisely what the API rejects with "Domain is of
   different platform". Same trap as the parent walk in ugcMatch, in a second
   place. */
const FALLBACK_UGC_HOSTS = new Set([
  'tiktok.com', 'vk.com', 'vk.ru', 'ok.ru', 'dailymotion.com', 'dai.ly',
  'bilibili.com', 'sharechat.com', 'chomikuj.pl',
])

/* One row of /api/ugc-domains — the sub-platform list behind "UGC & other
   social media", read from mediascan.OtherUGCAndSocialMediaPlatforms via
   reports_api. See go-server/handlers/ugcdomains.go. */
interface UGCDomainRow {
  domain: string
  site: string
  platformType: string
  token: string
}

/** What a URL was recognised as, and why. `site` is the matched entry's own
    name — "BIGO LIVE" for bigo.tv — and is shown to the reader so a routing
    decision made from a list they cannot see is still one they can check. */
interface Detection {
  token: string
  site?: string
  platformType?: string
}

/*
ugcMatch finds the list entry a hostname belongs to.

THE EXACT HOST ONLY. NO PARENT DOMAINS — and that restraint is the whole point
of this function.

The obvious reading of "bigo.tv is in the list" is that m.bigo.tv is the same
site and should match it. The API disagrees, and says so plainly: submitting
in.pinterest.com under the UGC platform comes back

	400 — Domain is of different platform in.pinterest.com

even though pinterest.com is a row in the list. The platform is not a label to
be inferred; upstream holds its own roster keyed by host, and a URL is accepted
only when its host is ON it.

The list itself says the same thing if you read it: it carries m.vk.ru,
video.sibnet.ru, open.spotify.com, music.amazon.com and app.revolt.chat as rows
of their OWN, beside vk.ru and spotify. Subdomains are enrolled individually,
one at a time, by whoever onboards a site to monitor. Walking up to a parent
invents a membership nobody granted.

So an unlisted subdomain falls through to Open Web, which is the residual bucket
and takes any host. That is the right answer for it: better a takedown filed
against the web at large than one rejected outright, and it is exactly where
such a URL went before this list existed.

www. is stripped by hostOf before this sees it, so the www spelling is tried
here as well — a row enrolled as www.example.com is a row, and a reader pasting
the bare name should still find it.
*/
function ugcMatch(host: string, index: Map<string, UGCDomainRow>): UGCDomainRow | undefined {
  if (!host) return undefined
  return index.get(host) ?? index.get('www.' + host)
}

// Substrings that identify each token inside a real platform label.
const TOKEN_ALIASES: Record<string, string[]> = {
  youtube:      ['youtube'],
  facebook:     ['facebook'],
  instagram:    ['instagram'],
  twitter:      ['twitter', 'x (twitter)'],
  telegram:     ['telegram'],
  ugc:          ['ugc'],
  /* The UGC sites MarkScan names in their own right. Each falls back to the
     umbrella through resolvePlatform below when the account's platform list
     does not offer it, so naming one here can only ever improve the routing. */
  tiktok:       ['tiktok'],
  vk:           ['vk'],
  ok:           ['ok'],
  sharechat:    ['sharechat'],
  dailymotion:  ['dailymotion'],
  bilibili:     ['bilibili'],
  chomikuj:     ['chomikuj'],
  itunes:       ['i-tunes', 'itunes'],
  'play store': ['play store', 'playstore'],
  internet:     ['internet'],
}

/** The tokens that mean "a site inside the UGC & other social media family".
    Every one of them falls back to the umbrella rather than to Open Web — see
    resolvePlatform. Kept as its own set rather than derived from the aliases
    above, which also hold the named platforms that must NOT take that road. */
const UGC_TOKENS = new Set(['ugc', 'tiktok', 'vk', 'ok', 'sharechat', 'dailymotion', 'bilibili', 'chomikuj'])

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}

/*
detect resolves one URL to a platform token, best evidence first.

  1. the named platforms, which have their own upstream queues
  2. the live UGC sub-platform list — 192 sites, the reason this page can now
     tell bigo.tv from an unknown host
  3. the built-in UGC hosts, but ONLY when that list could not be fetched
  4. Open Web, which is where everything unrecognised has always gone

An unparseable URL is Open Web rather than an error: it is caught on the way in
by extractUrls, and anything that still reaches here is better submitted
somewhere than dropped.
*/
function detect(url: string, index: Map<string, UGCDomainRow>): Detection {
  const host = hostOf(url)
  if (!host) return { token: 'internet' }

  for (const [re, token] of HOST_TOKENS) if (re.test(host)) return { token }

  const hit = ugcMatch(host, index)
  if (hit) return { token: hit.token, site: hit.site, platformType: hit.platformType }

  /* The standby, and only when there is NO list. An index that loaded and did
     not contain this host has answered the question — the host is not enrolled —
     and the fallback must not talk over it. */
  if (index.size === 0 && FALLBACK_UGC_HOSTS.has(host)) return { token: 'ugc' }
  return { token: 'internet' }
}

/** Resolve a token to the account's own platform option; falls back to Open
    Web, then to the token itself so a submission is never silently dropped. */
function resolvePlatform(token: string, platforms: { key: string; label: string }[]): string {
  // Matched on `key`, never on `label`: the label is a display string ("Internet"
  // reads as "Open Web"), so matching it would miss the very platform it names.
  const aliases = TOKEN_ALIASES[token] ?? [token]
  const hit = platforms.find(p => aliases.some(a => p.key.toLowerCase().includes(a)))
  if (hit) return hit.key
  /* A UGC site the account does not name individually belongs under the
     UMBRELLA, not on Open Web. Without this a TikTok URL on an account whose
     platform list has no "TikTok" entry would be filed as a web page — a worse
     answer than the one this page gave before it could tell them apart.

     Only the UGC tokens take this road. A YouTube URL on an account with no
     YouTube platform is not a UGC submission, and routing it there would be
     inventing a queue for it; it falls through to Open Web as it always did. */
  if (UGC_TOKENS.has(token)) {
    const umbrella = platforms.find(p => p.key.toLowerCase().includes('ugc'))
    if (umbrella) return umbrella.key
  }
  const web = platforms.find(p => p.key.toLowerCase().includes('internet'))
  return web?.key ?? token
}

/** Split raw text (textarea or file contents) into URLs, matching how the
    server tokenises an uploaded file. */
function extractUrls(text: string): string[] {
  return text
    .split(/[\r\n,;\t]+/)
    .map(u => {
      const t = u.trim()
      /* A cell Excel QUOTED on save. It does that whenever the value holds a
         quote, a newline or a leading space, and the quote then sits in front
         of the scheme — so the row fails the test below and that URL is
         dropped from the submission with nothing on screen saying one went
         missing.

         Only a FULLY quoted token is unwrapped. A fragment carrying a single
         quote is half of a value the comma split above cut in two, and
         unwrapping it would submit a TRUNCATED url — worse than the drop,
         because it looks like it worked. That case is left exactly as it
         behaves today. */
      const quoted = /^"(.*)"$/.exec(t)
      return (quoted ? quoted[1].replace(/""/g, '"') : t).trim()
    })
    .filter(u => /^https?:\/\//i.test(u))
}

/*
THE TEMPLATE IS BUILT IN THE BROWSER, and is a CSV.

It used to be a link to /templates/urls_template.xlsx, a file that did not exist.
A missing path under this server does not 404 — it falls through to the SPA
fallback and returns index.html — so the browser dutifully saved a web page as
urls_template.xlsx and Excel answered "the file format or file extension is not
valid". Nothing in the chain was broken enough to report itself.

Building it here removes that failure mode entirely: there is no path to go
missing and no fallback to be caught by.

CSV RATHER THAN A REAL WORKBOOK, and that is the more important half. Nothing in
this feature can read an .xlsx. The page finds URLs by running a regex over the
file's TEXT, and so does the server's own upload path — while a real .xlsx is a
zip, with its text deflated inside. A genuine workbook therefore yields zero URLs
from either side. A CSV is text, opens in Excel on a double click, and survives
the round trip; it is what the "Save it as CSV" message in onFileChosen has been
telling people all along.

NO EXAMPLE URL IN IT. A sample row starting with http:// is indistinguishable
from a real one to the parser, so anyone who filled the template in without
deleting the example would submit a takedown against it. The guidance line
carries no scheme and no comma for the same reason: it has to survive being read
by extractUrls without becoming a URL or splitting into one.
*/
const TEMPLATE_FILENAME = 'urls_template.csv'
const TEMPLATE_CSV =
  // The BOM is for Excel, which otherwise reads a UTF-8 CSV as the local
  // codepage and mangles any non-ASCII path in a URL.
  '\uFEFF' +
  'URL\r\n' +
  'One URL per row below. Delete this row before uploading.\r\n'

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = TEMPLATE_FILENAME
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next tick rather than immediately: Safari has not always
  // finished reading the blob by the time click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/* Open Web / third-party app submissions carry a "source URL" per infringing
   URL upstream (PushInfringementswithSource) — the legitimate copy the
   infringing one is compared against. The reader submitting a takedown from
   this screen does not have that URL on hand and should not be blocked
   entering one, so every submission sends this placeholder instead of
   asking for a real one. See go-server/handlers/upload.go, which still
   requires the field be non-empty for these platforms — this is what
   satisfies that, not a bypass of it. */
const DUMMY_OFFICIAL_URL = 'https://example.com/official-source'

export default function UploadURLPage() {
  const [mode,        setMode]        = useState<'manual' | 'file'>('manual')
  const [assetName,   setAssetName]   = useState('')
  const [urls,        setUrls]        = useState('')
  const [file,        setFile]        = useState<File | null>(null)
  const [fileUrls,    setFileUrls]    = useState<string[]>([])
  const [fileError,   setFileError]   = useState('')
  const [dragging,    setDragging]    = useState(false)
  const [remarks,     setRemarks]     = useState('')
  const [loading,     setLoading]     = useState(false)
  const [toast,       setToast]       = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const [history,     setHistory]     = useState<HistoryRow[]>([])
  const [histLoading, setHistLoading] = useState(true)
  const [page,        setPage]        = useState(1)
  const [modal,       setModal]       = useState<HistoryRow | null>(null)
  const [modalQuery,  setModalQuery]  = useState('')
  const [copied,      setCopied]      = useState(false)
  // 'self' = only URLs this login submitted; 'company' = every login's, for a
  // Client Admin and IP House staff. Decided server-side — the MarkScan history
  // itself is company-wide (go-server/handlers/requestledger.go).
  const [scope,       setScope]       = useState<'self' | 'company'>('self')
  /* How many URLs this login is NOT being shown. The server has always
     reported it and nothing ever displayed it, so a reader looking at four of
     their colleague's forty submissions had no way to know the list was
     filtered — it simply looked like a quiet week. */
  const [hidden,      setHidden]     = useState(0)
  const [histQuery,   setHistQuery]  = useState('')
  const [histPlatform, setHistPlatform] = useState('')

  /* The UGC sub-platform list, indexed by hostname. Empty until it arrives and
     empty forever if it cannot be fetched — detect() treats it as an addition to
     the built-in host list rather than a replacement, so the form is usable from
     the first paint and degrades to exactly its old behaviour. */
  const [ugcIndex, setUgcIndex] = useState<Map<string, UGCDomainRow>>(new Map())

  const { platforms, assets } = useMasterData()
  const fileRef = useRef<HTMLInputElement>(null)
  /* dragenter and dragleave fire for every CHILD the pointer crosses, so a
     boolean flipped by them switches off the moment the cursor moves from the
     zone onto the icon inside it. Counting entries against leaves is what keeps
     the highlight on for as long as the pointer is anywhere within. */
  const dragDepth = useRef(0)

  useEffect(() => { loadHistory() }, [])

  /* Fetched ONCE per page load, not per keystroke. 192 rows is a few kilobytes,
     and holding it here is what lets the platform chips update as the reader
     types instead of after a round trip per edit. */
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const res  = await fetch('/api/ugc-domains', { credentials: 'include' })
        const data = await res.json()
        if (!live || !Array.isArray(data?.domains)) return
        const idx = new Map<string, UGCDomainRow>()
        for (const row of data.domains as UGCDomainRow[]) {
          if (row?.domain) idx.set(row.domain, row)
        }
        setUgcIndex(idx)
      } catch {
        /* Silent on purpose. The endpoint answers 200 with an empty list when
           the warehouse is unreachable, so reaching here means the portal itself
           is — and the reader is about to find that out from something that
           matters more than a platform chip. */
      }
    })()
    return () => { live = false }
  }, [])

  /*
    A file dropped NEAR the zone rather than on it still navigates the page away
    — the default action belongs to the window, and the zone can only cancel
    what lands inside it. Missing by a few pixels therefore costs the reader
    everything they had typed, which is a harsh penalty for poor aim.

    Only drags carrying FILES are swallowed. A plain preventDefault here would
    also block dropping selected text into the Remarks box, which is a thing
    people do and which has nothing to do with this.

    Bound only while the file tab is open, so the manual tab's textarea keeps
    every drop behaviour it has always had.
  */
  useEffect(() => {
    if (mode !== 'file') {
      dragDepth.current = 0
      setDragging(false)
      return
    }
    const swallow = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
        e.preventDefault()
      }
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [mode])

  /* The filter belongs to the batch being looked at, not to the reader — so it
     resets when a different one is opened, rather than hiding most of the next
     submission behind a term typed against the last. */
  useEffect(() => { setModalQuery(''); setCopied(false) }, [modal])

  /*
    The batch's URLs, split for reading and filtered by the box above.

    NO 50-ROW CAP. The old list stopped there and offered nothing past it, so
    the remainder of a large submission could not be reached from this screen at
    all. A few hundred rows of plain text is not a rendering problem worth
    hiding data over.
  */
  const modalUrls = useMemo(() => {
    const q = modalQuery.trim().toLowerCase()
    const rows = (modal?.urls || []).map(u => {
      const url = typeof u === 'string' ? u : ((u as any)?.url ?? '')
      let host = '', rest = ''
      try {
        const parsed = new URL(url)
        host = parsed.hostname.replace(/^www\./, '')
        rest = parsed.pathname + parsed.search
        if (rest === '/') rest = ''
      } catch { /* not parseable — the whole string is shown instead */ }
      return { url, host, rest }
    })
    return q ? rows.filter(r => r.url.toLowerCase().includes(q)) : rows
  }, [modal, modalQuery])

  async function copyModalUrls() {
    try {
      await navigator.clipboard.writeText(modalUrls.map(u => u.url).join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* Clipboard access is refused on an insecure origin and by some policies.
         Silent rather than a red toast: nothing was lost, and the URLs are on
         screen to select by hand. */
    }
  }

  // Lock page scroll + close on Escape while the URL detail modal is open
  useEffect(() => {
    if (!modal) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModal(null) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [modal])

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  async function loadHistory() {
    setHistLoading(true)
    try {
      const res  = await fetch('/api/upload-url', { credentials: 'include' })
      const data = await res.json()
      setHistory(Array.isArray(data.items) ? data.items : [])
      setScope(data.scope === 'company' ? 'company' : 'self')
      setHidden(Number(data.hiddenCount) || 0)
    } catch {
      setHistory([])
    } finally {
      setHistLoading(false)
    }
  }

  // The URLs actually being submitted, whichever input method is active.
  const activeUrls = mode === 'manual' ? extractUrls(urls) : fileUrls

  /* Detected platforms, in submission order.

     Every URL is routed to the platform its host implies — from the named-host
     list, then from the UGC sub-platform list, see detect(). A batch spanning
     several platforms still becomes one upstream call per platform, because the
     API takes a single platform per call; the difference is that the fan-out now
     happens on the SERVER, from one request, so a submission that touches three
     platforms is still one submission with one confirmation email.

     `sites` carries the names the URLs were matched against, so a reader can see
     that bigo.tv was recognised as BIGO LIVE rather than having to trust a chip
     that says "Other UGC" with no working. */
  /* Every URL with what it was recognised as — the site it matched in the UGC
     list, the platform token, and the account platform that token resolves to.
     Kept as its own step so the chips and the request are built from one
     decision per URL rather than two that could drift. */
  const detections = useMemo(
    () => activeUrls.map(url => {
      const d = detect(url, ugcIndex)
      return { url, token: d.token, site: d.site, platform: resolvePlatform(d.token, platforms) }
    }),
    [activeUrls, platforms, ugcIndex])

  const groups = useMemo(() => {
    const byPlatform = new Map<string, { platform: string; urls: string[]; sites: string[] }>()
    for (const d of detections) {
      const g = byPlatform.get(d.platform) ?? { platform: d.platform, urls: [], sites: [] }
      g.urls.push(d.url)
      if (d.site && !g.sites.includes(d.site)) g.sites.push(d.site)
      byPlatform.set(d.platform, g)
    }
    return [...byPlatform.values()].sort((a, b) => b.urls.length - a.urls.length)
  }, [detections])

  /*
    ── DRAG AND DROP ────────────────────────────────────────────────────

    The zone has read "Drag & drop or browse" since it was written and only ever
    implemented the browse half. With no drop handler the browser takes its
    DEFAULT action on a dropped file, which is to navigate to it — so the page
    was replaced by a raw CSV and the asset, the remarks and any URLs already
    entered went with it. Nothing announced a failure, because from the
    browser's point of view nothing failed.

    dragOver must preventDefault on EVERY event, not just on drop: a drop only
    fires at all if the dragover immediately before it was cancelled. That is the
    part most easily left out, and leaving it out looks exactly like this bug.
  */
  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)

    const dropped = e.dataTransfer?.files
    if (!dropped || dropped.length === 0) return
    /* Several at once is a mistake worth naming rather than resolving silently.
       The form submits ONE file, so quietly taking the first would drop the rest
       of somebody's URLs without ever saying which ones went. */
    if (dropped.length > 1) {
      setFile(null); setFileUrls([])
      setFileError(`${dropped.length} files were dropped — this form takes one at a time.`)
      return
    }
    onFileChosen(dropped[0])
  }

  /* Excel/CSV files are read in the browser so the platform can be detected
     before submitting — the same "keep every http token" rule the server used
     when it parsed the upload itself. */
  async function onFileChosen(f: File | null) {
    setFile(f); setFileUrls([]); setFileError('')
    if (!f) return
    try {
      const text = await f.text()

      /* A REAL WORKBOOK, caught by its own first bytes rather than by its
         extension. .xlsx (and .ods) are zip archives — "PK\x03\x04" — and every
         URL in one is deflated inside, so the regex below finds nothing and the
         generic "no URLs" message sends someone hunting through a file that is
         perfectly correct. Naming the actual problem is the difference between
         a thirty-second fix and a support ticket. */
      if (text.startsWith('PK\u0003\u0004')) {
        setFileError('This is an Excel workbook, and this page reads URLs as plain text. Open it in Excel and use File → Save As → CSV, then upload that.')
        return
      }

      const found = extractUrls(text)
      if (found.length === 0) {
        setFileError('No URLs could be read from this file. Each URL must be on its own row and start with http:// or https://. Download the template if you need the layout.')
        return
      }
      setFileUrls(found)
    } catch {
      setFileError('Could not read this file. Please try again or paste the URLs manually.')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!assetName) { showToast('Please select an Asset', 'error'); return }
    if (mode === 'file' && !file) { showToast('Please select an Excel file', 'error'); return }
    if (activeUrls.length === 0) {
      showToast(mode === 'manual' ? 'Please enter at least one URL' : 'No URLs were found in the selected file', 'error')
      return
    }

    setLoading(true)
    try {
      /* ONE request for the whole submission, however many platforms it spans.

         This used to be a POST per platform. Each one sent its own confirmation
         email and rang the admin bell again, so pasting a list that happened to
         touch three platforms produced three emails for one press of one button.
         The server now takes the groups and fans out to the upstream API itself,
         which is the only part that genuinely has to happen per platform. */
      const res = await fetch('/api/upload-url', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetName, officialUrl: DUMMY_OFFICIAL_URL, remarks, mode: 'manual',
          /* One group per platform, and the platform goes up exactly as the
             account names it. The API validates each URL's domain against this
             value — "Domain is of different platform kwai.com" — so the UGC
             umbrella is what UGC sites are submitted under, including the ones
             MarkScan also names individually. Sending anything else is what
             produces that error. */
          groups: groups.map(g => ({ platform: g.platform, urls: g.urls })),
        }),
      })
      const data = await res.json()

      /* Per-platform outcomes, which the server reports even on a failure — a
         batch where one platform was refused and two landed is not a failed
         submission, and the reader needs to know which part to send again. */
      const outcomes: { platform: string; count: number; ok: boolean; accepted?: number; error?: string }[] =
        Array.isArray(data?.results)
          ? data.results
          : groups.map(g => ({
              platform: g.platform, count: g.urls.length,
              ok: !!data?.success, error: data?.error,
            }))

      const okGroups = outcomes.filter(o => o.ok)
      const failed   = outcomes.filter(o => !o.ok)
      const okUrls   = okGroups.reduce((n, o) => n + o.count, 0)

      /* WHAT UPSTREAM ACTUALLY KEPT, where it said.

         Not the same as what was sent: seven Facebook URLs can come back as one
         stored row, and until this was surfaced the only way to find out was to
         read the submission history afterwards and wonder which number was
         wrong. Neither was — they count different things.

         All-or-nothing, the same rule the server applies: if any platform did
         not report a count, no total is claimed. Mixing a reported figure with
         an assumed one produces a number that looks measured and is not. */
      const anyUnknown = okGroups.some(o => typeof o.accepted !== 'number')
      const stored = anyUnknown ? null : okGroups.reduce((n, o) => n + (o.accepted as number), 0)
      const shortfall = stored !== null && stored < okUrls

      if (failed.length === 0) {
        if (shortfall) {
          /* Deliberately not phrased as an error — the submission WORKED, and
             the usual reason for the gap is that the rest were already on
             record. It is stated rather than explained because upstream does
             not say which it was, and guessing in a toast is how a duplicate
             becomes a reported bug. */
          showToast(
            `${stored} of ${okUrls} URLs recorded — the rest were not added upstream (most often already on record). Check Submission History.`,
            'error')
        } else {
          showToast(`${okUrls} URL${okUrls === 1 ? '' : 's'} submitted across ${okGroups.length} platform${okGroups.length === 1 ? '' : 's'}`)
        }
        setUrls(''); setRemarks(''); setFile(null); setFileUrls([])
        if (fileRef.current) fileRef.current.value = ''
      } else {
        const detail = failed.map(o => `${o.platform}: ${o.error || 'failed'}`).join(' · ')
        showToast(
          okGroups.length > 0
            ? `Submitted ${okUrls} URL(s); ${failed.length} platform(s) failed — ${detail}`
            : `Submission failed — ${detail}`,
          'error')
      }
      loadHistory()
    } catch (err: any) {
      showToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  function clearForm() {
    setUrls(''); setRemarks(''); setFile(null); setFileUrls([]); setFileError('')
    setAssetName('')
    if (fileRef.current) fileRef.current.value = ''
  }

  /* ── What the history is filtered to ──────────────────────────────────

     Both filters are applied HERE rather than at the table, so the summary
     figures, the platform bars, the record count and the pages all describe the
     same set of rows. Computing them off `history` while the table showed
     something narrower is the classic version of this bug: every number on
     screen is correct about a list nobody is looking at. */
  const platformsInHistory = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of history) if (r.platform && !seen.has(r.platform)) seen.set(r.platform, platformLabel(r.platform))
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [history])

  /* The search, applied on its own.

     Kept apart from the platform filter because the platform BARS are drawn
     from it — see platformMix. Drawing them from the fully filtered set made
     them collapse to the single platform that had just been chosen, which took
     the card off the screen and left no way to undo the choice from the control
     that made it. A picker has to keep showing the options it is not on. */
  const searchMatched = useMemo(() => {
    const q = histQuery.trim().toLowerCase()
    if (!q) return history
    return history.filter(r =>
      /* The URLs are searched too, not just the asset. The question a reader
         actually arrives with is "did we ever submit this link", and answering
         it from a paged table of dates is not possible otherwise. */
      (r.assetName || '').toLowerCase().includes(q)
      || platformLabel(r.platform).toLowerCase().includes(q)
      || (r.submitters || []).some(s => s.toLowerCase().includes(q))
      || (r.urls || []).some(u => String(u).toLowerCase().includes(q)))
  }, [history, histQuery])

  const visible = useMemo(
    () => histPlatform ? searchMatched.filter(r => r.platform === histPlatform) : searchMatched,
    [searchMatched, histPlatform])

  /* A filter that leaves the reader on page 7 of a two-page list shows an empty
     table and looks like "no results". */
  useEffect(() => { setPage(1) }, [histQuery, histPlatform])

  /*
    The headline figures — four counts, which is a KPI row and deliberately not
    a chart. Four separate magnitudes with no shared scale and no time axis have
    nothing to gain from bars; a one-bar bar chart is the classic way of making
    a single number harder to read than it was as text.
  */
  const stats = useMemo(() => {
    const assets = new Set<string>()
    const platforms = new Set<string>()
    let urls = 0
    for (const r of visible) {
      urls += r.urlCount || 0
      if (r.assetName) assets.add(r.assetName)
      if (r.platform) platforms.add(r.platform)
    }
    return { submissions: visible.length, urls, platforms: platforms.size, assets: assets.size }
  }, [visible])

  /*
    Where the URLs went, as a magnitude comparison across platforms.

    ONE HUE, not a colour per platform. Identity here is carried by the row's
    own label, so a categorical palette would add a second, weaker encoding of
    something already named in words — and would then have to survive a CVD
    check to say nothing new. The bars answer "how much went where", which is
    magnitude, and magnitude is a single hue by default.

    Rendered only for two platforms or more. One bar at 100% is a stat tile
    wearing a chart's clothes, and there is already a stat tile.
  */
  const platformMix = useMemo(() => {
    const by = new Map<string, number>()
    /* searchMatched, NOT visible — the bars are the platform picker, so they
       show every platform the search left standing whether or not one of them
       is currently selected. */
    for (const r of searchMatched) by.set(r.platform, (by.get(r.platform) || 0) + (r.urlCount || 0))
    const rows = [...by.entries()]
      .map(([platform, urls]) => ({ platform, urls }))
      .sort((a, b) => b.urls - a.urls)
    const max = rows.length ? rows[0].urls : 0
    return rows.map(r => ({ ...r, pct: max > 0 ? Math.round((r.urls / max) * 100) : 0 }))
  }, [searchMatched])

  const totalPages = Math.max(1, Math.ceil(visible.length / PER_PAGE))
  const pageRows   = visible.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const urlCount   = activeUrls.length

  const filtersOn = histQuery.trim() !== '' || histPlatform !== ''

  /* Big counts shortened so a tile never wraps. Below 10,000 the exact figure
     is shown with thousands separators — "9,512" is as readable as "9.5K" and
     is the number the reader can act on. */
  function compact(n: number) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M'
    if (n >= 10_000) return (n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '') + 'K'
    return n.toLocaleString()
  }

  function fmtDate(dt: string) {
    const d = new Date(dt)
    return isNaN(d.getTime()) ? dt : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  }

  return (
    <div className="fade-in">

      {/* ── Header row ── */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 mb-4 sm:mb-6">
        <Breadcrumb items={[{ label: 'Submit Take-downs' }, { label: 'Report Submission' }]} />
        <div className="sm:text-right hidden sm:block">
          <h1 className="text-xl font-bold text-[#14254A]">Report Submission</h1>
          <p className="text-brand-muted text-sm">Submit takedown requests and track history.</p>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl flex items-center gap-2 ${
          toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'
        }`}>
          {toast.type === 'success'
            ? <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
            : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          }
          {toast.msg}
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-5 lg:items-start">

        {/* ── LEFT SIDEBAR: form ── */}
        <aside className="w-full lg:w-72 xl:w-80 lg:flex-shrink-0 bg-white rounded-2xl border border-gray-100 shadow-card lg:self-start lg:sticky lg:top-5">
          <div className="h-1 rounded-t-2xl" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />

          <div className="p-5">

            {/* Header */}
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#14254A,#FC934C)' }}>
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              <div>
                <div className="font-bold text-[#14254A] text-sm">Report Submission</div>
                <div className="text-[10px] text-gray-400">Submit URLs for Takedown</div>
              </div>
            </div>

            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4">
              Submission Details
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">

              {/* Asset */}
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Asset <span className="text-red-400">*</span>
                </label>
                <SearchableSelect options={assets} value={assetName} onChange={setAssetName}
                  placeholder="Select asset…" emptyLabel="— Select asset —" />
              </div>

              <div className="border-t border-gray-100" />

              {/* Mode toggle */}
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Input Method
                </label>
                <div className="flex p-1 gap-1 rounded-xl bg-gray-100">
                  {(['manual', 'file'] as const).map(m => (
                    <button key={m} type="button" onClick={() => setMode(m)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                        mode === m ? 'bg-white text-[#14254A] shadow-sm' : 'text-gray-400 hover:text-gray-600'
                      }`}>
                      {m === 'manual' ? '✏ Manual' : '📊 Excel'}
                    </button>
                  ))}
                </div>
              </div>

              {mode === 'manual' ? (
                <>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                      URL List
                    </label>
                    <textarea value={urls} onChange={e => setUrls(e.target.value)} rows={6}
                      placeholder={"https://…\nhttps://…"}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A] resize-none font-mono"
                    />
                    {urlCount > 0 && (
                      <p className="text-[10px] text-brand-muted mt-1">{urlCount} URL{urlCount > 1 ? 's' : ''} entered</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                      Remarks
                    </label>
                    <textarea value={remarks} onChange={e => setRemarks(e.target.value)} rows={2}
                      placeholder="Optional notes…"
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A] resize-none"
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  <button type="button" onClick={downloadTemplate}
                    className="flex items-center justify-center gap-2 w-full rounded-xl py-2 px-4 text-xs font-semibold text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 transition-colors">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download CSV Template
                  </button>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                      Select File
                    </label>
                    <div
                      onClick={() => fileRef.current?.click()}
                      onDragEnter={onDragEnter}
                      onDragOver={onDragOver}
                      onDragLeave={onDragLeave}
                      onDrop={onDrop}
                      className={`rounded-xl border-2 border-dashed p-5 text-center cursor-pointer transition-all hover:border-[#14254A]/30 hover:bg-[#14254A]/[0.02] ${
                        dragging  ? 'border-[#14254A] bg-[#14254A]/[0.06]'
                        : file    ? 'border-emerald-300 bg-emerald-50/40'
                                  : 'border-gray-200'
                      }`}>
                      <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.txt"
                        onChange={e => onFileChosen(e.target.files?.[0] || null)} className="hidden" />
                      <svg className="w-7 h-7 mx-auto mb-2 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      {file ? (
                        <>
                          <p className="text-xs font-semibold text-emerald-700">{file.name}</p>
                          {fileUrls.length > 0 && (
                            <p className="text-[10px] text-gray-400 mt-0.5">{fileUrls.length} URL{fileUrls.length === 1 ? '' : 's'} read</p>
                          )}
                        </>
                      ) : (
                        <>
                          <p className="text-xs text-gray-500">
                            {dragging
                              ? <span className="font-semibold text-[#14254A]">Drop the file here</span>
                              : <>Drag &amp; drop or <span className="font-semibold text-[#14254A]">browse</span></>}
                          </p>
                          {/* Says CSV first because CSV is what actually parses:
                              a real .xlsx is a zip and its URLs never reach the
                              reader. The extension stays accepted so picking one
                              gives the explanation in onFileChosen rather than a
                              file dialog that refuses to show the file at all. */}
                          <p className="text-[10px] text-gray-400 mt-0.5">.csv or .txt — save Excel files as CSV</p>
                        </>
                      )}
                    </div>
                    {fileError && (
                      <p className="text-[10px] text-red-500 mt-1.5">{fileError}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                      Remarks
                    </label>
                    <textarea value={remarks} onChange={e => setRemarks(e.target.value)} rows={2}
                      placeholder="Optional notes…"
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A] resize-none"
                    />
                  </div>
                </div>
              )}

              {/* Detected platforms — derived from the submitted URLs, so there
                  is no platform to pick. One submission is sent per platform. */}
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Detected Platform{groups.length === 1 ? '' : 's'}
                </label>
                {groups.length === 0 ? (
                  <p className="text-[11px] text-gray-400 rounded-xl border border-dashed border-gray-200 px-3 py-2.5">
                    Add URLs above — the platform is detected from each URL's domain,
                    matched against the monitored UGC and social sites.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {groups.map(g => (
                        <span key={g.platform}
                          className="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-full text-[11px] font-semibold bg-[#14254A]/5 text-[#14254A] border border-[#14254A]/10">
                          {platformLabel(g.platform)}
                          <span className="font-black px-1.5 rounded-full bg-[#14254A] text-[#FFC82B]">{g.urls.length}</span>
                        </span>
                      ))}
                    </div>

                    {/* WHICH SITES were recognised, under the chips that carry
                        them. A chip reading "Other UGC · 3" is a decision made
                        from a list of 192 sites the reader cannot see; naming
                        them is what makes it checkable — and what makes a URL
                        routed to the wrong place obvious before it is sent. */}
                    {groups.some(g => g.sites.length > 0) && (
                      <ul className="mt-2 space-y-1">
                        {groups.filter(g => g.sites.length > 0).map(g => (
                          <li key={g.platform} className="text-[10px] text-gray-500 leading-snug">
                            <span className="font-semibold text-[#14254A]">{platformLabel(g.platform)}</span>
                            {' — '}{g.sites.join(', ')}
                          </li>
                        ))}
                      </ul>
                    )}

                    {groups.length > 1 && (
                      <p className="text-[10px] text-gray-400 mt-1.5">
                        {groups.length} platforms detected — sent as one submission,
                        with one confirmation email.
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* Actions */}
              <div className="space-y-2 pt-2">
                <button type="submit" disabled={loading}
                  className="w-full py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                  {loading ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Submitting…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                      </svg>
                      Submit for Takedown
                    </>
                  )}
                </button>
                <button type="button" onClick={clearForm}
                  className="w-full py-2 rounded-xl text-xs font-semibold text-gray-400 hover:text-gray-600 hover:bg-gray-50 border border-gray-200 transition-all flex items-center justify-center gap-1.5">
                  ↺ Clear Form
                </button>
              </div>
            </form>
          </div>
        </aside>

        {/* ── RIGHT PANEL: history ── */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* ── Summary band ──
              Four counts as a KPI row, not a chart. They are four unrelated
              magnitudes with no shared scale, so bars would add a visual
              comparison that means nothing — and a single value drawn as one
              bar is harder to read than the number was as text.

              Hidden while loading rather than shown as zeros: a figure that
              counts up from 0 as the fetch lands reads as a real measurement of
              an empty account. */}
          {!histLoading && history.length > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: 'Submissions', value: stats.submissions },
                { label: 'URLs',        value: stats.urls },
                { label: 'Platforms',   value: stats.platforms },
                { label: 'Assets',      value: stats.assets },
              ].map(s => (
                <div key={s.label}
                  className="bg-white rounded-2xl border border-gray-100 shadow-card px-4 py-3">
                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{s.label}</div>
                  {/* Proportional figures, not tabular: these are standalone
                      display numbers, and tabular-nums gives every digit the
                      width of a 0, which makes a value like 171 read loose. */}
                  <div className="text-2xl font-bold text-[#14254A] mt-0.5 leading-none">{compact(s.value)}</div>
                </div>
              ))}
            </div>
          )}

          {/* ── Where the URLs went ──
              A magnitude comparison across platforms, so: bars, ONE hue, sorted
              high to low, direct-labelled. Identity is the row's own name, so
              there is no legend and no per-platform colour to tell apart.

              Two platforms minimum — a single bar pinned at 100% states nothing
              the stat tile above has not already said. */}
          {!histLoading && platformMix.length > 1 && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card px-5 py-4">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Where they went</h3>
                <span className="text-[10px] text-gray-400">URLs per platform</span>
              </div>
              <div className="space-y-2.5">
                {platformMix.map(m => (
                  <button key={m.platform} type="button"
                    onClick={() => setHistPlatform(histPlatform === m.platform ? '' : m.platform)}
                    aria-pressed={histPlatform === m.platform}
                    title={histPlatform === m.platform
                      ? `${platformLabel(m.platform)} — ${m.urls} URL${m.urls === 1 ? '' : 's'}. Click to show all platforms.`
                      : `${platformLabel(m.platform)} — ${m.urls} URL${m.urls === 1 ? '' : 's'}. Click to show only these.`}
                    className="w-full text-left group">
                    <div className="flex items-baseline justify-between gap-3 mb-1">
                      <span className={`text-xs truncate transition-colors ${
                        histPlatform === m.platform ? 'text-[#14254A] font-semibold' : 'text-gray-600 group-hover:text-[#14254A]'
                      }`}>
                        {platformLabel(m.platform)}
                      </span>
                      {/* tabular-nums HERE, because these are a column of
                          numbers that must line up down the right edge. */}
                      <span className="text-xs font-semibold text-[#14254A] tabular-nums flex-shrink-0">{m.urls}</span>
                    </div>
                    {/* The track is a lighter step of the bar's own hue, so the
                        pair reads as one scale rather than as bar-on-grey. */}
                    <div className="h-2 rounded-full bg-[#14254A]/[0.07] overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          histPlatform && histPlatform !== m.platform ? 'bg-[#14254A]/25' : 'bg-[#14254A]'
                        }`}
                        /* Square at the baseline, rounded at the data end —
                           the end is what the eye measures, and rounding both
                           would lift the bar off its own zero. */
                        style={{ width: `${Math.max(m.pct, 2)}%`, borderRadius: '0 4px 4px 0' }}
                      />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">

            {/* Header bar */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="font-bold text-[#14254A] text-base flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  Submission History
                  {/* The account can be shared by several logins, so the list
                      states whose submissions it is showing. */}
                  <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${
                    scope === 'company'
                      ? 'bg-[#14254A]/5 text-[#14254A] border-[#14254A]/15'
                      : 'bg-orange-50 text-[#c2691f] border-orange-200'
                  }`}>
                    {scope === 'company' ? 'All users' : 'Yours'}
                  </span>
                </h2>
                <p className="text-xs text-brand-muted mt-0.5">
                  {/* Submissions, not "batches" — the word is out of the
                      product's vocabulary now, here as well as on the reports
                      it had leaked onto. */}
                  {scope === 'company'
                    ? 'Every URL submission made on this account'
                    : 'Only the URL submissions you made'}
                </p>
              </div>
              {!histLoading && history.length > 0 && (
                <span className="text-xs font-semibold px-3 py-1.5 rounded-full bg-[#14254A]/5 text-[#14254A] border border-[#14254A]/10 flex-shrink-0">
                  {/* Says "of N" only while filtered, so the badge never
                      implies a filter that is not on. */}
                  {visible.length}{filtersOn && history.length !== visible.length ? ` of ${history.length}` : ''}
                  {' '}record{visible.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* ── Filters, in one row above the table ──
                Present only once there is enough history to need them: a filter
                bar over three rows is furniture. */}
            {!histLoading && history.length > PER_PAGE / 2 && (
              <div className="flex flex-col sm:flex-row gap-2 px-5 py-3 border-b border-gray-100 bg-gray-50/40">
                <div className="relative flex-1 min-w-0">
                  <svg className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
                  </svg>
                  <input
                    value={histQuery}
                    onChange={e => setHistQuery(e.target.value)}
                    placeholder="Search asset, platform or URL…"
                    className="w-full text-xs rounded-xl border border-gray-200 bg-white pl-9 pr-8 py-2 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A] transition-all"
                  />
                  {histQuery && (
                    <button type="button" onClick={() => setHistQuery('')}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                <select
                  value={histPlatform}
                  onChange={e => setHistPlatform(e.target.value)}
                  aria-label="Filter by platform"
                  className="text-xs rounded-xl border border-gray-200 bg-white px-3 py-2 text-gray-600 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A] transition-all sm:w-52">
                  <option value="">All platforms</option>
                  {platformsInHistory.map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>
            )}

            {/* ── What this login is NOT being shown ──
                The server has always reported hiddenCount and nothing displayed
                it. A reader seeing four of their colleague's forty submissions
                had no way to tell a filtered list from a quiet week. */}
            {!histLoading && scope === 'self' && hidden > 0 && (
              <div className="flex items-start gap-2 px-5 py-2.5 border-b border-gray-100 bg-orange-50/50">
                <svg className="w-3.5 h-3.5 text-[#c2691f] flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-[11px] text-[#8a4a12] leading-relaxed">
                  <strong className="font-semibold">{compact(hidden)} URL{hidden === 1 ? '' : 's'}</strong>
                  {' '}submitted by colleagues on this account are not shown here.
                </p>
              </div>
            )}

            {/* Table */}
            <div className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[540px]">
                  <thead>
                    <tr style={{ background: '#14254A' }}>
                      <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">Date</th>
                      <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">Platform</th>
                      <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">Asset</th>
                      {scope === 'company' && (
                        <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">Submitted By</th>
                      )}
                      <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">URLs</th>
                      <th className="px-5 py-3.5 w-28"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {histLoading ? (
                      Array.from({ length: 6 }).map((_, i) => (
                        <tr key={i} className="border-b border-gray-50">
                          {[100, 110, 130, ...(scope === 'company' ? [90] : []), 45, 70].map((w, j) => (
                            <td key={j} className="px-5 py-4">
                              <div className="h-2.5 rounded-full animate-pulse bg-gray-100" style={{ width: w }} />
                            </td>
                          ))}
                        </tr>
                      ))
                    ) : pageRows.length === 0 ? (
                      <tr>
                        <td colSpan={scope === 'company' ? 6 : 5} className="text-center py-24 px-5">
                          <div className="w-16 h-16 rounded-2xl bg-[#14254A]/5 flex items-center justify-center mx-auto mb-4">
                            <svg className="w-8 h-8 text-[#14254A]/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                            </svg>
                          </div>
                          {filtersOn ? (
                            <>
                              <p className="font-semibold text-gray-600 mb-1">Nothing matches those filters</p>
                              <button type="button"
                                onClick={() => { setHistQuery(''); setHistPlatform('') }}
                                className="text-sm text-[#FC934C] hover:underline font-medium">
                                Clear filters
                              </button>
                            </>
                          ) : (
                            <>
                              <p className="font-semibold text-gray-600 mb-1">No submissions yet</p>
                              <p className="text-sm text-gray-400">Submit URLs using the form on the left.</p>
                            </>
                          )}
                        </td>
                      </tr>
                    ) : (
                      pageRows.map((row, i) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-[#14254A]/[0.02] transition-colors group">
                          <td className="px-5 py-4">
                            <span className="text-sm font-semibold text-[#14254A] whitespace-nowrap">{fmtDate(row.date)}</span>
                          </td>
                          <td className="px-5 py-4">
                            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-[#14254A]/8 text-[#14254A] border border-[#14254A]/10">
                              {platformLabel(row.platform)}
                            </span>
                          </td>
                          <td className="px-5 py-4 max-w-[180px]">
                            <span className="text-sm text-gray-500 truncate block" title={row.assetName}>
                              {row.assetName || '—'}
                            </span>
                          </td>
                          {scope === 'company' && (
                            <td className="px-5 py-4 max-w-[170px]">
                              {row.submitters && row.submitters.length > 0 ? (
                                <span className="text-xs font-semibold text-gray-700 truncate block"
                                  title={row.submitters.join(', ')}>
                                  {row.submitters[0]}
                                  {row.submitters.length > 1 && (
                                    <span className="text-gray-400 font-normal"> +{row.submitters.length - 1}</span>
                                  )}
                                </span>
                              ) : (
                                /* Batches submitted before attribution existed, or
                                   pushed straight to the API. */
                                <span className="text-xs text-gray-300 italic">Unattributed</span>
                              )}
                            </td>
                          )}
                          <td className="px-5 py-4">
                            <span className="inline-flex items-center justify-center min-w-[2.5rem] px-2.5 py-1 rounded-lg text-xs font-black bg-[#14254A] text-[#FFC82B]">
                              {row.urlCount}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-right">
                            <button onClick={() => setModal(row)}
                              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-[#FC934C] hover:text-[#FC934C] hover:bg-orange-50/50 transition-all">
                              View
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {visible.length > PER_PAGE && (
                <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 bg-gray-50/50">
                  <span className="text-xs text-brand-muted">
                    Showing{' '}
                    <strong className="text-[#14254A]">{(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, visible.length)}</strong>
                    {' '}of <strong className="text-[#14254A]">{visible.length}</strong>
                  </span>
                  <div className="flex items-center gap-1">
                    <PgBtn onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>‹</PgBtn>
                    {pgRange(page, totalPages).map((p, i) =>
                      p === '…'
                        ? <span key={i} className="px-1 text-xs text-gray-400">…</span>
                        : <PgBtn key={p} active={p === page} onClick={() => setPage(p as number)}>{p}</PgBtn>
                    )}
                    <PgBtn onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>›</PgBtn>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* URL Detail Modal — portalled to <body> so the overlay covers the whole
          screen rather than the page's content box (see components/ui/Portal) */}
      {modal && (
        <Portal>
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 backdrop-blur-sm"
          style={{ background: 'rgba(20,37,74,0.62)' }}
          role="dialog" aria-modal="true"
          onClick={() => setModal(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col"
            style={{ maxHeight: 'min(80dvh, 640px)', border: '1px solid rgba(20,37,74,0.12)' }}
            onClick={e => e.stopPropagation()}>

            <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-3 flex-shrink-0">
              <div className="min-w-0">
                <h3 className="font-bold text-[#14254A] text-sm flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-[#14254A]/8 text-[#14254A] border border-[#14254A]/10">
                    {platformLabel(modal.platform)}
                  </span>
                  <span className="text-gray-400 font-normal text-xs">{fmtDate(modal.date)}</span>
                </h3>
                {/* The asset was in the table row and vanished on the way in,
                    which made two batches of the same platform and date
                    indistinguishable once the modal was open. */}
                <p className="text-xs text-brand-muted mt-1 truncate" title={modal.assetName}>
                  {modal.assetName || '—'}
                </p>
              </div>
              <button onClick={() => setModal(null)} aria-label="Close"
                className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Search within the batch. A seventeen-URL list does not need it;
                the four-hundred-URL list this endpoint can return does, and
                there is no other way to answer "is this link in here". */}
            {(modal.urls?.length ?? 0) > 8 && (
              <div className="px-5 py-2.5 border-b border-gray-100 bg-gray-50/40 flex-shrink-0">
                <input
                  value={modalQuery}
                  onChange={e => setModalQuery(e.target.value)}
                  placeholder={`Filter ${modal.urls?.length} URLs…`}
                  className="w-full text-xs rounded-lg border border-gray-200 bg-white px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A] transition-all"
                />
              </div>
            )}

            <div className="overflow-y-auto flex-1 divide-y divide-gray-50">
              {modalUrls.length === 0 ? (
                <p className="px-5 py-8 text-center text-xs text-gray-400">
                  {modalQuery ? 'No URLs match that filter.' : 'This submission carries no URLs.'}
                </p>
              ) : modalUrls.map((u, i) => (
                /* Host and path split, because a column of forty URLs that all
                   begin "https://www." is a column the eye cannot scan. The
                   host is what tells them apart. */
                <div key={i} className="flex items-baseline gap-3 px-5 py-2.5 hover:bg-gray-50 transition-colors">
                  <span className="text-[10px] text-gray-300 tabular-nums w-7 flex-shrink-0 text-right">{i + 1}</span>
                  <a href={u.url} target="_blank" rel="noopener noreferrer"
                    className="min-w-0 flex-1 group" title={u.url}>
                    <span className="block text-xs font-medium text-[#14254A] group-hover:text-[#FC934C] transition-colors truncate">
                      {u.host || u.url}
                    </span>
                    {u.rest && (
                      <span className="block text-[10px] text-gray-400 truncate">{u.rest}</span>
                    )}
                  </a>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-gray-100 flex-shrink-0">
              {/* Every URL, not the first fifty. The old list stopped at fifty
                  and offered nothing beyond it — no paging, no export — so the
                  rest of a large submission was simply unreachable from here. */}
              <button onClick={copyModalUrls}
                className="px-3 py-2 rounded-xl border border-gray-200 text-xs font-semibold text-gray-600 hover:border-[#14254A]/30 hover:text-[#14254A] hover:bg-[#14254A]/[0.03] transition-all inline-flex items-center gap-1.5">
                {copied ? (
                  <>
                    <svg className="w-3.5 h-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Copy {modalQuery ? modalUrls.length : 'all'}
                  </>
                )}
              </button>
              <button onClick={() => setModal(null)}
                className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
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

function PgBtn({ children, onClick, disabled, active }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`min-w-[28px] h-[28px] px-2 rounded-lg text-xs font-bold border transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
        active
          ? 'border-transparent bg-[#14254A] text-[#FFC82B]'
          : 'border-gray-200 bg-white text-[#14254A] hover:bg-gray-50'
      }`}>
      {children}
    </button>
  )
}

function pgRange(cur: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  if (cur <= 4)         return [1, 2, 3, 4, 5, '…', total]
  if (cur >= total - 3) return [1, '…', total - 4, total - 3, total - 2, total - 1, total]
  return [1, '…', cur - 1, cur, cur + 1, '…', total]
}
