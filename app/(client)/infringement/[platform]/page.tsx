'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useRouter } from '@/lib/router'
import { createPortal } from 'react-dom'
import type { InfringementItem } from '@/lib/types'
import Breadcrumb from '@/components/ui/Breadcrumb'
import PageLoader from '@/components/ui/PageLoader'
import { useTimeZone } from '@/lib/timezone'
import {
  matchesUrlType, platformLabel, isOpenWebPlatform, OPEN_WEB_URL_TYPES, type OpenWebUrlType,
} from '@/lib/platformCategories'
/* One resolver for both this screen and the category screen, which now renders
   the same card — see lib/infringementFields.ts. */
import { resolveFields, isListingPlatform, isLiveStatus } from '@/lib/infringementFields'

const PAGE_SIZES = [10, 25, 50, 100, 1000]

/**
 * Timestamps upstream are UTC, and this used to hand them to `new Date(v)` —
 * which reads a stamp with no zone on it as LOCAL time, so a discovery logged
 * at 09:00 UTC showed as 09:00 wherever you happened to be. It now goes through
 * the portal's time-zone preference (lib/timezone.tsx), which parses the value
 * as UTC and renders it in the country the header is set to.
 */
function useFmtDate() {
  const { formatUtc } = useTimeZone()
  return (v: string) => (v === '—' ? '—' : formatUtc(v, { fallback: v }))
}

/**
 * Screenshot thumbnail.
 *
 * Three states, because "no image" and "image that won't load" used to look the
 * same — a bare <img> whose src 404s, expires, or is plain http on an https page
 * renders as an empty box with no hint why. `no image` shows +, a failed load
 * shows a struck-through image mark with the URL on hover, and a good one shows
 * the picture.
 */
function Thumb({ src, size, linked = false }: { src: string; size: number; linked?: boolean }) {
  const [failed, setFailed] = useState(false)
  const box = 'rounded-xl object-cover flex-shrink-0 border border-gray-200 dark:border-white/10'
  const placeholder = `${box} bg-gray-100 dark:bg-white/10 flex items-center justify-center text-gray-400 font-light`
  const missing = src === '—' || !src

  if (missing || failed) {
    return (
      <div className={placeholder} style={{ width: size, height: size, fontSize: size / 2.6 }}
        title={failed ? `Screenshot could not be loaded: ${src}` : 'No screenshot for this record'}>
        {failed ? (
          <svg width={size / 2.4} height={size / 2.4} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" /><path d="m3 20 6-7 4 4 3-3 5 5M4 4l16 16" />
          </svg>
        ) : '+'}
      </div>
    )
  }

  const img = (
    <img src={src} alt="screenshot" loading="lazy" referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${box} ${linked ? 'hover:opacity-80 transition-opacity cursor-pointer' : ''}`}
      style={{ width: size, height: size }} />
  )
  if (!linked) return img
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="flex-shrink-0" title="Open image in new tab">
      {img}
    </a>
  )
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

/**
 * Record details drawer — a half-screen canvas that slides in from the right edge
 * rather than a centred dialog. A record carries long URLs and a dozen fields,
 * which a box in the middle of the screen has to either clip or scroll; a
 * full-height panel gives them the room and keeps the result list visible
 * alongside.
 *
 * Portalled to <body>: the page wrapper's `.fade-in` leaves a permanent
 * `transform` behind (fill-mode: both in app/globals.css), and a transformed
 * ancestor would pin `position: fixed` to the content box instead of the
 * viewport.
 */
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
  // Drives the enter transition: the panel mounts off-screen, then slides in on
  // the next frame. Without the two-step it would simply appear in place.
  const [shown, setShown] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!open) { setShown(false); return }
    const raf = requestAnimationFrame(() => setShown(true))
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!mounted || !open) return null

  return createPortal(
    <div className="fixed inset-0 z-[99999]" role="dialog" aria-modal="true" aria-label="Record details">
      {/* Scrim over the half of the screen still showing the list */}
      <div
        className={`absolute inset-0 backdrop-blur-[2px] transition-opacity duration-300 ${
          shown ? 'opacity-100' : 'opacity-0'}`}
        style={{ background: 'rgba(20,37,74,0.45)' }}
        onClick={onClose}
      />
      <div
        className={`absolute inset-y-0 right-0 w-full sm:w-1/2 max-w-[860px] flex flex-col
          bg-white dark:bg-[#1a2d55] shadow-2xl border-l border-gray-200 dark:border-white/10
          transition-transform duration-300 ease-out ${shown ? 'translate-x-0' : 'translate-x-full'}`}
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
  const router = useRouter()
  const fmtDate = useFmtDate()
  const platformParam = searchParams.get('platform') || slug
  const startDate = searchParams.get('startDate') || ''
  const endDate = searchParams.get('endDate') || ''
  const assetName = searchParams.get('assetName') || ''
  // Open Web only. /Internet/Paged returns host and linking rows together and
  // takes no source flag, so the choice made on the search page is applied here,
  // over the rows themselves.
  const urlTypeParam = searchParams.get('urlType')
  const urlType: OpenWebUrlType =
    urlTypeParam === 'linking' || urlTypeParam === 'source' ? urlTypeParam : 'all'

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

  // Everything below counts and pages over the CHOSEN url type, so the row
  // count on screen matches what is listed. `items` stays the raw fetch buffer
  // that "load more" appends to.
  const visible = useMemo(
    () => (urlType === 'all' ? items : items.filter(r => matchesUrlType(r as any, urlType))),
    [items, urlType])

  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize))
  const pageStart = (page - 1) * pageSize
  const pageRows = visible.slice(pageStart, pageStart + pageSize)

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
            { label: platformLabel(platformParam) },
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
        <div className="flex items-start gap-3 min-w-0">
          {/* Back to the platform picker — this page is always arrived at from
              there, and browser-back was the only way out. */}
          <button
            onClick={() => router.push('/infringement')}
            className="flex items-center gap-1.5 mt-1 text-sm font-semibold px-3 py-1.5 rounded-xl border border-gray-200 dark:border-white/15 text-gray-500 dark:text-white/60 hover:border-[#14254A] hover:text-[#14254A] dark:hover:text-white dark:hover:border-white/40 transition-all flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
              strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></svg>
            <span className="hidden sm:inline">Back</span>
          </button>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-[#14254A] dark:text-white">Search Results — {platformLabel(platformParam)}</h1>
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
              <span className="mr-3">
                To: <strong>{endDate}</strong>
              </span>
            )}
            {urlType !== 'all' && (
              <span>
                URL type: <strong>{OPEN_WEB_URL_TYPES.find(t => t.key === urlType)?.label}</strong>
              </span>
            )}
          </p>
        </div>
        </div>

        {!loading && visible.length > 0 && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-brand-muted">
              {visible.length.toLocaleString()} loaded
              {urlType !== 'all' && items.length !== visible.length ? ` of ${items.length.toLocaleString()} fetched` : ''}
              {urlType === 'all' && total > items.length ? ` of ${total.toLocaleString()}` : ''}
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
      ) : visible.length === 0 ? (
        <div className="text-center py-24 text-brand-muted">
          <p className="text-4xl mb-4">📭</p>
          <p className="font-medium">
            {items.length > 0
              ? `No ${OPEN_WEB_URL_TYPES.find(t => t.key === urlType)?.label.toLowerCase()} results`
              : 'No infringement data found'}
          </p>
          <p className="text-sm">
            {items.length > 0
              ? `${items.length.toLocaleString()} record${items.length === 1 ? '' : 's'} were fetched, but none are of this URL type.`
              : 'Try adjusting your filters'}
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Showing <strong className="text-[#14254A] dark:text-white">{pageStart + 1}</strong>–
                <strong className="text-[#14254A] dark:text-white">{Math.min(pageStart + pageSize, visible.length)}</strong> of{' '}
                <strong className="text-[#14254A] dark:text-white">{visible.length.toLocaleString()}</strong> cases — Page{' '}
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
              const isActive = isLiveStatus(f.status)

              return (
                /* The whole row opens the record — the link-styled "View Details"
                   was the only way in and read as body text. Links inside stop
                   propagation so they still open their own target. */
                <div key={pageStart + i}
                  onClick={() => setModal(item)}
                  role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setModal(item) } }}
                  className="group flex items-start gap-4 px-5 py-4 cursor-pointer hover:bg-orange-50/40 dark:hover:bg-white/5 transition-colors focus:outline-none focus-visible:bg-orange-50/60 dark:focus-visible:bg-white/10">
                  <Thumb src={f.screenshot} size={48} />

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#14254A] dark:text-white truncate">
                      {f.asset !== '—' ? f.asset : platformLabel(platformParam)}
                      {f.type !== '—' && <span className="text-gray-400 font-normal"> — {f.type}</span>}
                    </p>

                    <div className="mt-1 space-y-0.5">
                      {f.videoUrl !== '—' && (
                        <p className="text-xs truncate">
                          <span className="text-gray-400">Media File: </span>
                          <a href={f.videoUrl} target="_blank" onClick={e => e.stopPropagation()} rel="noopener noreferrer" className="text-blue-600 hover:underline" title={f.videoUrl}>
                            {f.videoUrl.length > 80 ? f.videoUrl.slice(0, 80) + '…' : f.videoUrl}
                          </a>
                        </p>
                      )}

                      {f.hostUrl !== '—' && (
                        <p className="text-xs truncate">
                          <span className="text-gray-400">Host URL: </span>
                          <a href={f.hostUrl} target="_blank" onClick={e => e.stopPropagation()} rel="noopener noreferrer" className="text-blue-600 hover:underline" title={f.hostUrl}>
                            {f.hostUrl.length > 80 ? f.hostUrl.slice(0, 80) + '…' : f.hostUrl}
                          </a>
                        </p>
                      )}

                      {f.linkUrl !== '—' && (
                        <p className="text-xs truncate">
                          <span className="text-gray-400">Link URL: </span>
                          <a href={f.linkUrl} target="_blank" onClick={e => e.stopPropagation()} rel="noopener noreferrer" className="text-blue-600 hover:underline" title={f.linkUrl}>
                            {f.linkUrl.length > 80 ? f.linkUrl.slice(0, 80) + '…' : f.linkUrl}
                          </a>
                        </p>
                      )}

                      {isUGCPlatform(platformParam) ? (
                        f.linkUrl !== '—' && (
                          <p className="text-xs truncate">
                            <span className="text-gray-400">Post URL: </span>
                            <a href={f.linkUrl} target="_blank" onClick={e => e.stopPropagation()} rel="noopener noreferrer" className="text-blue-600 hover:underline" title={f.linkUrl}>
                              {f.linkUrl.length > 80 ? f.linkUrl.slice(0, 80) + '…' : f.linkUrl}
                            </a>
                          </p>
                        )
                      ) : (
                        f.profileUrl !== '—' && (
                          <p className="text-xs truncate">
                            <span className="text-gray-400">{isListingPlatform(platformParam) ? 'Seller: ' : 'Channel: '}</span>
                            <a href={f.profileUrl} target="_blank" onClick={e => e.stopPropagation()} rel="noopener noreferrer" className="text-blue-600 hover:underline">
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
                      type="button"
                      onClick={e => { e.stopPropagation(); setModal(item) }}
                      className="inline-flex items-center gap-1.5 text-xs font-bold whitespace-nowrap px-3 py-1.5 rounded-lg border transition-all
                        border-[#14254A]/15 text-[#14254A] bg-white hover:bg-[#14254A] hover:border-[#14254A] hover:text-white
                        group-hover:border-[#14254A]/40
                        dark:bg-white/5 dark:border-white/15 dark:text-white/80 dark:hover:bg-white/15 dark:hover:text-white"
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
          /* Fills the drawer: fixed header, scrolling body, pinned footer. */
          <div className="flex flex-col h-full min-h-0">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100 dark:border-white/10 flex-shrink-0"
              style={{ background: 'linear-gradient(135deg,#14254A,#1E3766)' }}>
              <div className="min-w-0">
                <h2 className="font-bold text-white text-base leading-tight">Record details</h2>
                <p className="text-[11px] text-white/60 truncate">{platformLabel(platformParam)}</p>
              </div>
              <button onClick={() => setModal(null)} aria-label="Close"
                className="text-white/60 hover:text-white text-xl leading-none flex-shrink-0">
                ×
              </button>
            </div>

            <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1 min-h-0">
              <div className="flex items-start gap-3">
                <Thumb src={modalFields.screenshot} size={64} linked />
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-[#14254A] dark:text-white text-sm">{modalFields.asset !== '—' ? modalFields.asset : platformLabel(platformParam)}</p>
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
                  <MRow label="Media File">
                    <a href={modalFields.videoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all text-xs">
                      {modalFields.videoUrl}
                    </a>
                  </MRow>
                )}
                {modalFields.hostUrl !== '—' && (
                  <MRow label="Host URL">
                    <a href={modalFields.hostUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all text-xs">
                      {modalFields.hostUrl}
                    </a>
                  </MRow>
                )}
                {modalFields.linkUrl !== '—' && (
                  <MRow label="Linking URL">
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
                    /* Wire value, not the label — the URL param stays "Internet". */
                    .filter(({ internetOnly }) => !internetOnly || isOpenWebPlatform(platformParam))
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

            <div className="flex justify-end gap-3 px-4 sm:px-6 py-4 border-t border-gray-100 dark:border-white/10 flex-shrink-0 bg-gray-50/70 dark:bg-white/[0.03]">
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
