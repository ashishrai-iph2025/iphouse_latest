'use client'

import { useState, useEffect, useMemo } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import PaginationBar from '@/components/admin/PaginationBar'
import PageLoader from '@/components/ui/PageLoader'
import Drawer from '@/components/ui/Drawer'
import {
  enforceDashboardReports, selectAllRespectingRule, DASHBOARD_REPORTS_HINT,
} from '@/lib/moduleExclusivity'

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

interface ModuleRow {
  Id: number
  ModuleName: string
  pageName: string
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

  /* One drawer replaces the two modals. Reviewing a request and deciding on it
     were split across a "View remarks" dialog and a confirm dialog, which meant
     the thing you needed to read to decide was never on screen at the moment
     you decided. */
  const [review, setReview] = useState<RegistrationRequest | null>(null)

  /* Module access, chosen at the same time as the approval.
     Granting used to be a second trip to /admin/module-permissions, which is a
     step easy to forget — and a login approved without it can sign in and see
     nothing. */
  const [modules, setModules]       = useState<ModuleRow[]>([])
  const [modulesErr, setModulesErr] = useState('')
  const [picked, setPicked]         = useState<Set<number>>(new Set())

  /* Set once an approval has succeeded, so a failure in the SECOND half —
     granting the modules — can be retried without approving again. */
  const [grantedLoginId, setGrantedLoginId] = useState<number | null>(null)

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

  /* The module list, fetched once.

     It sits behind the `module-permissions` Configuration grant while this page
     only needs admin — so a reviewer who lacks that grant gets a 403 here. That
     is not an error to shout about: they can still approve, they simply cannot
     also grant, and the drawer says so instead of showing an empty checklist
     that looks like "this login gets nothing". */
  useEffect(() => {
    fetch('/api/admin/user-module-permissions', { credentials: 'include' })
      .then(async r => {
        if (r.status === 403) throw new Error('You do not hold the Module Permissions grant, so access cannot be set here.')
        return r.json()
      })
      .then(d => {
        if (Array.isArray(d?.modules)) setModules(d.modules)
        else throw new Error('The module list could not be read.')
      })
      .catch(e => setModulesErr(e.message || 'The module list could not be read.'))
  }, [])

  function openReview(r: RegistrationRequest) {
    setReview(r)
    setActionMsg('')
    setGrantedLoginId(null)
    setPicked(new Set())
  }

  function closeReview() {
    setReview(null)
    setActionMsg('')
    setGrantedLoginId(null)
  }

  /* Module ids paired with their names, for the Dashboard/Reports rule — the
     picker works in ids and the rule is about names. */
  const moduleNames = useMemo(
    () => modules.map(m => ({ id: m.Id, name: m.ModuleName })), [modules])

  /* Everything the rule allows is now fewer than every module, so "all" cannot
     be a count against modules.length — that comparison would never be true
     again and the button would read "Select all" even when it was. */
  const allPicked = (p: Set<number>) => {
    const want = selectAllRespectingRule(modules.map(m => m.Id), moduleNames)
    return want.length > 0 && want.every(id => p.has(id))
  }

  function toggleModule(id: number) {
    setPicked(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      // Dashboard and Reports are one entitlement — see lib/moduleExclusivity.
      return new Set(enforceDashboardReports([...next], id, moduleNames))
    })
  }

  /* Grant the chosen modules to a login. Split out because it is reachable two
     ways: straight after an approval, and on its own as a retry when the
     approval landed and this did not. */
  async function grantModules(loginId: number): Promise<string> {
    const res  = await fetch('/api/admin/user-module-permissions', {
      credentials: 'include',
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ loginId, modules: [...picked] }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.success) return ''
    return data.error || `Access could not be saved (HTTP ${res.status}).`
  }

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

  /*
    Approve, then grant — in that order, and it cannot be the other way round:
    the modules are attached to a loginId, and the login does not exist until
    the approval creates it (see the approve branch in admin/settings.go, which
    returns the new loginId for exactly this reason).

    The two are therefore NOT atomic. If the grant fails, the person is approved
    with no access — which is recoverable and must be SAID rather than hidden
    behind a generic failure, or the reviewer retries the approval, is told the
    request was already processed, and concludes nothing happened.
  */
  async function doAction(action: 'approved' | 'rejected') {
    if (!review) return
    setActioning(true); setActionMsg('')
    try {
      // Retry path: approval already landed, only the grant failed.
      if (action === 'approved' && grantedLoginId !== null) {
        const err = await grantModules(grantedLoginId)
        if (err) { setActionMsg(err); return }
        closeReview(); load()
        return
      }

      const res  = await fetch('/api/admin/registrations', {
        credentials: 'include',
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ requestId: review.id, action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data.success) { setActionMsg(data.error || 'Action failed'); return }

      if (action === 'approved' && picked.size > 0) {
        const loginId = Number(data.loginId)
        if (!loginId) {
          setActionMsg('Approved, but the new login id was not returned — set access from Module Permissions.')
          load()
          return
        }
        const err = await grantModules(loginId)
        if (err) {
          // Approved and NOT granted. Keep the drawer open holding the id so
          // "Retry access" is one click rather than a hunt on another page.
          setGrantedLoginId(loginId)
          setActionMsg(`Approved — but access was not saved. ${err}`)
          load()
          return
        }
      }

      closeReview()
      load()
    } catch (e: any) {
      setActionMsg(e?.message || 'Action failed')
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
          <button onClick={() => load()} className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg text-sm">Retry</button>
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
                    <td className="text-xs text-gray-600 max-w-[220px]">
                      {/* Shown inline rather than behind a "View" dialog. It is
                          one short sentence and it is the thing a reviewer reads
                          to decide; a click to see it meant deciding without it. */}
                      {r.remarks
                        ? <span className="block truncate" title={r.remarks}>{r.remarks}</span>
                        : <span className="text-brand-muted">—</span>}
                    </td>
                    <td className="text-xs text-brand-muted whitespace-nowrap">{r.created_at}</td>
                    <td>
                      <span className="inline-flex items-center gap-1.5 text-xs text-gray-700 capitalize">
                        <span className={`w-1.5 h-1.5 rounded-full ${statusDot[r.status]}`} />
                        {r.status}
                      </span>
                    </td>
                    <td>
                      {/* One entry point. Approve and Reject both live inside the
                          drawer now, next to the detail and the access being
                          granted with them — a decision taken from a list row is
                          a decision taken without reading anything. */}
                      <button onClick={() => openReview(r)}
                        className={`px-2.5 py-1 text-xs border rounded-lg transition-colors ${
                          r.status === 'pending'
                            ? 'border-gray-300 text-[#14254A] font-semibold hover:bg-[#14254A]/5'
                            : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                        }`}>
                        {r.status === 'pending' ? 'Review' : 'Details'}
                      </button>
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

      {/* ── Review drawer: the detail, the access, and the decision together ── */}
      <Drawer
        open={!!review}
        onClose={closeReview}
        title={review ? `${review.first_name} ${review.last_name}` : ''}
        subtitle={review?.email}
        footer={review && (
          <div className="flex items-center justify-end gap-3">
            {review.status === 'pending' ? (
              <>
                <button onClick={() => doAction('rejected')} disabled={actioning}
                  className="px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60">
                  Reject
                </button>
                <button onClick={() => doAction('approved')} disabled={actioning}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-60"
                  style={{ background: '#14254A' }}>
                  {actioning
                    ? 'Working…'
                    : grantedLoginId !== null
                      ? 'Retry access'
                      : picked.size > 0
                        // Names both halves, because both happen — and if only
                        // one had, the message afterwards has to make sense.
                        ? `Approve & grant ${picked.size} module${picked.size === 1 ? '' : 's'}`
                        : 'Approve'}
                </button>
              </>
            ) : (
              <button onClick={closeReview}
                className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                Close
              </button>
            )}
          </div>
        )}>

        {review && (
          <>
            {/* Detail */}
            <dl className="grid grid-cols-3 gap-x-4 gap-y-3 text-sm">
              {[
                ['Designation', review.designation || '—'],
                ['Requested on', review.created_at],
                ['Status', review.status],
              ].map(([k, v]) => (
                <div key={k as string} className="contents">
                  <dt className="col-span-1 text-xs text-gray-500 pt-0.5">{k}</dt>
                  <dd className="col-span-2 text-gray-800 capitalize">{v}</dd>
                </div>
              ))}
            </dl>

            {review.remarks && (
              <div className="mt-5">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Their remarks</p>
                <p className="text-sm text-gray-700 leading-relaxed bg-gray-50 rounded-xl px-4 py-3 whitespace-pre-wrap">
                  {review.remarks}
                </p>
              </div>
            )}

            {/* Access — only where there is still a decision to attach it to. */}
            {review.status === 'pending' && (
              <div className="mt-6 pt-5 border-t border-gray-100">
                <div className="flex items-baseline justify-between mb-1">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Module access</p>
                  {modules.length > 0 && (
                    <button type="button"
                      onClick={() => setPicked(p => allPicked(p)
                        ? new Set()
                        : new Set(selectAllRespectingRule(modules.map(m => m.Id), moduleNames)))}
                      className="text-xs font-semibold text-[#14254A] hover:underline">
                      {allPicked(picked) ? 'Clear all' : 'Select all'}
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-gray-400 mb-1">{DASHBOARD_REPORTS_HINT}</p>
                <p className="text-xs text-gray-500 mb-3">
                  Granted the moment this is approved. Leave everything unticked to approve
                  without access and set it later from Module Permissions.
                </p>

                {modulesErr ? (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    {modulesErr} Approving still works.
                  </p>
                ) : modules.length === 0 ? (
                  <p className="text-xs text-gray-400">Loading modules…</p>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5">
                    {modules.map(m => {
                      const on = picked.has(m.Id)
                      return (
                        <label key={m.Id}
                          className={`flex items-center gap-2 px-3 py-2 rounded-xl border cursor-pointer text-sm transition-colors ${
                            on ? 'border-[#14254A]/30 bg-[#14254A]/[0.04]' : 'border-gray-200 hover:bg-gray-50'
                          }`}>
                          <input type="checkbox" checked={on} onChange={() => toggleModule(m.Id)}
                            className="accent-[#14254A]" />
                          <span className="truncate text-gray-800" title={m.pageName}>{m.ModuleName}</span>
                        </label>
                      )
                    })}
                  </div>
                )}

                {/* The one thing a reviewer must know before approving: this
                    does not by itself let anyone in. */}
                <p className="text-[11px] text-gray-500 mt-4 leading-relaxed">
                  Approving creates the login and emails the credentials. They cannot sign in
                  until a client company is attached to the login on the Registrations page.
                </p>
              </div>
            )}

            {actionMsg && (
              <p className={`mt-5 text-xs rounded-xl px-3 py-2 border ${
                grantedLoginId !== null
                  ? 'text-amber-800 bg-amber-50 border-amber-200'
                  : 'text-red-700 bg-red-50 border-red-200'
              }`}>
                {actionMsg}
              </p>
            )}
          </>
        )}
      </Drawer>
    </div>
  )
}
