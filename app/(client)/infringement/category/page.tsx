'use client'

// Category results — one search, every platform in the category, a table each.
//
// The rows are NOT merged into one table. Each platform's upstream endpoint
// returns its own shape — YouTube has views and subscribers, Marketplace a price
// and a seller, Open Web a host URL and a linking URL — so a single table would
// mean picking a lowest common denominator and throwing the rest away. Instead
// each platform gets its own list whose fields are derived from its own rows,
// which is the only way to show a shape nobody has enumerated in advance.
//
// The list, the record card, the detail drawer and the screenshot lightbox now
// live in components/infringement/ResultsView.tsx, because the single-platform
// screen renders exactly the same ones — see the note at the top of that file
// for what the two copies had drifted into saying differently. What is left here
// is this screen's own job: asking several platforms at once and tabbing between
// their answers.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from '@/lib/router'
import Breadcrumb from '@/components/ui/Breadcrumb'
import { useMasterData } from '@/lib/masterDataContext'
import ReportLoader from '@/components/shared/ReportLoader'
import {
  categorizePlatforms, platformLabel, type PlatformCategoryKey,
} from '@/lib/platformCategories'
import {
  PlatformTable, DetailDrawer, ScreenshotPreview, type PlatformResult,
} from '@/components/infringement/ResultsView'

/** Platforms in the catalogue that are not searchable yet — see the search page.
    Included here so a category holding one does not report it as a failure. */
const COMING_SOON = new Set(['torrent'])
export default function CategoryResultsPage({ category }: { category: string }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { platforms } = useMasterData()

  const startDate = searchParams.get('startDate') || ''
  const endDate   = searchParams.get('endDate') || ''
  const assetName = searchParams.get('assetName') || ''

  const [results, setResults] = useState<PlatformResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  // Upstream pages are fetched one at a time across every platform at once, the
  // same way the single-platform page does it.
  const [apiPage, setApiPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  // The screenshot being viewed full size, if any.
  const [preview, setPreview] = useState('')
  // The row whose full details are open in the side drawer.
  const [detail, setDetail] = useState<{ row: Record<string, any>; platform: string } | null>(null)

  /* One Escape handler for both overlays, closing the top one only: the
     screenshot sits above the detail drawer, so dismissing a picture must not
     also throw away the row it was opened from. */
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

  const categories = useMemo(() => categorizePlatforms(platforms), [platforms])
  const cat = categories.find(c => c.key === (category as PlatformCategoryKey))
  const catLabel = cat?.label ?? category

  /* The searchable platforms in this category. The grouping is the browser's
     (lib/platformCategories.ts), so the list is worked out here and sent — the
     server validates each name rather than holding a second copy of the
     vocabulary that could drift from this one. */
  const keys = useMemo(
    () => (cat?.platforms ?? []).map(p => p.key).filter(k => !COMING_SOON.has(k.trim().toLowerCase())),
    [cat])

  const fetchPage = useCallback(async (pageNo: number, append: boolean) => {
    if (keys.length === 0) return
    append ? setLoadingMore(true) : setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/infringement/category', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platforms: keys, startDate, endDate, assetName, page: pageNo }),
      })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to load data'); return }
      const incoming: PlatformResult[] = data.data?.platforms ?? []
      setResults(prev => append
        ? prev.map(p => {
            const more = incoming.find(i => i.platform === p.platform)
            return more ? { ...p, items: [...p.items, ...more.items], error: more.error } : p
          })
        : incoming)
      setApiPage(pageNo)
    } catch (e: any) {
      setError(e.message)
    } finally {
      append ? setLoadingMore(false) : setLoading(false)
    }
  }, [keys, startDate, endDate, assetName])

  useEffect(() => {
    // Master data arrives asynchronously; until it does there is no platform
    // list to search and the effect would fire against an empty category.
    if (keys.length === 0) return
    setResults([])
    fetchPage(1, false)
  }, [keys, fetchPage])

  /* Display names come from master data — the server works in the lowercase
     keys MarkScan's endpoints take, and "facebook" is a wire value, not a name
     to show a client. A platform master data does not know still gets a readable
     label rather than its raw key. */
  const labelOf = useCallback((key: string) => {
    const hit = platforms.find(p => p.key.trim().toLowerCase() === key.trim().toLowerCase())
    if (hit) return platformLabel(hit.label || hit.key)
    const mapped = platformLabel(key)
    return mapped === key ? key.replace(/\b\w/g, c => c.toUpperCase()) : mapped
  }, [platforms])

  const withRows  = results.filter(r => !r.error && r.items.length > 0)
  const totalRows = withRows.reduce((a, r) => a + r.items.length, 0)
  // "Load more" is only meaningful while some platform is still returning rows.
  const canLoadMore = withRows.length > 0 && !loading

  /* One tab per platform, one table at a time. Stacked, the tables ran to a
     dozen screens and every one of them had different columns, so scrolling
     between two meant losing the header you were comparing against.

     The tab that opens is the first with rows: a category where two platforms
     hit and ten did not should not open on an empty one. */
  const [active, setActive] = useState('')
  useEffect(() => {
    setActive(cur => {
      if (results.length === 0) return ''
      // A tab that survived the refetch stays open — "load more" must not throw
      // the reader back to the first platform.
      if (results.some(r => r.platform === cur)) return cur
      return (results.find(r => !r.error && r.items.length > 0) ?? results[0]).platform
    })
  }, [results])

  const activeResult = results.find(r => r.platform === active) ?? null

  return (
    <div className="fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <Breadcrumb items={[
          { label: 'Find Infringements', href: '/infringement' },
          { label: catLabel },
        ]} />
        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A]">{catLabel}</h1>
          <p className="text-brand-muted text-sm">
            {keys.length} platform{keys.length === 1 ? '' : 's'} searched
            {totalRows > 0 && <> · {totalRows.toLocaleString()} rows</>}
          </p>
        </div>
      </div>

      {/* What was asked for, in words — the page has no filter controls of its
          own, so the criteria have to be visible or a stale tab is unreadable. */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        {[
          assetName && { k: 'Asset', v: assetName },
          (startDate || endDate) && { k: 'Dates', v: `${startDate || 'any'} → ${endDate || 'any'}` },
        ].filter(Boolean).map((c: any) => (
          <span key={c.k} className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg
            bg-[#14254A]/5 text-[#14254A]">
            <span className="opacity-50">{c.k}:</span> {c.v}
          </span>
        ))}
        <button onClick={() => router.push('/infringement')}
          className="text-[11px] font-bold text-gray-400 hover:text-[#FC934C] ml-auto">
          ← Change search
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 px-5 text-center">
          <ReportLoader
            size={150}
            label="Searching"
            sublabel={`${keys.length} platform${keys.length === 1 ? '' : 's'}`}
          />
        </div>
      ) : results.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 px-5 py-12 text-center">
          <p className="font-bold text-[#14254A]">Nothing to search</p>
          <p className="text-sm text-gray-400 mt-1">
            No searchable platform is configured under {catLabel}.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Every platform is a tab, including the ones that returned nothing
              and the ones that failed — "no results" and "could not be searched"
              are different answers, and a client reading a category report needs
              to see which platforms were actually covered. Each tab carries its
              own count, so the whole picture is readable without opening one. */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-2 overflow-x-auto">
            <div className="flex items-center gap-1.5 min-w-max" role="tablist"
              aria-label="Platforms searched">
              {results.map(r => {
                const on = r.platform === active
                const failed = !!r.error
                const empty = !failed && r.items.length === 0
                return (
                  <button key={r.platform} role="tab" aria-selected={on}
                    onClick={() => setActive(r.platform)}
                    title={failed ? r.error : `${r.items.length} row${r.items.length === 1 ? '' : 's'}`}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold
                      whitespace-nowrap transition-all border ${
                      on
                        ? 'bg-[#14254A] text-white border-[#14254A] shadow-sm'
                        : failed
                          ? 'border-red-200 text-red-600 hover:bg-red-50'
                          : empty
                            ? 'border-gray-100 text-gray-400 hover:text-[#14254A] hover:border-gray-200'
                            : 'border-gray-200 text-[#14254A] hover:border-[#FC934C]/50 hover:bg-[#FC934C]/[0.06]'
                    }`}>
                    {labelOf(r.platform)}
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full tabular-nums ${
                      on ? 'bg-white/15 text-white'
                        : failed ? 'bg-red-100 text-red-600'
                        : 'bg-[#14254A]/[0.07] text-[#14254A]/60'}`}>
                      {failed ? '!' : r.items.length.toLocaleString()}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {activeResult && (
            /* Keyed on the platform so switching tabs starts the new table at
               page one rather than inheriting a page number that meant something
               on a different result set. */
            <PlatformTable key={activeResult.platform} result={activeResult}
              label={labelOf(activeResult.platform)} onPreview={setPreview}
              /* Per PLATFORM, not per category. The download service takes one
                 platform, and the tab on screen is the one the reader means —
                 requesting the whole category from a button sitting above one
                 platform's rows would deliver something nobody asked for. */
              download={{ platform: activeResult.platform, assetName, startDate, endDate }}
              onOpenRow={row => setDetail({ row, platform: labelOf(activeResult.platform) })} />
          )}

          {canLoadMore && (
            <div className="text-center">
              <button onClick={() => fetchPage(apiPage + 1, true)} disabled={loadingMore}
                className="px-5 py-2 rounded-xl text-xs font-bold border border-dashed border-gray-300
                  text-gray-500 hover:border-[#FC934C] hover:text-[#FC934C] transition-all disabled:opacity-50">
                {loadingMore ? 'Loading…' : `Load page ${apiPage + 1} from every platform`}
              </button>
            </div>
          )}
        </div>
      )}

      {detail && (
        <DetailDrawer row={detail.row} platform={detail.platform}
          onClose={() => setDetail(null)} onPreview={setPreview} />
      )}

      <ScreenshotPreview src={preview} onClose={() => setPreview('')} />
    </div>
  )
}
