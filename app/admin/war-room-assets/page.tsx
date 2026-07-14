'use client'

// /admin/war-room-assets — per-client War Room configuration.
// Currently one switch per client: whether the Asset Comparison tab is
// visible on that client's /war-room page (default off).

import { useEffect, useMemo, useState } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import PaginationBar, { PER_PAGE } from '@/components/admin/PaginationBar'

interface ClientRow {
  userId: number
  name: string
  email: string
  comparison_enabled: number
}

export default function WarRoomAssetsPage() {
  const [clients, setClients] = useState<ClientRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState<number | null>(null)
  const [query,   setQuery]   = useState('')
  const [page,    setPage]    = useState(1)
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/warroom-settings', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setClients(data.clients || [])
    } catch { /* ignore */ }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return clients
    return clients.filter(c =>
      String(c.name ?? '').toLowerCase().includes(q) ||
      String(c.email ?? '').toLowerCase().includes(q))
  }, [clients, query])
  const pageRows = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const enabledCount = clients.filter(c => Number(c.comparison_enabled) === 1).length

  async function toggle(c: ClientRow) {
    const next = Number(c.comparison_enabled) !== 1
    setBusy(c.userId)
    try {
      const res = await fetch('/api/admin/warroom-settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: c.userId, comparisonEnabled: next }),
      })
      const data = await res.json()
      if (data.success) {
        setClients(prev => prev.map(x => x.userId === c.userId ? { ...x, comparison_enabled: next ? 1 : 0 } : x))
        showToast(`Asset Comparison ${next ? 'enabled' : 'disabled'} for ${c.name}`)
      } else {
        showToast(data.error || 'Update failed', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setBusy(null)
  }

  return (
    <div className="p-6 fade-in">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration', href: '/admin/configuration' }, { label: 'War Room Assets' }]}
        backHref="/admin/configuration"
        title="War Room Assets"
        description="Per-client War Room settings. Enable Asset Comparison to show the comparison tab on that client's War Room page."
      />

      {/* Summary + search */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-500">
          <span className="px-2.5 py-1 rounded-full bg-orange-50 border border-orange-200 text-[#d97b2e]">
            ⚖ Comparison enabled: {enabledCount}
          </span>
          <span className="px-2.5 py-1 rounded-full bg-gray-50 border border-gray-200">
            Clients: {clients.length}
          </span>
        </div>
        <input
          type="text" value={query}
          onChange={e => { setQuery(e.target.value); setPage(1) }}
          placeholder="Search client name or email…"
          className="w-full sm:w-72 border border-gray-200 rounded-xl px-3.5 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#14254A]/20"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                {['#', 'Client', 'Email', 'Asset Comparison Tab'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} className="text-center py-10 text-gray-400 text-sm">Loading…</td></tr>
              ) : pageRows.length === 0 ? (
                <tr><td colSpan={4} className="text-center py-10 text-gray-400 text-sm">No clients found.</td></tr>
              ) : pageRows.map((c, idx) => {
                const on = Number(c.comparison_enabled) === 1
                const rowNum = (page - 1) * PER_PAGE + idx + 1
                return (
                  <tr key={c.userId} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">{rowNum}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-[#14254A]">{c.name || '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{c.email || '—'}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => toggle(c)} disabled={busy === c.userId}
                        role="switch" aria-checked={on}
                        className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-emerald-500' : 'bg-gray-200'}`}>
                        <span className={`inline-block w-[18px] h-[18px] bg-white rounded-full shadow transform transition-transform ${on ? 'translate-x-[24px]' : 'translate-x-[3px]'}`} />
                      </button>
                      <span className={`ml-2.5 text-xs font-bold align-middle ${on ? 'text-emerald-600' : 'text-gray-400'}`}>
                        {busy === c.userId ? 'Saving…' : on ? 'Visible' : 'Hidden'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <PaginationBar page={page} total={filtered.length} onChange={setPage} />
      </div>
    </div>
  )
}
