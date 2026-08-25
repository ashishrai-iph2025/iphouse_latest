'use client'

import { useState } from 'react'
import Breadcrumb from '@/components/ui/Breadcrumb'
import { platformLabel } from '@/lib/platformCategories'

const WIDE_LABELS = new Set([
  'source url', 'infringing url', 'video url', 'profile url',
])

const INTERNET_FIELDS: [string, string[]][] = [
  ['Asset Name',        ['assetName',           'AssetName']],
  ['Host URL',          ['sourceURL',            'SourceURL',         'sourceUrl']],
  ['Host Domain',       ['sourceDomain',         'SourceDomain']],
  ['Linking URL',       ['infringingURL',        'InfringingURL',     'infringingUrl']],
  ['Linking Domain',    ['infringingDomain',     'InfringingDomain']],
  ['Infringement Type', ['infringementType',     'InfringementType']],
  ['Quality of Print',  ['qualityOfPrint',       'QualityOfPrint']],
  ['Country',           ['country',              'Country']],
  ['Upload Date',       ['urlUploadDate',        'URLUploadDate']],
  ['Removal Status',    ['removalStatus',        'RemovalStatus']],
  ['Removal Time',      ['removalTime',          'removed_at']],
  ['De-Indexed Status', ['delistingremovalstatus']],
  ['De-Indexing Time',  ['delistingTime']],
  ['DMCA Status',       ['dmcaremovalstatus']],
  ['DMCA Removal Time', ['dmcaRemovalTime']],
  ['Search Engine',     ['searchEngine']],
  ['Language',          ['audioLanguage',        'AudioLanguage']],
  ['Media File',        ['videoURL',             'VideoURL']],
]

const SOCIAL_FIELDS: [string, string[]][] = [
  ['Asset Name',        ['assetName',       'AssetName']],
  ['Platform',          ['platform',        'Platform']],
  ['Media File',        ['videoURL',        'VideoURL']],
  ['Profile URL',       ['profileURL',      'ProfileURL']],
  ['Media File Title',  ['videoTitle',      'VideoTitle']],
  ['Like Count',        ['likeCount',       'LikeCount',       'like_count']],
  ['Subscriber Count',  ['subscriberCount', 'SubscriberCount', 'subscrbers']],
  ['Views Count',       ['viewCount',       'ViewCount',       'views']],
  ['Comment Count',     ['commentCount',    'CommentCount',    'comment_count']],
  ['Season',            ['season',          'Season']],
  ['Episode',           ['episode',         'Episode']],
  ['Language',          ['language',        'Language',        'audioLanguage']],
  ['Country',           ['country',         'Country']],
  ['Infringement Type', ['infringementType','InfringementType']],
  ['Quality of Print',  ['qualityOfPrint',  'QualityOfPrint']],
  ['Removal Status',    ['removalStatus',   'RemovalStatus']],
  ['Upload Date',       ['uploadDate',      'UploadDate',      'urlUploadDate']],
]

function pick(obj: any, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k]
    if (v != null && String(v).trim() !== '' && String(v) !== 'null') return String(v)
  }
  return ''
}

/* The search is by URL alone — no platform is chosen, so the shape of the answer
   has to be read off the record that comes back. Open Web rows are the ones that
   carry a host/linking pair or the delisting columns; everything else is a
   social/UGC row. */
function looksOpenWeb(result: any): boolean {
  if (!result) return false
  if (/internet|open web/i.test(pick(result, ['platform', 'Platform']))) return true
  const openWebOnly = [
    ['sourceURL', 'SourceURL', 'sourceUrl'],
    ['sourceDomain', 'SourceDomain'],
    ['infringingURL', 'InfringingURL', 'infringingUrl'],
    ['infringingDomain', 'InfringingDomain'],
    ['delistingremovalstatus'],
    ['dmcaremovalstatus'],
    ['searchEngine'],
  ]
  return openWebOnly.some(keys => pick(result, keys) !== '')
}

export default function SearchPage() {
  const [url,     setUrl]     = useState('')
  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState<any>(null)
  const [error,   setError]   = useState('')

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) { setError('Please enter a URL.'); return }
    setError(''); setResult(null); setLoading(true)
    try {
      // URL only. The platform and host/linking flags the endpoint also accepts
      // are left unset, so it resolves the record from the URL itself.
      const res  = await fetch('/api/search', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: url.trim() }),
      })
      const data = await res.json()
      if (data.success) setResult(data.data)
      else setError(data.error || 'No results found or API error')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const fields = looksOpenWeb(result) ? INTERNET_FIELDS : SOCIAL_FIELDS
  const rows = result
    ? fields.map(([label, keys]) => {
        const value = pick(result, keys)
        // The platform the record names is shown by its display name too.
        return { label, value: label === 'Platform' ? platformLabel(value) : value }
      })
    : []
  // Label the result with whatever the record says it is.
  const foundPlatform = result ? platformLabel(pick(result, ['platform', 'Platform'])) : ''

  return (
    <div className="fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 sm:mb-6">
        <Breadcrumb items={[{ label: 'Find Infringements', href: '/infringement' }, { label: 'Search & Retrieve' }]} />
        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A]">Search &amp; Retrieve</h1>
          <p className="text-brand-muted text-sm">Look up an infringement record by its URL.</p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-5 lg:items-start">

        {/* ── Left Panel ── */}
        <div className="w-full lg:w-72 xl:w-80 lg:flex-shrink-0 bg-white rounded-2xl border border-gray-100 shadow-card lg:self-start lg:sticky lg:top-5">
          <div className="h-1 rounded-t-2xl" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />

          <div className="p-5">
            {/* Panel header */}
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#14254A,#FC934C)' }}>
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="8"/><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35"/>
                </svg>
              </div>
              <div>
                <div className="font-bold text-[#14254A] text-sm">Search &amp; Retrieve</div>
                <div className="text-[10px] text-gray-400">Query platform metadata</div>
              </div>
            </div>

            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4">Query Parameters</div>

            <form onSubmit={handleSearch} className="flex flex-col gap-4">
              {/* Target URL */}
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Target URL <span className="text-red-400">*</span>
                </label>
                <textarea
                  required
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  rows={4}
                  placeholder="https://example.com/content/…"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A] resize-none"
                />
                <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">
                  The platform is resolved from the URL — nothing else to pick.
                </p>
              </div>

              <button type="submit" disabled={loading}
                className="w-full py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 flex items-center justify-center gap-2"
                style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                {loading
                  ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Analyzing…</>
                  : <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35"/></svg>Run Analysis</>
                }
              </button>
            </form>
          </div>
        </div>

        {/* ── Right Panel ── */}
        <div className="flex-1 min-w-0 rounded-2xl border border-gray-100 shadow-card overflow-hidden min-h-[300px] lg:min-h-[520px]">
          {!result && !error && !loading && (
            <div className="flex flex-col items-center justify-center min-h-[520px] gap-3 text-center p-10">
              <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 grid place-items-center text-2xl text-gray-400">
                ⬡
              </div>
              <p className="font-bold text-gray-800 text-base">Awaiting Input</p>
              <p className="text-sm text-gray-400 max-w-[240px] leading-relaxed">
                Paste a URL and run an analysis to extract its platform metadata.
              </p>
            </div>
          )}

          {loading && (
            <div className="flex flex-col items-center justify-center min-h-[520px] gap-4">
              <span className="w-10 h-10 border-[3px] border-gray-200 border-t-blue-500 rounded-full animate-spin" />
              <p className="font-bold text-gray-800 text-sm">Analyzing URL</p>
              <p className="text-xs text-gray-400">Fetching metadata from platform…</p>
            </div>
          )}

          {error && !loading && (
            <div className="m-5 flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
              <span className="mt-0.5 flex-shrink-0">✕</span>
              <span><strong>Error:</strong> {error}</span>
            </div>
          )}

          {result && !loading && (
            <>
              <div className="flex items-center justify-between flex-wrap gap-2 px-5 py-3.5 border-b border-white/10" style={{ background: '#14254A' }}>
                <div>
                  <p className="text-sm font-bold text-white">Analysis Results</p>
                  <p className="text-[11px] text-white/40 mt-0.5">{rows.length} metadata fields extracted</p>
                </div>
                {foundPlatform && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-orange-400 text-white text-[11px] font-bold uppercase tracking-wide">
                    <span className="w-1.5 h-1.5 rounded-full bg-white/60 inline-block" />
                    {foundPlatform}
                  </span>
                )}
              </div>

              <div className="p-5">
                <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                  {rows.map(({ label, value }) => {
                    const isEmpty = !value
                    const isUrl   = value.startsWith('http://') || value.startsWith('https://')
                    const isWide  = WIDE_LABELS.has(label.toLowerCase())
                    return (
                      <div
                        key={label}
                        className="bg-gray-50 border border-gray-100 rounded-lg p-3 hover:border-blue-300 hover:shadow-sm transition-all overflow-hidden"
                        style={isWide ? { gridColumn: '1 / -1' } : {}}
                      >
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1 truncate">{label}</p>
                        {isEmpty ? (
                          <p className="text-xs text-gray-300 italic">—</p>
                        ) : isUrl ? (
                          <a
                            href={value}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline break-all leading-relaxed"
                          >
                            {value}
                          </a>
                        ) : (
                          <p className="text-xs text-gray-800 font-mono leading-relaxed break-words">{value}</p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
