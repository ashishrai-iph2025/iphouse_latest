'use client'

// /admin/war-room-assets — per-client War Room configuration.
// Currently one switch per client: whether the Asset Comparison tab is
// visible on that client's /war-room page (default off).
//
// Table layout mirrors the Shared Login Accounts (Registrations) page.

import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'

interface ClientRow {
  userId: number
  name: string
  email: string
  comparison_enabled: number
}

const PER_PAGE = 15

export default function WarRoomAssetsPage() {
  const [clients, setClients] = useState<ClientRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [busy,    setBusy]    = useState<number | null>(null)
  const [search,  setSearch]  = useState('')
  const [page,    setPage]    = useState(1)
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [sortCol, setSortCol] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const searchRef = useRef<HTMLInputElement>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/warroom-settings', { credentials: 'include' })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to load'); return }
      setClients(data.clients || [])
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  function handleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  function si(col: string): JSX.Element {
    if (sortCol !== col) return <span className="ml-1 opacity-40 text-[10px]">↕</span>
    return <span className="ml-1 text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }
  function sortRows(arr: ClientRow[]): ClientRow[] {
    if (!sortCol) return arr
    return [...arr].sort((a, b) => {
      const av = (a as any)[sortCol] ?? ''
      const bv = (b as any)[sortCol] ?? ''
      const cmp = (typeof av === 'number' && typeof bv === 'number')
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }

  const filtered = clients.filter(c =>
    String(c.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
    String(c.email ?? '').toLowerCase().includes(search.toLowerCase())
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const paginated  = sortRows(filtered).slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
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
        showToast(`Asset Comparison ${next ? 'enabled' : 'disabled'} for ${c.name || c.email}`)
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

      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <Link to="/admin/configuration" className="text-brand-muted hover:text-[#FC934C] text-xs font-medium">← Configuration</Link>
          <h1 className="text-2xl font-bold text-[#14254A] mt-1">War Room Assets</h1>
          <p className="text-brand-muted text-sm mt-1">
            {clients.length} client{clients.length !== 1 ? 's' : ''} · Asset Comparison enabled for {enabledCount}
          </p>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-[#14254A]">{filtered.length} account{filtered.length !== 1 ? 's' : ''}</span>
          <input ref={searchRef} type="text" placeholder="Search by client name or email…"
            value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-64 focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-gray-100 border-t-[#14254A] rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="text-center py-12 text-red-500 text-sm">{error}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('name')}>Client<>{si('name')}</></th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('email')}>Email<>{si('email')}</></th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('comparison_enabled')}>Asset Comparison Tab<>{si('comparison_enabled')}</></th>
                </tr>
              </thead>
              <tbody>
                {paginated.length === 0 ? (
                  <tr><td colSpan={4} className="text-center py-10 text-brand-muted">No clients found</td></tr>
                ) : paginated.map((c, i) => {
                  const on = Number(c.comparison_enabled) === 1
                  return (
                    <tr key={c.userId}>
                      <td className="text-xs text-gray-400">{(safePage - 1) * PER_PAGE + i + 1}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-white text-xs shrink-0"
                            style={{ background: 'linear-gradient(135deg,#0078D4,#004E8C)' }}>
                            {((c.name || 'U').charAt(0)).toUpperCase()}
                          </div>
                          <p className="text-sm font-medium text-gray-800">{c.name || '—'}</p>
                        </div>
                      </td>
                      <td><code className="text-xs bg-gray-100 px-2 py-0.5 rounded font-mono">{c.email || '—'}</code></td>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <button onClick={() => toggle(c)} disabled={busy === c.userId}
                            role="switch" aria-checked={on} title={on ? 'Comparison tab visible' : 'Comparison tab hidden'}
                            className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors disabled:opacity-50 flex-shrink-0 ${on ? 'bg-emerald-500' : 'bg-gray-200'}`}>
                            <span className={`inline-block w-[18px] h-[18px] bg-white rounded-full shadow transform transition-transform ${on ? 'translate-x-[24px]' : 'translate-x-[3px]'}`} />
                          </button>
                          <span className={`text-xs font-semibold ${on ? 'text-emerald-600' : 'text-gray-400'}`}>
                            {busy === c.userId ? 'Saving…' : on ? 'Visible' : 'Hidden'}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {!loading && !error && filtered.length > PER_PAGE && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 text-xs text-gray-500">
            <span>
              Showing {filtered.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(1)} disabled={safePage === 1}
                className="px-2 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">«</button>
              <button onClick={() => setPage(p => p - 1)} disabled={safePage === 1}
                className="px-2 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">‹</button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
                .reduce<(number | '...')[]>((acc, p, idx, arr) => {
                  if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push('...')
                  acc.push(p); return acc
                }, [])
                .map((p, idx) => p === '...'
                  ? <span key={`e${idx}`} className="px-2">…</span>
                  : <button key={p} onClick={() => setPage(p as number)}
                      className={`px-2.5 py-1 rounded border text-xs font-medium transition-colors ${safePage === p ? 'bg-[#14254A] text-white border-[#14254A]' : 'border-gray-200 hover:bg-gray-50'}`}>
                      {p}
                    </button>
                )}
              <button onClick={() => setPage(p => p + 1)} disabled={safePage === totalPages}
                className="px-2 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">›</button>
              <button onClick={() => setPage(totalPages)} disabled={safePage === totalPages}
                className="px-2 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">»</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
