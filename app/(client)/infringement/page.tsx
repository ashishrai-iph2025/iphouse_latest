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
  type PlatformCategoryKey, type OpenWebUrlType,
} from '@/lib/platformCategories'

const ICON_COLORS = ['#0078D4','#FC934C','#16A34A','#DC2626','#7C3AED','#F59E0B','#0891B2','#DB2777']

/** 14px line icon per category — lets the cards be scanned without reading. */
function CategoryIcon({ k }: { k: PlatformCategoryKey | 'all' }) {
  const p: Record<PlatformCategoryKey | 'all', React.ReactNode> = {
    'all':         <><circle cx="12" cy="12" r="9" /><path d="M12 7v10M7 12h10" /></>,
    'open-web':    <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" /></>,
    'social-ugc':  <><circle cx="9" cy="8" r="3" /><path d="M2.5 19a6.5 6.5 0 0 1 13 0" /><path d="m16 6 5 2.5-5 2.5z" /></>,
    'mobile-apps': <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>,
    'messenger':   <><path d="M21 4 3 11l5 2 2 6 4-4 5 3z" /></>,
    'other':       <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
      {p[k]}
    </svg>
  )
}

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
   * A search runs one of two ways.
   *
   * With a platform chosen it is unchanged: one platform, its own page, the
   * columns that platform has always had.
   *
   * Without one it is the whole category — every searchable platform under it,
   * on a page that keeps them apart. They cannot share a table: each upstream
   * endpoint returns its own shape, so one table would mean picking a lowest
   * common denominator and dropping the rest.
   */
  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!category) { setError('Please choose a category'); return }
    setError('')
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (range.from) params.set('startDate', range.from)
      if (range.to)   params.set('endDate',   range.to)
      if (assetName) params.set('assetName', assetName)

      if (!platform) {
        if (searchableInCategory.length === 0) {
          setError(`No searchable platform under ${activeCatLabel} yet`)
          return
        }
        router.push(`/infringement/category/${category}?${params}`)
        return
      }

      if (isComingSoon(platform)) { setComingSoon(platform); return }
      params.set('platform', platform)
      // Only meaningful for Open Web; every other platform has one kind of URL.
      if (openWeb && urlType !== 'all') params.set('urlType', urlType)
      const slug = PLATFORM_PAGE_MAP[platform as Platform] || platform.replace(/\s+/g, '-').toLowerCase()
      router.push(`/infringement/${slug}?${params}`)
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
          <p className="text-brand-muted text-sm">Select a platform and date range to fetch infringement data.</p>
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
            {/* Category first: it is the question a client actually has ("where
                was our content posted?"), and it narrows a 21-item platform list
                to a handful. */}
            <div className="sm:col-span-1 lg:flex-[2] lg:min-w-[170px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                Category <span className="text-[#FC934C]">*</span>
              </label>
              <SearchableSelect
                options={categories.map(c => ({ key: c.key, label: c.label }))}
                value={category}
                onChange={v => pickCategory(v as PlatformCategoryKey | '')}
                placeholder="Choose a category…" emptyLabel="– Choose a category –" />
            </div>

            {/* The dependent picker. It only exists once a category is chosen,
                and it is optional: Open Web defaults to both kinds of URL, and a
                category with a single platform has already filled it in. */}
            {category && (
              <div className="sm:col-span-1 lg:flex-[2] lg:min-w-[190px]">
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  {openWeb ? 'URL Type' : 'Platform'}
                  <span className="ml-1 font-semibold normal-case tracking-normal text-gray-300">optional</span>
                </label>
                {openWeb ? (
                  /* Open Web is one upstream platform carrying two kinds of URL,
                     so its dependent choice is which kind — not which platform. */
                  <SearchableSelect
                    options={OPEN_WEB_URL_TYPES.map(t => ({ key: t.key, label: t.label }))}
                    value={urlType}
                    onChange={v => setUrlType((v || 'all') as OpenWebUrlType)}
                    placeholder="All URLs" emptyLabel="– All URLs –" />
                ) : (
                  <SearchableSelect
                    options={shown}
                    value={platform}
                    onChange={pickPlatform}
                    placeholder={`All ${activeCatLabel}…`}
                    emptyLabel={`– ${activeCatLabel} –`} />
                )}
              </div>
            )}

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
              dropdown above, and two controls for one value can disagree. */}
          {category && (
            <p className="text-[11px] text-gray-400 mt-3 pt-3 border-t border-gray-100">
              {openWeb
                ? OPEN_WEB_URL_TYPES.find(t => t.key === urlType)?.hint
                : platform
                  ? <>Searching <b className="text-[#14254A]">{selectedLabel}</b>.</>
                  : searchableInCategory.length > 0
                    /* Leaving the platform empty is a real search now, not a
                       missing answer — so the line says what it will do rather
                       than asking for one more click. */
                    ? <>Searching all <b className="text-[#14254A]">{searchableInCategory.length} {activeCatLabel}</b>{' '}
                        platform{searchableInCategory.length === 1 ? '' : 's'} — each one gets its own table,
                        because their results carry different fields. Pick a platform above for a single one.</>
                    : <>No searchable platform under {activeCatLabel} yet.</>}
            </p>
          )}
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
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[#14254A]/5 text-[#14254A]">
              {shown.length} of {platforms.length} platforms
            </span>
          </div>

          {/* ── Category cards ── */}
          <div className="px-5 pt-5">
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Category</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {[{ key: '' as const, label: 'All platforms', count: platforms.length },
                ...categories.map(c => ({ key: c.key, label: c.label, count: c.platforms.length }))
              ].map(c => {
                const on = category === c.key
                return (
                  <button key={c.key || 'all'} type="button" onClick={() => pickCategory(c.key)}
                    aria-pressed={on}
                    className={`group text-left rounded-xl px-2.5 py-2 border transition-all ${
                      on
                        ? 'border-[#14254A] bg-[#14254A] shadow-md'
                        : 'border-[#14254A]/10 bg-white hover:border-[#FC934C]/50 hover:bg-[#FC934C]/[0.06]'
                    }`}>
                    <span className="flex items-center gap-1.5">
                      <span className={on ? 'text-[#FFC82B]' : 'text-[#14254A]/35 group-hover:text-[#FC934C]'}>
                        <CategoryIcon k={(c.key || 'all') as PlatformCategoryKey | 'all'} />
                      </span>
                      <span className={`text-[11px] font-bold leading-tight ${on ? 'text-white' : 'text-[#14254A]'}`}>
                        {c.label}
                      </span>
                    </span>
                    <span className={`mt-1 block text-[9px] font-semibold uppercase tracking-wide tabular-nums ${
                      on ? 'text-white/50' : 'text-gray-400'}`}>
                      {c.count} platform{c.count === 1 ? '' : 's'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* ── Platform tiles for the active category ── */}
          <div className="p-5">
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">
              {activeCatLabel}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
              {shown.map((p, i) => (
                <button
                  key={p.key}
                  onClick={e => {
                    if (isComingSoon(p.key)) { setComingSoon(p.label); return }
                    pickPlatform(p.key); scrollShellToTop(e.currentTarget)
                  }}
                  className={`relative flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:-translate-y-0.5 text-center group ${
                    platform === p.key
                      ? 'border-[#14254A] bg-[#14254A]/5 shadow-sm'
                      : 'border-gray-100 hover:border-[#FC934C]/50 hover:bg-orange-50/50'
                  }`}
                >
                  {isComingSoon(p.key) && (
                    <span className="absolute top-2 right-2 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[#FC934C]/15 text-[#d97b2e] border border-[#FC934C]/30">
                      Soon
                    </span>
                  )}
                  <span className={`w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold mb-2 shadow-sm ${isComingSoon(p.key) ? 'opacity-60' : ''}`}
                    style={{ background: ICON_COLORS[i % ICON_COLORS.length] }}>
                    {p.label.charAt(0).toUpperCase()}
                  </span>
                  <span className={`text-xs font-semibold leading-tight transition-colors ${
                    platform === p.key ? 'text-[#14254A]' : 'text-gray-600 group-hover:text-[#14254A]'
                  }`}>{p.label}</span>
                </button>
              ))}
            </div>
          </div>
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
