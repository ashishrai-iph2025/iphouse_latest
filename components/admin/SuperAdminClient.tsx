'use client'

import { useState, useEffect } from 'react'
import AdminPageHeader from './AdminPageHeader'
import ManageAccessModal from './ManageAccessModal'

interface ModuleRow {
  moduleId:   number
  moduleName: string
  moduleIcon: string
  granted:    number
}

const ROLE_LABEL: Record<number, { label: string; color: string; bg: string }> = {
  2: { label: 'Super Admin', color: '#7C3AED', bg: 'rgba(124,58,237,0.08)' },
  1: { label: 'Admin',       color: '#0078D4', bg: 'rgba(0,120,212,0.08)'  },
  0: { label: 'Client',      color: '#6b7280', bg: 'rgba(107,114,128,0.08)'},
}

/* ── Reusable Pagination bar ───────────────────────────────────────────── */
function Pagination({
  total, page, perPage, onChange,
}: { total: number; page: number; perPage: number; onChange: (p: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  if (totalPages <= 1) return null

  const pages: (number | '…')[] = []
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
      pages.push(i)
    } else if (pages[pages.length - 1] !== '…') {
      pages.push('…')
    }
  }

  return (
    <div className="flex items-center gap-1 px-5 py-3 border-t border-gray-50 justify-between">
      <span className="text-xs text-gray-400">
        {Math.min((page - 1) * perPage + 1, total)}–{Math.min(page * perPage, total)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button onClick={() => onChange(page - 1)} disabled={page === 1}
          className="px-2 py-1 text-xs rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30">‹</button>
        {pages.map((p, i) =>
          p === '…' ? (
            <span key={`e${i}`} className="px-2 text-xs text-gray-400">…</span>
          ) : (
            <button key={p} onClick={() => onChange(p as number)}
              className={`w-7 h-7 text-xs rounded-lg font-semibold transition-colors ${page === p ? 'bg-[#14254A] text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {p}
            </button>
          )
        )}
        <button onClick={() => onChange(page + 1)} disabled={page === totalPages}
          className="px-2 py-1 text-xs rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30">›</button>
      </div>
    </div>
  )
}

export default function SuperAdminClient() {
  const [tab, setTab] = useState<'accounts' | 'userPermissions' | 'permissions' | 'sessions' | 'flow'>('accounts')

  return (
    <div className="p-6 fade-in">
      <AdminPageHeader
        breadcrumb={[{ label: 'Super Admin' }]}
        title="Super Admin Control"
        description="Manage Admin/Super Admin access and Configuration modules for every user, right here."
      />

      <MaintenanceCard />

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit mb-6">
        {[
          { key: 'accounts',        label: '👑 Admins & Super Admins' },
          { key: 'userPermissions', label: '👤 User Permission'     },
          { key: 'permissions',     label: '🔐 Module Permissions'  },
          { key: 'sessions',        label: '🟢 Active Sessions'     },
          { key: 'flow',            label: '🗺️ Access Flow'        },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key as any)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${tab === t.key ? 'bg-white shadow text-[#14254A]' : 'text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'accounts'        && <AdminAccountsTab />}
      {tab === 'userPermissions' && <UserPermissionTab />}
      {tab === 'permissions'     && <ModulePermissionsTab />}
      {tab === 'flow'            && <AccessFlowTab />}
      {tab === 'sessions'        && <ActiveSessionsTab />}
    </div>
  )
}

/* ── Maintenance mode toggle ──────────────────────────────────────────────── */
function MaintenanceCard() {
  const [on,      setOn]      = useState(false)
  const [message, setMessage] = useState('')
  const [loaded,  setLoaded]  = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  useEffect(() => {
    fetch('/api/maintenance', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setOn(!!d.maintenance); setMessage(d.message || '') })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function save(enabled: boolean) {
    setSaving(true)
    try {
      const res = await fetch('/api/admin/maintenance', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, message }),
      })
      const data = await res.json()
      if (data.success) {
        setOn(enabled)
        showToast(enabled ? 'Maintenance mode enabled — clients now see the maintenance page' : 'Maintenance mode disabled — platform is live')
      } else {
        showToast(data.error || 'Failed to update maintenance mode', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setSaving(false)
  }

  return (
    <div className={`rounded-2xl border shadow-card p-5 mb-6 ${on ? 'bg-orange-50 border-orange-200' : 'bg-white border-gray-100'}`}>
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
          style={{ background: on ? '#FC934C22' : '#14254A12' }}>
          🛠️
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm text-[#14254A]">Maintenance Mode</h3>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide ${on ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
              {on ? 'ON' : 'OFF'}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            When enabled, clients see an &quot;Under Maintenance&quot; page and their API access is paused. Admins and Super Admins are not affected.
          </p>
        </div>
        <button onClick={() => save(!on)} disabled={!loaded || saving}
          className={`px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-all ${on ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-orange-500 hover:bg-orange-600'}`}>
          {saving ? 'Saving…' : on ? 'Turn OFF — Go Live' : 'Turn ON Maintenance'}
        </button>
      </div>

      <div className="mt-4">
        <label className="block text-xs font-semibold text-gray-600 mb-1">Message shown to visitors (optional)</label>
        <div className="flex gap-2">
          <input type="text" value={message} onChange={e => setMessage(e.target.value)}
            placeholder="e.g. We are upgrading the platform and will be back by 6:00 PM IST."
            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
          <button onClick={() => save(on)} disabled={!loaded || saving}
            className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            Save Message
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Tab 0: Admins & Super Admins (the dcp_super_admin table itself) ────── */
interface SuperAdminAccount {
  id:         number
  name:       string
  email:      string
  role:       'Admin' | 'SuperAdmin'
  is_active:  number
  last_login: string | null
  created_at: string
}

function AdminAccountsTab() {
  const [accounts, setAccounts]   = useState<SuperAdminAccount[]>([])
  const [saCount,  setSaCount]    = useState(0)
  const [loading,  setLoading]    = useState(true)
  const [busy,     setBusy]       = useState<number | null>(null)
  const [toast,    setToast]      = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [confirm,  setConfirm]    = useState<{ account: SuperAdminAccount; action: 'demote' | 'revoke' } | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/super-admin/accounts', { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        setAccounts(data.accounts || [])
        setSaCount(data.superAdminCount ?? 0)
      }
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function handleConfirm() {
    if (!confirm) return
    setBusy(confirm.account.id)
    try {
      const res  = await fetch('/api/admin/super-admin', {
        credentials: 'include',
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          loginUsername: confirm.account.email,
          role: confirm.action === 'demote' ? 'admin' : 'client',
          source: 'user',
        }),
      })
      const data = await res.json()
      if (data.success) {
        showToast(confirm.action === 'demote'
          ? `${confirm.account.name} demoted to Admin`
          : `${confirm.account.name} removed from portal access`)
        setConfirm(null)
        await load()
      } else {
        showToast(data.error || 'Action failed', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setBusy(null)
  }

  const lastSuperAdminStanding = (a: SuperAdminAccount) => a.role === 'SuperAdmin' && a.is_active === 1 && saCount <= 1

  return (
    <>
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <p className="font-semibold text-[#14254A] text-sm">dcp_super_admin — {accounts.length} account{accounts.length !== 1 ? 's' : ''}</p>
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-violet-50 text-violet-700 border border-violet-200">
            {saCount} active Super Admin{saCount !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                {['Name', 'Email', 'Role', 'Status', 'Last Login', 'Created', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="text-center py-12 text-gray-400 text-sm">Loading…</td></tr>
              ) : accounts.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12 text-gray-400 text-sm">No Admin or Super Admin accounts yet.</td></tr>
              ) : accounts.map(a => {
                const ri = ROLE_LABEL[a.role === 'SuperAdmin' ? 2 : 1]
                const protectedLast = lastSuperAdminStanding(a)
                const isBusy = busy === a.id
                return (
                  <tr key={a.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                          style={{ background: ri.color }}>
                          {(a.name || a.email || '?').charAt(0).toUpperCase()}
                        </div>
                        <p className="font-medium text-gray-800 text-sm">{a.name || '—'}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">{a.email}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                        style={{ color: ri.color, background: ri.bg }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: ri.color }} />
                        {ri.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${a.is_active ? 'text-emerald-600' : 'text-gray-400'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${a.is_active ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                        {a.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{a.last_login || '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{a.created_at || '—'}</td>
                    <td className="px-4 py-3">
                      {protectedLast ? (
                        <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 inline-flex items-center gap-1">
                          🔒 Last Super Admin — protected
                        </span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {a.role === 'SuperAdmin' && (
                            <button onClick={() => setConfirm({ account: a, action: 'demote' })} disabled={isBusy}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 disabled:opacity-50">
                              ⬇ Demote to Admin
                            </button>
                          )}
                          <button onClick={() => setConfirm({ account: a, action: 'revoke' })} disabled={isBusy}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-50">
                            {isBusy ? '…' : '✕ Revoke'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Confirm modal */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-2xl mb-4 ${confirm.action === 'revoke' ? 'bg-red-50' : 'bg-blue-50'}`}>
              {confirm.action === 'revoke' ? '⚠️' : '⬇'}
            </div>
            <h3 className="font-bold text-[#14254A] text-base mb-1">
              {confirm.action === 'revoke' ? 'Revoke Portal Access' : 'Demote to Admin'}
            </h3>
            <p className="text-sm text-gray-500 mb-5">
              <strong>{confirm.account.name}</strong> ({confirm.account.email}) {confirm.action === 'revoke'
                ? 'will lose all Admin/Super Admin access immediately.'
                : 'will keep Admin access but lose Super Admin privileges.'}
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirm(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
              <button onClick={handleConfirm} disabled={busy !== null}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 ${confirm.action === 'revoke' ? 'bg-red-500' : 'bg-blue-600'}`}>
                {busy !== null ? '…' : confirm.action === 'revoke' ? 'Revoke' : 'Demote'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* ── Tab: User Permission (one row per unique person) ───────────────────── */
interface UserPermRow {
  loginId:        number
  login_username: string
  first_name:     string | null
  last_name:      string | null
  is_active:      number
  companies:      string | null
  portal_role:    string | null   // 'Admin' | 'SuperAdmin' | null
}

function portalRoleNum(r: string | null): 0 | 1 | 2 {
  if (r === 'SuperAdmin') return 2
  if (r === 'Admin') return 1
  return 0
}

const USER_PERM_PER_PAGE = 15

function UserPermissionTab() {
  const [users,   setUsers]   = useState<UserPermRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search,  setSearch]  = useState('')
  const [page,    setPage]    = useState(1)
  const [accessRow, setAccessRow] = useState<UserPermRow | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/super-admin/user-permissions', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setUsers(data.users || [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const displayName = (u: UserPermRow) =>
    [u.first_name, u.last_name].filter(Boolean).join(' ') || u.login_username

  const q = search.toLowerCase()
  const filtered = users.filter(u =>
    !q || displayName(u).toLowerCase().includes(q)
       || u.login_username.toLowerCase().includes(q)
       || (u.companies || '').toLowerCase().includes(q)
  )
  const totalPages = Math.ceil(filtered.length / USER_PERM_PER_PAGE)
  const safePage   = Math.min(page, Math.max(1, totalPages))
  const paginated  = filtered.slice((safePage - 1) * USER_PERM_PER_PAGE, safePage * USER_PERM_PER_PAGE)

  useEffect(() => { setPage(1) }, [search])

  return (
    <>
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-5 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-[#14254A]">{filtered.length} user{filtered.length !== 1 ? 's' : ''}</span>
          <input autoComplete="off" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, username or company…"
            className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-full sm:w-72 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                {['Name', 'Username', 'Companies', 'Role', 'Status', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400 text-sm">Loading…</td></tr>
              ) : paginated.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400 text-sm">No users found.</td></tr>
              ) : paginated.map(u => {
                const role = portalRoleNum(u.portal_role)
                const ri   = ROLE_LABEL[role] ?? ROLE_LABEL[0]
                return (
                  <tr key={u.loginId} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                          style={{ background: ri.color }}>
                          {displayName(u).charAt(0).toUpperCase()}
                        </div>
                        <p className="font-medium text-gray-800 text-sm">{displayName(u)}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">{u.login_username}</td>
                    <td className="px-4 py-3 text-xs text-gray-600 max-w-[220px]">
                      <span className="truncate block" title={u.companies || ''}>{u.companies || '—'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                        style={{ color: ri.color, background: ri.bg }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: ri.color }} />
                        {ri.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${u.is_active ? 'text-emerald-600' : 'text-gray-400'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${u.is_active ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                        {u.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => setAccessRow(u)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-gray-50 text-[#14254A] border border-gray-200 hover:bg-gray-100">
                        🔑 Manage Access
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <Pagination total={filtered.length} page={safePage} perPage={USER_PERM_PER_PAGE} onChange={setPage} />
      </div>

      {accessRow && (
        <ManageAccessModal
          loginUsername={accessRow.login_username}
          displayName={displayName(accessRow)}
          companiesLabel={accessRow.companies || undefined}
          initialRole={portalRoleNum(accessRow.portal_role)}
          onClose={() => setAccessRow(null)}
          onChanged={() => load()}
        />
      )}
    </>
  )
}

/* ── Tab 1: Module Permissions ─────────────────────────────────────────── */
interface LoginUser {
  loginId: number; userId: number
  first_name: string; last_name: string
  login_username: string; is_active: number
  user_name: string; user_email: string; role: number | null
}

const PERMS_PER_PAGE = 10

function ModulePermissionsTab() {
  const [users,          setUsers]          = useState<LoginUser[]>([])
  const [selected,       setSelected]       = useState<LoginUser | null>(null)
  const [modules,        setModules]        = useState<ModuleRow[]>([])
  const [busy,           setBusy]           = useState<number | null>(null)
  const [search,         setSearch]         = useState('')
  const [toast,          setToast]          = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [loadingUsers,   setLoadingUsers]   = useState(true)
  const [loadingModules, setLoadingModules] = useState(false)
  const [page,           setPage]           = useState(1)

  useEffect(() => {
    fetch('/api/admin/super-admin/permissions', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.success) setUsers(d.users || []) })
      .catch(() => {})
      .finally(() => setLoadingUsers(false))
  }, [])

  async function selectUser(u: LoginUser) {
    setSelected(u)
    setModules([])
    setLoadingModules(true)
    const res  = await fetch(`/api/admin/super-admin/permissions?userId=${u.userId}`, { credentials: 'include' })
    const data = await res.json()
    if (data.success) setModules(data.modules || [])
    setLoadingModules(false)
  }

  async function toggleModule(mod: ModuleRow) {
    if (!selected) return
    setBusy(mod.moduleId)
    const grant = mod.granted === 0
    const res   = await fetch('/api/admin/super-admin/permissions', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId: selected.userId, moduleId: mod.moduleId, grant }),
    })
    const data = await res.json()
    if (data.success) {
      setModules(prev => prev.map(m => m.moduleId === mod.moduleId ? { ...m, granted: grant ? 1 : 0 } : m))
      setToast({ msg: `${mod.moduleName} ${grant ? 'enabled' : 'disabled'} for ${selected.user_name || selected.login_username}`, type: 'success' })
      setTimeout(() => setToast(null), 3000)
    } else {
      setToast({ msg: data.error || 'Failed', type: 'error' })
      setTimeout(() => setToast(null), 3000)
    }
    setBusy(null)
  }

  const filteredUsers = users.filter(u => {
    if (!search) return true
    const q = search.toLowerCase()
    return (u.user_name || '').toLowerCase().includes(q)
        || (u.login_username || '').toLowerCase().includes(q)
        || (u.user_email || '').toLowerCase().includes(q)
  })

  const totalPages   = Math.ceil(filteredUsers.length / PERMS_PER_PAGE)
  const safePage     = Math.min(page, Math.max(1, totalPages))
  const pagedUsers   = filteredUsers.slice((safePage - 1) * PERMS_PER_PAGE, safePage * PERMS_PER_PAGE)

  useEffect(() => { setPage(1) }, [search])

  const grantedCount = modules.filter(m => m.granted).length
  const displayName  = (u: LoginUser) => `${u.first_name} ${u.last_name}`.trim() || u.login_username || u.user_name
  const roleInfo     = (u: LoginUser) => ROLE_LABEL[u.role ?? 0] ?? ROLE_LABEL[0]

  return (
    <>
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">

        {/* User list panel */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Select Login User <span className="text-gray-300 font-normal normal-case">({filteredUsers.length})</span>
            </p>
            <input autoComplete="off" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, email or username…"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
            {loadingUsers ? (
              <p className="text-center py-8 text-xs text-gray-400">Loading…</p>
            ) : pagedUsers.length === 0 ? (
              <p className="text-center py-8 text-xs text-gray-400">No users found.</p>
            ) : pagedUsers.map(u => {
              const isActive = selected?.loginId === u.loginId
              const ri = roleInfo(u)
              return (
                <button key={u.loginId} onClick={() => selectUser(u)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${isActive ? 'bg-[#14254A]' : 'hover:bg-gray-50'}`}>
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{
                      background: isActive ? 'rgba(255,255,255,0.2)' : `${ri.color}15`,
                      color: isActive ? '#fff' : ri.color
                    }}>
                    {displayName(u).charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs font-semibold truncate ${isActive ? 'text-white' : 'text-gray-800'}`}>{displayName(u)}</p>
                    <p className={`text-[10px] truncate ${isActive ? 'text-white/60' : 'text-gray-400'}`}>{u.user_name}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                      style={isActive ? { background: 'rgba(255,255,255,0.2)', color: '#fff' } : { background: `${ri.color}15`, color: ri.color }}>
                      {ri.label}
                    </span>
                    <span className={`w-1.5 h-1.5 rounded-full ${u.is_active ? 'bg-emerald-400' : 'bg-gray-300'}`} />
                  </div>
                </button>
              )
            })}
          </div>

          {/* Pagination inside the side panel */}
          {totalPages > 1 && (
            <div className="border-t border-gray-50 flex items-center justify-between px-4 py-2 flex-shrink-0">
              <span className="text-[10px] text-gray-400">
                {(safePage - 1) * PERMS_PER_PAGE + 1}–{Math.min(safePage * PERMS_PER_PAGE, filteredUsers.length)} of {filteredUsers.length}
              </span>
              <div className="flex gap-1">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
                  className="px-2 py-0.5 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30">‹</button>
                <span className="px-2 py-0.5 text-xs text-gray-500">{safePage}/{totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
                  className="px-2 py-0.5 text-xs rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30">›</button>
              </div>
            </div>
          )}
        </div>

        {/* Module grid panel */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden flex flex-col">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center flex-col gap-3 py-20 text-gray-400">
              <span className="text-4xl">👈</span>
              <p className="text-sm font-medium">Select a user to manage their module access</p>
            </div>
          ) : (
            <>
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <p className="font-semibold text-[#14254A] text-sm">{displayName(selected)}</p>
                  <p className="text-xs text-gray-400">{selected.login_username} · {selected.user_email}</p>
                </div>
                {modules.length > 0 && (
                  <span className="text-xs font-semibold px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                    {grantedCount} / {modules.length} modules enabled
                  </span>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-5">
                {loadingModules ? (
                  <div className="flex items-center justify-center py-16">
                    <span className="w-6 h-6 border-2 border-[#14254A] border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : modules.length === 0 ? (
                  <p className="text-center py-12 text-gray-400 text-sm">No modules available.</p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {modules.map(mod => {
                      const isGranted = mod.granted === 1
                      const isBusy    = busy === mod.moduleId
                      return (
                        <button key={mod.moduleId} onClick={() => toggleModule(mod)} disabled={isBusy}
                          className={`relative flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all text-center disabled:opacity-60 ${
                            isGranted
                              ? 'border-emerald-400 bg-emerald-50 shadow-sm'
                              : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                          }`}>
                          {isBusy && (
                            <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-white/70">
                              <span className="w-4 h-4 border-2 border-[#14254A] border-t-transparent rounded-full animate-spin" />
                            </div>
                          )}
                          <span className="text-2xl">📦</span>
                          <p className={`text-xs font-semibold leading-tight ${isGranted ? 'text-emerald-700' : 'text-gray-600'}`}>
                            {mod.moduleName}
                          </p>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isGranted ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                            {isGranted ? 'Enabled' : 'Disabled'}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

/* ── Tab 2: Active Sessions ────────────────────────────────────────────── */
interface ActiveSession {
  loginId:        number
  userId:         number
  full_name:      string
  username:       string
  client:         string
  last_activity:  string
  ip_address:     string | null
  action_count:   number
  force_logout_at:string | null
}

const SESSIONS_PER_PAGE = 15

function ActiveSessionsTab() {
  const [sessions, setSessions] = useState<ActiveSession[]>([])
  const [loading,  setLoading]  = useState(true)
  const [busy,     setBusy]     = useState<number | null>(null)
  const [busyAll,  setBusyAll]  = useState(false)
  const [toast,    setToast]    = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [confirm,  setConfirm]  = useState<ActiveSession | null>(null)
  const [page,     setPage]     = useState(1)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function load() {
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/super-admin/active-sessions', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setSessions(data.sessions)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  async function forceLogout(s: ActiveSession) {
    setBusy(s.loginId)
    setConfirm(null)
    const res  = await fetch('/api/admin/super-admin/force-logout', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ loginId: s.loginId }),
    })
    const data = await res.json()
    if (data.success) {
      showToast(`${s.full_name || s.username} has been force-logged out`)
      await load()
    } else {
      showToast(data.error || 'Force logout failed', 'error')
    }
    setBusy(null)
  }

  async function restoreAccess(s: ActiveSession) {
    setBusy(s.loginId)
    const res  = await fetch('/api/admin/super-admin/force-logout', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ loginId: s.loginId }),
    })
    const data = await res.json()
    if (data.success) {
      showToast(`Access restored for ${s.full_name || s.username}`)
      await load()
    } else {
      showToast(data.error || 'Failed to restore', 'error')
    }
    setBusy(null)
  }

  async function forceLogoutAll() {
    setBusyAll(true)
    const active = sessions.filter(s => !s.force_logout_at)
    await Promise.all(active.map(s =>
      fetch('/api/admin/super-admin/force-logout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: s.loginId }),
      })
    ))
    showToast(`Force-logged out ${active.length} active session${active.length !== 1 ? 's' : ''}`)
    await load()
    setBusyAll(false)
  }

  const activeCount  = sessions.filter(s => !s.force_logout_at).length
  const blockedCount = sessions.filter(s =>  s.force_logout_at).length

  const totalPages = Math.ceil(sessions.length / SESSIONS_PER_PAGE)
  const safePage   = Math.min(page, Math.max(1, totalPages))
  const paginated  = sessions.slice((safePage - 1) * SESSIONS_PER_PAGE, safePage * SESSIONS_PER_PAGE)

  return (
    <>
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Sessions (30 min)', value: sessions.length, icon: '📡', color: '#14254A' },
          { label: 'Currently Active',  value: activeCount,     icon: '🟢', color: '#16A34A' },
          { label: 'Force-Logged Out',  value: blockedCount,    icon: '🔴', color: '#DC2626' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-2xl border border-gray-100 shadow-card p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: `${s.color}12` }}>{s.icon}</div>
            <div>
              <p className="text-2xl font-bold" style={{ color: s.color }}>{s.value}</p>
              <p className="text-xs text-gray-400 font-medium">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <div>
            <p className="font-semibold text-[#14254A] text-sm">Live Active Sessions</p>
            <p className="text-xs text-gray-400">Users active in the last 30 minutes · auto-refreshes every 30 s</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} disabled={loading}
              className="text-xs px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 flex items-center gap-1">
              {loading ? <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" /> : '↻'} Refresh
            </button>
            {activeCount > 0 && (
              <button onClick={forceLogoutAll} disabled={busyAll}
                className="text-xs px-3 py-1.5 rounded-xl bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-40 flex items-center gap-1 font-semibold">
                {busyAll ? <span className="w-3 h-3 border-2 border-red-400 border-t-transparent rounded-full animate-spin" /> : '⏏'} Force Logout All
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#14254A' }}>
                {['#','User','Username','Client','IP Address','Last Activity','Actions','Session Status','Force Logout'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-white/80 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="text-center py-12 text-gray-400 text-sm">
                  <span className="w-5 h-5 border-2 border-[#14254A] border-t-transparent rounded-full animate-spin inline-block" />
                </td></tr>
              ) : paginated.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-12 text-gray-400 text-sm">
                  No active sessions in the last 30 minutes.
                </td></tr>
              ) : paginated.map((s, idx) => {
                const isForcedOut = !!s.force_logout_at
                const isBusy      = busy === s.loginId
                return (
                  <tr key={s.loginId} className={`border-b border-gray-50 transition-colors ${isForcedOut ? 'bg-red-50/40' : 'hover:bg-gray-50/50'}`}>
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">{(safePage - 1) * SESSIONS_PER_PAGE + idx + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                            style={{ background: isForcedOut ? '#DC2626' : '#14254A' }}>
                            {(s.full_name || s.username || 'U').charAt(0).toUpperCase()}
                          </div>
                          {!isForcedOut && (
                            <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 border-2 border-white rounded-full" />
                          )}
                        </div>
                        <p className="text-xs font-medium text-gray-800">{s.full_name || '—'}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">{s.username}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">{s.client}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">{s.ip_address || '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{s.last_activity}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold"
                        style={{ background: '#0078D415', color: '#0078D4' }}>
                        {s.action_count}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {isForcedOut ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                          Force-logged out
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isForcedOut ? (
                        <button onClick={() => restoreAccess(s)} disabled={isBusy}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 transition-all">
                          {isBusy ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> : '✓'}
                          Restore Access
                        </button>
                      ) : (
                        <button onClick={() => setConfirm(s)} disabled={isBusy}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-50 transition-all">
                          {isBusy ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> : '⏏'}
                          Force Logout
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <Pagination total={sessions.length} page={safePage} perPage={SESSIONS_PER_PAGE} onChange={setPage} />
      </div>

      {/* Info banner */}
      <div className="mt-4 bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
        <span className="text-lg">ℹ️</span>
        <div>
          <p className="text-xs font-semibold text-amber-800 mb-1">How Force Logout works</p>
          <p className="text-xs text-amber-700">When you force-logout a user, their active JWT session is invalidated on their next request (within seconds). They will be redirected to the login page. You can restore their access at any time using the "Restore Access" button — this clears the force-logout flag and allows them to log in again normally.</p>
        </div>
      </div>

      {/* Confirm modal */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl mb-4 bg-red-50">⏏️</div>
            <h3 className="font-bold text-[#14254A] text-base mb-1">Force Logout User</h3>
            <p className="text-sm text-gray-500 mb-2">
              <strong>{confirm.full_name || confirm.username}</strong> ({confirm.client}) will be signed out immediately on their next request.
            </p>
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-5">
              Their session token will be invalidated. You can restore access later.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirm(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
              <button onClick={() => forceLogout(confirm)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-red-500 hover:bg-red-600">
                Force Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* ── Tab: Access Flow — static reference diagram of the login/permission model ── */
function DiagramCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-5 mb-5">
      <h3 className="font-bold text-[#14254A] text-sm mb-1">{title}</h3>
      <p className="text-xs text-gray-500 mb-4">{description}</p>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}

function AccessFlowTab() {
  return (
    <>
      <DiagramCard
        title="1. Login Decision"
        description="Every login attempt checks dcp_super_admin by email FIRST. A match always wins over the regular client path.">
        <svg viewBox="0 0 700 370" style={{ minWidth: 640 }}>
          <defs>
            <marker id="af1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M2 1L8 5L2 9" fill="none" stroke="#9CA3AF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </defs>

          <rect x="220" y="20" width="260" height="56" rx="8" fill="#F9FAFB" stroke="#D1D5DB" strokeWidth="1" />
          <text x="350" y="38" textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="700" fill="#111827">Login Attempt</text>
          <text x="350" y="60" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#6B7280">username + password or OTP</text>

          <line x1="350" y1="76" x2="350" y2="132" stroke="#9CA3AF" strokeWidth="1.5" markerEnd="url(#af1)" />

          <rect x="220" y="136" width="260" height="56" rx="8" fill="#F9FAFB" stroke="#D1D5DB" strokeWidth="1" />
          <text x="350" y="154" textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="700" fill="#111827">Check dcp_super_admin</text>
          <text x="350" y="176" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#6B7280">match by email?</text>

          <text x="180" y="228" textAnchor="middle" fontSize="11" fill="#6B7280">no match</text>
          <text x="475" y="228" textAnchor="middle" fontSize="11" fill="#6B7280">match found</text>

          <line x1="260" y1="192" x2="130" y2="278" stroke="#9CA3AF" strokeWidth="1.5" markerEnd="url(#af1)" />
          <line x1="440" y1="192" x2="350" y2="278" stroke="#9CA3AF" strokeWidth="1.5" markerEnd="url(#af1)" />
          <line x1="440" y1="192" x2="570" y2="278" stroke="#9CA3AF" strokeWidth="1.5" markerEnd="url(#af1)" />

          <rect x="40" y="280" width="180" height="56" rx="8" fill="#F3F4F6" stroke="#9CA3AF" strokeWidth="1" />
          <text x="130" y="298" textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="700" fill="#374151">Client</text>
          <text x="130" y="320" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#6B7280">dcp_user.role = 0</text>

          <rect x="260" y="280" width="180" height="56" rx="8" fill="#EFF6FF" stroke="#0078D4" strokeWidth="1" />
          <text x="350" y="298" textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="700" fill="#0078D4">Admin</text>
          <text x="350" y="320" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#0078D4">role = 'Admin'</text>

          <rect x="480" y="280" width="180" height="56" rx="8" fill="#F5F3FF" stroke="#7C3AED" strokeWidth="1" />
          <text x="570" y="298" textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="700" fill="#7C3AED">Super Admin</text>
          <text x="570" y="320" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#7C3AED">role = 'SuperAdmin'</text>

          <text x="350" y="356" textAnchor="middle" fontSize="11" fill="#9CA3AF">dcp_super_admin is checked first — it always wins over the regular client path</text>
        </svg>
      </DiagramCard>

      <DiagramCard
        title="2. Authentication Method"
        description="Admin / Super Admin can use EITHER password or emailed OTP — either one alone completes login. Clients use password, then OTP as a second factor when their login type requires it.">
        <svg viewBox="0 0 700 340" style={{ minWidth: 640 }}>
          <defs>
            <marker id="af2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M2 1L8 5L2 9" fill="none" stroke="#9CA3AF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </defs>

          <line x1="345" y1="20" x2="345" y2="320" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="4 4" />

          {/* Left: Admin / Super Admin */}
          <text x="170" y="34" textAnchor="middle" fontSize="13" fontWeight="700" fill="#111827">Admin / Super Admin</text>
          <text x="170" y="52" textAnchor="middle" fontSize="11" fill="#6B7280">either method is enough</text>

          <rect x="40" y="76" width="120" height="56" rx="8" fill="#EFF6FF" stroke="#0078D4" strokeWidth="1" />
          <text x="100" y="96" textAnchor="middle" dominantBaseline="central" fontSize="13" fontWeight="700" fill="#0078D4">Password</text>
          <text x="100" y="116" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#0078D4">vs password_hash</text>

          <rect x="180" y="76" width="120" height="56" rx="8" fill="#ECFDF5" stroke="#10B981" strokeWidth="1" />
          <text x="240" y="96" textAnchor="middle" dominantBaseline="central" fontSize="13" fontWeight="700" fill="#059669">Email OTP</text>
          <text x="240" y="116" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#059669">vs twofa_code</text>

          <text x="170" y="150" textAnchor="middle" fontSize="11" fill="#9CA3AF">OR</text>

          <line x1="100" y1="132" x2="160" y2="188" stroke="#9CA3AF" strokeWidth="1.5" markerEnd="url(#af2)" />
          <line x1="240" y1="132" x2="180" y2="188" stroke="#9CA3AF" strokeWidth="1.5" markerEnd="url(#af2)" />

          <rect x="90" y="192" width="160" height="56" rx="8" fill="#F5F3FF" stroke="#7C3AED" strokeWidth="1" />
          <text x="170" y="210" textAnchor="middle" dominantBaseline="central" fontSize="13" fontWeight="700" fill="#7C3AED">Session Issued</text>
          <text x="170" y="230" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#7C3AED">JWT · role = Admin/SuperAdmin</text>

          {/* Right: Client */}
          <text x="520" y="34" textAnchor="middle" fontSize="13" fontWeight="700" fill="#111827">Client</text>
          <text x="520" y="52" textAnchor="middle" fontSize="11" fill="#6B7280">sequential — both required</text>

          <rect x="440" y="76" width="160" height="44" rx="8" fill="#EFF6FF" stroke="#0078D4" strokeWidth="1" />
          <text x="520" y="98" textAnchor="middle" dominantBaseline="central" fontSize="13" fontWeight="700" fill="#0078D4">Password</text>

          <line x1="520" y1="120" x2="520" y2="156" stroke="#9CA3AF" strokeWidth="1.5" markerEnd="url(#af2)" />

          <rect x="440" y="160" width="160" height="52" rx="8" fill="#ECFDF5" stroke="#10B981" strokeWidth="1" />
          <text x="520" y="178" textAnchor="middle" dominantBaseline="central" fontSize="13" fontWeight="700" fill="#059669">Email OTP</text>
          <text x="520" y="196" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#059669">if login type requires</text>

          <line x1="520" y1="212" x2="520" y2="240" stroke="#9CA3AF" strokeWidth="1.5" markerEnd="url(#af2)" />

          <rect x="440" y="244" width="160" height="56" rx="8" fill="#F3F4F6" stroke="#9CA3AF" strokeWidth="1" />
          <text x="520" y="262" textAnchor="middle" dominantBaseline="central" fontSize="13" fontWeight="700" fill="#374151">Session Issued</text>
          <text x="520" y="282" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#6B7280">JWT · role = Client</text>
        </svg>
      </DiagramCard>

      <DiagramCard
        title="3. Module Access Unlocked"
        description="Same identity (login_username), different scope. Configuration access is keyed to dcp_super_admin.id — the same id used for claims.LoginID — so it works whether the person has one company or many.">
        <svg viewBox="0 0 730 380" style={{ minWidth: 640 }}>
          <defs>
            <marker id="af3" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M2 1L8 5L2 9" fill="none" stroke="#9CA3AF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </defs>

          <rect x="20" y="158" width="130" height="44" rx="8" fill="#F9FAFB" stroke="#D1D5DB" strokeWidth="1" />
          <text x="85" y="180" textAnchor="middle" dominantBaseline="central" fontSize="13" fontWeight="700" fill="#111827">Person</text>
          <line x1="150" y1="180" x2="178" y2="180" stroke="#9CA3AF" strokeWidth="1.5" markerEnd="url(#af3)" />

          <rect x="180" y="40" width="530" height="300" rx="20" fill="#FAFAFA" stroke="#E5E7EB" strokeWidth="1" />
          <text x="200" y="68" fontSize="14" fontWeight="700" fill="#111827">Access Unlocked, By Role</text>
          <text x="200" y="86" fontSize="11" fill="#9CA3AF">Same identity, different scope</text>

          <rect x="200" y="105" width="150" height="215" rx="12" fill="#F3F4F6" stroke="#9CA3AF" strokeWidth="1" />
          <text x="275" y="135" textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="700" fill="#374151">Client</text>
          <text x="275" y="159" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#6B7280">Own dashboards</text>
          <text x="275" y="183" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#6B7280">No config access</text>

          <rect x="370" y="105" width="150" height="215" rx="12" fill="#EFF6FF" stroke="#0078D4" strokeWidth="1" />
          <text x="445" y="135" textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="700" fill="#0078D4">Admin</text>
          <text x="445" y="159" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#0078D4">Dashboard access</text>
          <text x="445" y="183" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#0078D4">Config: partial</text>
          <text x="445" y="207" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#0078D4" opacity="0.75">(granted subset)</text>

          <rect x="540" y="105" width="150" height="215" rx="12" fill="#F5F3FF" stroke="#7C3AED" strokeWidth="1" />
          <text x="615" y="135" textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="700" fill="#7C3AED">Super Admin</text>
          <text x="615" y="159" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#7C3AED">All dashboards</text>
          <text x="615" y="183" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#7C3AED">All config modules</text>
          <text x="615" y="207" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#7C3AED" opacity="0.75">automatic, no grants</text>
          <text x="615" y="231" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#7C3AED">Manages all admins</text>
        </svg>
      </DiagramCard>

      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
        <span className="text-lg">ℹ️</span>
        <p className="text-xs text-amber-800">
          The only place any of this is edited is <strong>Manage Access</strong> (from the User Permission tab or Registrations) —
          it sets the role, which creates/updates/deletes the <code>dcp_super_admin</code> row, and — once elevated — the
          Configuration module checkboxes right below it.
        </p>
      </div>
    </>
  )
}
