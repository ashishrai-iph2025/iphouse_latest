/**
 * One reading of an infringement row, shared by every screen that shows one.
 *
 * The warehouse spells the same thing several ways — `videoURL`, `VideoURL`,
 * `videoUrl`, `sourceURLLink` are one field — and each platform fills a
 * different subset. This resolves a row to the fields a card or a drawer
 * actually displays.
 *
 * It lives here rather than in a page because two pages now render the same
 * card: the single-platform view and the category view, which shows several
 * platforms under one search. Two copies of this list would drift, and the
 * symptom would be a field appearing on one screen and reading "—" on the
 * other for the same record.
 */

import { isOpenWebPlatform, rowIsSourceUrl } from '@/lib/platformCategories'

export interface InfringementRow {
  [key: string]: unknown
}

/** First key that carries a real value, or "—". */
export function get(row: InfringementRow, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k]
    if (v != null && String(v).trim() !== '' && String(v) !== 'null' && String(v) !== 'undefined') {
      if (k === 'isSourceURL') return v ? 'Source' : 'Infringing'
      return String(v)
    }
  }
  return '—'
}

/**
 * Listing-style platforms (Meta Ads, Marketplace) carry commerce fields —
 * listing and shop URLs, a seller, a price — and use the pipeline status as
 * their display status where removalStatus is empty.
 */
export function isListingPlatform(platform: string) {
  const p = platform.trim().toLowerCase()
  return p === 'meta ads' || p === 'marketplace'
}

/** Ratings, reviews and purchases are meaningless as 0, so they read "—". */
function positiveNum(v: unknown): string {
  const n = Number(v)
  return v != null && isFinite(n) && n > 0 ? String(n) : '—'
}

export type ResolvedFields = ReturnType<typeof resolveFields>

export function resolveFields(row: InfringementRow, platform = '') {
  const listing = isListingPlatform(platform)

  // Marketplace price range: min / max + currency.
  const priceParts = [row['listingPriceMin'], row['listingPriceMax']]
    .filter(v => v != null && String(v).trim() !== '')
    .map(v => Number(v).toLocaleString())
  const currency = row['listingCurrency'] != null ? String(row['listingCurrency']).trim() : ''
  const price = priceParts.length ? `${priceParts.join(' – ')}${currency ? ` ${currency}` : ''}` : '—'

  return {
    asset: get(row, 'assetName', 'AssetName', 'asset', 'Asset', 'title'),
    type: get(row, 'infringementType', 'InfringementType', 'infringementTypeName', 'type', 'isSourceURL'),
    status: statusOf(row, platform, listing),
    videoUrl: get(row, 'videoURL', 'VideoURL', 'videoUrl', 'sourceURLLink'),
    profileUrl: get(row, 'profileURL', 'ProfileURL', 'channelOrProfileURL', 'channelURL', 'channelUrl', 'ChannelURL', 'shopUrl'),
    hostUrl: get(row, 'sourceURL', 'sourceUrl', 'SourceURL', 'hostURL', 'hostUrl'),
    linkUrl: get(row, 'infringingURL', 'infringingUrl', 'url', 'URL', 'postURL', 'postUrl', 'listingUrl'),
    domain: get(row, 'infringingDomain', 'domain', 'infringingHost', 'host'),
    sourceDomain: get(row, 'sourceDomain', 'sourceHost'),
    videoTitle: get(row, 'videoTitle', 'VideoTitle', 'caption', 'title', 'postDescription', 'listingTitle'),
    channelName: get(row, 'channelName', 'ChannelName', 'profileName', 'channelOrProfileName', 'userName', 'chatTitle', 'sellerName'),
    channelId: get(row, 'channelId', 'channelID', 'ChannelId', 'channelURL', 'channelUrl', 'pageId'),
    views: get(row, 'views', 'Views', 'viewCount'),
    likes: get(row, 'like_count', 'likeCount', 'likes'),
    comments: get(row, 'comment_count', 'commentCount', 'commentsCount'),
    subscribers: get(row, 'subscribers', 'subscriberCount', 'subscrbers', 'followersCount', 'members'),
    quality: get(row, 'qualityOfPrint', 'QualityOfPrint', 'qualityOfPrintName', 'quality', 'qualityPrint'),
    duration: get(row, 'videoLength', 'VideoLength', 'videoDuration', 'duration'),
    keywords: get(row, 'keywords', 'Keywords', 'keyword', 'category'),
    screenshot: get(row, 'screenshotUrl', 'screenshotURL', 'screenshot', 'screenshot_url'),
    discovered: get(row, 'urlUploadDate', 'URLUploadDate', 'publishedDate', 'PublishedDate', 'discoveredDate', 'detectedDate', 'detectionDate', 'createdAt', 'date'),
    published: get(row, 'publishedDate', 'PublishedDate', 'postUploadDate'),
    uploaded: get(row, 'urlUploadDate', 'URLUploadDate'),
    country: get(row, 'country', 'Country', 'countryName', 'sellerCountryName'),
    language: get(row, 'audioLanguage', 'AudioLanguage', 'language1', 'language', 'lang', 'languageName'),
    searchEngine: get(row, 'searchEngine', 'engine', 'searchEngineType'),
    removalTime: get(row, 'removalTime', 'RemovalTime'),
    delistStatus: get(row, 'delistingremovalstatus', 'delistingRemovalStatus', 'delistingStatus', 'delisting', 'delistStatus'),
    delistTime: get(row, 'delistingTime', 'delistingDate', 'delistDate'),
    dmcaStatus: get(row, 'dmcaremovalstatus', 'dmcaRemovalStatus', 'hostDmcaStatus', 'infringingDmcaStatus', 'infringingDmca', 'dmcaStatus'),
    dmcaTime: get(row, 'dmcaRemovalTime', 'infringingDmcaTime', 'hostDmcaTime'),
    // Listing-platform extras ("—" on every other platform)
    price,
    ratings: positiveNum(row['ratings']),
    reviews: positiveNum(row['noOfReviews']),
    buys: positiveNum(row['noOfBuys']),
  }
}

/**
 * Whether a record should read as active.
 *
 * An empty status counts as active on purpose: these rows are enforcement
 * targets, and a record with no removal recorded has not been removed. Reading
 * "unknown" as "handled" would flatter every report it appears in.
 */
/*
── THE STATUS THE LIST PILL SHOWS ───────────────────────────────────────────

	Two bugs met here and produced a green ACTIVE pill on rows that were dead.

	THE SPELLING. This looked for `removalStatus`, `RemovalStatus` and `status`.
	Open Web sends `removalstatus`, all lowercase — the same run-on spelling the
	drawer has a whole label map for — so on Open Web the lookup matched nothing,
	fell through to get()'s "—", and isLiveStatus reads "—" as live. Every row of
	every Open Web search has therefore shown ACTIVE since the screen was built,
	including the ones whose host file was confirmed gone. Nothing looked broken:
	a green pill on a live URL and a green pill on a dead one are the same pixels.

	THE SIDE. Open Web rows come in pairs and the two ends have separate
	outcomes: `removalstatus` is the HOST file coming down, `dmcaremovalstatus`
	is the LINKING page coming down. A row is one end, so the pill has to read
	the outcome belonging to the end it is on — otherwise a linking row is
	labelled by whether somebody else's host is still serving, which is not what
	the line above the pill is describing.

	The de-indexing statuses are deliberately NOT considered. A de-indexed link
	is still there, and this pill says whether the thing is up.
*/
function statusOf(row: InfringementRow, platform: string, listing: boolean): string {
  if (isOpenWebPlatform(platform)) {
    return rowIsSourceUrl(row)
      // The host end: is the file still served?
      ? get(row, 'removalstatus', 'removalStatus', 'RemovalStatus')
      // The linking end: is the page still up? Falling back to the host's only
      // where the link has no status of its own, which is better than "—".
      : get(row, 'dmcaremovalstatus', 'dmcaRemovalStatus', 'DMCARemovalStatus',
            'removalstatus', 'removalStatus')
  }
  return listing
    ? get(row, 'removalStatus', 'RemovalStatus', 'status', 'currentStatusName')
    : get(row, 'removalStatus', 'RemovalStatus', 'status')
}

export function isLiveStatus(status: string) {
  const s = status.trim().toLowerCase()
  return s === '—' || s === '' || s.includes('active') || s === 'live'
}
