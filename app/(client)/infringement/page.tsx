'use client'

import { useMemo, useState } from 'react'
import { useRouter } from '@/lib/router'
import { PLATFORM_PAGE_MAP } from '@/lib/platformMap'
import type { Platform } from '@/lib/types'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DateRangePicker, { type DateRange } from '@/components/ui/DateRangePicker'
import Breadcrumb from '@/components/ui/Breadcrumb'
import Portal from '@/components/ui/Portal'
import { useMasterData } from '@/lib/masterDataContext'
import {
  categorizePlatforms, categoryOf, platformLabel, isOpenWebPlatform, OPEN_WEB_URL_TYPES,
  ALL_PLATFORMS_CATEGORY, type PlatformCategoryKey, type OpenWebUrlType,
} from '@/lib/platformCategories'

// Platforms visible in the catalogue but not yet searchable — clicking them
// shows a "Coming Soon" notice instead of running a search.
const COMING_SOON_PLATFORMS = ['torrent']
const isComingSoon = (key: string) => COMING_SOON_PLATFORMS.includes(key.trim().toLowerCase())

/**
 * Back to the top after picking a platform.
 *
 * The client shell scrolls its <main>, not the document (see ClientShell), so
 * window.scrollTo has nothing left to move. Walking up to the nearest scrollable
 * ancestor stays correct in either arrangement instead of naming one of them.
 */
function scrollShellToTop(from: Element | null) {
  for (let el = from; el; el = el.parentElement) {
    const oy = window.getComputedStyle(el).overflowY
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
      el.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
  }
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

export default function InfringementPage() {
  const router = useRouter()

  const [platform,  setPlatform]  = useState('')
  const [range,     setRange]     = useState<DateRange>({ from: '', to: '' })
  const [assetName, setAssetName] = useState('')
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [comingSoon, setComingSoon] = useState<string | null>(null)
  // Open Web only: those results mix host pages with the pages linking to them.
  const [urlType,   setUrlType]   = useState<OpenWebUrlType>('all')
  // '' = the whole catalogue, which is what this page showed before categories
  // existed; a category key narrows the tile grid below to that group.
  const [category,  setCategory]  = useState<PlatformCategoryKey | ''>('')
  // The category picker + platform tile grid below are opt-in — a reader who
  // just wants "every platform" (the default search anyway) never needs them
  // on screen at all. Off by default; purely a visibility toggle, so turning
  // it off again does not clear whatever category/platform was already chosen.
  const [showPlatforms, setShowPlatforms] = useState(false)

  const { platforms, assets } = useMasterData()

  // Display grouping only — every tile still carries the raw master-data key,
  // which is what the platform routes and the API expect.
  const categories = useMemo(() => categorizePlatforms(platforms), [platforms])
  const platformOptions = useMemo(
    () => platforms.map(p => ({ key: p.key, label: platformLabel(p.label || p.key) })),
    [platforms])
  const shown = useMemo(() => {
    if (!category) return platformOptions
    return categories.find(c => c.key === category)?.platforms ?? []
  }, [category, categories, platformOptions])
  const activeCatLabel = categories.find(c => c.key === category)?.label ?? 'All platforms'

  const selectedLabel = platformOptions.find(p => p.key === platform)?.label ?? ''
  const openWeb = category === 'open-web'
  /** What a category search would actually cover — the tiles marked "Soon" are
      in the catalogue but have no endpoint behind them yet. */
  const searchableInCategory = useMemo(() => shown.filter(p => !isComingSoon(p.key)), [shown])

  /**
   * Choosing a category chooses the platform too, when there is only one to
   * choose. Messenger is Telegram and Open Web is the whole open web; making
   * someone confirm a list of one is a click that carries no information.
   */
  function pickCategory(next: PlatformCategoryKey | '') {
    setCategory(next)
    setError('')
    setUrlType('all')
    const inCat = next ? (categories.find(c => c.key === next)?.platforms ?? []) : []
    setPlatform(inCat.length === 1 ? inCat[0].key : '')
  }

  /**
   * A tile sets BOTH controls, so the dropdowns never disagree with the grid.
   *
   * It only ever did that for Open Web. Picking Instagram set the platform and
   * left Category reading "Choose a category…", so the one thing a tile is for
   * ended in "Please choose a category" — the reader had already said which
   * platform they wanted, in the most specific way the page offers, and was
   * asked to say the broader thing as well.
   *
   * categoryOf is the same function categorizePlatforms buckets the grid with,
   * so the category set here is by construction the one whose tile was clicked.
   * A hand-written map would be a second opinion about which group a platform is
   * in, and the two would disagree the first time a platform moved.
   */
  function pickPlatform(key: string) {
    setPlatform(key)
    setError('')
    setCategory(categoryOf(key))
    /* The Open Web URL type has no meaning off Open Web — the form hides it and
       the search drops it. Cleared on the way out so it cannot be carried back
       in later as a stale choice nobody can see. */
    if (!isOpenWebPlatform(key)) setUrlType('all')
  }

  /**
   * A search runs one of three ways, narrowest first.
   *
   * With a platform chosen it is unchanged: one platform, its own page, the
   * columns that platform has always had.
   *
   * With a category chosen (and no platform within it) it is every searchable
   * platform under that category — unchanged from before, reachable now by
   * clicking a category card below rather than by a required dropdown.
   *
   * With neither chosen — the default now — it is EVERY searchable platform in
   * the catalogue, on the same category-results page ALL_PLATFORMS_CATEGORY
   * names specially. They cannot share a table: each upstream endpoint returns
   * its own shape, so one table would mean picking a lowest common denominator
   * and dropping the rest.
   */
  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (range.from) params.set('startDate', range.from)
      if (range.to)   params.set('endDate',   range.to)
      if (assetName) params.set('assetName', assetName)

      if (platform) {
        if (isComingSoon(platform)) { setComingSoon(platform); return }
        params.set('platform', platform)
        // Only meaningful for Open Web; every other platform has one kind of URL.
        if (openWeb && urlType !== 'all') params.set('urlType', urlType)
        const slug = PLATFORM_PAGE_MAP[platform as Platform] || platform.replace(/\s+/g, '-').toLowerCase()
        router.push(`/infringement/${slug}?${params}`)
        return
      }

      if (category) {
        if (searchableInCategory.length === 0) {
          setError(`No searchable platform under ${activeCatLabel} yet`)
          return
        }
        router.push(`/infringement/category/${category}?${params}`)
        return
      }

      // Nothing picked: every searchable platform, category or not.
      router.push(`/infringement/category/${ALL_PLATFORMS_CATEGORY}?${params}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fade-in">

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 sm:mb-6">
        <Breadcrumb items={[{ label: 'Find Infringements' }, { label: 'Infringement Search' }]} />
        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A]">Infringement Search</h1>
          <p className="text-brand-muted text-sm">Select an asset and date range to search every platform, or pick one below.</p>
        </div>
      </div>

      {/* Search form card */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden mb-6">
        <div className="h-1" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />
        <form onSubmit={handleSearch} className="p-5 sm:p-6">
          {error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-2.5 text-sm mb-4">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end gap-3 lg:gap-4">
            {/* Platform (a category — Open Web, UGC & Social Media, …) sits
                here now, a peer of Asset and Date Range rather than tucked
                into the Supported Platforms panel below. Choosing one there
                still narrows that panel's list to match (see `shown`). */}
            <div className="sm:col-span-1 lg:flex-[2] lg:min-w-[180px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Platform</label>
              <SearchableSelect
                options={categories.map(c => ({ key: c.key, label: c.label }))}
                value={category}
                onChange={v => pickCategory(v as PlatformCategoryKey | '')}
                placeholder="All platforms…"
                emptyLabel="– All platforms –" />
            </div>

            {/* No dependent Specific Platform / URL Type field here any more
                — the Supported Platforms panel below is the one place that
                choice is made now (as cards), not duplicated as a dropdown
                up here too. */}

            <div className="sm:col-span-1 lg:flex-[2] lg:min-w-[180px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Asset Name</label>
              <SearchableSelect options={assets} value={assetName} onChange={setAssetName} placeholder="All assets…" emptyLabel="– All assets –" />
            </div>
            {/* One control owning both ends of the range, with the presets a
                client actually reaches for — the same picker the reports page
                uses, so the two surfaces ask for a period the same way. */}
            <div className="sm:col-span-2 lg:flex-[2] lg:min-w-[230px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Date Range</label>
              <DateRangePicker value={range} onChange={setRange} />
            </div>
            <div className="sm:col-span-2 lg:flex-shrink-0">
              <button type="submit" disabled={loading}
                className="w-full lg:w-auto px-6 py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 flex items-center justify-center gap-2 whitespace-nowrap shadow-sm"
                style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Loading…
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                      <circle cx="11" cy="11" r="8"/><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35"/>
                    </svg>
                    Search
                  </>
                )}
              </button>
            </div>
          </div>

          {/* What the current selection will search, in words. The pill row that
              used to sit here is gone: it asked the same question as the URL Type
              dropdown above, and two controls for one value can disagree.

              Always shown now, not just once a category is picked: with
              neither a category nor a platform chosen, Search still runs — over
              everything — and that default is exactly the case most worth
              stating rather than leaving silent. */}
          <p className="text-[11px] text-gray-400 mt-3 pt-3 border-t border-gray-100">
            {category
              ? (openWeb
                  ? OPEN_WEB_URL_TYPES.find(t => t.key === urlType)?.hint
                  : platform
                    ? <>Searching <b className="text-[#14254A]">{selectedLabel}</b>.</>
                    : searchableInCategory.length > 0
                      /* Leaving the platform empty is a real search now, not a
                         missing answer — so the line says what it will do rather
                         than asking for one more click. */
                      ? <>Searching all <b className="text-[#14254A]">{searchableInCategory.length} {activeCatLabel}</b>{' '}
                          platform{searchableInCategory.length === 1 ? '' : 's'} — each one gets its own table,
                          because their results carry different fields. Pick a platform below for a single one.</>
                      : <>No searchable platform under {activeCatLabel} yet.</>)
              : <>Searching all <b className="text-[#14254A]">{searchableInCategory.length} platforms</b> — each
                  one gets its own table, because their results carry different fields. Pick a category or a
                  platform below to narrow it to one.</>}
          </p>
        </form>
      </div>

      {/* Platform catalogue, grouped by category */}
      {platforms.length > 0 && (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-sm font-bold text-[#14254A] flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
              Supported Platforms
            </h2>
            <div className="flex items-center gap-3">
              {showPlatforms && (
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[#14254A]/5 text-[#14254A]">
                  {openWeb ? `${OPEN_WEB_URL_TYPES.length} URL types` : `${shown.length} of ${platforms.length} platforms`}
                </span>
              )}
              {/* Off by default — see showPlatforms above. */}
              <button type="button" onClick={() => setShowPlatforms(s => !s)}
                aria-pressed={showPlatforms}
                className="flex items-center gap-2 text-xs font-semibold text-gray-500 hover:text-[#14254A] transition-colors">
                Filter by platform
                <span className={`relative flex-shrink-0 rounded-full transition-colors ${showPlatforms ? 'bg-[#FC934C]' : 'bg-gray-200'}`}
                  style={{ width: '34px', height: '19px' }}>
                  <span className={`absolute top-[2.5px] left-[2.5px] w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${showPlatforms ? 'translate-x-[15px]' : ''}`} />
                </span>
              </button>
            </div>
          </div>

          {/* ── Cards for the Platform field's current category: which URL
                 type for Open Web (it is one upstream platform, not a list of
                 them), or which specific platform for everything else. The
                 category picker that used to live here moved into the search
                 form above, so this panel only ever reflects that choice now,
                 never sets it — and it's the ONE place either of these two is
                 picked, not duplicated as a dropdown up there too. ── */}
          {showPlatforms && (
          <div className="p-5">
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">
              {openWeb ? 'URL Type' : activeCatLabel}
            </div>
            {openWeb ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {OPEN_WEB_URL_TYPES.map(t => {
                  const on = urlType === t.key
                  return (
                    <button key={t.key} type="button"
                      onClick={() => setUrlType(t.key)}
                      className={`relative text-left p-4 rounded-xl border-2 transition-all hover:-translate-y-0.5 hover:shadow-md ${
                        on ? 'border-[#14254A] bg-[#14254A]/5 shadow-sm' : 'border-gray-100 hover:border-[#FC934C]/50 hover:bg-orange-50/30'
                      }`}>
                      {on && (
                        <svg className="absolute top-3 right-3 w-4 h-4 text-[#14254A]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      <span className={`block text-sm font-bold ${on ? 'text-[#14254A]' : 'text-gray-700'}`}>{t.label}</span>
                      <span className="block text-xs text-gray-400 leading-snug mt-1">{t.hint}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {shown.map(p => {
                  const on = platform === p.key
                  const soon = isComingSoon(p.key)
                  return (
                    <button key={p.key} type="button"
                      onClick={e => {
                        if (soon) { setComingSoon(p.label); return }
                        pickPlatform(p.key); scrollShellToTop(e.currentTarget)
                      }}
                      className={`relative text-left p-4 rounded-xl border-2 transition-all hover:-translate-y-0.5 hover:shadow-md ${
                        on ? 'border-[#14254A] bg-[#14254A]/5 shadow-sm' : 'border-gray-100 hover:border-[#FC934C]/50 hover:bg-orange-50/30'
                      }`}>
                      {soon ? (
                        <span className="absolute top-3 right-3 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[#FC934C]/15 text-[#d97b2e] border border-[#FC934C]/30">
                          Soon
                        </span>
                      ) : on && (
                        <svg className="absolute top-3 right-3 w-4 h-4 text-[#14254A]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      <span className={`block text-sm font-bold truncate pr-5 ${on ? 'text-[#14254A]' : 'text-gray-700'}`}>{p.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          )}
        </div>
      )}

      {/* ── Coming Soon modal — portalled so the overlay covers the viewport and
             not just this page's content box (see components/ui/Portal) ── */}
      {comingSoon && (
        <Portal>
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 backdrop-blur-sm"
          style={{ background: 'rgba(20,37,74,0.55)' }}
          role="dialog" aria-modal="true"
          onClick={() => setComingSoon(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden fade-in"
            onClick={e => e.stopPropagation()}>
            <div className="h-1" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />
            <div className="p-7 text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center text-3xl"
                style={{ background: 'linear-gradient(135deg,#FC934C22,#14254A14)' }}>
                🚧
              </div>
              <h3 className="text-lg font-extrabold text-[#14254A]">Coming Soon</h3>
              <p className="text-sm text-gray-500 mt-2 leading-relaxed">
                <b className="text-[#14254A]">{comingSoon}</b> monitoring is under development
                and will be available on the platform shortly.
              </p>
              <p className="text-xs text-gray-400 mt-1.5">
                Stay tuned — we&apos;ll enable it here as soon as it&apos;s ready.
              </p>
              <button onClick={() => setComingSoon(null)}
                className="mt-6 px-8 py-2.5 rounded-xl font-bold text-white text-sm transition-all hover:opacity-90"
                style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                Got it
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}
    </div>
  )
}
