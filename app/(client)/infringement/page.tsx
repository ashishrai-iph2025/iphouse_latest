'use client'

import { useState } from 'react'
import { useRouter } from '@/lib/router'
import { PLATFORM_PAGE_MAP } from '@/lib/platformMap'
import type { Platform } from '@/lib/types'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DatePicker from '@/components/ui/DatePicker'
import Breadcrumb from '@/components/ui/Breadcrumb'
import { useMasterData } from '@/lib/masterDataContext'

const ICON_COLORS = ['#0078D4','#FC934C','#16A34A','#DC2626','#7C3AED','#F59E0B','#0891B2','#DB2777']

export default function InfringementPage() {
  const router = useRouter()

  const [platform,  setPlatform]  = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate,   setEndDate]   = useState('')
  const [assetName, setAssetName] = useState('')
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')

  const { platforms, assets } = useMasterData()

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!platform) { setError('Please select a platform'); return }
    setError('')
    setLoading(true)
    try {
      const params = new URLSearchParams({ platform })
      if (startDate) params.set('startDate', startDate)
      if (endDate)   params.set('endDate',   endDate)
      if (assetName) params.set('assetName', assetName)
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
            <div className="sm:col-span-1 lg:flex-[2] lg:min-w-[180px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Platform *</label>
              <SearchableSelect options={platforms} value={platform} onChange={setPlatform} placeholder="Select platform…" emptyLabel="– Select platform –" />
            </div>
            <div className="sm:col-span-1 lg:flex-[2] lg:min-w-[180px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Asset Name</label>
              <SearchableSelect options={assets} value={assetName} onChange={setAssetName} placeholder="All assets…" emptyLabel="– All assets –" />
            </div>
            <div className="lg:flex-1 lg:min-w-[140px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Start Date</label>
              <DatePicker value={startDate} onChange={setStartDate} placeholder="Start date" />
            </div>
            <div className="lg:flex-1 lg:min-w-[140px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">End Date</label>
              <DatePicker value={endDate} onChange={setEndDate} placeholder="End date" min={startDate} />
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
        </form>
      </div>

      {/* Platform grid */}
      {platforms.length > 0 && (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-bold text-[#14254A] flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
              Supported Platforms
            </h2>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[#14254A]/5 text-[#14254A]">
              {platforms.length} platforms
            </span>
          </div>
          <div className="p-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
              {platforms.map((p, i) => (
                <button
                  key={p.key}
                  onClick={() => { setPlatform(p.key); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                  className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all hover:-translate-y-0.5 text-center group ${
                    platform === p.key
                      ? 'border-[#14254A] bg-[#14254A]/5 shadow-sm'
                      : 'border-gray-100 hover:border-[#FC934C]/50 hover:bg-orange-50/50'
                  }`}
                >
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold mb-2 shadow-sm"
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
    </div>
  )
}
