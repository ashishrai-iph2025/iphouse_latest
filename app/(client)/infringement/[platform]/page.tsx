'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from '@/lib/router'
import { createPortal } from 'react-dom'
import type { InfringementItem } from '@/lib/types'
import Breadcrumb from '@/components/ui/Breadcrumb'
import PageLoader from '@/components/ui/PageLoader'

const PAGE_SIZES = [10, 25, 50, 100, 1000]

function get(row: InfringementItem, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k]
    if (v != null && String(v).trim() !== '' && String(v) !== 'null' && String(v) !== 'undefined') {
      if (k === 'isSourceURL') return v ? 'Source' : 'Infringing'
      return String(v)
    }
  }
  return '—'
}

function fmtDate(v: string) {
  if (v === '—') return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return v
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Listing-style platforms (Meta Ads, Marketplace) carry commerce fields
// (listing/shop URLs, seller, price) and use the pipeline status
// (currentStatusName) as their display status when removalStatus is empty.
function isListingPlatform(platform: string) {
  const p = platform.trim().toLowerCase()
  return p === 'meta ads' || p === 'marketplace'
}

// Positive-count helper: ratings/reviews/purchases are meaningless as 0.
function positiveNum(v: unknown): string {
  const n = Number(v)
  return v != null && isFinite(n) && n > 0 ? String(n) : '—'
}

function resolveFields(row: InfringementItem, platform = '') {
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
    status: listing
      ? get(row, 'removalStatus', 'RemovalStatus', 'status', 'currentStatusName')
      : get(row, 'removalStatus', 'RemovalStatus', 'status'),
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
    // Listing-platform extras (— on every other platform)
    price,
    ratings: positiveNum(row['ratings']),
    reviews: positiveNum(row['noOfReviews']),
    buys: positiveNum(row['noOfBuys']),
  }
}

function MRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-50 dark:bg-white/5 rounded-lg px-3 py-2 border border-gray-100 dark:border-white/10">
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">{label}</p>
      <div className="text-xs">{children}</div>
    </div>
  )
}

function MCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-50 dark:bg-white/5 rounded-lg px-3 py-2 border border-gray-100 dark:border-white/10">
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">{label}</p>
      <p className="text-xs font-medium text-gray-800 dark:text-gray-200">{children}</p>
    </div>
  )
}

function PgBtn({
  children,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-w-[30px] h-[28px] px-2 rounded-lg text-xs font-bold border transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
        active
          ? 'border-transparent text-white bg-gradient-to-br from-[#FFC82B] to-[#FC934C]'
          : 'border-gray-200 dark:border-white/15 text-[#14254A] dark:text-gray-200 hover:text-white hover:border-transparent hover:bg-gradient-to-br hover:from-[#FFC82B] hover:to-[#FC934C]'
      }`}
    >
      {children}
    </button>
  )
}

function ModalPortal({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!mounted || !open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[99999] bg-black/30 backdrop-blur-[2px] flex items-start justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[calc(100vw-2rem)] sm:max-w-[560px] bg-white dark:bg-[#1a2d55] rounded-2xl shadow-2xl border border-gray-100 dark:border-white/10 overflow-hidden"
        style={{ maxHeight: 'calc(100vh - 3rem)' }}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

const UGC_PLATFORMS = new Set(['ugc and other social media', 'tiktok', 'vk', 'ok', 'sharechat', 'dailymotion', 'bilibili', 'chomikuj'])

function isUGCPlatform(p: string) {
  return UGC_PLATFORMS.has(p.toLowerCase())
}

function PlatformDetail({ platform: slug }: { platform: string }) {
  const searchParams = useSearchParams()
  const platformParam = searchParams.get('platform') || slug
  const startDate = searchParams.get('startDate') || ''
  const endDate = searchParams.get('endDate') || ''
  const assetName = searchParams.get('assetName') || ''

  const [items, setItems] = useState<InfringementItem[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [modal, setModal] = useState<InfringementItem | null>(null)

  const nextApiPage = useRef(1)

  async function fetchApiPage(pageNo: number, append: boolean) {
    append ? setLoadingMore(true) : setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/infringement', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: platformParam, startDate, endDate, assetName, page: pageNo }),
      })
      const data = await res.json()
      if (!data.success) {
        setError(data.error || 'Failed to load data')
        return
      }

      const incoming: InfringementItem[] = data.data?.items ?? []
      const tot: number = data.data?.total ?? 0

      setItems(prev => (append ? [...prev, ...incoming] : incoming))
      if (!append) {
        setTotal(tot)
        setPage(1)
      }

      nextApiPage.current = Math.max(1, pageNo) + 1
      setHasMore(incoming.length > 0)
    } catch (e: any) {
      setError(e.message)
    } finally {
      append ? setLoadingMore(false) : setLoading(false)
    }
  }

  useEffect(() => {
    nextApiPage.current = 1
    setItems([])
    setTotal(0)
    setHasMore(false)
    fetchApiPage(1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformParam, startDate, endDate, assetName])

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const pageStart = (page - 1) * pageSize
  const pageRows = items.slice(pageStart, pageStart + pageSize)

  function pgRange(cur: number, tot: number): (number | '…')[] {
    if (tot <= 9) return Array.from({ length: tot }, (_, i) => i + 1)
    const pages: (number | '…')[] = [1]
    if (cur > 3) pages.push('…')
    for (let p = Math.max(2, cur - 1); p <= Math.min(tot - 1, cur + 1); p++) pages.push(p)
    if (cur < tot - 2) pages.push('…')
    pages.push(tot)
    return pages
  }

  const modalFields = useMemo(() => (modal ? resolveFields(modal, platformParam) : null), [modal, platformParam])

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-1">
        <Breadcrumb
          items={[
            { label: 'Find Infringements', href: '/infringement' },
            { label: platformParam },
          ]}
        />
        {hasMore && (
          <button
            onClick={() => fetchApiPage(nextApiPage.current, true)}
            disabled={loadingMore}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl border border-dashed border-gray-300 dark:border-white/20 text-gray-500 dark:text-gray-400 hover:border-[#FC934C] hover:text-[#FC934C] transition-all disabled:opacity-50 flex-shrink-0"
          >
            {loadingMore ? (
              <>
                <span className="w-3 h-3 border-2 border-gray-300 border-t-[#FC934C] rounded-full animate-spin" />
                Loading…
              </>
            ) : (
              '+ Load more records'
            )}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-[#14254A] dark:text-white">Search Results — {platformParam}</h1>
          <p className="text-brand-muted text-xs mt-1">
            {assetName && (
              <span className="mr-3">
                Asset: <strong>{assetName}</strong>
              </span>
            )}
            {startDate && (
              <span className="mr-3">
                From: <strong>{startDate}</strong>
              </span>
            )}
            {endDate && (
              <span>
                To: <strong>{endDate}</strong>
              </span>
            )}
          </p>
        </div>

        {!loading && items.length > 0 && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-brand-muted">
              {items.length.toLocaleString()} loaded{total > items.length ? ` of ${total.toLocaleString()}` : ''}
            </span>
            <span className="badge badge-info">{total.toLocaleString()} total</span>
          </div>
        )}
      </div>

      {loading ? (
        <PageLoader />
      ) : error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-6 text-center">
          <p className="font-semibold">Error loading data</p>
          <p className="text-sm mt-1">{error}</p>
          <button onClick={() => fetchApiPage(0, false)} className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg text-sm">
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-24 text-brand-muted">
          <p className="text-4xl mb-4">📭</p>
          <p className="font-medium">No infringement data found</p>
          <p className="text-sm">Try adjusting your filters</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Showing <strong className="text-[#14254A] dark:text-white">{pageStart + 1}</strong>–
                <strong className="text-[#14254A] dark:text-white">{Math.min(pageStart + pageSize, items.length)}</strong> of{' '}
                <strong className="text-[#14254A] dark:text-white">{items.length.toLocaleString()}</strong> cases — Page{' '}
                <strong className="text-[#14254A] dark:text-white">{page}</strong> of{' '}
                <strong className="text-[#14254A] dark:text-white">{totalPages}</strong>
              </p>

              <select
                value={pageSize}
                onChange={e => {
                  setPageSize(Number(e.target.value))
                  setPage(1)
                }}
                className="text-xs border border-gray-200 dark:border-white/10 rounded-lg px-2 py-1 bg-white dark:bg-[#1a2d55] text-gray-700 dark:text-gray-200 cursor-pointer"
              >
                {PAGE_SIZES.map(s => (
                  <option key={s} value={s}>
                    {s} / page
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1 flex-wrap">
              <PgBtn onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                Prev
              </PgBtn>
              {pgRange(page, totalPages).map((p, i) =>
                p === '…' ? (
                  <span key={`e-${i}`} className="px-1 text-xs text-gray-400">
                    …
                  </span>
                ) : (
                  <PgBtn key={`p-${p}`} active={p === page} onClick={() => setPage(p as number)}>
                    {p}
                  </PgBtn>
                ),
              )}
              <PgBtn onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                Next
              </PgBtn>
            </div>
          </div>

          <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/8 overflow-hidden">
            {pageRows.map((item, i) => {
              const f = resolveFields(item, platformParam)
              const isActive = f.status === '—' || f.status.toLowerCase().includes('active') || f.status.toLowerCase() === 'live'

              return (
                <div key={pageStart + i} className="flex items-start gap-4 px-5 py-4 hover:bg-orange-50/40 dark:hover:bg-white/5 transition-colors">
                  {f.screenshot !== '—' ? (
                    <img
                      src={f.screenshot}
                      alt="screenshot"
                      className="w-12 h-12 rounded-lg object-cover flex-shrink-0 border border-gray-200 dark:border-white/10"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-gray-100 dark:bg-white/10 flex items-center justify-center flex-shrink-0 text-gray-400 text-xl font-light border border-gray-200 dark:border-white/10">
                      +
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#14254A] dark:text-white truncate">
                      {f.asset !== '—' ? f.asset : platformParam}
                      {f.type !== '—' && <span className="text-gray-400 font-normal"> — {f.type}</span>}
                    </p>

                    <div className="mt-1 space-y-0.5">
                      {f.videoUrl !== '—' && (
                        <p className="text-xs truncate">
                          <span className="text-gray-400">Video URL: </span>
                          <a href={f.videoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" title={f.videoUrl}>
                            {f.videoUrl.length > 80 ? f.videoUrl.slice(0, 80) + '…' : f.videoUrl}
                          </a>
                        </p>
                      )}

                      {f.hostUrl !== '—' && (
                        <p className="text-xs truncate">
                          <span className="text-gray-400">Host URL: </span>
                          <a href={f.hostUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" title={f.hostUrl}>
                            {f.hostUrl.length > 80 ? f.hostUrl.slice(0, 80) + '…' : f.hostUrl}
                          </a>
                        </p>
                      )}

                      {f.linkUrl !== '—' && (
                        <p className="text-xs truncate">
                          <span className="text-gray-400">Link URL: </span>
                          <a href={f.linkUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" title={f.linkUrl}>
                            {f.linkUrl.length > 80 ? f.linkUrl.slice(0, 80) + '…' : f.linkUrl}
                          </a>
                        </p>
                      )}

                      {isUGCPlatform(platformParam) ? (
                        f.linkUrl !== '—' && (
                          <p className="text-xs truncate">
                            <span className="text-gray-400">Post URL: </span>
                            <a href={f.linkUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" title={f.linkUrl}>
                              {f.linkUrl.length > 80 ? f.linkUrl.slice(0, 80) + '…' : f.linkUrl}
                            </a>
                          </p>
                        )
                      ) : (
                        f.profileUrl !== '—' && (
                          <p className="text-xs truncate">
                            <span className="text-gray-400">{isListingPlatform(platformParam) ? 'Seller: ' : 'Channel: '}</span>
                            <a href={f.profileUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                              {f.channelName !== '—' ? f.channelName : f.profileUrl.slice(0, 60)}
                            </a>
                          </p>
                        )
                      )}
                    </div>

                    <p className="text-xs text-gray-400 mt-1.5">
                      {f.discovered !== '—' && <span>Discovered: {fmtDate(f.discovered)}</span>}
                      {f.language !== '—' && <span className="ml-3">| Lang: {f.language}</span>}
                      {f.subscribers !== '—' && <span className="ml-3">| Subscribers: {Number(f.subscribers).toLocaleString()}</span>}
                      {f.price !== '—' && <span className="ml-3">| Price: {f.price}</span>}
                      {f.country !== '—' && isListingPlatform(platformParam) && <span className="ml-3">| Country: {f.country}</span>}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wide ${
                        isActive ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-gray-100 text-gray-500 border border-gray-200'
                      }`}
                    >
                      {f.status !== '—' ? f.status : 'Active'}
                    </span>

                    <button
                      onClick={e => {
                        setModal(item)
                      }}
                      className="text-xs text-gray-500 dark:text-gray-400 hover:text-[#FC934C] dark:hover:text-[#FC934C] font-medium transition-colors whitespace-nowrap"
                    >
                      View Details
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="flex justify-end mt-4">
            <div className="flex items-center gap-1 flex-wrap">
              <PgBtn onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                Prev
              </PgBtn>
              {pgRange(page, totalPages).map((p, i) =>
                p === '…' ? (
                  <span key={`e-${i}`} className="px-1 text-xs text-gray-400">
                    …
                  </span>
                ) : (
                  <PgBtn key={`p-${p}`} active={p === page} onClick={() => setPage(p as number)}>
                    {p}
                  </PgBtn>
                ),
              )}
              <PgBtn onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                Next
              </PgBtn>
            </div>
          </div>
        </>
      )}

      <ModalPortal open={!!modal} onClose={() => setModal(null)}>
        {modal && modalFields && (
          <div className="flex flex-col max-h-[calc(100vh-3rem)]">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100 dark:border-white/10">
              <h2 className="font-bold text-[#14254A] dark:text-white text-base">Record details</h2>
              <button onClick={() => setModal(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
                ×
              </button>
            </div>

            <div className="p-4 sm:p-5 space-y-4 overflow-y-auto">
              <div className="flex items-start gap-3">
                {modalFields.screenshot !== '—' ? (
                  <a href={modalFields.screenshot} target="_blank" rel="noopener noreferrer" className="flex-shrink-0" title="Open image in new tab">
                    <img
                      src={modalFields.screenshot}
                      alt="screenshot"
                      className="w-16 h-16 rounded-xl object-cover border border-gray-200 dark:border-white/10 hover:opacity-80 transition-opacity cursor-pointer"
                    />
                  </a>
                ) : (
                  <div className="w-16 h-16 rounded-xl bg-gray-100 dark:bg-white/10 flex items-center justify-center text-gray-400 text-2xl border border-gray-200 dark:border-white/10 flex-shrink-0">
                    +
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-[#14254A] dark:text-white text-sm">{modalFields.asset !== '—' ? modalFields.asset : platformParam}</p>
                  {modalFields.videoTitle !== '—' && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{modalFields.videoTitle}</p>}
                  {modalFields.domain !== '—' && <p className="text-xs text-gray-400 mt-0.5">{modalFields.domain}</p>}
                </div>
                <div className="text-right flex-shrink-0 text-xs">
                  {modalFields.discovered !== '—' && (
                    <>
                      <p className="text-gray-400 uppercase tracking-wide text-[10px]">Discovered</p>
                      <p className="font-semibold text-[#14254A] dark:text-white">{fmtDate(modalFields.discovered)}</p>
                    </>
                  )}
                  {modalFields.language !== '—' && (
                    <>
                      <p className="text-gray-400 uppercase tracking-wide text-[10px] mt-1">Language</p>
                      <p className="font-semibold text-[#14254A] dark:text-white">{modalFields.language}</p>
                    </>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2">
                {modalFields.videoUrl !== '—' && (
                  <MRow label="Video URL">
                    <a href={modalFields.videoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all text-xs">
                      {modalFields.videoUrl}
                    </a>
                  </MRow>
                )}
                {modalFields.hostUrl !== '—' && (
                  <MRow label="Source URL">
                    <a href={modalFields.hostUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all text-xs">
                      {modalFields.hostUrl}
                    </a>
                  </MRow>
                )}
                {modalFields.linkUrl !== '—' && (
                  <MRow label="Infringing URL">
                    <a href={modalFields.linkUrl} target="_blank" rel="noopener noreferrer" className="text-red-500 hover:underline break-all text-xs">
                      {modalFields.linkUrl}
                    </a>
                  </MRow>
                )}
                {modalFields.profileUrl !== '—' && (
                  <MRow label={isListingPlatform(platformParam) ? 'Seller / Shop URL' : 'Channel / Profile URL'}>
                    <a href={modalFields.profileUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all text-xs">
                      {modalFields.profileUrl}
                    </a>
                  </MRow>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {modalFields.channelName !== '—' && <MCell label={isListingPlatform(platformParam) ? 'Seller' : 'Channel / Profile'}>{modalFields.channelName}</MCell>}
                {modalFields.price !== '—' && <MCell label="Listing Price">{modalFields.price}</MCell>}
                {modalFields.ratings !== '—' && <MCell label="Ratings">{modalFields.ratings}</MCell>}
                {modalFields.reviews !== '—' && <MCell label="Reviews">{Number(modalFields.reviews).toLocaleString()}</MCell>}
                {modalFields.buys !== '—' && <MCell label="Purchases">{Number(modalFields.buys).toLocaleString()}</MCell>}
                {modalFields.sourceDomain !== '—' && <MCell label="Source Domain">{modalFields.sourceDomain}</MCell>}
                {modalFields.domain !== '—' && <MCell label="Infringing Domain">{modalFields.domain}</MCell>}
                {modalFields.type !== '—' && <MCell label="Infringement Type">{modalFields.type}</MCell>}
                {modalFields.quality !== '—' && <MCell label="Quality of Print">{modalFields.quality}</MCell>}
                {modalFields.duration !== '—' && <MCell label="Duration">{modalFields.duration}</MCell>}
                {modalFields.country !== '—' && <MCell label="Country">{modalFields.country}</MCell>}
                {modalFields.keywords !== '—' && <MCell label="Keywords">{modalFields.keywords}</MCell>}
                {modalFields.searchEngine !== '—' && <MCell label="Search Engine">{modalFields.searchEngine}</MCell>}
                {modalFields.views !== '—' && <MCell label="Views">{Number(modalFields.views).toLocaleString()}</MCell>}
                {modalFields.likes !== '—' && <MCell label="Likes">{Number(modalFields.likes).toLocaleString()}</MCell>}
                {modalFields.comments !== '—' && <MCell label="Comments">{modalFields.comments}</MCell>}
                {modalFields.subscribers !== '—' && <MCell label="Subscribers">{Number(modalFields.subscribers).toLocaleString()}</MCell>}
              </div>

              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Enforcement</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    { label: 'Removal', status: modalFields.status, time: modalFields.removalTime, internetOnly: false },
                    { label: 'Delisting', status: modalFields.delistStatus, time: modalFields.delistTime, internetOnly: true },
                    { label: 'DMCA', status: modalFields.dmcaStatus, time: modalFields.dmcaTime, internetOnly: true },
                  ]
                    .filter(({ internetOnly }) => !internetOnly || platformParam.toLowerCase() === 'internet')
                    .map(({ label, status, time }) => (
                    <div key={label} className="bg-gray-50 dark:bg-white/5 rounded-xl p-2.5 border border-gray-100 dark:border-white/10">
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">{label}</p>
                      <p className="text-xs text-gray-600 dark:text-gray-400">
                        Status: <span className="font-semibold text-gray-800 dark:text-gray-200">{status}</span>
                      </p>
                      <p className="text-xs text-gray-600 dark:text-gray-400">
                        Time: <span className="font-semibold text-gray-800 dark:text-gray-200">{time !== '—' ? fmtDate(time) : '—'}</span>
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 px-4 sm:px-6 py-4 border-t border-gray-100 dark:border-white/10">
              {(modalFields.linkUrl !== '—' || modalFields.hostUrl !== '—') && (
                <a
                  href={modalFields.linkUrl !== '—' ? modalFields.linkUrl : modalFields.hostUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-5 py-2 rounded-xl text-white text-sm font-semibold transition-all hover:opacity-90"
                  style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}
                >
                  Open URL
                </a>
              )}
              <button
                onClick={() => setModal(null)}
                className="px-5 py-2 rounded-xl border border-gray-200 dark:border-white/10 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </ModalPortal>
    </div>
  )
}

export default function PlatformDetailPage({ platform }: { platform: string }) {
  return (
    <Suspense fallback={<PageLoader />}>
      <PlatformDetail platform={platform} />
    </Suspense>
  )
}
