'use client'

// "Cache by report" — one section per report on the Cache & Redis tab: Sports,
// VOD, Traffic Analysis, Torrent Analysis. All four live in the one Redis the
// connection panel above configures; each section sees and steers only its own
// entries, and each offers cache on demand by client and period (≤ 1 year).

import { useEffect, useState } from 'react'
import SectionCachePanel from './SectionCachePanel'
import { AnalyticsSection } from '../AnalyticsCachePanel'

const SECTIONS = [
  { key: 'sports', label: 'Sports' },
  { key: 'vod', label: 'VOD' },
  { key: 'traffic', label: 'Traffic Analysis' },
  { key: 'torrent', label: 'Torrent Analysis' },
] as const
type Key = typeof SECTIONS[number]['key']

export default function CacheSections() {
  // Remembered per browser: the section someone works in is usually the same one.
  const [tab, setTab] = useState<Key>(() => {
    try { return (localStorage.getItem('cache-section') as Key) || 'sports' } catch { return 'sports' }
  })
  useEffect(() => { try { localStorage.setItem('cache-section', tab) } catch { /* private mode */ } }, [tab])

  return (
    <div className="space-y-3 mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold text-[#14254A]">Cache by report</h2>
        <p className="text-xs text-gray-500">Each report&rsquo;s cache on its own — what it holds, and caching on demand by client and period (at most 1 year).</p>
      </div>
      <div className="inline-flex flex-wrap rounded-xl border border-gray-200 overflow-hidden bg-white">
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => setTab(s.key)}
            className={`px-4 py-2 text-sm font-medium ${tab === s.key ? 'bg-[#14254A] text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
            {s.label}
          </button>
        ))}
      </div>
      {tab === 'sports' && <SectionCachePanel name="sports" label="Sports" />}
      {tab === 'vod' && <SectionCachePanel name="vod" label="VOD" />}
      {tab === 'traffic' && <AnalyticsSection scope="traffic" />}
      {tab === 'torrent' && <AnalyticsSection scope="torrent" />}
    </div>
  )
}
