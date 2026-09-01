// Platform categorisation for the client-facing pickers.
//
// The platform LIST is master data from MarkScan (/api/master-data), and every
// value is passed straight through to MarkScan on the wire
// (/SearchandRetriveapi, /*/Paged, …). So this module only ever changes how a
// platform is *grouped and labelled* — `MasterOption.key` is never rewritten,
// or the upstream call would 400.
//
// Categories are matched by name against the known platform vocabulary
// (go-server/markscan/client.go: infringementEndpoints + ugcPlatformMap).
// Anything master data returns that isn't recognised falls into "Other", so a
// new platform appearing upstream still shows up in the picker.

import type { MasterOption } from '@/lib/masterDataContext'

export type PlatformCategoryKey =
  | 'open-web' | 'social-ugc' | 'mobile-apps' | 'messenger' | 'other'

/** Canonical platform-name sets, lowercased. Social and UGC are kept as two
    lists because they are two distinct upstream vocabularies (named endpoints
    vs /UGCPlatform/Paged), but they present as ONE category: to a client they
    are all "somebody posted our content on a social platform", and splitting
    them made the picker ask a question about MarkScan's routing. */
const OPEN_WEB_NAMES = new Set(['internet', 'open web', 'openweb'])
const SOCIAL_NAMES   = new Set(['facebook', 'instagram', 'twitter', 'x', 'x (twitter)', 'youtube'])
const UGC_NAMES      = new Set([
  'ugc and other social media',
  'tiktok', 'vk', 'ok', 'sharechat', 'dailymotion', 'bilibili', 'chomikuj',
])
/** App stores and the apps distributed outside them — one question for a client
    ("is our title being shipped as an app?"), four upstream platform names. */
const MOBILE_APP_NAMES = new Set([
  'play store', 'playstore', 'google play', 'google play store',
  'i-tunes', 'itunes', 'app store', 'apple app store',
  'third party app', 'third party mobile app', 'thirdpartyapp', 'thirdpartymobileapp',
])
/** Chat and messaging platforms. Telegram is the only one upstream serves
    today; the category exists so the next one does not land in "Other". */
const MESSENGER_NAMES = new Set([
  'telegram', 'whatsapp', 'discord', 'signal', 'wechat', 'viber',
])

/** Display overrides. Everything not listed keeps its master-data label. */
const LABEL_OVERRIDES: Record<string, string> = {
  'internet': 'Open Web',
  'ugc and other social media': 'Other UGC',
}

const norm = (v: string) => String(v ?? '').trim().toLowerCase()

/** What the user should see for a platform — the wire value stays untouched. */
export function platformLabel(nameOrLabel: string): string {
  return LABEL_OVERRIDES[norm(nameOrLabel)] ?? nameOrLabel
}

export function categoryOf(platformName: string): PlatformCategoryKey {
  const n = norm(platformName)
  if (OPEN_WEB_NAMES.has(n)) return 'open-web'
  if (MESSENGER_NAMES.has(n)) return 'messenger'
  if (MOBILE_APP_NAMES.has(n)) return 'mobile-apps'
  if (SOCIAL_NAMES.has(n) || UGC_NAMES.has(n)) return 'social-ugc'
  return 'other'
}

export const isOpenWebPlatform = (platformName: string) => categoryOf(platformName) === 'open-web'

export interface PlatformCategory {
  key:       PlatformCategoryKey
  label:     string
  /** Master-data options in this category, `key` unchanged, `label` display-mapped. */
  platforms: MasterOption[]
}

const CATEGORY_ORDER: { key: PlatformCategoryKey; label: string }[] = [
  { key: 'open-web',    label: 'Open Web' },
  { key: 'social-ugc',  label: 'UGC and Social Media' },
  { key: 'mobile-apps', label: 'Mobile Apps' },
  { key: 'messenger',   label: 'Messenger' },
  { key: 'other',       label: 'Other' },
]

/** Preferred order within a category; unlisted names keep master-data order after these. */
const WITHIN_CATEGORY_ORDER: string[] = [
  'facebook', 'instagram', 'twitter', 'x (twitter)', 'youtube',
  'ugc and other social media', 'tiktok', 'vk', 'ok', 'sharechat', 'dailymotion', 'bilibili', 'chomikuj',
  'play store', 'i-tunes', 'itunes', 'third party app', 'third party mobile app',
]

/**
 * Group the master-data platform list into display categories, dropping any
 * category master data has no platform for (so the picker never offers a value
 * MarkScan would reject).
 */
export function categorizePlatforms(platforms: MasterOption[]): PlatformCategory[] {
  const buckets = new Map<PlatformCategoryKey, MasterOption[]>()
  for (const p of platforms) {
    const cat = categoryOf(p.key)
    const arr = buckets.get(cat) ?? []
    arr.push({ key: p.key, label: platformLabel(p.label || p.key) })
    buckets.set(cat, arr)
  }

  const rank = (o: MasterOption) => {
    const i = WITHIN_CATEGORY_ORDER.indexOf(norm(o.key))
    return i === -1 ? WITHIN_CATEGORY_ORDER.length : i
  }

  return CATEGORY_ORDER
    .map(c => ({
      ...c,
      platforms: (buckets.get(c.key) ?? []).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)),
    }))
    .filter(c => c.platforms.length > 0)
}

/* ── Open Web URL type ─────────────────────────────────────────────────────
   Open Web rows carry both a host URL (sourceURL) and a linking URL
   (infringingURL), and each row states which it is via `isSourceURL`.

   This is applied as a FILTER over returned rows, not as a request field:
   /Internet/Paged takes {startDate, endDate, assetName, pageNo} and no source
   flag, so it returns both kinds together and the choice has to be made on the
   results. (The endpoints that DO take the flag — /SearchandRetriveapi's
   `isSrcUrl`, /GetDiscoveryQcURLs' `isSourceURL` — don't agree on its name,
   which is another reason not to guess one onto an endpoint that never
   documented it.) */

export type OpenWebUrlType = 'all' | 'linking' | 'source'

export const OPEN_WEB_URL_TYPES: { key: OpenWebUrlType; label: string; hint: string }[] = [
  { key: 'all',     label: 'All URLs',    hint: 'Host pages and the links pointing at them' },
  { key: 'linking', label: 'Linking URL', hint: 'Pages that link to the infringing file' },
  /* "Host URL", not "Source URL". Open Web results are a PAIR — the page
     carrying the link, and the host serving the file — and "source" reads as
     "where this came from" when it means the far end of that pair. The KEY stays
     `source`: it is the wire value, it is in the `urlType` query parameter, and
     renaming it would break every link anyone has already shared. */
  { key: 'source',  label: 'Host URL',    hint: 'The host page carrying the file itself' },
]

/** The fields that carry the HOST page — the pirate player or file host, as
    opposed to the page linking to it. Same list resolveFields reads hostUrl
    from, so the tab and the card can never disagree about whether a row has
    one. */
const HOST_URL_KEYS = ['sourceURL', 'sourceUrl', 'SourceURL', 'hostURL', 'hostUrl']

const filled = (v: unknown) =>
  v !== undefined && v !== null && String(v).trim() !== '' &&
  String(v) !== 'null' && String(v) !== 'undefined'

/*
Whether a row is the HOST side of an Open Web pair.

Two ways of knowing, in order, and the second is the one that was missing.

An EXPLICIT FLAG wins where there is one. The QC screens get theirs stamped by
the server, which asks MarkScan for each side separately and marks the two
batches as it merges them (go-server/handlers/enforce.go). `isSource` is the
same fact under the War Room's name for it.

Otherwise it is DERIVED from the row, exactly as the server's own normaliser
derives it — `r["isSource"] = notEmpty(r["sourceURL"])`, and the comment above it
reads "A row with no sourceURL is an infringing-URL row"
(go-server/markscan/warroom.go).

That fallback is the fix for a filter that could only ever answer one way.
/Internet/Paged returns host and linking rows in one list and stamps neither —
POST /api/infringement passes them straight through, unlike the QC path — so no
flag was ever present, every row fell through to `return false`, and every row
was therefore classified as linking. The Linking URL tab showed all thousand
rows and the Host URL tab showed none of them, on data where the host URLs were
plainly there to see.
*/
export function rowIsSourceUrl(row: Record<string, any>): boolean {
  for (const k of ['isSourceURL', 'isSourceUrl', 'IsSourceURL', 'isSrcUrl', 'IsSrcUrl', 'isSource', 'IsSource']) {
    const v = row?.[k]
    if (v !== undefined && v !== null && v !== '') {
      return v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v) === '1'
    }
  }
  return HOST_URL_KEYS.some(k => filled(row?.[k]))
}

/** Whether a row belongs in the chosen Open Web view. */
export function matchesUrlType(row: Record<string, any>, type: OpenWebUrlType): boolean {
  if (type === 'all') return true
  return rowIsSourceUrl(row) === (type === 'source')
}
