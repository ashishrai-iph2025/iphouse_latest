'use client'

import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import { useSession } from '@/lib/auth-client'
import UserPicker, { type MasterUser } from './UserPicker'
import LoginSecurityPanel from './LoginSecurityPanel'

interface LoginGroup {
  loginId: number
  login_username: string
  login_type: number
  twofa_secret: string | null
  first_name: string | null
  last_name: string | null
  designation: string | null
  allUserIds: string   // "1,2,3"
  master_names: string
  portal_role: string | null   // 'Admin' | 'SuperAdmin' | null — role of the PERSON, not any one client company
}

// portal_role is granted to the shared login (the person) itself, independent
// of dcp_user.role for any of the client companies they're assigned to.
function portalRoleNum(r: string | null): 0 | 1 | 2 {
  if (r === 'SuperAdmin') return 2
  if (r === 'Admin') return 1
  return 0
}

const PORTAL_ROLE_LABEL: Record<number, { label: string; color: string; bg: string }> = {
  2: { label: 'Super Admin', color: '#7C3AED', bg: 'rgba(124,58,237,0.08)' },
  1: { label: 'Admin',       color: '#0078D4', bg: 'rgba(0,120,212,0.08)'  },
  0: { label: 'Client',      color: '#6b7280', bg: 'rgba(107,114,128,0.08)'},
}

const LOGIN_TYPES = [
  { value: 0, label: 'Email OTP',        badge: 'badge-info'    },
  { value: 1, label: 'Authenticator App', badge: 'badge-warning' },
  { value: 2, label: 'Password Login',   badge: 'badge-muted'   },
]

const BLANK_FORM = {
  login_username: '', login_password: '', login_type: 0,
  twofa_secret: '', first_name: '', last_name: '', designation: '',
  userIds: [] as number[],
}

function typeInfo(t: number) {
  return LOGIN_TYPES.find(x => x.value === t) ?? { label: 'Unknown', badge: 'badge-muted' }
}

type LoginForm = typeof BLANK_FORM

/* ── Form panel (shared by Add + Edit modals) ──────────────────────────────
 *
 * Declared HERE, at module scope, and not inside SharedLoginsClient. A
 * component defined inside another is a NEW function identity on every parent
 * render, so React compares element types, finds them unequal, and unmounts
 * the whole subtree to mount a fresh one. The <input> DOM nodes go with it —
 * which is why typing one character used to drop focus and the field appeared
 * to freeze until it was clicked again. Same identity every render, and the
 * inputs are merely updated in place. */
const NAVY = '#14254A'
const ORANGE = '#FC934C'

/** One input, styled once. The focus ring was Tailwind's stock blue, which
    belongs to no part of this product; it picks up the accent instead. */
const inputCls =
  'w-full rounded-xl px-3 py-2.5 text-sm border transition-colors ' +
  'bg-white border-gray-200 text-[#14254A] placeholder-gray-400 ' +
  'focus:outline-none focus:border-[#FC934C] focus:ring-2 focus:ring-[#FC934C]/20 ' +
  'dark:bg-white/5 dark:border-white/15 dark:text-white dark:placeholder-white/30'

const labelCls =
  'block text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1.5'

/**
 * One group of related fields, as a card.
 *
 * The drawer held eight controls in a single column with nothing between them,
 * so "which of these is about the person and which is about signing in" was a
 * question the reader had to answer by reading every label. Grouping them is
 * not decoration: it is the difference between a form you scan and a form you
 * parse.
 */
function Section({ icon, title, hint, children }: {
  icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-gray-100 dark:border-white/10
      bg-white dark:bg-[#1a2d55] shadow-card overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-gray-100 dark:border-white/10">
        <span className="w-7 h-7 rounded-lg grid place-items-center flex-shrink-0"
          style={{ background: 'rgba(252,147,76,0.14)' }}>
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block text-[11px] font-bold uppercase tracking-widest text-[#14254A] dark:text-white">
            {title}
          </span>
          {hint && <span className="block text-[10px] text-gray-400 truncate">{hint}</span>}
        </span>
      </div>
      <div className="p-4 space-y-3.5">{children}</div>
    </section>
  )
}

/* Small line-art rather than emoji: emoji render at a different weight on every
   platform and would be the only thing on this panel that does. */
const ICON = { stroke: ORANGE, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
const PersonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...ICON}>
    <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
  </svg>
)
const KeyIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...ICON}>
    <circle cx="8" cy="14" r="4" /><path d="M11 11l9-9M17 5l2 2M14 8l2 2" />
  </svg>
)
const UsersIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...ICON}>
    <circle cx="9" cy="8" r="3.2" /><path d="M2.5 20c0-3.4 2.9-5.2 6.5-5.2s6.5 1.8 6.5 5.2" />
    <path d="M16.5 5.6a3.2 3.2 0 0 1 0 5.6M18 14.9c2.2.6 3.5 2.1 3.5 4.4" />
  </svg>
)

/* ── Form panel (shared by Add + Edit) ─────────────────────────────────────
 *
 * Declared HERE, at module scope, and not inside SharedLoginsClient. A
 * component defined inside another is a NEW function identity on every parent
 * render, so React compares element types, finds them unequal, and unmounts
 * the whole subtree to mount a fresh one. The <input> DOM nodes go with it —
 * which is why typing one character used to drop focus and the field appeared
 * to freeze until it was clicked again. Same identity every render, and the
 * inputs are merely updated in place. */
function FormFields({ form, setForm, isEdit, masterUsers }: {
  form:        LoginForm
  setForm:     Dispatch<SetStateAction<LoginForm>>
  isEdit:      boolean
  masterUsers: MasterUser[]
}) {
  return (
    <div className="space-y-4">

      <Section icon={<PersonIcon />} title="Person" hint="How this account is named around the portal">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>First name</label>
            <input type="text" value={form.first_name} className={inputCls}
              onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} />
          </div>
          <div>
            <label className={labelCls}>Last name</label>
            <input type="text" value={form.last_name} className={inputCls}
              onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Designation</label>
          <input type="text" value={form.designation} className={inputCls}
            onChange={e => setForm(f => ({ ...f, designation: e.target.value }))} />
        </div>
      </Section>

      <Section icon={<KeyIcon />} title="Sign-in" hint="The credential and how it is verified">
        <div>
          <label className={labelCls}>
            Login username <span style={{ color: ORANGE }}>*</span>
          </label>
          <input type="text" value={form.login_username} readOnly={isEdit}
            onChange={e => setForm(f => ({ ...f, login_username: e.target.value }))}
            className={`${inputCls} ${isEdit ? 'bg-gray-50 text-gray-500 cursor-not-allowed dark:bg-white/[0.03]' : ''}`} />
          {isEdit && (
            <p className="text-[10px] text-gray-400 mt-1">
              The username is the account&rsquo;s identity and cannot be changed here.
            </p>
          )}
        </div>

        <div>
          <label className={labelCls}>Password</label>
          <input type="password" value={form.login_password} autoComplete="new-password"
            className={inputCls}
            placeholder={isEdit ? 'Leave blank to keep the current one' : 'At least 8 characters'}
            onChange={e => setForm(f => ({ ...f, login_password: e.target.value }))} />
        </div>

        <div>
          <label className={labelCls}>Login type</label>
          <select value={form.login_type} className={inputCls}
            onChange={e => setForm(f => ({ ...f, login_type: Number(e.target.value) }))}>
            {LOGIN_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>

        {form.login_type === 1 && (
          <div>
            <label className={labelCls}>Authenticator secret</label>
            <input type="text" value={form.twofa_secret} placeholder="TOTP base32 secret"
              className={`${inputCls} font-mono`}
              onChange={e => setForm(f => ({ ...f, twofa_secret: e.target.value }))} />
          </div>
        )}
      </Section>

      <Section icon={<UsersIcon />} title="Access"
        hint={isEdit ? 'Deselect a company to remove this login’s access to it' : 'The companies this login may read'}>
        <div>
          <label className={labelCls}>
            Assigned client dashboards <span style={{ color: ORANGE }}>*</span>
          </label>
          <UserPicker users={masterUsers} selected={form.userIds}
            onChange={ids => setForm(f => ({ ...f, userIds: ids }))} />
        </div>
      </Section>
    </div>
  )
}

export default function SharedLoginsClient() {
  const { data: session } = useSession()
  const isSuperAdmin = (session?.user as any)?.role === 2

  const [logins,      setLogins]      = useState<LoginGroup[]>([])
  const [masterUsers, setMasterUsers] = useState<MasterUser[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [search,      setSearch]      = useState('')

  const [modal,       setModal]       = useState<'add' | 'edit' | 'delete' | null>(null)
  const [form,        setForm]        = useState({ ...BLANK_FORM })
  const [editTarget,  setEditTarget]  = useState<LoginGroup | null>(null)
  const [delTarget,   setDelTarget]   = useState<LoginGroup | null>(null)
  const [saving,      setSaving]      = useState(false)
  const [saveMsg,     setSaveMsg]     = useState('')
  const [sortCol, setSortCol] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const [page,    setPage]    = useState(1)
  const PER_PAGE = 15

  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const searchRef = useRef<HTMLInputElement>(null)

  async function load() {
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/admin/shared-logins', { credentials: 'include' })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to load'); return }
      setLogins(data.logins)
      setMasterUsers(data.masterUsers)
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function openAdd() {
    setForm({ ...BLANK_FORM }); setSaveMsg(''); setModal('add')
  }

  function openEdit(row: LoginGroup) {
    setEditTarget(row)
    const ids = row.allUserIds ? row.allUserIds.split(',').map(Number).filter(Boolean) : []
    setForm({
      login_username: row.login_username,
      login_password: '',
      login_type:     row.login_type,
      twofa_secret:   row.twofa_secret ?? '',
      first_name:     row.first_name ?? '',
      last_name:      row.last_name ?? '',
      designation:    row.designation ?? '',
      userIds:        ids,
    })
    setSaveMsg(''); setModal('edit')
  }

  function openDelete(row: LoginGroup) {
    setDelTarget(row); setModal('delete')
  }

  function closeModal() {
    setModal(null); setSaveMsg('')
  }

  /* Escape closes the drawer — but never mid-save, where it would leave the
     request in flight with nothing on screen to say whether it landed. */
  useEffect(() => {
    if (!modal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal, saving])

  async function handleSave() {
    if (!form.login_username.trim()) { setSaveMsg('Login username is required'); return }
    if (form.userIds.length === 0)   { setSaveMsg('Select at least one client dashboard'); return }
    setSaving(true); setSaveMsg('')
    try {
      const res  = await fetch('/api/admin/shared-logins', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: modal === 'add' ? 'add' : 'update', ...form }),
      })
      const data = await res.json()
      if (!data.success) { setSaveMsg(data.error || 'Save failed'); return }
      closeModal(); load()
    } catch {
      setSaveMsg('Network error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!delTarget) return
    setSaving(true)
    try {
      const res  = await fetch('/api/admin/shared-logins', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'delete', login_username: delTarget.login_username }),
      })
      const data = await res.json()
      if (!data.success) { setSaveMsg(data.error || 'Delete failed'); return }
      closeModal(); load()
    } catch {
      setSaveMsg('Network error')
    } finally {
      setSaving(false)
    }
  }

  function handleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  function si(col: string): JSX.Element {
    if (sortCol !== col) return <span className="ml-1 opacity-40 text-[10px]">↕</span>
    return <span className="ml-1 text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }
  function sortRows(arr: LoginGroup[]): LoginGroup[] {
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

  const filtered = logins.filter(r =>
    r.login_username.toLowerCase().includes(search.toLowerCase()) ||
    (r.first_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (r.last_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (r.master_names ?? '').toLowerCase().includes(search.toLowerCase())
  )

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const paginated  = sortRows(filtered).slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)

  return (
    <div className="p-6 fade-in">

      {/* Header */}

      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#14254A]">Shared Login Accounts</h1>
          <p className="text-brand-muted text-sm mt-1">{logins.length} login group{logins.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={openAdd}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm text-white transition-all hover:opacity-90"
          style={{ background: '#14254A' }}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add Login Account
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-[#14254A]">{filtered.length} account{filtered.length !== 1 ? 's' : ''}</span>
          <input ref={searchRef} type="text" placeholder="Search by username, name, or assigned user…"
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
                  <th className="cursor-pointer select-none" onClick={() => handleSort('first_name')}>Name<>{si('first_name')}</></th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('designation')}>Designation<>{si('designation')}</></th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('login_username')}>Login Username<>{si('login_username')}</></th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('login_type')}>Login Type<>{si('login_type')}</></th>
                  <th>TOTP Secret</th>
                  <th className="cursor-pointer select-none" onClick={() => handleSort('master_names')}>Assigned Dashboards<>{si('master_names')}</></th>
                  {isSuperAdmin && <th>Portal Access</th>}
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginated.length === 0 ? (
                  <tr><td colSpan={isSuperAdmin ? 9 : 8} className="text-center py-10 text-brand-muted">No login accounts found</td></tr>
                ) : paginated.map((row, i) => {
                  const lt = typeInfo(row.login_type)
                  return (
                    <tr key={row.loginId}>
                      <td className="text-xs text-gray-400">{(safePage - 1) * PER_PAGE + i + 1}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-white text-xs shrink-0"
                            style={{ background: 'linear-gradient(135deg,#0078D4,#004E8C)' }}>
                            {((row.first_name || 'U').charAt(0)).toUpperCase()}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-gray-800">
                              {[row.first_name, row.last_name].filter(Boolean).join(' ') || '—'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="text-sm text-gray-600">{row.designation || <span className="text-gray-300">—</span>}</td>
                      <td><code className="text-xs bg-gray-100 px-2 py-0.5 rounded font-mono">{row.login_username}</code></td>
                      <td><span className={`badge ${lt.badge}`}>{lt.label}</span></td>
                      <td>
                        {row.twofa_secret
                          ? <code className="text-xs bg-gray-100 px-2 py-0.5 rounded font-mono text-gray-600 max-w-[120px] truncate block">{row.twofa_secret}</code>
                          : <span className="text-gray-300 text-sm">—</span>
                        }
                      </td>
                      <td className="text-sm text-gray-600 max-w-[200px]">
                        {row.master_names
                          ? <span className="truncate block" title={row.master_names}>{row.master_names}</span>
                          : <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                              Unassigned
                            </span>
                        }
                      </td>
                      {isSuperAdmin && (() => {
                        const pr = portalRoleNum(row.portal_role)
                        const ri = PORTAL_ROLE_LABEL[pr]
                        return (
                          <td>
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold"
                              style={{ color: ri.color, background: ri.bg }}
                              title="Manage from /admin/users">
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: ri.color }} />
                              {ri.label}
                            </span>
                          </td>
                        )
                      })()}
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => openEdit(row)}
                            className="p-1.5 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors" title="Edit">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button onClick={() => openDelete(row)}
                            className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 transition-colors" title="Delete">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
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

      {/* ── ADD / EDIT DRAWER ──────────────────────────────────────────────
          A panel from the right rather than a box in the middle. The editor now
          carries the account's security history alongside its fields, which is
          more than a centred dialog can hold without becoming a scrolling box
          floating in a dimmed page — and the full height of the window is
          exactly the shape a long form and a list of dates want.

          The list stays visible behind it, which is the other reason: the
          question being answered here is usually about one row among many. */}
      {(modal === 'add' || modal === 'edit') && mounted && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', justifyContent: 'flex-end' }}>
          {/* The scrim closes it. A click outside is what everyone tries first,
              and a drawer that ignores it feels stuck. */}
          <div onClick={saving ? undefined : closeModal}
            style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(2,18,46,0.45)' }}
            aria-hidden />

          <div role="dialog" aria-modal="true" aria-label={modal === 'add' ? 'Add login account' : 'Edit login account'}
            /* Half the window on anything desk-sized, the whole of it below
               that — half a phone is not a form. The floor keeps the fields
               from cramping on a small laptop, where 50% is under 500px. */
            className="admin-modal-panel bg-white dark:bg-[#1a2d55] animate-drawer-in
              w-full md:w-1/2 md:min-w-[520px]"
            style={{
              position: 'relative', height: '100%',
              display: 'flex', flexDirection: 'column',
              boxShadow: '-24px 0 60px rgba(2,18,46,0.22)',
            }}>

            {/* Header — pinned, so the title and the close button stay reachable
                however far down the body is scrolled. Navy, like every other
                header band in the admin: the drawer was the one surface that
                looked like an untouched browser dialog. */}
            <div className="flex-shrink-0 flex items-center gap-3 px-6 py-4"
              style={{ background: `linear-gradient(135deg, ${NAVY} 0%, #1d3563 100%)` }}>
              {/* Initials rather than an icon — this panel is always about one
                  named person, and the monogram says which at a glance. */}
              <span className="w-10 h-10 rounded-xl grid place-items-center flex-shrink-0
                text-[13px] font-bold text-white"
                style={{ background: 'rgba(252,147,76,0.22)', border: '1px solid rgba(252,147,76,0.35)' }}>
                {modal === 'add'
                  ? '+'
                  : ((form.first_name?.[0] ?? '') + (form.last_name?.[0] ?? '')).toUpperCase()
                    || (editTarget?.login_username?.[0] ?? '?').toUpperCase()}
              </span>

              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] font-bold text-white leading-tight">
                  {modal === 'add' ? 'Add Login Account' : 'Edit Login Account'}
                </h3>
                {modal === 'edit' && editTarget && (
                  <p className="text-[11px] text-white/55 truncate mt-0.5">{editTarget.login_username}</p>
                )}
              </div>

              {modal === 'edit' && editTarget && (
                <span className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-lg text-[10px] font-bold
                  uppercase tracking-wider text-white/80 flex-shrink-0"
                  style={{ background: 'rgba(255,255,255,0.12)' }}>
                  {typeInfo(editTarget.login_type).label}
                </span>
              )}

              <button onClick={closeModal} aria-label="Close"
                className="w-8 h-8 grid place-items-center rounded-lg text-white/60 hover:text-white
                  hover:bg-white/10 transition-colors flex-shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth={2.4} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>

            {/* Body — the only thing that scrolls. Sunk to the app's page
                colour so the section cards inside it read as cards rather than
                as ruled-off regions of one white sheet. */}
            <div className="flex-1 overflow-y-auto px-5 py-5 bg-[#eef2f7] dark:bg-[#0f1f3d]">
              <FormFields form={form} setForm={setForm}
                isEdit={modal === 'edit'} masterUsers={masterUsers} />

              {/* Only when editing: an account being CREATED has no password
                  history, no notices and no locks, and three empty sections
                  would read as a panel that failed to load. */}
              {modal === 'edit' && editTarget && (
                <div className="mt-4">
                  <LoginSecurityPanel loginId={editTarget.loginId} />
                </div>
              )}

              {saveMsg && (
                <p className="mt-4 rounded-xl px-3.5 py-2.5 text-sm border
                  bg-red-50 border-red-200 text-red-700
                  dark:bg-red-500/10 dark:border-red-400/25 dark:text-red-300">
                  {saveMsg}
                </p>
              )}
            </div>

            {/* Footer — pinned for the same reason as the header: with the
                security detail below the form, Save would otherwise sit some
                distance down a scroll. */}
            <div className="flex-shrink-0 flex items-center justify-end gap-2.5 px-6 py-3.5
              bg-white dark:bg-[#1a2d55] border-t border-gray-100 dark:border-white/10">
              <button onClick={closeModal} disabled={saving}
                className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600
                  hover:bg-gray-50 transition-colors disabled:opacity-50
                  dark:border-white/15 dark:text-white/60 dark:hover:bg-white/5">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving}
                className="px-5 py-2 rounded-xl text-sm font-semibold text-white transition-opacity
                  hover:opacity-90 disabled:opacity-60"
                style={{ background: NAVY }}>
                {saving ? 'Saving…' : modal === 'add' ? 'Save' : 'Update'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── DELETE CONFIRM MODAL ── */}
      {modal === 'delete' && delTarget && mounted && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
          <div className="admin-modal-panel" style={{ borderRadius: 16, width: '100%', maxWidth: 420, maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', boxShadow: '0 24px 60px rgba(2,18,46,0.18)', padding: '28px 28px 24px' }}>
              <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center mb-4 mx-auto">
                <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <h3 className="text-center font-bold text-gray-800 mb-1">Deactivate Login Account</h3>
              <p className="text-center text-sm text-brand-muted mb-6">
                This will deactivate <strong>{delTarget.login_username}</strong> and remove access for all{' '}
                {delTarget.master_names ? `(${delTarget.master_names})` : 'assigned client dashboards'}.
              </p>
              {saveMsg && <p className="text-red-500 text-sm mb-3 text-center">{saveMsg}</p>}
              <div className="flex gap-3">
                <button onClick={closeModal} disabled={saving}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={handleDelete} disabled={saving}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-red-500 hover:bg-red-600 transition-colors disabled:opacity-60">
                  {saving ? 'Deleting…' : 'Deactivate'}
                </button>
              </div>
            </div>
          </div>,
        document.body
      )}

    </div>
  )
}
