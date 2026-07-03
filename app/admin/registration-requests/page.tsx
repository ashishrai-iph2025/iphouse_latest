'use client'

import { useState, useEffect } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import PaginationBar from '@/components/admin/PaginationBar'
import PageLoader from '@/components/ui/PageLoader'

const PER_PAGE = 15

type Status = 'pending' | 'approved' | 'rejected'

interface RegistrationRequest {
  id: number
  first_name: string
  last_name: string
  email: string
  designation: string
  remarks: string
  status: Status
  created_at: string
}

const statusDot: Record<Status, string> = {
  pending:  'bg-amber-400',
  approved: 'bg-emerald-500',
  rejected: 'bg-red-400',
}

export default function RegistrationRequestsPage() {
  const [items,        setItems]        = useState<RegistrationRequest[]>([])
  const [total,        setTotal]        = useState(0)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [search,       setSearch]       = useState('')
  const [filterStatus, setFilterStatus] = useState<Status | 'all'>('all')
  const [page,         setPage]         = useState(1)
  const [actioning,    setActioning]    = useState(false)
  const [actionMsg,    setActionMsg]    = useState('')
  const [counts,       setCounts]       = useState({ pending: 0, approved: 0, rejected: 0 })

  // Confirm modal
  const [confirmTarget, setConfirmTarget] = useState<{ id: number; action: 'approved' | 'rejected'; name: string } | null>(null)

  // Remarks modal
  const [remarksText, setRemarksText] = useState('')

  const [allItems, setAllItems] = useState<RegistrationRequest[]>([])

  async function load() {
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/admin/registration-requests', { credentials: 'include' })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to load'); return }
      const rows: RegistrationRequest[] = data.requests || []
      setAllItems(rows)
      setCounts({
        pending:  rows.filter(r => r.status === 'pending').length,
        approved: rows.filter(r => r.status === 'approved').length,
        rejected: rows.filter(r => r.status === 'rejected').length,
      })
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  // Derive filtered + paginated items client-side
  const filtered = allItems.filter(r => {
    const matchStatus = filterStatus === 'all' || r.status === filterStatus
    const q = search.trim().toLowerCase()
    const matchSearch = !q || [r.first_name, r.last_name, r.email, r.designation].join(' ').toLowerCase().includes(q)
    return matchStatus && matchSearch
  })

  useEffect(() => {
    setTotal(filtered.length)
    setItems(filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE))
  }, [allItems, filterStatus, search, page])

  function handleSearch(q: string) { setSearch(q); setPage(1) }
  function handleStatus(s: Status | 'all') { setFilterStatus(s); setPage(1) }
  function handlePage(p: number) { setPage(p) }

  async function doAction() {
    if (!confirmTarget) return
    setActioning(true); setActionMsg('')
    try {
      const res  = await fetch('/api/admin/registrations', {
        credentials: 'include',
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ requestId: confirmTarget.id, action: confirmTarget.action }),
      })
      const data = await res.json()
      if (data.success) {
        setConfirmTarget(null)
        load()
      } else {
        setActionMsg(data.error || 'Action failed')
      }
    } finally { setActioning(false) }
  }

  return (
    <div className="fade-in py-6 px-4 sm:px-6 lg:px-8">
      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration', href: '/admin/configuration' }, { label: 'Registration Requests' }]}
        title="Registration Requests"
        description="Review and approve new user access requests"
        actions={counts.pending > 0 ? (
          <span className="px-2.5 py-1 text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 rounded-full">
            {counts.pending} pending
          </span>
        ) : undefined}
      />

      {/* Stat cards */}
      <div className="flex gap-3 mb-6">
        {(['pending', 'approved', 'rejected'] as Status[]).map(s => (
          <button key={s} onClick={() => handleStatus(filterStatus === s ? 'all' : s)}
            className={`text-left p-4 rounded-xl border transition-all w-36 ${
              filterStatus === s
                ? 'border-[#14254A]/30 bg-[#14254A]/5 shadow-sm'
                : 'border-gray-100 bg-white shadow-sm hover:border-gray-200'
            }`}>
            <p className="text-2xl font-bold text-[#14254A]">{counts[s]}</p>
            <p className="text-xs text-brand-muted mt-0.5 capitalize">{s}</p>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <svg className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input autoComplete="off" value={search} onChange={e => handleSearch(e.target.value)}
            placeholder="Search by name, email, designation…"
            className="w-full border border-gray-200 text-sm rounded-xl pl-9 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
        </div>
        {filterStatus !== 'all' && (
          <button onClick={() => handleStatus('all')}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 px-3 py-2 border border-gray-200 rounded-xl transition-colors">
            ✕ Clear filter
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <PageLoader />
      ) : error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-6 text-center">
          <p className="font-semibold">Error loading data</p>
          <p className="text-sm mt-1">{error}</p>
          <button onClick={() => load(page)} className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg text-sm">Retry</button>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  {['Name', 'Email', 'Designation', 'Remarks', 'Requested On', 'Status', 'Actions'].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map(r => (
                  <tr key={r.id}>
                    <td className="font-medium text-gray-800 text-sm">
                      {r.first_name} {r.last_name}
                    </td>
                    <td className="text-sm text-brand-muted">{r.email}</td>
                    <td className="text-sm text-gray-600">{r.designation || '—'}</td>
                    <td>
                      {r.remarks ? (
                        <button onClick={() => setRemarksText(r.remarks)}
                          className="px-2.5 py-1 text-xs border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors">
                          View
                        </button>
                      ) : (
                        <span className="text-brand-muted text-xs">—</span>
                      )}
                    </td>
                    <td className="text-xs text-brand-muted whitespace-nowrap">{r.created_at}</td>
                    <td>
                      <span className="inline-flex items-center gap-1.5 text-xs text-gray-700 capitalize">
                        <span className={`w-1.5 h-1.5 rounded-full ${statusDot[r.status]}`} />
                        {r.status}
                      </span>
                    </td>
                    <td>
                      {r.status === 'pending' && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setConfirmTarget({ id: r.id, action: 'approved', name: `${r.first_name} ${r.last_name}` })}
                            className="px-2.5 py-1 text-xs border border-gray-300 text-emerald-700 rounded-lg hover:bg-emerald-50 transition-colors">
                            Approve
                          </button>
                          <button
                            onClick={() => setConfirmTarget({ id: r.id, action: 'rejected', name: `${r.first_name} ${r.last_name}` })}
                            className="px-2.5 py-1 text-xs border border-gray-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors">
                            Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-brand-muted">
                      No requests match your criteria.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {total > PER_PAGE && (
            <div className="px-4 py-3 border-t border-gray-100">
              <PaginationBar page={page} total={total} perPage={PER_PAGE} onChange={handlePage} />
            </div>
          )}
        </div>
      )}

      {/* Remarks modal */}
      {remarksText && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4" style={{ background: '#14254A' }}>
              <h2 className="text-sm font-semibold text-white">User Remarks</h2>
              <button onClick={() => setRemarksText('')} className="text-white/60 hover:text-white text-xl leading-none">×</button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-700 leading-relaxed">{remarksText}</p>
            </div>
            <div className="flex justify-end px-6 py-4 border-t border-gray-100">
              <button onClick={() => setRemarksText('')}
                className="px-5 py-2 border border-gray-200 text-sm font-medium text-gray-700 rounded-xl hover:bg-gray-50">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm action modal */}
      {confirmTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-800 capitalize">
                {confirmTarget.action === 'approved' ? 'Approve' : 'Reject'} Registration
              </h2>
              <button onClick={() => { setConfirmTarget(null); setActionMsg('') }}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-600">
                {confirmTarget.action === 'approved'
                  ? <>Approve <strong>{confirmTarget.name}</strong> and send login credentials to their email?</>
                  : <>Reject the registration request from <strong>{confirmTarget.name}</strong>?</>
                }
              </p>
              {actionMsg && (
                <p className="mt-3 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{actionMsg}</p>
              )}
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button onClick={() => { setConfirmTarget(null); setActionMsg('') }}
                className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={doAction} disabled={actioning}
                className={`px-5 py-2.5 rounded-xl border text-sm font-medium disabled:opacity-60 transition-colors ${
                  confirmTarget.action === 'approved'
                    ? 'border-gray-300 text-emerald-700 hover:bg-emerald-50'
                    : 'border-gray-300 text-red-600 hover:bg-red-50'
                }`}>
                {actioning ? 'Processing…' : confirmTarget.action === 'approved' ? 'Approve' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
