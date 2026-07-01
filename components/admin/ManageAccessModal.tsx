'use client'

import { useState, useEffect } from 'react'
import AdminModal from './AdminModal'
import { CONFIG_MODULES } from '@/lib/configModules'

type Role = 'client' | 'admin' | 'superadmin'

const ROLE_INFO: Record<Role, { num: number; label: string; color: string; bg: string }> = {
  client:     { num: 0, label: 'Client',      color: '#6b7280', bg: 'rgba(107,114,128,0.08)' },
  admin:      { num: 1, label: 'Admin',       color: '#0078D4', bg: 'rgba(0,120,212,0.08)'   },
  superadmin: { num: 2, label: 'Super Admin', color: '#7C3AED', bg: 'rgba(124,58,237,0.08)'  },
}
const ROLE_BY_NUM: Record<number, Role> = { 0: 'client', 1: 'admin', 2: 'superadmin' }

interface Props {
  loginUsername: string
  displayName:   string
  companiesLabel?: string
  initialRole:   number
  onClose:       () => void
  onChanged:     (newRole: number) => void
}

/**
 * Single place to manage a person's portal role (Client/Admin/Super Admin)
 * and, when elevated, which Configuration modules they can see. Identity is
 * always login_username/email — one person, one set of controls, regardless
 * of how many client companies share that login.
 */
export default function ManageAccessModal({
  loginUsername, displayName, companiesLabel, initialRole, onClose, onChanged,
}: Props) {
  const [role,       setRole]       = useState<Role>(ROLE_BY_NUM[initialRole] ?? 'client')
  const [personId,   setPersonId]   = useState<number | null>(null)
  const [granted,    setGranted]    = useState<Set<string>>(new Set())
  const [pendingRole, setPendingRole] = useState<Role | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [roleBusy,   setRoleBusy]   = useState(false)
  const [moduleBusy, setModuleBusy] = useState<string | null>(null)
  const [toast,      setToast]      = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function loadAccess() {
    setLoading(true)
    try {
      const res  = await fetch(`/api/admin/super-admin/config-access?loginUsername=${encodeURIComponent(loginUsername)}`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        setRole(ROLE_BY_NUM[data.role ?? 0] ?? 'client')
        setPersonId(data.id ?? null)
        setGranted(new Set<string>(data.granted || []))
      }
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { loadAccess() }, [loginUsername])

  async function confirmRoleChange() {
    if (!pendingRole) return
    setRoleBusy(true)
    try {
      const res  = await fetch('/api/admin/super-admin', {
        credentials: 'include',
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ loginUsername, role: pendingRole, source: 'user' }),
      })
      const data = await res.json()
      if (data.success) {
        showToast(`Role set to ${ROLE_INFO[pendingRole].label}`)
        setPendingRole(null)
        onChanged(ROLE_INFO[pendingRole].num)
        await loadAccess()
      } else {
        showToast(data.error || 'Failed to change role', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setRoleBusy(false)
  }

  async function toggleModule(key: string) {
    if (!personId) return
    const grant = !granted.has(key)
    setModuleBusy(key)
    try {
      const res  = await fetch('/api/admin/super-admin/config-access', {
        credentials: 'include',
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ loginId: personId, moduleKey: key, grant }),
      })
      const data = await res.json()
      if (data.success) {
        setGranted(prev => {
          const next = new Set(prev)
          if (grant) next.add(key); else next.delete(key)
          return next
        })
      } else {
        showToast(data.error || 'Failed', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setModuleBusy(null)
  }

  const ri = ROLE_INFO[role]

  return (
    <AdminModal onClose={() => !roleBusy && onClose()}>
      <div className="admin-modal-panel bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        {toast && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
            {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
          </div>
        )}

        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100" style={{ background: '#14254A' }}>
          <div>
            <h3 className="font-bold text-white text-base">Manage Access</h3>
            <p className="text-white/60 text-xs mt-0.5">{displayName} · {loginUsername}</p>
            {companiesLabel && <p className="text-white/40 text-[11px] mt-0.5">{companiesLabel}</p>}
          </div>
          <button onClick={() => !roleBusy && onClose()} className="text-white/70 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="p-6">
          {/* Role selector */}
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Role</p>
          <div className="flex gap-2 mb-2">
            {(['client', 'admin', 'superadmin'] as Role[]).map(r => {
              const info = ROLE_INFO[r]
              const active = role === r
              return (
                <button key={r} disabled={loading || roleBusy} onClick={() => r !== role && setPendingRole(r)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold border-2 transition-all disabled:opacity-50"
                  style={active
                    ? { borderColor: info.color, background: info.bg, color: info.color }
                    : { borderColor: '#e5e7eb', color: '#6b7280' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: active ? info.color : '#d1d5db' }} />
                  {info.label}
                </button>
              )
            })}
          </div>

          {pendingRole && (
            <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 mb-4">
              <p className="text-xs text-amber-800">
                Change role to <strong>{ROLE_INFO[pendingRole].label}</strong>?
                {pendingRole === 'client' && ' They will lose all portal/config access immediately.'}
              </p>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => setPendingRole(null)} disabled={roleBusy}
                  className="px-3 py-1 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-white">
                  Cancel
                </button>
                <button onClick={confirmRoleChange} disabled={roleBusy}
                  className="px-3 py-1 rounded-lg text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50">
                  {roleBusy ? '…' : 'Confirm'}
                </button>
              </div>
            </div>
          )}

          {/* Configuration modules */}
          {role !== 'client' && (
            <>
              <div className="flex items-center justify-between mt-4 mb-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Configuration Modules</p>
                <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                  {granted.size} / {CONFIG_MODULES.length} shared
                </span>
              </div>
              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <span className="w-6 h-6 border-2 border-[#14254A] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : !personId ? (
                <p className="text-xs text-gray-400 text-center py-6">Unable to resolve this admin's access record.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {CONFIG_MODULES.map(mod => {
                    const enabled = granted.has(mod.key)
                    const busy    = moduleBusy === mod.key
                    return (
                      <button key={mod.key} onClick={() => toggleModule(mod.key)} disabled={busy}
                        className={`relative flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 text-center transition-all disabled:opacity-60 ${
                          enabled ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                        }`}>
                        {busy && (
                          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/70">
                            <span className="w-4 h-4 border-2 border-[#14254A] border-t-transparent rounded-full animate-spin" />
                          </div>
                        )}
                        <span className="text-lg">{mod.icon}</span>
                        <p className={`text-[11px] font-semibold leading-tight ${enabled ? 'text-emerald-700' : 'text-gray-500'}`}>{mod.title}</p>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${enabled ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                          {enabled ? 'Shared' : 'Not shared'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </AdminModal>
  )
}
