'use client'

// War Room API client. Talks to the Go server's POST /api/warroom, which fans
// out across every MarkScan platform, stores the accumulated rows (Redis, with
// in-memory fallback) and returns an aggregated cross-platform report.

export interface Totals {
  identified: number
  removed: number
  enforced: number
  views: number
  engagement: number
}

export interface Funnel {
  discovered: number
  enforced: number
  removed: number
  pending: number
}

export interface Removal {
  urlRemoved: number
  urlPending: number
  channelsTotal: number
  channelsRemoved: number
  channelsActive: number
  subscribersImpacted: number
}

export interface Segment {
  key: string
  label: string
  identified: number
  removed: number
}

export interface MetricPoint {
  date: string
  identified: number
  removed: number
}

export interface Breakdowns {
  byDate: MetricPoint[] | null
  byReason: Segment[] | null
  byQuality: Segment[] | null
  byLanguage: Segment[] | null
  byCountry: Segment[] | null
  byStatus: Segment[] | null
}

export interface PlatformResult {
  platform: string
  label: string
  available: boolean
  totals: Totals
  funnel: Funnel
  removal: Removal
  breakdowns: Breakdowns
}

export interface WarRoomReport {
  summary: Totals
  funnel: Funnel
  removal: Removal
  breakdowns: Breakdowns
  platforms: PlatformResult[]
}

export interface WarRoomMeta {
  lastFetch: string
  rowCount: number
  displayCount?: number
  pulledNow: number
  mode: 'full' | 'incremental'
  source: 'redis' | 'memory'
  perPlatform: Record<string, number>
}

// Trimmed row returned for client-side cross-filtering (mirrors backend TrimRows).
export interface WarRoomRow {
  id?: string | number | null
  platform?: string
  // Concrete UGC platform (tiktok/vk/ok/…) behind an "ugc and other social
  // media" row — set at ingestion, drives the UGC platform breakdown chart.
  subPlatform?: string | null
  assetName?: string | null
  infringementType?: string
  qualityOfPrint?: string
  language?: string
  country?: string
  removalStatus?: string | null
  removalTime?: string | null
  enforcementTime?: string | null
  urlUploadDate?: string | null
  discoveryDoneAt?: string | null
  uploadDate?: string | null
  createdAt?: string | null
  viewCount?: string | number | null
  likeCount?: string | number | null
  commentCount?: string | number | null
  channelId?: string | null
  isChannelSuspended?: boolean
  subscriberCount?: string | number | null
  // Canonical channel/profile identity (folded from profileUrl/channelUrl/
  // channelOrProfileUrl variants at ingestion) + its removal status.
  channelOrProfileUrl?: string | null
  profileRemovalStatus?: string | null
  // Open Web (internet) extras — isSource=true means the row is a source URL,
  // false means it's an infringing URL (sourceURL was null).
  isSource?: boolean
  sourceURL?: string | null
  sourceDomain?: string | null
  infringingURL?: string | null
  infringingDomain?: string | null
  searchEngine?: string | null
  delistingTime?: string | null
  delistingStatus?: string | null
}

// Active cross-filter selections. Empty string / undefined = no filter on that dim.
export interface WarRoomFilters {
  platform?: string
  subPlatform?: string // UGC umbrella: concrete platform (lowercased key)
  offender?: string    // repeat offender: channel/profile identity key (lowercased)
  reason?: string
  quality?: string
  language?: string
  country?: string
  status?: string
  date?: string
  tatUrlEnf?: string  // TAT bucket label for URL discovery → Enforcement
  tatEnfRem?: string  // TAT bucket label for Enforcement → Removal
  searchEngine?: string // Open Web: infringing-URL search engine
}

// TAT bucket definitions — exported so WarRoomReport can import and reuse them.
export const TAT_BUCKETS = [
  { label: '0-15 min',  test: (m: number) => m >= 0 && m <= 15 },
  { label: '15-30 min', test: (m: number) => m > 15 && m <= 30 },
  { label: '31-45 min', test: (m: number) => m > 30 && m <= 45 },
  { label: '46-60 min', test: (m: number) => m > 45 && m <= 60 },
  { label: '1hr+',      test: (m: number) => m > 60 },
]

const parseTatTime = (v?: string | null): Date | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'))
  return isFinite(d.getTime()) ? d : null
}

const diffTatMins = (from?: string | null, to?: string | null): number | null => {
  const a = parseTatTime(from); const b = parseTatTime(to)
  if (!a || !b) return null
  return (b.getTime() - a.getTime()) / 60000
}

// Effective removal timestamp for TAT: Open Web infringing URLs (no host URL)
// are delisted rather than removed, so use delistingTime once Approved; Open Web
// host URLs must be Dead to count; every other platform uses removalTime.
const effectiveRemovalTime = (r: WarRoomRow): string | null | undefined => {
  if (String(r.platform ?? '').trim().toLowerCase() === 'internet') {
    if (r.isSource) {
      return String(r.removalStatus ?? '').trim().toLowerCase() === 'dead' ? r.removalTime : null
    }
    return String(r.delistingStatus ?? '').trim().toLowerCase() === 'approved' ? r.delistingTime : null
  }
  return r.removalTime
}

export type WarRoomMode = 'auto' | 'full' | 'incremental'

export interface FetchWarRoomParams {
  assetNames: string[]
  startDate?: string
  endDate?: string
  platforms?: string[]
  mode?: WarRoomMode
  /** Admin only: generate the report on behalf of this client (dcp_user id). */
  clientUserId?: number
}

export interface ClientOption { userId: number; name: string }
export interface AssetOption { key: string; label: string }

export async function fetchWarRoom(
  params: FetchWarRoomParams
): Promise<{ data: WarRoomReport; rows: WarRoomRow[]; meta: WarRoomMeta }> {
  const res = await fetch('/api/warroom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      assetNames: params.assetNames,
      startDate:  params.startDate  ?? '',
      endDate:    params.endDate    ?? '',
      platforms:  params.platforms  ?? [],
      mode:       params.mode       ?? 'auto',
      clientUserId: params.clientUserId ?? 0,
    }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.success) {
    throw new Error(json?.error || `Request failed (${res.status})`)
  }
  return {
    data: json.data as WarRoomReport,
    rows: (json.rows ?? []) as WarRoomRow[],
    meta: json.meta as WarRoomMeta,
  }
}

export interface WarRoomProgressEvent {
  asset: string
  platform: string
  phase: 'start' | 'done'
  count: number
  error?: string
}

// Same as fetchWarRoom, but streams live per-platform progress over Server-Sent
// Events so the UI can show which platform is currently being fetched instead of
// one opaque spinner. onProgress fires once when a platform's fetch starts and
// once when it finishes (with its row count, or an error).
export async function streamWarRoom(
  params: FetchWarRoomParams,
  onProgress: (evt: WarRoomProgressEvent) => void
): Promise<{ data: WarRoomReport; rows: WarRoomRow[]; meta: WarRoomMeta }> {
  const res = await fetch('/api/warroom/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      assetNames: params.assetNames,
      startDate:  params.startDate  ?? '',
      endDate:    params.endDate    ?? '',
      platforms:  params.platforms  ?? [],
      mode:       params.mode       ?? 'auto',
      clientUserId: params.clientUserId ?? 0,
    }),
  })

  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => null)
    throw new Error(json?.error || `Request failed (${res.status})`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    // SSE frames are separated by a blank line; each frame has "event: X\ndata: Y".
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)

      const eventLine = frame.split('\n').find(l => l.startsWith('event: '))
      const dataLine  = frame.split('\n').find(l => l.startsWith('data: '))
      if (!eventLine || !dataLine) continue
      const event = eventLine.slice('event: '.length).trim()
      const data  = JSON.parse(dataLine.slice('data: '.length))

      if (event === 'platform') {
        onProgress(data as WarRoomProgressEvent)
      } else if (event === 'error') {
        throw new Error(data.message || 'Request failed')
      } else if (event === 'done') {
        return {
          data: data.data as WarRoomReport,
          rows: (data.rows ?? []) as WarRoomRow[],
          meta: data.meta as WarRoomMeta,
        }
      }
    }
  }

  throw new Error('Stream ended without a result')
}

// Admin: list clients (dcp_user, role != 1) to pick whose data to view.
export async function fetchWarRoomClients(): Promise<ClientOption[]> {
  const res = await fetch('/api/admin/clients?list=1', { credentials: 'include' })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.success) throw new Error(json?.error || 'Failed to load clients')
  return (json.items ?? [])
    .map((c: any) => ({ userId: Number(c.userId), name: String(c.name ?? c.email ?? `#${c.userId}`) }))
    .filter((c: ClientOption) => c.userId)
}

// Admin: generate the selected client's MarkScan token and return its assets.
export async function fetchWarRoomClientToken(clientUserId: number): Promise<AssetOption[]> {
  const res = await fetch('/api/warroom/client-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ clientUserId }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.success) throw new Error(json?.error || 'Failed to generate client token')
  return (json.assets ?? []) as AssetOption[]
}

// ─── Client-side aggregation (mirrors the Go Aggregate) for cross-filtering ────

const PLATFORM_ORDER = [
  'facebook', 'youtube', 'instagram', 'twitter', 'telegram',
  'internet',
  'ugc and other social media',
  'i-tunes', 'play store', 'third party app', 'third party mobile app',
]
const PLATFORM_LABELS: Record<string, string> = {
  'facebook': 'Facebook', 'youtube': 'YouTube', 'instagram': 'Instagram',
  'twitter': 'X (Twitter)', 'telegram': 'Telegram',
  'internet': 'Open Web',
  'ugc and other social media': 'UGC & Other',
  'i-tunes': 'iTunes', 'play store': 'Play Store',
  'third party app': 'Third-Party App', 'third party mobile app': 'Third-Party Mobile',
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'string') { const n = parseFloat(v); return isNaN(n) ? 0 : n }
  return 0
}
const notEmpty = (v: unknown): boolean =>
  v !== null && v !== undefined && String(v).trim() !== ''

const rowRemoved = (r: WarRoomRow): boolean => {
  if (notEmpty(r.removalTime)) return true
  const s = String(r.removalStatus ?? '').toLowerCase()
  if (s === 'dead' || s === 'removed') return true
  // Open Web infringing URLs count as removed once delisting is Approved.
  return String(r.delistingStatus ?? '').trim().toLowerCase() === 'approved'
}
const rowStatus = (r: WarRoomRow): string => {
  const s = String(r.removalStatus ?? '').trim()
  if (!s) return 'Pending'
  // Normalize: cap first letter, lowercase rest — so "DEAD" and "Dead" merge
  const label = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
  // Display term: "Dead" is shown as "Removed" (must match the Go statusLabel
  // so server- and client-aggregated status buckets carry the same label).
  return label === 'Dead' ? 'Removed' : label
}
// Rows under the UGC umbrella with no derivable platform belong to the
// residual bucket — same fallback the ingestion side uses.
export const rowSubPlatform = (r: WarRoomRow): string =>
  String(r.subPlatform ?? '').trim().toLowerCase() || 'ugc and other social media'

// Canonical channel/profile identity key for a row — channelOrProfileUrl,
// falling back to channelId (YouTube). Used by the repeat-offender chart and
// its cross-filter.
export const rowChannelKey = (r: WarRoomRow): string =>
  (String(r.channelOrProfileUrl ?? '').trim() || String(r.channelId ?? '').trim()).toLowerCase()

const profileDead = (r: WarRoomRow): boolean =>
  String(r.profileRemovalStatus ?? '').trim().toLowerCase() === 'dead'

// Fallback chain mirrors the backend's ReportDay: not every platform populates
// urlUploadDate/discoveryDoneAt, so rows without either would otherwise get no
// day at all and drop out of date-bucketed views (trend chart, TAT).
const rowDay = (r: WarRoomRow): string => {
  const s = String(r.urlUploadDate ?? r.discoveryDoneAt ?? r.uploadDate ?? r.createdAt ?? '')
  return s.length >= 10 ? s.slice(0, 10) : ''
}

function segsFrom(rows: WarRoomRow[], pick: (r: WarRoomRow) => string): Segment[] {
  const map = new Map<string, Segment>()
  for (const r of rows) {
    const raw = (pick(r) || 'Unknown').trim()
    const normKey = raw.toLowerCase() // case-insensitive dedup key
    let s = map.get(normKey)
    if (!s) {
      // Capitalize first letter for display; preserve rest of original casing
      const label = raw.charAt(0).toUpperCase() + raw.slice(1)
      s = { key: label, label, identified: 0, removed: 0 }
      map.set(normKey, s)
    }
    s.identified++
    if (rowRemoved(r)) s.removed++
  }
  return [...map.values()].sort((a, b) => b.identified - a.identified)
}

function aggregateSet(rows: WarRoomRow[]): {
  totals: Totals; funnel: Funnel; removal: Removal; breakdowns: Breakdowns
} {
  const totals: Totals = { identified: 0, removed: 0, enforced: 0, views: 0, engagement: 0 }
  const dateMap = new Map<string, MetricPoint>()
  const channels = new Map<string, { suspended: boolean; subs: number }>()

  // Open Web identification is distinct sourceURL + distinct infringingURL,
  // not raw row count — the same URL can appear on many rows.
  let owRows = 0
  const owSrcURLs = new Set<string>()
  const owInfURLs = new Set<string>()

  for (const r of rows) {
    const removed = rowRemoved(r)
    totals.identified++
    if (removed) totals.removed++
    if (notEmpty(r.enforcementTime)) totals.enforced++
    totals.views += num(r.viewCount)
    totals.engagement += num(r.likeCount) + num(r.commentCount)

    const day = rowDay(r)
    if (day) {
      let mp = dateMap.get(day)
      if (!mp) { mp = { date: day, identified: 0, removed: 0 }; dateMap.set(day, mp) }
      mp.identified++
      if (removed) mp.removed++
    }
    // Channel/profile identity is the normalized profile/channel URL when the
    // endpoint supplies one, with YouTube channelId as the legacy fallback.
    // Dead/Active comes from the standardized profileRemovalStatus column.
    const chKey = rowChannelKey(r)
    if (chKey) {
      let cs = channels.get(chKey)
      if (!cs) { cs = { suspended: false, subs: 0 }; channels.set(chKey, cs) }
      const chRemoved = profileDead(r) || (!!String(r.channelId ?? '').trim() && !!r.isChannelSuspended)
      if (chRemoved) cs.suspended = true
      const s = num(r.subscriberCount)
      if (s > cs.subs) cs.subs = s
    }

    if (String(r.platform ?? '').trim().toLowerCase() === 'internet') {
      owRows++
      const su = String(r.sourceURL ?? '').trim().toLowerCase()
      if (su) owSrcURLs.add(su)
      const iu = String(r.infringingURL ?? '').trim().toLowerCase()
      if (iu) owInfURLs.add(iu)
    }
  }

  // Replace the Open Web raw row count with its distinct-URL identification.
  if (owRows > 0) {
    totals.identified += owSrcURLs.size + owInfURLs.size - owRows
  }

  const funnel: Funnel = {
    discovered: totals.identified, enforced: totals.enforced, removed: totals.removed,
    pending: Math.max(0, totals.identified - totals.removed),
  }
  const removal: Removal = {
    urlRemoved: totals.removed,
    urlPending: Math.max(0, totals.identified - totals.removed),
    channelsTotal: 0, channelsRemoved: 0, channelsActive: 0, subscribersImpacted: 0,
  }
  for (const cs of channels.values()) {
    removal.channelsTotal++
    if (cs.suspended) { removal.channelsRemoved++; removal.subscribersImpacted += cs.subs }
    else removal.channelsActive++
  }

  const breakdowns: Breakdowns = {
    byDate: [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byReason: segsFrom(rows, r => String(r.infringementType ?? '')),
    byQuality: segsFrom(rows, r => String(r.qualityOfPrint ?? '')),
    byLanguage: segsFrom(rows, r => String(r.language ?? '')),
    byCountry: segsFrom(rows, r => String(r.country ?? '')),
    byStatus: segsFrom(rows, rowStatus),
  }
  return { totals, funnel, removal, breakdowns }
}

/** Recompute the full report from trimmed rows under the active cross-filters. */
export function aggregate(rows: WarRoomRow[], filters: WarRoomFilters): WarRoomReport {
  const match = (r: WarRoomRow): boolean => {
    if (filters.platform && r.platform !== filters.platform) return false
    if (filters.subPlatform && rowSubPlatform(r) !== filters.subPlatform.toLowerCase()) return false
    if (filters.offender && rowChannelKey(r) !== filters.offender.toLowerCase()) return false
    if (filters.reason   && String(r.infringementType ?? '').toLowerCase() !== filters.reason.toLowerCase())   return false
    if (filters.quality  && String(r.qualityOfPrint   ?? '').toLowerCase() !== filters.quality.toLowerCase())  return false
    if (filters.language && String(r.language         ?? '').toLowerCase() !== filters.language.toLowerCase()) return false
    if (filters.country  && String(r.country          ?? '').toLowerCase() !== filters.country.toLowerCase())  return false
    if (filters.status   && rowStatus(r).toLowerCase() !== filters.status.toLowerCase()) return false
    if (filters.tatUrlEnf) {
      const bkt = TAT_BUCKETS.find(b => b.label === filters.tatUrlEnf)
      const mins = diffTatMins(r.urlUploadDate ?? r.discoveryDoneAt, r.enforcementTime)
      if (!bkt || mins === null || !bkt.test(mins)) return false
    }
    if (filters.tatEnfRem) {
      const bkt = TAT_BUCKETS.find(b => b.label === filters.tatEnfRem)
      const mins = diffTatMins(r.enforcementTime, effectiveRemovalTime(r))
      if (!bkt || mins === null || !bkt.test(mins)) return false
    }
    if (filters.searchEngine &&
        String(r.searchEngine ?? '').trim().toLowerCase() !== filters.searchEngine.toLowerCase()) return false
    return true
  }
  const filtered = rows.filter(match)
  const top = aggregateSet(filtered)

  // Per-platform strip always reflects the non-platform filters (so you can see
  // every platform's slice of the current filter), never the platform filter itself.
  const platformFilters: WarRoomFilters = { ...filters, platform: '' }
  const stripRows = rows.filter(r => {
    const f = platformFilters
    if (f.subPlatform && rowSubPlatform(r) !== f.subPlatform.toLowerCase()) return false
    if (f.offender && rowChannelKey(r) !== f.offender.toLowerCase()) return false
    if (f.reason && String(r.infringementType ?? '') !== f.reason) return false
    if (f.quality && String(r.qualityOfPrint ?? '') !== f.quality) return false
    if (f.language && String(r.language ?? '') !== f.language) return false
    if (f.country && String(r.country ?? '') !== f.country) return false
    if (f.status && rowStatus(r) !== f.status) return false
    if (f.tatUrlEnf) {
      const bkt = TAT_BUCKETS.find(b => b.label === f.tatUrlEnf)
      const mins = diffTatMins(r.urlUploadDate ?? r.discoveryDoneAt, r.enforcementTime)
      if (!bkt || mins === null || !bkt.test(mins)) return false
    }
    if (f.tatEnfRem) {
      const bkt = TAT_BUCKETS.find(b => b.label === f.tatEnfRem)
      const mins = diffTatMins(r.enforcementTime, effectiveRemovalTime(r))
      if (!bkt || mins === null || !bkt.test(mins)) return false
    }
    if (f.searchEngine &&
        String(r.searchEngine ?? '').trim().toLowerCase() !== f.searchEngine.toLowerCase()) return false
    return true
  })
  const byPlat = new Map<string, WarRoomRow[]>()
  for (const r of stripRows) {
    const p = String(r.platform ?? '')
    const arr = byPlat.get(p) ?? []
    arr.push(r); byPlat.set(p, arr)
  }
  const platforms: PlatformResult[] = PLATFORM_ORDER.map(key => {
    const set = byPlat.get(key) ?? []
    const a = aggregateSet(set)
    return {
      platform: key, label: PLATFORM_LABELS[key] ?? key, available: a.totals.identified > 0,
      totals: a.totals, funnel: a.funnel, removal: a.removal, breakdowns: a.breakdowns,
    }
  })

  return {
    summary: top.totals, funnel: top.funnel, removal: top.removal,
    breakdowns: top.breakdowns, platforms,
  }
}
