'use client'

// Search results for ONE platform.
//
// The list, the record card, the detail drawer and the screenshot lightbox are
// components/infringement/ResultsView.tsx — the same ones the category screen
// renders. This file is what is left once presentation is not its job: fetching
// a platform's rows, paging the upstream API, and the Open Web URL-type filter,
// which is the one thing here that no other screen has.
//
// It used to draw its own version of all of that, and the two drifted. The
// drawer was the worst of it: this screen listed seventeen hand-named fields, so
// whatever a platform returned outside that list was simply absent — and each
// platform returns a different subset, which is why Facebook, Instagram, X,
// Telegram and Open Web each appeared to be missing a different set of data
// points. The shared drawer derives its fields from the row, so a platform's own
// shape survives whatever it happens to be. See the note at the top of
// ResultsView.tsx.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useRouter } from '@/lib/router'
import type { InfringementItem } from '@/lib/types'
import Breadcrumb from '@/components/ui/Breadcrumb'
import PageLoader from '@/components/ui/PageLoader'
import {
  matchesUrlType, platformLabel, OPEN_WEB_URL_TYPES, isOpenWebPlatform, type OpenWebUrlType,
} from '@/lib/platformCategories'
import {
  PlatformTable, DetailDrawer, ScreenshotPreview, type PlatformResult,
} from '@/components/infringement/ResultsView'

function PlatformDetail({ platform: slug }: { platform: string }) {
  const searchParams = useSearchParams()
  const router = useRouter()
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
  // The screenshot being viewed full size, if any.
  const [preview, setPreview] = useState('')
  // The row whose full details are open in the side drawer.
  const [detail, setDetail] = useState<Record<string, any> | null>(null)

  const nextApiPage = useRef(1)

  const label = platformLabel(platformParam)

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
      if (!append) setTotal(tot)

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

  /* One Escape handler for both overlays, closing the top one only: the
     screenshot sits above the detail drawer, so dismissing a picture must not
     also throw away the row it was opened from. Same rule as the category
     screen, and the reason neither overlay binds its own. */
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

  // The rows the list actually shows. `items` stays the raw fetch buffer that
  // "load more" appends to, so a filtered view never loses what was fetched.
  const visible = useMemo(
    () => (urlType === 'all' ? items : items.filter(r => matchesUrlType(r as any, urlType))),
    [items, urlType])

  /* The shape the shared list takes. Memoised on `visible` because
     PlatformTable resets to page one whenever `result.items` changes identity —
     a fresh array every render would pin it to page one for good. */
  const result: PlatformResult = useMemo(
    () => ({ platform: platformParam, items: visible, total }),
    [platformParam, visible, total])

  /* How the fetched rows actually split between the two sides.

     Counted on every tab rather than only the open one, and shown on the tabs
     themselves. An empty tab is then a fact about the data — "Host URL 0" — and
     not a screen that looks broken: the reader can see the split before
     choosing, and can tell a filter that found nothing from a filter that is
     not working. This screen has been both. */
  const urlTypeCounts = useMemo(() => ({
    all: items.length,
    linking: items.filter(r => matchesUrlType(r as any, 'linking')).length,
    source: items.filter(r => matchesUrlType(r as any, 'source')).length,
  }), [items])

  /* The Open Web URL-type switch, handed to the list's header bar.

     It lives on this page rather than in the shared component because no other
     screen has one: only Open Web returns host and linking rows in a single
     response, and only this screen is ever opened with a `urlType` in its URL.
     Written back to the query string so the choice survives a reload and can be
     shared as a link, which is what it was on the search page too. */
  const urlTypeFilter = isOpenWebPlatform(platformParam) ? (
    <span className="flex items-center gap-1 rounded-lg border border-gray-200 dark:border-white/15 p-0.5">
      {OPEN_WEB_URL_TYPES.map(t => (
        <button key={t.key} type="button"
          onClick={() => {
            const q = new URLSearchParams(searchParams.toString())
            t.key === 'all' ? q.delete('urlType') : q.set('urlType', t.key)
            router.push(`/infringement/${slug}?${q}`)
          }}
          aria-pressed={urlType === t.key}
          title={t.hint}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-bold transition-colors ${
            urlType === t.key
              ? 'bg-[#14254A] text-white dark:bg-white/20'
              : 'text-gray-500 dark:text-white/60 hover:text-[#14254A] dark:hover:text-white hover:bg-[#14254A]/[0.06] dark:hover:bg-white/10'}`}>
          {t.label}
          <span className={`text-[10px] font-bold px-1.5 rounded-full tabular-nums ${
            urlType === t.key ? 'bg-white/20 text-white' : 'bg-[#14254A]/[0.07] text-[#14254A]/60 dark:bg-white/10 dark:text-white/50'}`}>
            {urlTypeCounts[t.key].toLocaleString()}
          </span>
        </button>
      ))}
    </span>
  ) : null

  return (
    <div className="fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <Breadcrumb items={[
          { label: 'Find Infringements', href: '/infringement' },
          { label },
        ]} />
        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A] dark:text-white">{label}</h1>
          <p className="text-brand-muted text-sm">
            {visible.length.toLocaleString()} row{visible.length === 1 ? '' : 's'} loaded
            {total > items.length && <> of {total.toLocaleString()}</>}
          </p>
        </div>
      </div>

      {/* What was asked for, in words — the page has no filter controls of its
          own beyond the URL type, so the criteria have to be visible or a stale
          tab is unreadable. */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        {[
          assetName && { k: 'Asset', v: assetName },
          (startDate || endDate) && { k: 'Dates', v: `${startDate || 'any'} → ${endDate || 'any'}` },
          urlType !== 'all' && {
            k: 'URL type', v: OPEN_WEB_URL_TYPES.find(t => t.key === urlType)?.label ?? urlType,
          },
        ].filter(Boolean).map((c: any) => (
          <span key={c.k} className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg
            bg-[#14254A]/5 text-[#14254A] dark:bg-white/10 dark:text-white/80">
            <span className="opacity-50">{c.k}:</span> {c.v}
          </span>
        ))}
        <button onClick={() => router.push('/infringement')}
          className="text-[11px] font-bold text-gray-400 hover:text-[#FC934C] ml-auto">
          ← Change search
        </button>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-400/30
          text-red-700 dark:text-red-300 rounded-xl px-4 py-3 text-sm mb-4 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => fetchApiPage(1, false)}
            className="px-3 py-1 rounded-lg text-xs font-bold border border-red-300 dark:border-red-400/40">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <PageLoader />
      ) : (
        <div className="space-y-4">
          <PlatformTable result={result} label={label}
            header={urlTypeFilter}
            /* The search this page IS, handed to the download menu so a
               complete-data request asks for exactly what is on screen. The
               PLATFORM here is the wire value the search was made with, not the
               display label — POST /api/download passes it straight through to
               MarkScan, which does not know what "Open Web" is. */
            download={{ platform: platformParam, assetName, startDate, endDate }}
            onPreview={setPreview}
            onOpenRow={row => setDetail(row)} />

          {/* Nothing matched the URL type, but rows WERE fetched — a different
              answer from "this search found nothing", and the only one the
              reader can act on by changing the filter above. */}
          {visible.length === 0 && items.length > 0 && (
            <p className="text-center text-xs text-gray-400">
              {items.length.toLocaleString()} record{items.length === 1 ? '' : 's'} were fetched,
              but none are of this URL type.
            </p>
          )}

          {hasMore && (
            <div className="text-center">
              <button onClick={() => fetchApiPage(nextApiPage.current, true)} disabled={loadingMore}
                className="px-5 py-2 rounded-xl text-xs font-bold border border-dashed border-gray-300
                  dark:border-white/20 text-gray-500 dark:text-white/60
                  hover:border-[#FC934C] hover:text-[#FC934C] transition-all disabled:opacity-50">
                {loadingMore ? 'Loading…' : `Load page ${nextApiPage.current} from ${label}`}
              </button>
            </div>
          )}
        </div>
      )}

      {detail && (
        <DetailDrawer row={detail} platform={label}
          onClose={() => setDetail(null)} onPreview={setPreview} />
      )}

      <ScreenshotPreview src={preview} onClose={() => setPreview('')} />
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
