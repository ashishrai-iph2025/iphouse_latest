'use client'

// /admin/client-admins — grant or revoke the Client Admin role.
//
// A Client Admin is an ordinary client login that may list and enable/disable
// the OTHER logins attached to the same client company. The grant is stored per
// (person × company) on dcp_user_login.is_client_admin, so the same person can
// administer one company while staying a normal user of another — each row
// below is one such pair.
//
// Deliberately not a value on the role ladder: RequireAdmin gates on role >= 1,
// so a numeric "Client Admin" role would have inherited portal-wide staff
// access. Admin/Super Admin keep full control; this page only hands out the
// company-scoped grant.

import { useEffect, useMemo, useState } from 'react'
import BackToConfiguration from '@/components/admin/BackToConfiguration'
import SearchableSelect from '@/components/ui/SearchableSelect'

interface LoginRow {
  loginId: number
  userId: number
  first_name: string
  last_name: string
  login_username: string
  login_type: number
  is_active: number
  is_client_admin: number
  client_name: string
  client_email: string
  is_staff: number
  // Whether the CLIENT COMPANY holds usable MarkScan API credentials. Presence
  // only — the credentials themselves are never sent here.
  has_api: number
}

const PER_PAGE = 15

const fullName = (u: LoginRow) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.login_username || '—'

const LOGIN_TYPES: Record<number, string> = { 0: 'Password', 1: 'SSO', 2: 'Email OTP' }

export default function ClientAdminsPage() {
  const [users,   setUsers]   = useState<LoginRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [busy,    setBusy]    = useState<number | null>(null)
  const [search,  setSearch]  = useState('')
  const [client,  setClient]  = useState('')      // company filter (userId as string)
  const [onlyAdmins, setOnlyAdmins] = useState(false)
  const [apiFilter, setApiFilter] = useState<'' | 'yes' | 'no'>('')
  const [page,    setPage]    = useState(1)
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4500)
  }

  async function load() {
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/admin/client-admins', { credentials: 'include' })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to load'); return }
      setUsers(data.users || [])
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  // Company options, derived from the rows themselves.
  const clients = useMemo(() => {
    const m = new Map<number, string>()
    for (const u of users) if (!m.has(u.userId)) m.set(u.userId, u.client_name || u.client_email || `#${u.userId}`)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [users])

  // API access is a property of the COMPANY, not of the login — the rows are
  // per (person × company), so counting rows would count a company once per
  // user. Collapse to distinct companies first.
  const apiStats = useMemo(() => {
    const byCompany = new Map<number, boolean>()
    for (const u of users) if (!byCompany.has(u.userId)) byCompany.set(u.userId, Number(u.has_api) === 1)
    const total = byCompany.size
    const withApi = [...byCompany.values()].filter(Boolean).length
    return { total, withApi, without: total - withApi }
  }, [users])

  const filtered = users.filter(u => {
    if (client && String(u.userId) !== client) return false
    if (onlyAdmins && Number(u.is_client_admin) !== 1) return false
    if (apiFilter === 'yes' && Number(u.has_api) !== 1) return false
    if (apiFilter === 'no'  && Number(u.has_api) === 1) return false
    const q = search.toLowerCase()
    if (!q) return true
    return fullName(u).toLowerCase().includes(q)
      || String(u.login_username ?? '').toLowerCase().includes(q)
      || String(u.client_name ?? '').toLowerCase().includes(q)
  })

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const paginated  = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
  const grantedCount = users.filter(u => Number(u.is_client_admin) === 1).length

  async function toggle(u: LoginRow) {
    const next = Number(u.is_client_admin) !== 1
    setBusy(u.loginId)
    try {
      const res = await fetch('/api/admin/client-admins', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: u.loginId, isClientAdmin: next }),
      })
      const data = await res.json()
      if (data.success) {
        setUsers(prev => prev.map(x => x.loginId === u.loginId ? { ...x, is_client_admin: next ? 1 : 0 } : x))
        showToast(
          `${fullName(u)} ${next ? 'is now Client Admin of' : 'is no longer Client Admin of'} ${u.client_name}` +
          ' — applies from their next sign-in.')
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
        <div className={`fixed top-4 right-4 z-50 max-w-sm px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <BackToConfiguration />

      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#14254A]">Client Admins</h1>
          <p className="text-brand-muted text-sm mt-1">
            {users.length} client login{users.length !== 1 ? 's' : ''} · Client Admin granted to {grantedCount}
            {' · '}
            <span className="font-semibold text-emerald-600">{apiStats.withApi}</span>
            {' of '}{apiStats.total} compan{apiStats.total === 1 ? 'y has' : 'ies have'} API access
          </p>
        </div>
      </div>

      {/* What the grant means */}
      <div className="flex items-start gap-2.5 mb-5 px-4 py-3 rounded-xl bg-blue-50/70 border border-blue-100 text-xs text-blue-800">
        <svg className="w-4 h-4 flex-shrink-0 mt-px" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>
          A <b>Client Admin</b> gets an <b>Account Access</b> page in their own portal, listing every user
          attached to <b>their own client company</b>, where they can grant or revoke those users&apos; sign-in.
          They cannot create users, change credentials, grant this role, or see any other company. The grant is
          per company — the same person listed twice below is two separate grants. Admin and Super Admin keep
          full control everywhere. A change applies from that person&apos;s next sign-in.
        </span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 gap-3 flex-wrap">
          <span className="text-sm font-semibold text-[#14254A]">
            {filtered.length} login{filtered.length !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 h-11 text-xs text-gray-500 cursor-pointer select-none">
              <input type="checkbox" checked={onlyAdmins}
                onChange={e => { setOnlyAdmins(e.target.checked); setPage(1) }}
                className="w-3.5 h-3.5 rounded accent-emerald-500" />
              Client Admins only
            </label>
            <select value={apiFilter} onChange={e => { setApiFilter(e.target.value as '' | 'yes' | 'no'); setPage(1) }}
              className="h-11 border border-gray-200 rounded-xl px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
              <option value="">API access: any</option>
              <option value="yes">Has API access</option>
              <option value="no">No API access</option>
            </select>
            {/* The same picker the reports screens use, rather than a native
                select. There are ninety-odd companies here: a plain <select>
                offers no way to search them, so finding one means scrolling a
                list whose order the reader cannot see. */}
            <div className="w-64">
              <SearchableSelect
                options={clients.map(([id, name]) => ({ key: String(id), label: name }))}
                value={client}
                onChange={v => { setClient(v); setPage(1) }}
                placeholder="Select client"
                emptyLabel="All Client"
              />
            </div>
            <input type="text" placeholder="Search by name, login or client…"
              value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
              className="h-11 border border-gray-200 rounded-xl px-3 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>
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
                  <th>User</th>
                  <th>Login</th>
                  <th>Client (Company)</th>
                  <th>API Access</th>
                  <th>Login Type</th>
                  <th>Status</th>
                  <th>Client Admin</th>
                </tr>
              </thead>
              <tbody>
                {paginated.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-10 text-brand-muted">No logins found</td></tr>
                ) : paginated.map((u, i) => {
                  const on      = Number(u.is_client_admin) === 1
                  const isStaff = Number(u.is_staff) === 1
                  return (
                    <tr key={u.loginId}>
                      <td className="text-xs text-gray-400">{(safePage - 1) * PER_PAGE + i + 1}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-white text-xs shrink-0"
                            style={{ background: 'linear-gradient(135deg,#0078D4,#004E8C)' }}>
                            {fullName(u).charAt(0).toUpperCase()}
                          </div>
                          <p className="text-sm font-medium text-gray-800">{fullName(u)}</p>
                        </div>
                      </td>
                      <td><code className="text-xs bg-gray-100 px-2 py-0.5 rounded font-mono">{u.login_username || '—'}</code></td>
                      <td className="text-sm text-gray-700">{u.client_name || '—'}</td>
                      <td>
                        {/* A property of the company, not this login: whether
                            MarkScan API credentials are configured for it. */}
                        {Number(u.has_api) === 1 ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700"
                            title="MarkScan API credentials are configured for this company">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            Yes
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700"
                            title="No MarkScan API credentials configured — this company's users see no live data">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                            No
                          </span>
                        )}
                      </td>
                      <td className="text-xs text-gray-500">{LOGIN_TYPES[Number(u.login_type)] ?? '—'}</td>
                      <td>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                          Number(u.is_active) === 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                          {Number(u.is_active) === 1 ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>
                        {isStaff ? (
                          // Portal staff already has access everywhere; the grant
                          // would be a no-op, so it isn't offered.
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700"
                            title="IP House staff — already has full access">
                            Staff
                          </span>
                        ) : (
                          <div className="flex items-center gap-2.5">
                            <button onClick={() => toggle(u)} disabled={busy === u.loginId}
                              role="switch" aria-checked={on}
                              title={on ? 'Revoke Client Admin' : 'Grant Client Admin'}
                              className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors disabled:opacity-50 flex-shrink-0 ${on ? 'bg-emerald-500' : 'bg-gray-200'}`}>
                              <span className={`inline-block w-[18px] h-[18px] bg-white rounded-full shadow transform transition-transform ${on ? 'translate-x-[24px]' : 'translate-x-[3px]'}`} />
                            </button>
                            <span className={`text-xs font-semibold ${on ? 'text-emerald-600' : 'text-gray-400'}`}>
                              {busy === u.loginId ? 'Saving…' : on ? 'Granted' : 'No'}
                            </span>
                          </div>
                        )}
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
