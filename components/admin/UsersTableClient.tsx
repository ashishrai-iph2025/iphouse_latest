'use client'

import { useState, useEffect } from 'react'
import { useRouter } from '@/lib/router'
import PaginationBar, { PER_PAGE } from './PaginationBar'
import AdminModal from './AdminModal'

interface LoginRow {
  loginId: number
  userId: number
  first_name: string
  last_name: string
  login_username: string
  login_type: number
  is_active: number
  user_name: string
  user_email: string
  role: number | null
}

const LOGIN_TYPES = [
  { value: 0, label: 'Email OTP',     desc: 'A one-time code is sent to the user\'s email on each login.',   badge: 'badge-info'    },
  { value: 1, label: 'Authenticator', desc: 'User scans a QR code and uses an authenticator app (TOTP).',   badge: 'badge-warning' },
  { value: 2, label: 'Password',      desc: 'User logs in with username and password only. No second factor.', badge: 'badge-muted'   },
]

function LoginTypeBadge({ type }: { type: number }) {
  const lt = LOGIN_TYPES.find(t => t.value === type) ?? LOGIN_TYPES[2]
  return <span className={`badge ${lt.badge}`}>{lt.label}</span>
}

export default function UsersTableClient() {
  const router = useRouter()
  const [rows, setRows] = useState<LoginRow[]>([])
  const [fetchError, setFetchError] = useState<string | null>(null)
  useEffect(() => {
    fetch('/api/admin/users', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.users) { setRows(d.users); setFetchError(null) }
        else setFetchError(d.error || 'Unexpected response')
      })
      .catch(e => setFetchError(String(e)))
  }, [])
  const [page, setPage]     = useState(1)
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  // Login type change modal
  const [typeRow,    setTypeRow]    = useState<LoginRow | null>(null)
  const [newType,    setNewType]    = useState<number>(0)
  const [typeBusy,   setTypeBusy]   = useState(false)

  // Toggle active confirm
  const [toggleRow,  setToggleRow]  = useState<LoginRow | null>(null)
  const [toggleBusy, setToggleBusy] = useState(false)

  // Edit name modal
  const [nameRow,    setNameRow]    = useState<LoginRow | null>(null)
  const [nameForm,   setNameForm]   = useState({ firstName: '', lastName: '' })
  const [nameBusy,   setNameBusy]   = useState(false)

  function handleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  function si(col: string): JSX.Element {
    if (sortCol !== col) return <span className="ml-1 opacity-40 text-[10px]">↕</span>
    return <span className="ml-1 text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }
  function sortRows(arr: LoginRow[]): LoginRow[] {
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

  const displayName = (r: LoginRow) =>
    [r.first_name, r.last_name].filter(Boolean).join(' ') || r.user_name || r.login_username

  const q = search.toLowerCase()
  const filtered = rows.filter(r =>
    !q || displayName(r).toLowerCase().includes(q) ||
    r.login_username.toLowerCase().includes(q) ||
    r.user_email.toLowerCase().includes(q)
  )
  const pageRows = sortRows(filtered).slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  function openTypeModal(row: LoginRow) {
    setTypeRow(row)
    setNewType(row.login_type)
  }

  function openNameModal(row: LoginRow) {
    setNameRow(row)
    setNameForm({ firstName: row.first_name || '', lastName: row.last_name || '' })
  }

  async function handleNameSave(e: React.FormEvent) {
    e.preventDefault()
    if (!nameRow) return
    setNameBusy(true)
    try {
      const res  = await fetch('/api/admin/users', {
        credentials: 'include',
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ loginId: nameRow.loginId, firstName: nameForm.firstName, lastName: nameForm.lastName }),
      })
      const data = await res.json()
      if (data.success) {
        showToast('Name updated successfully')
        setRows(prev => prev.map(r => r.loginId === nameRow.loginId
          ? { ...r, first_name: nameForm.firstName, last_name: nameForm.lastName }
          : r
        ))
        setNameRow(null)
      } else {
        showToast(data.error || 'Update failed', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setNameBusy(false)
  }

  async function handleTypeChange(e: React.FormEvent) {
    e.preventDefault()
    if (!typeRow) return
    setTypeBusy(true)
    try {
      const res  = await fetch('/api/admin/users', {
        credentials: 'include',
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ loginId: typeRow.loginId, loginType: newType }),
      })
      const data = await res.json()
      if (data.success) {
        showToast('Login type updated successfully')
        setRows(prev => prev.map(r => r.loginId === typeRow.loginId ? { ...r, login_type: newType } : r))
        setTypeRow(null)
      } else {
        showToast(data.error || 'Update failed', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setTypeBusy(false)
  }

  async function handleToggleActive() {
    if (!toggleRow) return
    setToggleBusy(true)
    try {
      const res  = await fetch('/api/admin/users', {
        credentials: 'include',
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ loginId: toggleRow.loginId, isActive: toggleRow.is_active !== 1 }),
      })
      const data = await res.json()
      if (data.success) {
        showToast(toggleRow.is_active === 1 ? 'User deactivated' : 'User activated')
        setRows(prev => prev.map(r => r.loginId === toggleRow.loginId ? { ...r, is_active: r.is_active === 1 ? 0 : 1 } : r))
        setToggleRow(null)
        router.refresh()
      } else {
        showToast(data.error || 'Update failed', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setToggleBusy(false)
  }

  if (fetchError) return (
    <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
      Failed to load users: <strong>{fetchError}</strong>
    </div>
  )

  return (
    <>
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-[#14254A]">{filtered.length} user{filtered.length !== 1 ? 's' : ''}</span>
          <input
            autoComplete="off"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search by name, username, email…"
            className="border border-gray-200 rounded-xl px-3 py-1.5 text-xs w-60 focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="cursor-pointer select-none" onClick={() => handleSort('loginId')}>#<>{si('loginId')}</></th>
                <th className="cursor-pointer select-none" onClick={() => handleSort('first_name')}>Name<>{si('first_name')}</></th>
                <th className="cursor-pointer select-none" onClick={() => handleSort('login_username')}>Username<>{si('login_username')}</></th>
                <th className="cursor-pointer select-none" onClick={() => handleSort('user_name')}>Account<>{si('user_name')}</></th>
                <th className="cursor-pointer select-none" onClick={() => handleSort('login_type')}>Login Type<>{si('login_type')}</></th>
                <th className="cursor-pointer select-none" onClick={() => handleSort('is_active')}>Status<>{si('is_active')}</></th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-8 text-brand-muted">No users found</td></tr>
              ) : pageRows.map(r => (
                <tr key={r.loginId}>
                  <td className="text-xs text-gray-400">#{r.loginId}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-white text-xs flex-shrink-0"
                        style={{ background: 'linear-gradient(135deg,#0078D4,#004E8C)' }}>
                        {displayName(r).charAt(0).toUpperCase()}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div>
                          <p className="text-sm font-medium text-gray-800">{displayName(r)}</p>
                          <p className="text-xs text-brand-muted">{r.user_email}</p>
                        </div>
                        <button
                          onClick={() => openNameModal(r)}
                          title="Edit name"
                          className="p-1 rounded-lg text-gray-300 hover:text-[#0078D4] hover:bg-blue-50 transition-colors flex-shrink-0">
                          <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  </td>
                  <td className="text-xs font-mono text-gray-600">{r.login_username}</td>
                  <td className="text-xs text-gray-600">
                    {r.user_name}
                    {r.role === 1 && <span className="ml-1 badge badge-info text-[10px]">Admin</span>}
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <LoginTypeBadge type={r.login_type} />
                      <button
                        onClick={() => openTypeModal(r)}
                        className="text-[10px] font-medium text-[#0078D4] hover:underline"
                        title="Change login type">
                        change
                      </button>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${r.is_active === 1 ? 'badge-success' : 'badge-danger'}`}>
                      {r.is_active === 1 ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>
                    <button
                      onClick={() => setToggleRow(r)}
                      className={`text-xs font-medium hover:underline ${r.is_active === 1 ? 'text-red-600' : 'text-green-600'}`}>
                      {r.is_active === 1 ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <PaginationBar page={page} total={filtered.length} onChange={setPage} />
      </div>

      {/* ── Change Login Type Modal ─────────────────────────────── */}
      {typeRow && (
        <AdminModal onClose={() => !typeBusy && setTypeRow(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 text-white" style={{ background: '#14254A' }}>
              <div>
                <h3 className="font-bold text-sm">Change Login Type</h3>
                <p className="text-white/60 text-xs mt-0.5">{displayName(typeRow)}</p>
              </div>
              <button onClick={() => !typeBusy && setTypeRow(null)}
                className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>

            <form onSubmit={handleTypeChange} className="p-5 space-y-3">
              {LOGIN_TYPES.map(lt => (
                <label key={lt.value}
                  className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${newType === lt.value ? 'border-[#0078D4] bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                  <input
                    type="radio"
                    name="loginType"
                    value={lt.value}
                    checked={newType === lt.value}
                    onChange={() => setNewType(lt.value)}
                    className="mt-0.5 accent-[#0078D4]"
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-800">{lt.label}</span>
                      {typeRow.login_type === lt.value && (
                        <span className="text-[10px] font-medium text-gray-400 border border-gray-200 px-1.5 py-0.5 rounded">current</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{lt.desc}</p>
                  </div>
                </label>
              ))}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => !typeBusy && setTypeRow(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={typeBusy || newType === typeRow.login_type}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-all"
                  style={{ background: '#14254A' }}>
                  {typeBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* ── Edit Name Modal ────────────────────────────────────── */}
      {nameRow && (
        <AdminModal onClose={() => !nameBusy && setNameRow(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 text-white" style={{ background: '#14254A' }}>
              <div>
                <h3 className="font-bold text-sm">Edit Name</h3>
                <p className="text-white/60 text-xs mt-0.5">{nameRow.login_username}</p>
              </div>
              <button onClick={() => !nameBusy && setNameRow(null)}
                className="text-white/70 hover:text-white text-xl leading-none">×</button>
            </div>
            <form onSubmit={handleNameSave} className="p-5 space-y-4">
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  First Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={nameForm.firstName}
                  onChange={e => setNameForm(p => ({ ...p, firstName: e.target.value }))}
                  placeholder="Enter first name"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A]"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Last Name
                </label>
                <input
                  type="text"
                  value={nameForm.lastName}
                  onChange={e => setNameForm(p => ({ ...p, lastName: e.target.value }))}
                  placeholder="Enter last name"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A]"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => !nameBusy && setNameRow(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={nameBusy}
                  className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-all"
                  style={{ background: '#14254A' }}>
                  {nameBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </AdminModal>
      )}

      {/* ── Toggle Active Confirm Modal ─────────────────────────── */}
      {toggleRow && (
        <AdminModal onClose={() => !toggleBusy && setToggleRow(null)}>
          <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-bold text-sm text-gray-800">
                {toggleRow.is_active === 1 ? 'Deactivate User' : 'Activate User'}
              </h3>
              <button onClick={() => !toggleBusy && setToggleRow(null)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600">
                {toggleRow.is_active === 1
                  ? <>Are you sure you want to deactivate <strong>{displayName(toggleRow)}</strong>? They will no longer be able to log in.</>
                  : <>Activate <strong>{displayName(toggleRow)}</strong>? They will regain access to the portal.</>
                }
              </p>
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => !toggleBusy && setToggleRow(null)}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleToggleActive} disabled={toggleBusy}
                  className={`px-5 py-2 rounded-xl text-sm font-medium border disabled:opacity-50 transition-colors ${toggleRow.is_active === 1 ? 'border-gray-300 text-red-600 hover:bg-red-50' : 'border-gray-300 text-green-700 hover:bg-green-50'}`}>
                  {toggleBusy ? '…' : toggleRow.is_active === 1 ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            </div>
          </div>
        </AdminModal>
      )}
    </>
  )
}
