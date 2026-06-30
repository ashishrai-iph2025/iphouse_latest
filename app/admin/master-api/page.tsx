'use client'

import { useState, useEffect } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'

interface Row { [key: string]: unknown }

export default function MasterApiPage() {
  const [platforms, setPlatforms] = useState<Row[]>([])
  const [assets,    setAssets]    = useState<Row[]>([])
  const [syncedAt,  setSyncedAt]  = useState<number | null>(null)
  const [syncing,   setSyncing]   = useState(false)
  const [tab,       setTab]       = useState<'platforms' | 'assets'>('platforms')
  const [error,     setError]     = useState('')

  useEffect(() => {
    fetch('/api/admin/master-api', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          const items = d.items || []
          setPlatforms(items.filter((r: Row) => (r.type as string) === 'platform' || !r.type))
          setAssets(items.filter((r: Row) => (r.type as string) === 'asset'))
          setSyncedAt(d.syncedAt || null)
        }
      })
      .catch(() => {})
  }, [])

  async function syncNow() {
    setSyncing(true)
    setError('')
    try {
      const res  = await fetch('/api/admin/master-api', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        setPlatforms(data.platforms || [])
        setAssets(data.assets || [])
        setSyncedAt(data.syncedAt)
      } else {
        setError(data.error || 'Sync failed')
      }
    } catch {
      setError('Network error during sync')
    } finally {
      setSyncing(false)
    }
  }

  const rows = tab === 'platforms' ? platforms : assets
  const cols  = rows.length > 0 ? Object.keys(rows[0]) : []

  return (
    <div className="p-6 fade-in">
      <AdminPageHeader
        backHref="/admin/configuration"
        breadcrumb={[{ label: 'Master API Data' }]}
        title="Master API Data"
        description={`Platforms and assets synced from IP House API${syncedAt ? ` — Last synced: ${new Date(syncedAt).toLocaleString()}` : ''}`}
        actions={
          <button onClick={syncNow} disabled={syncing}
            className="px-5 py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60 transition-all"
            style={{ background: '#14254A' }}>
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm mb-5">
          {error}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-2xl p-5 shadow-card border border-gray-100">
          <p className="text-3xl font-bold text-[#14254A]">{platforms.length}</p>
          <p className="text-xs text-brand-muted mt-1">Platforms</p>
        </div>
        <div className="bg-white rounded-2xl p-5 shadow-card border border-gray-100">
          <p className="text-3xl font-bold text-[#14254A]">{assets.length}</p>
          <p className="text-xs text-brand-muted mt-1">Assets</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        {(['platforms', 'assets'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors capitalize
              ${tab === t ? 'text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
            style={tab === t ? { background: '#14254A' } : {}}
          >
            {t} ({t === 'platforms' ? platforms.length : assets.length})
          </button>
        ))}
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <div className="bg-white rounded-2xl p-10 text-center shadow-card border border-gray-100">
          <p className="text-brand-muted text-sm">
            {syncedAt ? `No ${tab} data found.` : 'Click "Sync Now" to load data from IP House API.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  {cols.map(c => (
                    <th key={c}>{c.replace(/_/g, ' ').toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    <td className="text-xs text-brand-muted">{i + 1}</td>
                    {cols.map(c => (
                      <td key={c} className="text-xs text-gray-700 max-w-xs truncate">
                        {String(row[c] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
