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
  { key: 'source',  label: 'Source URL',  hint: 'The host page carrying the file itself' },
]

/** Reads a row's source/linking flag across the casings MarkScan returns. */
export function rowIsSourceUrl(row: Record<string, any>): boolean {
  for (const k of ['isSourceURL', 'isSourceUrl', 'IsSourceURL', 'isSrcUrl', 'IsSrcUrl']) {
    const v = row?.[k]
    if (v !== undefined && v !== null && v !== '') {
      return v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v) === '1'
    }
  }
  return false
}

/** Whether a row belongs in the chosen Open Web view. */
export function matchesUrlType(row: Record<string, any>, type: OpenWebUrlType): boolean {
  if (type === 'all') return true
  return rowIsSourceUrl(row) === (type === 'source')
}
