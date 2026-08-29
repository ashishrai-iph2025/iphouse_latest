'use client'

/*
 * Whether this login administers its own client company.
 *
 * A Client Admin gets an Account Access page in their own portal listing every
 * user attached to their company, where they may grant or revoke those users'
 * sign-in. They cannot create users, change credentials, grant this role, or see
 * any other company.
 *
 * ── One switch per company, not one per account ──────────────────────────────
 *
 * The grant lives on dcp_user_login.is_client_admin, and a shared login is one
 * row per company — so "is this person a Client Admin" has as many answers as
 * they have companies, and they are allowed to differ. That is the point: an
 * agency user can run one client's account list without touching another's.
 *
 * Which is why this lists them rather than showing a single switch. A single one
 * would have to pick a row to write, and the account editor's own loginId is
 * MAX() over those rows — whichever company was added last. It would have looked
 * like it worked.
 *
 * ── Why it saves on the switch ───────────────────────────────────────────────
 *
 * Same reason as Valid/Invalid above it: this is a permission on an account, not
 * a field of the form, and it writes a different table through a different
 * endpoint from the one Update posts to.
 *
 * ── Staff ────────────────────────────────────────────────────────────────────
 *
 * An Admin or Super Admin already has portal-wide access, so the grant would
 * mean nothing. The server refuses it; this disables the switch and says so
 * rather than letting the click fail.
 */

import { useCallback, useEffect, useState } from 'react'

const ORANGE = '#FC934C'

interface Row {
  loginId: number
  clientName: string
  isClientAdmin: boolean
  isStaff: boolean
  /** Whether the COMPANY holds usable MarkScan API credentials. Without them a
      Client Admin finds most of the portal empty, so it is worth saying at the
      moment the grant is made rather than leaving them to discover it. */
  hasApi: boolean
}

export default function LoginClientAdmin({ loginIds }: {
  /** The login rows this account has, one per company. */
  loginIds: number[]
}) {
  const [rows,    setRows]    = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState<number | null>(null)
  const [err,     setErr]     = useState('')

  const idKey = loginIds.join(',')

  /* Keyed on the joined string, not the array: the parent builds that array
     inline, so a fresh identity arrives on every render and listing it as a
     dependency is one request per keystroke in the form above. */
  const load = useCallback(async () => {
    if (!idKey) { setLoading(false); setRows([]); return }
    setLoading(true); setErr('')
    try {
      const res = await fetch(`/api/admin/client-admins?loginIds=${idKey}`,
        { credentials: 'include' })
      if (res.status === 403) {
        setErr('You may not manage the Client Admin role.')
        return
      }
      const data = await res.json()
      if (!data?.success) { setErr(data?.error || 'Could not read the Client Admin role'); return }
      setRows((data.users || []).map((u: any) => ({
        loginId: Number(u.loginId),
        clientName: String(u.client_name || '—'),
        isClientAdmin: Number(u.is_client_admin) === 1,
        isStaff: !!u.is_staff && u.is_staff !== 0 && u.is_staff !== '0',
        hasApi: !!u.has_api && u.has_api !== 0 && u.has_api !== '0',
      })))
    } catch {
      setErr('Network error')
    } finally {
      setLoading(false)
    }
  }, [idKey])

  useEffect(() => { load() }, [load])

  async function toggle(row: Row) {
    const next = !row.isClientAdmin
    setBusy(row.loginId); setErr('')
    // Optimistic: the switch IS the feedback, and one that waits on a round trip
    // before moving reads as a click that did not register.
    setRows(rs => rs.map(r => r.loginId === row.loginId ? { ...r, isClientAdmin: next } : r))
    try {
      const res = await fetch('/api/admin/client-admins', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: row.loginId, isClientAdmin: next }),
      })
      const data = await res.json()
      if (!data?.success) {
        setRows(rs => rs.map(r => r.loginId === row.loginId ? { ...r, isClientAdmin: !next } : r))
        setErr(data?.error || 'Could not save')
      }
    } catch {
      setRows(rs => rs.map(r => r.loginId === row.loginId ? { ...r, isClientAdmin: !next } : r))
      setErr('Network error')
    }
    setBusy(null)
  }

  const granted = rows.filter(r => r.isClientAdmin).length

  return (
    <div className="rounded-2xl border border-gray-100 dark:border-white/10
      bg-white dark:bg-[#1a2d55] shadow-card overflow-hidden mt-4">

      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-gray-100 dark:border-white/10">
        <span className="w-7 h-7 rounded-lg grid place-items-center flex-shrink-0"
          style={{ background: 'rgba(252,147,76,0.14)' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={ORANGE}
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 11h-6" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-bold uppercase tracking-widest text-[#14254A] dark:text-white">
            Client Admin
          </span>
          <span className="block text-[10px] text-gray-400 truncate">
            Lets this login govern Account Access for a company, granted per company
          </span>
        </span>
        {!loading && rows.length > 0 && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 flex-shrink-0">
            {granted} of {rows.length}
          </span>
        )}
      </div>

      <div className="p-4 space-y-2">
        <p className="text-[11px] text-gray-500 dark:text-white/50 leading-relaxed">
          A Client Admin sees an <strong>Account Access</strong> page listing every user at
          that company, and may grant or revoke those users&rsquo; sign-in. They cannot create
          users, change credentials, grant this role, or see any other company. A change
          applies from that person&rsquo;s next sign-in.
        </p>

        {err && <p className="text-[11px] text-red-600">{err}</p>}

        {loading ? (
          <p className="text-xs text-gray-400">Reading the Client Admin role…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-white/50 leading-relaxed">
            No company is assigned to this login yet. Tick one under Companies and press
            Update; the role is granted per company.
          </p>
        ) : rows.map(r => (
          <div key={r.loginId}
            className={`flex items-center gap-3 px-3 py-2 rounded-xl border transition-colors ${
              r.isClientAdmin
                ? 'border-emerald-500/40 bg-emerald-500/[0.07]'
                : 'border-gray-100 bg-gray-50 dark:border-white/10 dark:bg-white/[0.03]'}`}>
            <button type="button" onClick={() => toggle(r)}
              disabled={busy === r.loginId || r.isStaff}
              role="switch" aria-checked={r.isClientAdmin}
              title={r.isStaff
                ? 'This login is IP House staff and already has full access'
                : r.isClientAdmin ? 'Client Admin — click to revoke' : 'Click to grant Client Admin'}
              className={`relative inline-flex items-center h-5 w-9 rounded-full flex-shrink-0
                transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  r.isClientAdmin ? 'bg-emerald-500' : 'bg-gray-200 dark:bg-white/15'}`}>
              <span className={`inline-block w-[15px] h-[15px] bg-white rounded-full shadow transform
                transition-transform ${r.isClientAdmin ? 'translate-x-[20px]' : 'translate-x-[3px]'}`} />
            </button>

            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-[#14254A] dark:text-white truncate">
                {r.clientName}
              </span>
              <span className="block text-[10px] text-gray-400">
                {r.isStaff
                  ? 'IP House staff — already has full access'
                  : busy === r.loginId ? 'Saving…'
                  : r.isClientAdmin ? 'Governs this company’s Account Access'
                  : 'Ordinary user of this company'}
              </span>
            </span>

            {/* Said only where it bites: a Client Admin of a company with no
                MarkScan credentials gets the page and finds the rest of the
                portal empty, because the data screens need that token. */}
            {r.isClientAdmin && !r.hasApi && (
              <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 flex-shrink-0"
                title="This company has no MarkScan API credentials, so its data pages will be empty">
                No API access
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
