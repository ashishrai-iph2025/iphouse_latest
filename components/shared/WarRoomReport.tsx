'use client'

import { useMemo, useState, useRef, useEffect, type ReactNode } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  BarChart, Bar, Cell, LabelList, ComposedChart, Line,
} from 'recharts'
import {
  aggregate, TAT_BUCKETS, rowSubPlatform, rowChannelKey,
  type WarRoomReport as Report, type WarRoomRow, type WarRoomFilters,
  type Totals, type Funnel, type Removal, type Segment, type Breakdowns, type PlatformResult,
} from '@/lib/warroom'

const NAVY   = '#14254A'
const ORANGE = '#FC934C'
// Text-only variants of the above, painted via inline style={{color}} — these
// read CSS vars (globals.css) that flip for dark-mode contrast. The site's
// `.dark` class-override system only intercepts Tailwind class names
// (bg-white, text-[#14254A], …), not raw hex passed through inline style, so
// every stat/value number here needs to go through these instead of NAVY/the
// deep-orange hexes directly. NAVY/ORANGE themselves stay literal — they're
// also used for chart fills, icon-badge backgrounds and gradients, which read
// fine unchanged against a dark card.
const NAVY_TEXT   = 'var(--wr-navy-text)'
const ORANGE_TEXT = 'var(--wr-orange-text)'

const nf      = (n: number) => n.toLocaleString()
const compact = (n: number) =>
  Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)

type FilterDim = 'reason' | 'quality' | 'language' | 'country' | 'status' | 'searchEngine'

/* ── Admin-only "how is this calculated" tooltip ──────────────────────────
   Shown on every card/chart, but only to admin/super-admin logins — clicking
   the ⓘ reveals the exact formula/field logic behind that visual, so support
   staff can explain a number without reading the source. */
function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <span ref={ref} className="relative inline-flex flex-shrink-0">
      <button type="button" onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        title="How this is calculated (admin only)"
        className="w-3.5 h-3.5 grid place-items-center rounded-full text-gray-300 hover:text-[#14254A] hover:bg-[#14254A]/10 transition-colors">
        <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 8h.01M12 11v5" />
        </svg>
      </button>
      {open && (
        <div onClick={e => e.stopPropagation()}
          className="absolute z-50 top-5 left-0 w-64 sm:w-72 bg-[#14254A] text-white text-[11px] leading-relaxed rounded-lg shadow-xl p-3 normal-case font-normal tracking-normal">
          {text}
        </div>
      )}
    </span>
  )
}

/* Explanation text for every visual, admin/super-admin only. Keep these in
   sync with the actual aggregation logic in go-server/markscan/warroom.go —
   this is meant to describe reality, not aspiration. */
const LOGIC = {
  platformPicker: 'Each platform card totals rows fetched for that MarkScan endpoint (facebook/youtube/instagram/twitter/telegram/internet/UGC/etc). "Identified" = row count (Open Web counts distinct source+infringing URLs instead, since the same URL can repeat across rows). "Removed" = rows where removalStatus is Dead/Removed, or (Open Web infringing URLs) delistingStatus is Approved.',
  trend: 'Groups rows by day using ReportDay: urlUploadDate, falling back to discoveryDoneAt, then uploadDate, enforcementTime, removalTime, createdAt — whichever is populated first. Each day plots identified (row count that day) vs removed (same rows where isRemoved() is true).',
  openWebStats: 'Open Web identification is distinct URLs, not raw rows, since one URL can appear on many rows: "Distinct host URLs"/"domains" = unique sourceURL/domain values; "Distinct infringing URLs"/"domains" = unique infringingURL/domain values (rows with no sourceURL are infringing-URL rows).',
  newDomains: 'For each infringing domain, takes the earliest ReportDay across all its rows and buckets that domain under that first-seen date — so a domain only counts once, on the day it was first discovered.',
  searchEngine: 'Groups Open Web rows by the searchEngine field. Identified = row count per engine; Removed = rows where the same isRemoved() logic (Dead / delisting Approved) is true.',
  funnel: 'Discovered = total identified rows. Enforced = rows with a non-empty enforcementTime. Removed = rows where isRemoved() is true (Dead/Removed status, or Open Web delisting Approved). Each stage % is stage ÷ discovered; the small % next to each row is stage ÷ previous stage (conversion rate).',
  currentStatus: 'Buckets rows by removalStatus, title-cased (DEAD/Dead/dead all merge into one "Dead" bucket); blank status becomes "Pending". Bars show identified (count in that status) vs removed (rows in that status that also satisfy isRemoved()) — for most buckets these are equal since the status IS the removal signal.',
  hostVideo: 'removed = same Removed count as the funnel above. active = identified − removed (clamped at 0). The ring % = removed ÷ (removed + active).',
  channelsProfiles: 'Distinct channel/profile per platform: YouTube = channelId; Facebook/Instagram/Twitter = profileUrl; Telegram = channelUrl; UGC = channelOrProfileUrl. Removed = profileRemovalStatus is "Dead" (the Active/Dead column every paged endpoint returns); Active = everything else. YouTube additionally counts isChannelSuspended as removed (fallback for older cached rows). "Subscribers impacted" sums the MAX subscriberCount seen per distinct removed profile (not summed across every row, to avoid double-counting the same profile appearing on many URLs).',
  headlineKpi: 'Identification/Enforced/Removal/Views mirror the same totals as the Enforcement funnel and At-a-glance cards for the currently selected platform (or all platforms combined). Views sums viewCount across all identified rows.',
  kpiIdentification: 'Total identified row count for the current platform/filter selection (Open Web: distinct source+infringing URLs instead of raw rows).',
  kpiEnforced: 'Count of rows with a non-empty enforcementTime — a notice has gone out, regardless of whether it has been actioned yet.',
  kpiRemoval: 'Count of rows where isRemoved() is true (Dead/Removed status, or Open Web delisting Approved). The % shown is removed ÷ identified.',
  kpiViews: 'Sum of viewCount across every identified row for the current selection. Not shown for Open Web, which has no view-count concept.',
  removalRate: 'removed ÷ identified × 100, rounded to the nearest whole percent, for the current platform/filter selection.',
  atAGlance: 'Restates Identified, Enforced, Removed, Pending Removal (identified − removed), Total Views (Σ viewCount) and Engagement (Σ likeCount + Σ commentCount) for the current platform/filter selection — same underlying totals as the Headline KPIs, just laid out as a quick-reference grid.',
  tatUrlEnf: 'For each row, minutes between (urlUploadDate ?? discoveryDoneAt) and enforcementTime, bucketed into 0-15/15-30/31-45/46-60/1hr+ (TAT_BUCKETS). Rows missing either timestamp, or with a negative gap, are excluded — the row count shown is only rows where both timestamps exist.',
  tatEnfRem: 'For each row, minutes between enforcementTime and the effective removal timestamp, bucketed the same way. Effective removal time = removalTime for most platforms; for Open Web, host URLs use removalTime only once Dead, infringing URLs use delistingTime only once delistingStatus is Approved.',
  breakdownReason: 'Groups rows by infringementType (blank → "Unknown"). Identified = row count per type; Removed = rows of that type where isRemoved() is true.',
  breakdownQuality: 'Groups rows by qualityOfPrint (blank → "Unknown"). Same identified/removed split as Infringement type.',
  breakdownLanguage: 'Groups rows by the "language" field. Facebook/Instagram/Twitter rows populate this from audioLanguage instead (copied over once at ingestion since those endpoints don’t use a generic "language" field). Blank → "Unknown".',
  breakdownCountry: 'Groups rows by the "country" field (blank → "Unknown"). Hidden entirely when Telegram is the selected platform — Telegram rows carry no meaningful country data.',
  ugcPlatforms: 'Only shown when UGC & Other is the selected platform. The UGC endpoint is queried once per platform value — TikTok, Chomikuj, ShareChat, VK, OK, Bilibili, Dailymotion, plus the residual "UGC And Other Social Media" bucket — and named fetches tag their rows directly. Residual rows carry no platform field, so theirs is derived from the videoURL domain (tiktok.com → TikTok, vk.com → VK, ok.ru → OK, dai.ly → Dailymotion, …; an unmapped domain shows as itself; no usable URL → "UGC & Other"). Bars: Identified = row count per platform; Removed = rows where isRemoved() is true. Line (right axis): removal % = removed ÷ identified × 100. Clicking a bar cross-filters every card by that platform; clicking it again clears the filter.',
  repeatOffenders: 'A profile/channel (channelOrProfileUrl; YouTube: channelId) is a repeat offender when at least one of its URLs was removed (marked Dead, with a removalTime) and another of its URLs was discovered AFTER that first removal — i.e. it re-uploaded post-takedown. Identified / Removed = that profile’s total URL counts under the current filters; re-uploads = its URLs discovered after its first removal. Sorted by re-uploads. Profiles with no timestamped removal, or nothing discovered afterwards, don’t qualify. Clicking a row cross-filters every card to that profile’s URLs; clicking it again clears the filter.',
  assetCompare: 'Only shown when multiple assets are selected. Per asset: identified = row count (Open Web: distinct source+infringing URLs, same as the platform cards); removed = rows where isRemoved() is true; rate = removed ÷ identified.',
} as const

/* Friendly display names for the concrete platforms behind the UGC umbrella.
   Keys are lowercased subPlatform values as MarkScan sends them. */
const UGC_LABELS: Record<string, string> = {
  'tiktok': 'TikTok',
  'chomikuj': 'Chomikuj',
  'sharechat': 'ShareChat',
  'vk': 'VK',
  'ok': 'OK',
  'bilibili': 'Bilibili',
  'dailymotion': 'Dailymotion',
  'ugc and other social media': 'UGC & Other',
}

/* ═══════════════════════════════════════════════════════════════════════════
   Root component
═══════════════════════════════════════════════════════════════════════════ */
export default function WarRoomReport({ report, rows, admin = false }: { report: Report; rows: WarRoomRow[]; admin?: boolean }) {
  const [filters, setFilters] = useState<WarRoomFilters>({})

  const hasFilter = Object.values(filters).some(Boolean)
  const view = useMemo<Report>(
    () => (hasFilter && rows.length ? aggregate(rows, filters) : report),
    [hasFilter, rows, filters, report]
  )

  const activePlatform = filters.platform || ''
  const ap  = activePlatform ? view.platforms.find(p => p.platform === activePlatform) : undefined
  const s: Totals     = ap?.totals    ?? view.summary
  const f: Funnel     = ap?.funnel    ?? view.funnel
  const rem: Removal  = ap?.removal   ?? view.removal
  const b: Breakdowns = ap?.breakdowns ?? view.breakdowns

  const rowStatus = (r: WarRoomRow): string => {
    const s = String(r.removalStatus ?? '').trim()
    if (!s) return 'Pending'
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
  }
  const normalized = (value: string | undefined | null) => String(value ?? '').trim().toLowerCase()

  const parseTime = (value?: string | null) => {
    const raw = String(value ?? '').trim()
    if (!raw) return null
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T')
    const d = new Date(iso)
    return Number.isFinite(d.getTime()) ? d : null
  }
  const diffMinutes = (from?: string | null, to?: string | null) => {
    const dtA = parseTime(from)
    const dtB = parseTime(to)
    if (!dtA || !dtB) return null
    return (dtB.getTime() - dtA.getTime()) / 60000
  }

  // Effective removal timestamp for TAT: Open Web infringing URLs (no host URL)
  // use delistingTime once Approved; Open Web host URLs must be Dead; every
  // other platform uses removalTime directly.
  const removalStamp = (r: WarRoomRow): string | null | undefined => {
    if (normalized(r.platform) === 'internet') {
      if (r.isSource) return normalized(r.removalStatus) === 'dead' ? r.removalTime : null
      return normalized(r.delistingStatus) === 'approved' ? r.delistingTime : null
    }
    return r.removalTime
  }

  const matchesFilters = (r: WarRoomRow, f: WarRoomFilters = filters): boolean => {
    if (f.platform && normalized(r.platform) !== f.platform.toLowerCase()) return false
    if (f.subPlatform && rowSubPlatform(r) !== f.subPlatform.toLowerCase()) return false
    if (f.offender && rowChannelKey(r) !== f.offender.toLowerCase()) return false
    if (f.reason   && normalized(r.infringementType) !== f.reason.toLowerCase())   return false
    if (f.quality  && normalized(r.qualityOfPrint)   !== f.quality.toLowerCase())  return false
    if (f.language && normalized(r.language)         !== f.language.toLowerCase()) return false
    if (f.country  && normalized(r.country)          !== f.country.toLowerCase())  return false
    if (f.status   && rowStatus(r).toLowerCase()     !== f.status.toLowerCase())   return false
    if (f.tatUrlEnf) {
      const bkt = TAT_BUCKETS.find(bk => bk.label === f.tatUrlEnf)
      const mins = diffMinutes(r.urlUploadDate ?? r.discoveryDoneAt, r.enforcementTime)
      if (!bkt || mins === null || !bkt.test(mins)) return false
    }
    if (f.tatEnfRem) {
      const bkt = TAT_BUCKETS.find(bk => bk.label === f.tatEnfRem)
      const mins = diffMinutes(r.enforcementTime, removalStamp(r))
      if (!bkt || mins === null || !bkt.test(mins)) return false
    }
    if (f.searchEngine && normalized(r.searchEngine) !== f.searchEngine.toLowerCase()) return false
    return true
  }

  const activeRows = useMemo(() => hasFilter ? rows.filter(r => matchesFilters(r)) : rows, [hasFilter, rows, filters])

  // TAT_BUCKETS imported from warroom.ts

  const bucketCounts = (rows: WarRoomRow[], getMinutes: (r: WarRoomRow) => number | null) =>
    TAT_BUCKETS.map(bucket => ({
      label: bucket.label,
      count: rows.reduce((sum, r) => {
        const mins = getMinutes(r)
        return sum + (mins !== null && mins >= 0 && bucket.test(mins) ? 1 : 0)
      }, 0),
    }))

  const tatUrlToEnforcement = useMemo(
    () => bucketCounts(activeRows, r => diffMinutes(r.urlUploadDate ?? r.discoveryDoneAt, r.enforcementTime)),
    [activeRows]
  )
  const tatEnforcementToRemoval = useMemo(
    () => bucketCounts(activeRows, r => diffMinutes(r.enforcementTime, removalStamp(r))),
    [activeRows]
  )

  // ── Per-asset comparison (only when multiple assets were selected) ────────
  const multiAsset = useMemo(
    () => new Set(rows.map(r => String(r.assetName ?? '').trim().toLowerCase() || 'unknown')).size > 1,
    [rows]
  )
  const assetCompare = useMemo(() => {
    if (!multiAsset) return []
    const isRowRemoved = (r: WarRoomRow) => {
      if (String(r.removalTime ?? '').trim()) return true
      const st = normalized(r.removalStatus)
      if (st === 'dead' || st === 'removed') return true
      return normalized(r.delistingStatus) === 'approved'
    }
    type Agg = { asset: string; rows: number; removed: number; owRows: number; owSrc: Set<string>; owInf: Set<string> }
    const byAsset = new Map<string, Agg>()
    for (const r of activeRows) {
      const name = String(r.assetName ?? '').trim() || 'Unknown'
      const key = name.toLowerCase()
      let a = byAsset.get(key)
      if (!a) { a = { asset: name, rows: 0, removed: 0, owRows: 0, owSrc: new Set(), owInf: new Set() }; byAsset.set(key, a) }
      a.rows++
      if (isRowRemoved(r)) a.removed++
      // Open Web identification is distinct sourceURL + distinct infringingURL
      if (normalized(r.platform) === 'internet') {
        a.owRows++
        const su = normalized(r.sourceURL);     if (su) a.owSrc.add(su)
        const iu = normalized(r.infringingURL); if (iu) a.owInf.add(iu)
      }
    }
    return [...byAsset.values()]
      .map(a => {
        const identified = a.rows - a.owRows + a.owSrc.size + a.owInf.size
        return {
          asset: a.asset,
          identified,
          removed: a.removed,
          rate: identified > 0 ? Math.round((a.removed / identified) * 100) : 0,
        }
      })
      .sort((x, y) => y.identified - x.identified)
  }, [multiAsset, activeRows])

  // ── Open Web (internet platform) intelligence ─────────────────────────────
  // Computed client-side from the trimmed rows so it respects every active
  // cross-filter. sourceURL rows are the pirate host pages; rows without a
  // sourceURL are infringing URLs (search results / embed pages).
  const openWeb = useMemo(() => {
    const ow = activeRows.filter(r => normalized(r.platform) === 'internet')
    if (!ow.length) return null

    let sourceCount = 0
    const srcUrls    = new Set<string>()
    const srcDomains = new Set<string>()
    const infDomains = new Set<string>()
    const infUrls    = new Set<string>()
    const engineMap  = new Map<string, Segment>()
    const domainFirstSeen = new Map<string, string>()

    const owRemoved = (r: WarRoomRow) => {
      const st = normalized(r.removalStatus)
      return st === 'dead' || st === 'removed' ||
        normalized(r.delistingStatus) === 'approved' ||
        String(r.removalTime ?? '').trim() !== ''
    }

    for (const r of ow) {
      if (r.isSource) sourceCount++
      const su = normalized(r.sourceURL);        if (su) srcUrls.add(su)
      const sd = normalized(r.sourceDomain);     if (sd) srcDomains.add(sd)
      const id = normalized(r.infringingDomain); if (id) infDomains.add(id)
      const iu = normalized(r.infringingURL);    if (iu) infUrls.add(iu)

      // Search-engine spread of infringing URLs
      if (iu) {
        const rawEng = String(r.searchEngine ?? '').trim() || 'Unknown'
        const k = rawEng.toLowerCase()
        let seg = engineMap.get(k)
        if (!seg) {
          const label = rawEng.charAt(0).toUpperCase() + rawEng.slice(1)
          seg = { key: label, label, identified: 0, removed: 0 }
          engineMap.set(k, seg)
        }
        seg.identified++
        if (owRemoved(r)) seg.removed++
      }

      // First date each infringing domain was seen → "newly identified domains"
      const day = String(r.urlUploadDate ?? r.discoveryDoneAt ?? '').slice(0, 10)
      if (id && day.length === 10) {
        const prev = domainFirstSeen.get(id)
        if (!prev || day < prev) domainFirstSeen.set(id, day)
      }
    }

    const newPerDay = new Map<string, number>()
    for (const day of domainFirstSeen.values()) newPerDay.set(day, (newPerDay.get(day) ?? 0) + 1)
    const newDomainsByDate = [...newPerDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, count]) => ({ date, count }))

    return {
      total: ow.length,
      sourceCount,
      infringingCount: ow.length - sourceCount,
      distinctSourceUrls:        srcUrls.size,
      distinctInfringingUrls:    infUrls.size,
      distinctSourceDomains:     srcDomains.size,
      distinctInfringingDomains: infDomains.size,
      // Identification = distinct host URLs + distinct infringing URLs
      identification:            srcUrls.size + infUrls.size,
      bySearchEngine: [...engineMap.values()].sort((a, b) => b.identified - a.identified),
      newDomainsByDate,
    }
  }, [activeRows])

  // //── UGC sub-platform breakdown (only rendered when UGC & Other is selected).
  // Rows under the umbrella carry subPlatform (tiktok/vk/…) from ingestion;
  // rows cached before that field existed fall into the residual bucket.
  const ugcBreakdown = useMemo(() => {
    // Ignore the subPlatform filter itself so every platform's bar stays on
    // screen for comparison — the selected one is highlighted, not isolated.
    const ignoreOwn: WarRoomFilters = { ...filters, subPlatform: '' }
    const ugc = rows.filter(r =>
      normalized(r.platform) === 'ugc and other social media' && matchesFilters(r, ignoreOwn))
    if (!ugc.length) return []
    const isRowRemoved = (r: WarRoomRow) => {
      if (String(r.removalTime ?? '').trim()) return true
      const st = normalized(r.removalStatus)
      return st === 'dead' || st === 'removed' || normalized(r.delistingStatus) === 'approved'
    }
    const map = new Map<string, { key: string; label: string; identified: number; removed: number }>()
    for (const r of ugc) {
      const raw = String(r.subPlatform ?? '').trim() || 'UGC And Other Social Media'
      const key = raw.toLowerCase()
      let a = map.get(key)
      if (!a) {
        const label = UGC_LABELS[key] ?? raw.charAt(0).toUpperCase() + raw.slice(1)
        a = { key, label, identified: 0, removed: 0 }
        map.set(key, a)
      }
      a.identified++
      if (isRowRemoved(r)) a.removed++
    }
    return [...map.values()]
      .map(a => ({ ...a, rate: a.identified > 0 ? Math.round((a.removed / a.identified) * 100) : 0 }))
      .sort((x, y) => y.identified - x.identified)
  }, [rows, filters])

  // ── Repeat offenders: profiles whose new URLs were discovered AFTER one of
  // their earlier URLs was already removed. Grouped by the canonical profile
  // identity (channelOrProfileUrl; YouTube falls back to channelId). Anchor =
  // the profile's EARLIEST timestamped removal; every URL discovered after
  // that anchor is a re-upload. Computed from activeRows so it cross-filters.
  const repeatOffenders = useMemo(() => {
    const isRowRemoved = (r: WarRoomRow) => {
      if (String(r.removalTime ?? '').trim()) return true
      const st = normalized(r.removalStatus)
      return st === 'dead' || st === 'removed' || normalized(r.delistingStatus) === 'approved'
    }
    // Ignore the offender filter itself so the full list stays on screen —
    // the selected profile is highlighted, not isolated.
    const ignoreOwn: WarRoomFilters = { ...filters, offender: '' }
    const source = rows.filter(r => matchesFilters(r, ignoreOwn))
    const groups = new Map<string, { url: string; rows: WarRoomRow[] }>()
    for (const r of source) {
      const key = rowChannelKey(r)
      if (!key) continue
      let g = groups.get(key)
      if (!g) {
        const curl = String(r.channelOrProfileUrl ?? '').trim()
        const cid  = String(r.channelId ?? '').trim()
        g = { url: curl || cid, rows: [] }
        groups.set(key, g)
      }
      g.rows.push(r)
    }
    const out: { key: string; url: string; identified: number; removed: number; reuploads: number }[] = []
    for (const [key, g] of groups) {
      if (g.rows.length < 2) continue
      let firstRemoval: number | null = null
      for (const r of g.rows) {
        if (!isRowRemoved(r)) continue
        const t = parseTime(r.removalTime)
        if (t && (firstRemoval === null || t.getTime() < firstRemoval)) firstRemoval = t.getTime()
      }
      if (firstRemoval === null) continue
      let reuploads = 0
      for (const r of g.rows) {
        const d = parseTime(String(r.urlUploadDate ?? r.discoveryDoneAt ?? r.uploadDate ?? r.createdAt ?? ''))
        if (d && d.getTime() > firstRemoval) reuploads++
      }
      if (!reuploads) continue
      out.push({
        key, url: g.url,
        identified: g.rows.length,
        removed: g.rows.filter(isRowRemoved).length,
        reuploads,
      })
    }
    return out.sort((a, b) => b.reuploads - a.reuploads || b.identified - a.identified)
  }, [rows, filters])

  const removalRate = s.identified > 0 ? Math.round((s.removed / s.identified) * 100) : 0

  const toggle = (dim: keyof WarRoomFilters, key: string) =>
    setFilters(prev => ({ ...prev, [dim]: prev[dim] === key ? '' : key }))
  const selectPlatform = (key: string) =>
    setFilters(prev => {
      const next = prev.platform === key ? '' : key
      // The subPlatform filter only makes sense while UGC & Other is selected.
      return { ...prev, platform: next, subPlatform: next === 'ugc and other social media' ? prev.subPlatform : '' }
    })

  // ── "Unknown" inspector ─────────────────────────────────────────────────
  // A segment labelled Unknown means rows arrived with that field blank/null.
  // Clicking the inspect icon on such a segment opens a modal listing the
  // MarkScan IDs behind it, so the gap can be traced back at the source.
  const [inspect, setInspect] = useState<{ dim: FilterDim; title: string } | null>(null)
  const DIM_FIELD: Record<FilterDim, (r: WarRoomRow) => string> = {
    reason:       r => String(r.infringementType ?? ''),
    quality:      r => String(r.qualityOfPrint ?? ''),
    language:     r => String(r.language ?? ''),
    country:      r => String(r.country ?? ''),
    status:       r => String(r.removalStatus ?? ''),
    searchEngine: r => String(r.searchEngine ?? ''),
  }
  const inspectRows = useMemo(() => {
    if (!inspect) return []
    const get = DIM_FIELD[inspect.dim]
    return rows.filter(r =>
      (!activePlatform || normalized(r.platform) === activePlatform.toLowerCase()) &&
      get(r).trim() === ''
    )
  }, [inspect, rows, activePlatform])
  const openInspect = (dim: FilterDim, title: string) => setInspect({ dim, title })

  const DIM_LABEL: Partial<Record<keyof WarRoomFilters, string>> = {
    reason: 'Infringement', quality: 'Quality', language: 'Language',
    country: 'Country', status: 'Status', platform: 'Platform',
    subPlatform: 'UGC Platform', offender: 'Profile',
    tatUrlEnf: 'TAT URL→Enf', tatEnfRem: 'TAT Enf→Rem',
    searchEngine: 'Search Engine',
  }
  const activeChips = (
    ['reason', 'quality', 'language', 'country', 'status', 'platform', 'subPlatform', 'offender', 'tatUrlEnf', 'tatEnfRem',
     'searchEngine'] as const
  ).filter(k => filters[k])

  const isUgcSelected = activePlatform === 'ugc and other social media'
  const isOpenWeb     = activePlatform === 'internet'
  // Platforms whose extra sections (UGC breakdown / Open Web intelligence)
  // already dominate the center column render the shared blocks below at full
  // page width instead of squeezing them beside the KPI sidebar.
  const fullWidthBlocks = isUgcSelected || isOpenWeb

  /* Date-wise trend. Defined once, rendered full-width for Open Web (its
     intelligence cards already dominate the center column), inside the center
     column for everything else. */
  const trendBlock = (
    <div className={isOpenWeb ? 'mt-3' : ''}>
      <Label info={admin && <InfoTip text={LOGIC.trend} />}>Date-wise trend — identified vs removed</Label>
      <Card className="p-4 mt-1">
        <TrendChart data={b.byDate ?? []} />
      </Card>
    </div>
  )

  /* Funnel, status, donuts. Equal-height rows (items-stretch) so every card in
     a row shares the same height and width — plain row-major grid, no masonry
     reflow, so nothing zigzags. Same two-slot treatment as the trend block. */
  const funnelStatusRow = (
    <div className={`grid grid-cols-1 md:grid-cols-2 gap-3 items-stretch ${
      activePlatform === 'internet' ? 'xl:grid-cols-3' : 'xl:grid-cols-4'} ${fullWidthBlocks ? 'mt-3' : ''}`}>

      <div className="flex flex-col">
        <Label info={admin && <InfoTip text={LOGIC.funnel} />}>Enforcement funnel</Label>
        <Card className="mt-1 overflow-hidden flex-1 flex flex-col">
          <FunnelView f={f} />
        </Card>
      </div>
      <div className="flex flex-col">
        <Label>Current status</Label>
        <SegmentBars className="flex-1 mt-1" title="Current status" data={b.byStatus} dim="status" active={filters.status} onSelect={toggle} info={admin && <InfoTip text={LOGIC.currentStatus} />} />
      </div>
      <div className="flex flex-col">
        <Label info={admin && <InfoTip text={LOGIC.hostVideo} />}>Host / video URLs</Label>
        <DonutCard className="flex-1"
          title="Host / video URLs" icon={<IconLink />}
          removed={rem.urlRemoved} pending={rem.urlPending} tone="navy"
        />
      </div>
      {activePlatform !== 'internet' && (
        <div className="flex flex-col">
          <Label info={admin && <InfoTip text={LOGIC.channelsProfiles} />}>Channels / profiles</Label>
          <DonutCard className="flex-1"
            title="Channels / profiles" icon={<IconUser />}
            removed={rem.channelsRemoved} pending={rem.channelsActive} tone="orange"
            removedLabel="dead" pendingLabel="active"
            extras={[
              { label: 'Distinct channels',    value: nf(rem.channelsTotal) },
              { label: 'Subscribers impacted', value: nf(rem.subscribersImpacted) },
            ]}
          />
        </div>
      )}
    </div>
  )

  return (
    <div className="fade-in w-full">

      {/* Active filter chips */}
      {hasFilter && (
        <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
          {activeChips.map(k => (
            <button key={k} onClick={() => toggle(k as any, filters[k as keyof WarRoomFilters]!)}
              className="px-2.5 py-1 rounded-full font-semibold border transition-colors"
              style={{ background: '#FC934C15', borderColor: '#FC934C55', color: ORANGE_TEXT }}>
              {DIM_LABEL[k] ?? k}: <strong>{filters[k as keyof WarRoomFilters]}</strong> ✕
            </button>
          ))}
          <button onClick={() => setFilters({})}
            className="px-2.5 py-1 rounded-full font-semibold border border-gray-200 text-gray-500 hover:bg-gray-50">
            Clear all
          </button>
        </div>
      )}

      {/* ── 2-section layout: Headline KPIs pinned right, everything else
             (including the platform picker trigger) uses the full remaining
             width instead of losing a fixed column to a pinned platform list. ── */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_210px] gap-4 items-start">

        {/* ── CENTER: auto-arranged content ─────────────────────────────────── */}
        <div className="min-w-0 w-full flex flex-col gap-3">

          {/* Platform row — every platform as a pill in one horizontally
              scrollable row, so nothing is hidden behind a click and the
              cards below still get the full page width. */}
          <div>
            <Label info={admin && <InfoTip text={LOGIC.platformPicker} />}>Platform</Label>
            <div className="flex gap-2 overflow-x-auto pb-1">
              <button
                onClick={() => selectPlatform(activePlatform)}
                className={`flex-shrink-0 text-left rounded-xl border-2 p-3 transition-all ${
                  !activePlatform
                    ? 'border-[#14254A] bg-[#14254A]/5'
                    : 'border-gray-100 bg-white hover:border-[#14254A]/30'
                }`}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="w-6 h-6 rounded-md grid place-items-center text-white flex-shrink-0" style={{ background: NAVY }}>
                    <IconGrid />
                  </span>
                  <span className="text-xs font-bold text-[#14254A] whitespace-nowrap">All Platforms</span>
                </div>
                <div className="flex gap-3">
                  <Stat n={compact(view.summary.identified)} label="Total" tone="navy" />
                  <Stat n={compact(view.summary.removed)} label="Removed" tone="orange" />
                </div>
              </button>

              {view.platforms.filter(p => p.available).map(p => {
                const rate    = p.totals.identified > 0 ? Math.round((p.totals.removed / p.totals.identified) * 100) : 0
                const isActive = activePlatform === p.platform
                return (
                  <button key={p.platform} onClick={() => selectPlatform(p.platform)}
                    className={`flex-shrink-0 text-left rounded-xl border-2 p-3 transition-all ${
                      isActive ? 'border-[#FC934C] bg-orange-50/60'
                      :          'border-gray-100 bg-white hover:border-[#FC934C]/30'
                    }`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="w-6 h-6 rounded-md grid place-items-center text-white text-[11px] font-bold flex-shrink-0"
                        style={{ background: NAVY }}>
                        {p.label.charAt(0)}
                      </span>
                      <span className="text-xs font-bold text-[#14254A] whitespace-nowrap">{p.label}</span>
                      {rate > 0 && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                          style={{ background: '#FC934C20', color: ORANGE_TEXT }}>{rate}%</span>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <Stat n={compact(p.totals.identified)} label="Identified" tone="navy" />
                      <Stat n={compact(p.totals.removed)} label="Removed" tone="orange" />
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Open Web intelligence — only when the Open Web platform is selected */}
          {activePlatform === 'internet' && openWeb && (
            <div>
              <Label info={admin && <InfoTip text={LOGIC.openWebStats} />}>Open Web — hosts &amp; infringing URLs</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mt-3">
                <OwStat label="Distinct host URLs"          value={nf(openWeb.distinctSourceUrls)}        foot={`identification: ${nf(openWeb.identification)}`} tone="navy" />
                <OwStat label="Distinct infringing URLs"    value={nf(openWeb.distinctInfringingUrls)}    foot={`${nf(openWeb.total)} total rows`} tone="orange" />
                <OwStat label="Distinct host domains"       value={nf(openWeb.distinctSourceDomains)}     foot="unique host domains" tone="navy" />
                <OwStat label="Distinct infringing domains" value={nf(openWeb.distinctInfringingDomains)} foot="unique linking domains" tone="orange" />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-3">
                <div className="flex flex-col">
                  <Label info={admin && <InfoTip text={LOGIC.newDomains} />}>Date-wise newly identified domains</Label>
                  <Card className="p-4 flex-1 mt-1">
                    <NewDomainsChart data={openWeb.newDomainsByDate} />
                  </Card>
                </div>
                <div className="flex flex-col">
                  <Label info={admin && <InfoTip text={LOGIC.searchEngine} />}>Infringing URLs by search engine</Label>
                  <div className="mt-1 flex-1 flex flex-col">
                    <SegmentBars className="flex-1" title="Search engine" data={openWeb.bySearchEngine}
                      dim="searchEngine" active={filters.searchEngine} onSelect={toggle} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* UGC platform breakdown — only when UGC & Other is selected */}
          {activePlatform === 'ugc and other social media' && ugcBreakdown.length > 0 && (
            <div>
              <Label info={admin && <InfoTip text={LOGIC.ugcPlatforms} />}>
                UGC platforms — identification, removal &amp; removal % · click a bar to filter
              </Label>
              <Card className="p-4 mt-1">
                <UgcPlatformChart data={ugcBreakdown} active={filters.subPlatform}
                  onSelect={k => toggle('subPlatform', k)} />
              </Card>
            </div>
          )}

          {/* Trend chart center slot — full-width below when Open Web is selected */}
          {!isOpenWeb && trendBlock}

          {/* Asset comparison — only when multiple assets are selected */}
          {multiAsset && assetCompare.length > 0 && (
            <div>
              <Label info={admin && <InfoTip text={LOGIC.assetCompare} />}>Asset comparison — identification vs removal</Label>
              <Card className="p-4 mt-1">
                <AssetCompareChart data={assetCompare} />
              </Card>
            </div>
          )}

          {/* Funnel/status/donuts center slot — UGC & Other and Open Web render
              the same row full-width below instead. */}
          {!fullWidthBlocks && funnelStatusRow}
        </div>

        {/* ── RIGHT: Headline KPIs ──────────────────────────────────────────── */}
        <div className="w-full flex flex-col gap-3 xl:sticky xl:top-4 xl:self-start">
          <Label info={admin && <InfoTip text={LOGIC.headlineKpi} />}>Headline KPIs{ap ? ` — ${ap.label}` : ''}</Label>
          <Kpi label="Identification" value={nf(s.identified)}      foot="URLs identified"      tone="navy"   icon={<IconShield />} info={admin && <InfoTip text={LOGIC.kpiIdentification} />} />
          <Kpi label="Enforced"       value={nf(s.enforced)}        foot="notices sent"         icon={<IconSend />} info={admin && <InfoTip text={LOGIC.kpiEnforced} />} />
          <Kpi label="Removal"        value={nf(s.removed)}         foot={`${removalRate}% removal rate`} tone="orange" icon={<IconTrash />} info={admin && <InfoTip text={LOGIC.kpiRemoval} />} />
          {activePlatform !== 'internet' && (
            <Kpi label="Views" value={compact(s.views)} foot="total views reached" icon={<IconEye />} info={admin && <InfoTip text={LOGIC.kpiViews} />} />
          )}

          {/* Removal rate ring */}
          <div className="mt-1 bg-white rounded-2xl shadow-card border border-gray-100 p-4 flex flex-col items-center">
            <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3 self-start flex items-center gap-1.5">
              Removal rate{admin && <InfoTip text={LOGIC.removalRate} />}
            </div>
            <div className="w-[88px] h-[88px] rounded-full grid place-items-center"
              style={{ background: `conic-gradient(${ORANGE} ${removalRate}%, #f1f4f8 0)` }}>
              <div className="w-[62px] h-[62px] rounded-full bg-white dark:bg-[#1a2d55] grid place-items-center">
                <span className="text-lg font-extrabold" style={{ color: ORANGE }}>{removalRate}%</span>
              </div>
            </div>
            <div className="text-[11px] text-gray-400 mt-2 text-center">of identified removed</div>
          </div>
        </div>

      </div>

      {/* Full-width slots — Open Web gets the trend chart here too; UGC & Other
          and Open Web both get the funnel/status/donuts row. */}
      {isOpenWeb && trendBlock}
      {fullWidthBlocks && funnelStatusRow}

      {/* ── FULL WIDTH: at-a-glance + TAT buckets — spans the whole page width,
             not just the center column between the sidebars. ─────────────────── */}
      <div className="mt-3 grid grid-cols-1 xl:grid-cols-3 gap-3 items-stretch">
        <div className="flex flex-col">
          <Label info={admin && <InfoTip text={LOGIC.atAGlance} />}>At a glance</Label>
          <SummaryCard className="flex-1" totals={s} funnel={f} />
        </div>
        <div className="flex flex-col">
          <Label info={admin && <InfoTip text={LOGIC.tatUrlEnf} />}>TAT: URL → Enforcement</Label>
          <TatBucketCard buckets={tatUrlToEnforcement}
            active={filters.tatUrlEnf}
            onSelect={l => toggle('tatUrlEnf', l)} />
        </div>
        <div className="flex flex-col">
          <Label info={admin && <InfoTip text={LOGIC.tatEnfRem} />}>TAT: Enforcement → Removal</Label>
          <TatBucketCard buckets={tatEnforcementToRemoval}
            active={filters.tatEnfRem}
            onSelect={l => toggle('tatEnfRem', l)} />
        </div>
      </div>

      {/* ── FULL WIDTH: repeat offenders — profiles that re-uploaded after a
             takedown. Hidden when nothing qualifies (e.g. Open Web, which has
             no profile concept). ───────────────────────────────────────────── */}
      {repeatOffenders.length > 0 && (
        <div className="mt-3">
          <Label info={admin && <InfoTip text={LOGIC.repeatOffenders} />}>
            Repeat offenders — profiles re-uploading after removal · click a row to filter
          </Label>
          <RepeatOffendersCard data={repeatOffenders} active={filters.offender}
            onSelect={k => toggle('offender', k)} />
        </div>
      )}

      {/* ── FULL WIDTH: breakdown bars ──────────────────────────────────────── */}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 items-stretch">
        <SegmentBars title="Infringement type" data={b.byReason} dim="reason" active={filters.reason} onSelect={toggle} onInspect={openInspect} info={admin && <InfoTip text={LOGIC.breakdownReason} />} />
        <SegmentBars title="Quality of print"  data={b.byQuality}  dim="quality"  active={filters.quality}  onSelect={toggle} onInspect={openInspect} info={admin && <InfoTip text={LOGIC.breakdownQuality} />} />
        <SegmentBars title="Language"           data={b.byLanguage} dim="language" active={filters.language} onSelect={toggle} onInspect={openInspect} info={admin && <InfoTip text={LOGIC.breakdownLanguage} />} />
        {activePlatform !== 'telegram' && (
          <SegmentBars title="Country" data={b.byCountry} dim="country" active={filters.country} onSelect={toggle} onInspect={openInspect} info={admin && <InfoTip text={LOGIC.breakdownCountry} />} />
        )}
      </div>

      {/* ── "Unknown" inspector modal — the MarkScan IDs whose field is blank ── */}
      {inspect && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setInspect(null)}>
          <div onClick={e => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h3 className="text-sm font-bold text-[#14254A]">{inspect.title} — blank / unknown values</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {inspectRows.length.toLocaleString()} row{inspectRows.length === 1 ? '' : 's'} arrived with this field empty
                  {activePlatform ? ` (platform: ${ap?.label ?? activePlatform})` : ' (all platforms)'}
                </p>
              </div>
              <button onClick={() => setInspect(null)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                ✕
              </button>
            </div>
            <div className="overflow-y-auto p-4">
              {inspectRows.length === 0 ? (
                <div className="text-sm text-gray-400 py-4 text-center">No blank rows found in the current dataset.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 border-b border-gray-100">
                      <th className="py-2 pr-3 font-bold">ID</th>
                      <th className="py-2 pr-3 font-bold">Platform</th>
                      <th className="py-2 pr-3 font-bold">Asset</th>
                      <th className="py-2 font-bold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspectRows.slice(0, 500).map((r, i) => (
                      <tr key={`${String(r.id ?? '')}-${i}`} className="border-b border-gray-50">
                        <td className="py-1.5 pr-3 font-mono text-[#14254A] font-semibold">{String(r.id ?? '—')}</td>
                        <td className="py-1.5 pr-3 text-gray-600">{String(r.platform ?? '—')}</td>
                        <td className="py-1.5 pr-3 text-gray-600 truncate max-w-[200px]">{String(r.assetName ?? '—')}</td>
                        <td className="py-1.5 text-gray-600">{String(r.removalStatus ?? '').trim() || 'Pending'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {inspectRows.length > 500 && (
                <div className="text-[11px] text-gray-400 mt-3 text-center">
                  Showing first 500 of {inspectRows.length.toLocaleString()}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Stat within platform card ─────────────────────────────────────────── */
function Stat({ n, label, tone }: { n: string; label: string; tone: 'navy' | 'orange' }) {
  return (
    <div className="flex flex-col min-w-0">
      <b className="text-sm leading-tight" style={{ color: tone === 'navy' ? NAVY_TEXT : ORANGE_TEXT }}>{n}</b>
      <span className="text-[9px] uppercase tracking-wide text-gray-400 font-semibold truncate">{label}</span>
    </div>
  )
}

/* ── KPI card (right panel, full width) ───────────────────────────────── */
function Kpi({ label, value, foot, icon, tone, info }: {
  label: string; value: string; foot: string; icon: ReactNode; tone?: 'navy' | 'orange'; info?: ReactNode
}) {
  const accent   = tone === 'navy' ? NAVY : tone === 'orange' ? ORANGE : '#c3ccd8'
  const valColor = tone === 'navy' ? NAVY_TEXT : tone === 'orange' ? ORANGE_TEXT : NAVY_TEXT
  return (
    <div className="relative bg-white rounded-2xl shadow-card border border-gray-100 p-3.5 overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl" style={{ background: accent }} />
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 flex items-center gap-1.5">{label}{info}</span>
        <span className="w-6 h-6 rounded-lg grid place-items-center text-[#14254A] bg-gray-50">{icon}</span>
      </div>
      <div className="text-xl font-extrabold leading-none" style={{ color: valColor }}>{value}</div>
      <div className="text-[10px] text-gray-400 mt-1">{foot}</div>
    </div>
  )
}

/* ── Open Web stat card ──────────────────────────────────────────────── */
function OwStat({ label, value, foot, tone }: {
  label: string; value: string; foot?: string; tone: 'navy' | 'orange'
}) {
  const accent = tone === 'navy' ? NAVY : ORANGE
  const color  = tone === 'navy' ? NAVY_TEXT : ORANGE_TEXT
  return (
    <div className="relative bg-white rounded-2xl shadow-card border border-gray-100 p-4 overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl" style={{ background: accent }} />
      <div className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">{label}</div>
      <div className="text-2xl font-extrabold leading-none" style={{ color }}>{value}</div>
      {foot && <div className="text-[10px] text-gray-400 mt-1.5">{foot}</div>}
    </div>
  )
}

/* ── Open Web: newly identified domains per day ──────────────────────── */
function NewDomainsChart({ data }: { data: { date: string; count: number }[] }) {
  if (!data.length) return <div className="text-sm text-gray-400 py-10 text-center">No dated domain data.</div>
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: '#8592a6', fontSize: 11 }} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} tick={{ fill: '#8592a6', fontSize: 11 }} width={40} allowDecimals={false} />
        <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: 10, border: '1px solid #e4e8f0', fontSize: 13 }} />
        <Bar dataKey="count" name="New domains" fill={NAVY} radius={[4, 4, 0, 0]} maxBarSize={26} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ── Asset comparison chart (multi-asset) ────────────────────────────── */
function AssetCompareChart({ data }: {
  data: { asset: string; identified: number; removed: number; rate: number }[]
}) {
  if (!data.length) return <div className="text-sm text-gray-400 py-10 text-center">No asset data.</div>
  return (
    <ResponsiveContainer width="100%" height={Math.max(240, Math.min(360, 120 + data.length * 24))}>
      <BarChart data={data} margin={{ top: 24, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
        <XAxis dataKey="asset" tickLine={false} axisLine={false} interval={0}
          tick={{ fill: '#64748b', fontSize: 11 }}
          tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)} />
        <YAxis tickLine={false} axisLine={false} tick={{ fill: '#8592a6', fontSize: 11 }} width={44} tickFormatter={compact} />
        <Tooltip cursor={{ fill: '#f8fafc' }}
          contentStyle={{ borderRadius: 10, border: '1px solid #e4e8f0', fontSize: 13 }}
          formatter={(value: any, name: any, entry: any) =>
            name === 'Removed' ? [`${nf(Number(value))} (${entry?.payload?.rate ?? 0}%)`, name] : [nf(Number(value)), name]} />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="identified" name="Identified" fill={NAVY} radius={[6, 6, 0, 0]} maxBarSize={42} />
        <Bar dataKey="removed" name="Removed" fill={ORANGE} radius={[6, 6, 0, 0]} maxBarSize={42}>
          <LabelList dataKey="rate" position="top"
            formatter={(v: any) => `${v}%`}
            style={{ fill: '#b5651a', fontSize: 11, fontWeight: 700 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ── UGC sub-platform chart: identified/removed bars + removal-% line.
      Bars are clickable and cross-filter the whole report by that platform;
      clicking the active platform again clears the filter. ─────────────── */
function UgcPlatformChart({ data, active, onSelect }: {
  data: { key: string; label: string; identified: number; removed: number; rate: number }[]
  active?: string
  onSelect: (key: string) => void
}) {
  if (!data.length) return <div className="text-sm text-gray-400 py-10 text-center">No UGC platform data.</div>
  const hasActive = !!active
  const barClick = (d: any) => {
    const key = d?.payload?.key ?? d?.key
    if (key) onSelect(key)
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 24, right: 0, left: -12, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0}
          tick={{ fill: '#64748b', fontSize: 11 }}
          tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)} />
        <YAxis yAxisId="count" tickLine={false} axisLine={false}
          tick={{ fill: '#8592a6', fontSize: 11 }} width={44} tickFormatter={compact} allowDecimals={false} />
        <YAxis yAxisId="rate" orientation="right" domain={[0, 100]} tickLine={false} axisLine={false}
          tick={{ fill: '#8592a6', fontSize: 11 }} width={40} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip cursor={{ fill: '#f8fafc' }}
          contentStyle={{ borderRadius: 10, border: '1px solid #e4e8f0', fontSize: 13 }}
          formatter={(value: any, name: any) =>
            name === '% Removal' ? [`${value}%`, name] : [nf(Number(value)), name]} />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
        <Bar yAxisId="count" dataKey="identified" name="Identified" fill={NAVY} radius={[6, 6, 0, 0]} maxBarSize={42}
          onClick={barClick} style={{ cursor: 'pointer' }}>
          {data.map(d => (
            <Cell key={d.key} opacity={hasActive && d.key !== active ? 0.25 : 1} style={{ cursor: 'pointer' }} />
          ))}
        </Bar>
        <Bar yAxisId="count" dataKey="removed" name="Removed" fill={ORANGE} radius={[6, 6, 0, 0]} maxBarSize={42}
          onClick={barClick} style={{ cursor: 'pointer' }}>
          {data.map(d => (
            <Cell key={d.key} opacity={hasActive && d.key !== active ? 0.25 : 1} style={{ cursor: 'pointer' }} />
          ))}
        </Bar>
        <Line yAxisId="rate" type="monotone" dataKey="rate" name="% Removal" stroke="#b5651a" strokeWidth={2.2}
          dot={{ r: 3.5, fill: '#b5651a', strokeWidth: 0 }}>
          <LabelList dataKey="rate" position="top"
            formatter={(v: any) => `${v}%`}
            style={{ fill: '#b5651a', fontSize: 11, fontWeight: 700 }} />
        </Line>
      </ComposedChart>
    </ResponsiveContainer>
  )
}

/* ── Repeat offenders — profiles that re-uploaded after a takedown.
      Rows are clickable and cross-filter the whole report by that profile;
      clicking the active row again clears the filter. ─────────────────── */
function RepeatOffendersCard({ data, active, onSelect }: {
  data: { key: string; url: string; identified: number; removed: number; reuploads: number }[]
  active?: string
  onSelect: (key: string) => void
}) {
  const top = data.slice(0, 12)
  const max = Math.max(1, ...top.map(d => d.identified))
  const totIdentified = data.reduce((n, d) => n + d.identified, 0)
  const totRemoved    = data.reduce((n, d) => n + d.removed, 0)
  const totReuploads  = data.reduce((n, d) => n + d.reuploads, 0)
  const hasActive = !!active
  // Display form of a profile URL: no scheme/www, capped length.
  const pretty = (u: string) => {
    const s = u.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
    return s.length > 46 ? `${s.slice(0, 45)}…` : s
  }
  const isLink = (u: string) => /^https?:\/\//i.test(u)
  return (
    <Card className="p-4 mt-1">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-3 text-[11px] text-gray-500">
        <span><b style={{ color: NAVY_TEXT }}>{nf(data.length)}</b> repeat offender{data.length === 1 ? '' : 's'}</span>
        <span><b style={{ color: NAVY_TEXT }}>{nf(totIdentified)}</b> URLs identified</span>
        <span><b style={{ color: ORANGE_TEXT }}>{nf(totRemoved)}</b> removed</span>
        <span><b style={{ color: ORANGE_TEXT }}>{nf(totReuploads)}</b> re-uploads after takedown</span>
        {hasActive && (
          <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full"
            style={{ background: '#FC934C22', color: ORANGE_TEXT }}>filtered</span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {top.map(d => {
          const isActive = d.key === active
          const dimmed   = hasActive && !isActive
          return (
          <button key={d.key} onClick={() => onSelect(d.key)}
            className={`grid items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-all hover:bg-[#14254A]/5 dark:hover:bg-white/5 ${
              isActive ? 'bg-[#14254A]/5 ring-1 ring-[#14254A]/40 dark:bg-white/5 dark:ring-white/20' : ''} ${dimmed ? 'opacity-40' : ''}`}
            style={{ gridTemplateColumns: 'minmax(140px, 320px) 1fr auto auto' }}>
            <span className="text-xs text-gray-600 truncate" title={d.url}>
              {isLink(d.url) ? (
                <a href={d.url} target="_blank" rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="hover:text-[#FC934C] hover:underline">
                  {pretty(d.url)}
                </a>
              ) : pretty(d.url)}
            </span>
            <span className="flex flex-col gap-1">
              <span className="h-1.5 rounded" style={{ width: `${(d.identified / max) * 100}%`, minWidth: 2, background: NAVY }} />
              <span className="h-1.5 rounded" style={{ width: `${(d.removed    / max) * 100}%`, minWidth: 2, background: ORANGE }} />
            </span>
            <span className="flex flex-col items-end text-[11px] font-bold leading-tight min-w-[42px]">
              <span style={{ color: NAVY_TEXT }}>{nf(d.identified)}</span>
              <span style={{ color: ORANGE_TEXT }}>{nf(d.removed)}</span>
            </span>
            <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full whitespace-nowrap"
              style={{ background: '#FC934C22', color: ORANGE_TEXT }}>
              {nf(d.reuploads)} re-upload{d.reuploads === 1 ? '' : 's'}
            </span>
          </button>
          )
        })}
      </div>
      <div className="flex items-center justify-between mt-2">
        <div className="flex gap-4 text-[11px] text-gray-400">
          <span className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: NAVY }} />Identified</span>
          <span className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: ORANGE }} />Removed</span>
        </div>
        {data.length > top.length && (
          <span className="text-[11px] text-gray-400">Top {top.length} of {nf(data.length)} shown</span>
        )}
      </div>
    </Card>
  )
}

/* ── Trend chart ──────────────────────────────────────────────────────── */
function TrendChart({ data }: { data: { date: string; identified: number; removed: number }[] }) {
  if (!data.length) return <div className="text-sm text-gray-400 py-10 text-center">No dated data.</div>
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id="wrNavy" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={NAVY}   stopOpacity={0.28} />
            <stop offset="95%" stopColor={NAVY}   stopOpacity={0} />
          </linearGradient>
          <linearGradient id="wrOrange" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={ORANGE} stopOpacity={0.35} />
            <stop offset="95%" stopColor={ORANGE} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: '#8592a6', fontSize: 11 }} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} tick={{ fill: '#8592a6', fontSize: 11 }} width={40} tickFormatter={compact} />
        <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e4e8f0', fontSize: 13 }} />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="identified" name="Identified" stroke={NAVY}   fill="url(#wrNavy)"   strokeWidth={2.2} dot={false} />
        <Area type="monotone" dataKey="removed"    name="Removed"    stroke={ORANGE} fill="url(#wrOrange)" strokeWidth={2.2} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/* ── Enforcement funnel ───────────────────────────────────────────────── */
function FunnelView({ f }: { f: Funnel }) {
  const stages = [
    { k: 'Discovered', v: f.discovered },
    { k: 'Enforced',   v: f.enforced },
    { k: 'Removed',    v: f.removed },
  ]
  const max = Math.max(1, f.discovered)
  return (
    <div className="flex-1 flex flex-col">
      {stages.map((st, i) => {
        const pct  = Math.round((st.v / max) * 100)
        const conv = i === 0 ? null : Math.round((st.v / (stages[i - 1].v || 1)) * 100)
        const last = i === stages.length - 1
        return (
          <div key={st.k}
            className="flex-1 grid items-center gap-3 px-5 py-3.5 border-b border-gray-100 last:border-0"
            style={{ gridTemplateColumns: '110px 1fr 52px' }}>
            <div className="text-xs font-semibold text-gray-600">{st.k}</div>
            <div className="h-7 rounded-lg bg-gray-100 overflow-hidden">
              <div className="h-full rounded-lg flex items-center min-w-[40px] transition-all"
                style={{
                  width: `${Math.max(pct, 4)}%`,
                  background: last
                    ? `linear-gradient(90deg,#d97b2e,${ORANGE})`
                    : `linear-gradient(90deg,${NAVY},#1e3a6e)`,
                }}>
                <span className="text-xs font-bold text-white px-2.5 whitespace-nowrap">{nf(st.v)}</span>
              </div>
            </div>
            <div className="text-[11px] font-bold text-gray-400 text-right">{conv === null ? '—' : `${conv}%`}</div>
          </div>
        )
      })}
    </div>
  )
}

/* ── Donut removal card ───────────────────────────────────────────────── */
function DonutCard({ title, icon, removed, pending, tone, extras, className = '', removedLabel = 'removed', pendingLabel = 'active' }: {
  title: string; icon: ReactNode; removed: number; pending: number
  tone: 'navy' | 'orange'; extras?: { label: string; value: string }[]; className?: string
  removedLabel?: string; pendingLabel?: string
}) {
  const total = removed + pending
  const pct   = total > 0 ? Math.round((removed / total) * 100) : 0
  // The ring itself is a decorative fill (fine unchanged in dark mode); the
  // percentage/removed-count numbers are text painted on top and need the
  // dark-aware variant so navy tone doesn't vanish against a dark card.
  const ringColor = tone === 'navy' ? NAVY : ORANGE
  const textColor = tone === 'navy' ? NAVY_TEXT : ORANGE_TEXT
  return (
    <Card className={`p-4 flex flex-col items-center text-center ${className}`}>
      <div className="self-start flex items-center gap-2 text-[11px] font-bold text-gray-600 mb-3">{icon} {title}</div>
      {/* Center the donut in whatever vertical space the row gives this card */}
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="w-[88px] h-[88px] rounded-full grid place-items-center mb-3"
          style={{ background: `conic-gradient(${ringColor} ${pct}%, #f1f4f8 0)` }}>
          <div className="w-[60px] h-[60px] rounded-full bg-white dark:bg-[#1a2d55] grid place-items-center text-base font-extrabold" style={{ color: textColor }}>
            {pct}%
          </div>
        </div>
        <div className="flex gap-3 text-xs text-gray-600 mb-2">
          <span><b style={{ color: textColor }}>{nf(removed)}</b> {removedLabel}</span>
          <span><b className="text-gray-700">{nf(pending)}</b> {pendingLabel}</span>
        </div>
      </div>
      {extras && (
        <div className="w-full mt-auto flex flex-col gap-1">
          {extras.map(e => (
            <div key={e.label} className="flex justify-between items-center px-2.5 py-1.5 rounded-lg bg-gray-50 border border-gray-100 text-[11px] text-gray-600">
              <span>{e.label}</span><b className="text-gray-800">{e.value}</b>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/* ── Summary "at a glance" card ───────────────────────────────────────── */
function SummaryCard({ totals, funnel, className = '' }: { totals: Totals; funnel: Funnel; className?: string }) {
  const items = [
    { label: 'Identified',      value: nf(totals.identified),  color: NAVY_TEXT },
    { label: 'Enforced',        value: nf(totals.enforced),    color: '#64748b' },
    { label: 'Removed',         value: nf(totals.removed),     color: ORANGE },
    { label: 'Pending removal', value: nf(funnel.pending),     color: '#64748b' },
    { label: 'Total views',     value: nf(totals.views),       color: '#64748b' },
    { label: 'Engagement',      value: nf(totals.engagement),  color: '#64748b' },
  ]
  return (
    <Card className={`p-4 flex flex-col ${className}`}>
      <div className="flex items-center gap-2 text-[11px] font-bold text-gray-600 mb-3"><IconChart /> At a glance</div>
      {/* auto-rows-fr + flex-1 so the tiles stretch to fill the card height and
          the card doesn't show a large empty area when its row is tall */}
      <div className="flex-1 grid grid-cols-2 auto-rows-fr gap-x-4 gap-y-2">
        {items.map(r => (
          <div key={r.label} className="flex flex-col justify-center px-2.5 py-2 rounded-lg bg-gray-50 border border-gray-100">
            <span className="text-[9px] uppercase tracking-widest text-gray-400 font-bold">{r.label}</span>
            <b className="text-sm mt-0.5" style={{ color: r.color }}>{r.value}</b>
          </div>
        ))}
      </div>
    </Card>
  )
}

/* ── TAT bucket card (clickable, cross-filterable) ───────────────────── */
function TatBucketCard({ buckets, active, onSelect }: {
  buckets: { label: string; count: number }[]
  active?: string
  onSelect: (label: string) => void
}) {
  if (!buckets.length) {
    return (
      <Card className="p-4 flex flex-col gap-3 flex-1">
        <div className="text-sm font-bold text-[#14254A]">TAT bucket distribution</div>
        <div className="text-sm text-gray-400 py-8 text-center">No TAT data available.</div>
      </Card>
    )
  }
  const total    = buckets.reduce((sum, b) => sum + b.count, 0)
  const hasActive = !!active
  return (
    <Card className="p-4 flex flex-col gap-3 flex-1">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-[#14254A]">TAT bucket distribution</div>
          <div className="text-[11px] text-gray-500">{total.toLocaleString()} rows · click a bar to filter</div>
        </div>
        {hasActive && (
          <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full self-center"
            style={{ background: '#FC934C22', color: ORANGE_TEXT }}>filtered</span>
        )}
      </div>
      <div className="h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets} layout="vertical" margin={{ top: 8, right: 10, bottom: 8, left: 0 }}
            style={{ cursor: 'pointer' }}>
            <XAxis type="number" hide />
            <YAxis dataKey="label" type="category" axisLine={false} tickLine={false}
              tick={{ fill: '#64748b', fontSize: 11 }} width={90} />
            <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: 10, border: '1px solid #e4e8f0', fontSize: 13 }} />
            <Bar dataKey="count" barSize={14} radius={[8, 8, 8, 8]}
              onClick={(data: any) => onSelect(data.label)}>
              {buckets.map((bucket, index) => {
                const isActive = bucket.label === active
                return (
                  <Cell key={bucket.label}
                    fill={isActive ? ORANGE : (index % 2 === 0 ? NAVY : ORANGE)}
                    opacity={hasActive && !isActive ? 0.25 : 1}
                    style={{ cursor: 'pointer' }}
                  />
                )
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-gray-600">
        {buckets.map(bucket => {
          const isActive = bucket.label === active
          return (
            <button key={bucket.label} onClick={() => onSelect(bucket.label)}
              className={`rounded-xl px-3 py-2 text-left transition-all ${
                isActive
                  ? 'border-2 border-[#FC934C] bg-orange-50 text-[var(--wr-orange-text)]'
                  : 'border border-gray-100 bg-gray-50 hover:border-[#FC934C]/40 hover:bg-orange-50/40'
              } ${hasActive && !isActive ? 'opacity-30' : ''}`}>
              <div className="font-bold" style={{ color: isActive ? ORANGE_TEXT : NAVY_TEXT }}>{bucket.count.toLocaleString()}</div>
              <div className="truncate text-gray-500">{bucket.label}</div>
            </button>
          )
        })}
      </div>
    </Card>
  )
}

function SegmentBars({ title, data, dim, active, onSelect, onInspect, info, className = '' }: {
  title: string; data: Segment[] | null; dim: FilterDim
  active?: string; onSelect: (dim: FilterDim, key: string) => void
  onInspect?: (dim: FilterDim, title: string) => void; info?: ReactNode; className?: string
}) {
  const segs     = data ?? []
  const max      = Math.max(1, ...segs.map(s => s.identified))
  const hasActive = !!active
  return (
    <Card className={`p-4 ${className}`}>
      <div className="flex items-center gap-1.5 text-sm font-bold text-[#14254A] mb-3">
        {title}
        {info}
        {hasActive && (
          <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full"
            style={{ background: '#FC934C22', color: ORANGE_TEXT }}>filtered</span>
        )}
      </div>
      {segs.length === 0 ? (
        <div className="text-sm text-gray-400 py-3">No data.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {segs.slice(0, 10).map(sg => {
            const isActive = sg.key === active
            const dimmed   = hasActive && !isActive
            const isUnknown = sg.label.trim().toLowerCase() === 'unknown'
            return (
              <button key={sg.key} onClick={() => onSelect(dim, sg.key)}
                className={`grid items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-all hover:bg-[#14254A]/5 dark:hover:bg-white/5 ${
                  isActive ? 'bg-[#14254A]/5 ring-1 ring-[#14254A]/40 dark:bg-white/5 dark:ring-white/20' : ''} ${dimmed ? 'opacity-40' : ''}`}
                style={{ gridTemplateColumns: '96px 1fr auto' }}>
                <span className="text-xs text-gray-600 truncate flex items-center gap-1" title={sg.label}>
                  <span className="truncate">{sg.label}</span>
                  {isUnknown && onInspect && (
                    <span role="button" tabIndex={0} title="See the IDs behind this blank value"
                      onClick={e => { e.stopPropagation(); onInspect(dim, title) }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onInspect(dim, title) } }}
                      className="flex-shrink-0 w-4 h-4 grid place-items-center rounded-full text-gray-400 hover:text-[#14254A] hover:bg-[#14254A]/10 transition-colors">
                      <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 8h.01M12 11v5" />
                      </svg>
                    </span>
                  )}
                </span>
                <span className="flex flex-col gap-1">
                  <span className="h-1.5 rounded" style={{ width: `${(sg.identified / max) * 100}%`, minWidth: 2, background: NAVY }} />
                  <span className="h-1.5 rounded" style={{ width: `${(sg.removed    / max) * 100}%`, minWidth: 2, background: ORANGE }} />
                </span>
                <span className="flex flex-col items-end text-[11px] font-bold leading-tight min-w-[42px]">
                  <span style={{ color: NAVY_TEXT }}>{nf(sg.identified)}</span>
                  <span style={{ color: ORANGE_TEXT }}>{nf(sg.removed)}</span>
                </span>
              </button>
            )
          })}
          <div className="flex gap-4 mt-1 text-[11px] text-gray-400">
            <span className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: NAVY }} />Identified</span>
            <span className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: ORANGE }} />Removed</span>
          </div>
        </div>
      )}
    </Card>
  )
}

/* ── Primitives ──────────────────────────────────────────────────────── */
function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl shadow-card border border-gray-100 ${className}`}>{children}</div>
}
function Label({ children, info }: { children: ReactNode; info?: ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-1.5">
      {children}{info}
    </div>
  )
}

/* ── Icons ───────────────────────────────────────────────────────────── */
const sv = { width: 14, height: 14, fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', strokeWidth: 2 } as const
const IconShield = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path strokeLinecap="round" strokeLinejoin="round" d="m9 12 2 2 4-4" /></svg>
const IconSend   = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
const IconTrash  = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
const IconEye    = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
const IconHeart  = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" /></svg>
const IconLink   = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>
const IconUser   = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
const IconChart  = () => <svg {...sv}><path strokeLinecap="round" strokeLinejoin="round" d="M3 3v18h18M18 17V9M13 17V5M8 17v-3" /></svg>
const IconGrid   = () => <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
