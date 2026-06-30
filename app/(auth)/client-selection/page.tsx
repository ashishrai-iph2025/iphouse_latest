'use client'

import { useEffect, useState } from 'react'
import { useRouter } from '@/lib/router'
import { useSession } from '@/lib/auth-client'

interface LoginOption {
  loginId: number
  login_username: string
  userId: number
  account_name: string
  has_api?: number | boolean
}

const SESSION_KEYS = [
  'pending_otp_email',
  'pending_otp_userId',
  'pending_otp_username',
  'pending_login_rows',
  'otp_verified_tempToken',
  'otp_verified_username',
  'pending_multi_tempToken',
]

const AVATAR_GRAD = 'linear-gradient(135deg,#FFC82B 0%,#FC934C 100%)'

export default function ClientSelectionPage() {
  const router = useRouter()
  const { data: session, status, update } = useSession()

  useEffect(() => {
    if (status === 'authenticated') {
      const role = (session?.user as any)?.role
      router.replace(role === 1 || role === 2 ? '/admin/home' : '/dashboard')
    }
  }, [status, session])

  const [rows, setRows]         = useState<LoginOption[]>([])
  const [username, setUsername] = useState('')
  const [tempToken, setTempToken] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  useEffect(() => {
    const raw        = sessionStorage.getItem('pending_login_rows')
    // Prefer the email the user actually typed — it must match the temp token's
    // username. (otp_verified_username could differ for shared client accounts.)
    const storedUser = sessionStorage.getItem('pending_otp_username')
      || sessionStorage.getItem('otp_verified_username')
      || ''
    const storedTok  = sessionStorage.getItem('pending_multi_tempToken')
      || sessionStorage.getItem('otp_verified_tempToken')
      || ''

    if (!raw || !storedUser) { router.replace('/login'); return }

    try {
      const parsed: LoginOption[] = JSON.parse(raw)
      if (parsed.length === 0) { router.replace('/login'); return }
      setRows(parsed)
      setUsername(storedUser)
      setTempToken(storedTok)
    } catch {
      router.replace('/login')
    }
  }, [])

  const selectedRow = rows.find(r => r.loginId === selected) || null

  async function handleContinue() {
    if (!selectedRow) return
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/select-login', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ loginId: selectedRow.loginId, username, password: tempToken }),
      })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to select account'); setLoading(false); return }

      const role = data.user?.role
      if (role !== undefined && role !== null) {
        document.cookie = `userRole=${role}; path=/; max-age=86400`
      }
      SESSION_KEYS.forEach(k => sessionStorage.removeItem(k))
      await update()
      // Navigation handled by useEffect once status === 'authenticated'
    } catch {
      setError('An unexpected error occurred. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#eef1f6', fontFamily: 'Inter, system-ui, sans-serif' }}>

      {/* ── NAVY HEADER BAND ── */}
      <div style={{ background: 'linear-gradient(135deg,#14254A 0%,#22386b 100%)', position: 'relative' }}>
        <div style={{ padding: '28px 32px 56px', position: 'relative' }}>
          <img src="/newlogo.png" alt="IP House" style={{ height: 34, width: 'auto', position: 'absolute', left: 32, top: 24 }} />
          <div style={{ textAlign: 'center', maxWidth: 640, margin: '8px auto 0' }}>
            <h1 style={{ margin: 0, fontSize: 36, fontWeight: 800, color: '#fff', letterSpacing: '-0.01em' }}>
              Select Your <span style={{ color: '#FFC82B' }}>Account</span>
            </h1>
            <p style={{ margin: '10px 0 0', fontSize: 15, color: 'rgba(255,255,255,0.72)' }}>
              You have access to multiple accounts — choose one to continue
            </p>
          </div>
        </div>
      </div>

      {/* ── BODY ── */}
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '32px clamp(16px,4vw,48px) 48px' }}>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#14254A' }}>Your Accounts</h2>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#7C899C' }}>Click an account card to select it, then press Continue</p>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: '#e7ebf2', color: '#14254A', fontSize: 12, fontWeight: 700 }}>
            🏢 {rows.length} account{rows.length !== 1 ? 's' : ''}
          </span>
        </div>

        {error && (
          <div style={{ background: '#fff5f5', border: '1px solid #f3d4d4', color: '#b3091a', borderRadius: 12, padding: '12px 16px', fontSize: 13, marginBottom: 18, textAlign: 'center' }}>
            {error}
          </div>
        )}

        {/* card grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 18 }}>
          {rows.map(row => {
            const isSel = selected === row.loginId
            return (
              <button
                key={row.loginId}
                onClick={() => setSelected(row.loginId)}
                disabled={loading}
                style={{
                  background: '#fff',
                  border: `2px solid ${isSel ? '#FC934C' : '#eef1f6'}`,
                  borderRadius: 16,
                  padding: '28px 20px 24px',
                  cursor: loading ? 'default' : 'pointer',
                  textAlign: 'center',
                  boxShadow: isSel ? '0 8px 24px rgba(252,147,76,0.22)' : '0 2px 10px rgba(13,36,75,0.06)',
                  transform: isSel ? 'translateY(-2px)' : 'none',
                  transition: 'all 0.15s',
                  position: 'relative',
                }}
              >
                {isSel && (
                  <span style={{ position: 'absolute', top: 10, right: 10, width: 20, height: 20, borderRadius: '50%', background: '#FC934C', color: '#fff', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>
                )}
                <div style={{ width: 56, height: 56, borderRadius: 14, background: AVATAR_GRAD, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 20, fontWeight: 800, color: '#fff', boxShadow: '0 4px 12px rgba(252,147,76,0.3)' }}>
                  {row.account_name.slice(0, 2).toUpperCase()}
                </div>
                <p style={{ margin: 0, fontSize: 14.5, fontWeight: 700, color: '#14254A', lineHeight: 1.3 }}>{row.account_name}</p>
                <p style={{ margin: '6px 0 0', fontSize: 12, color: '#7C899C', wordBreak: 'break-word' }}>{row.login_username}</p>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 12,
                  padding: '3px 10px', borderRadius: 20, fontSize: 10.5, fontWeight: 700,
                  background: row.has_api ? 'rgba(43,124,56,0.10)' : 'rgba(124,137,156,0.12)',
                  color: row.has_api ? '#2b7c38' : '#7C899C',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: row.has_api ? '#2b7c38' : '#9aa3b2' }} />
                  {row.has_api ? 'Full access' : 'Limited access'}
                </span>
              </button>
            )
          })}
        </div>

        {/* footer bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 32, paddingTop: 20, borderTop: '1px solid #e2e7ef', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ fontSize: 13, color: selectedRow ? '#14254A' : '#9aa3b2', fontWeight: selectedRow ? 600 : 400 }}>
            {selectedRow ? (
              <>
                Selected: {selectedRow.account_name}
                <span style={{ marginLeft: 8, fontSize: 11, color: selectedRow.has_api ? '#2b7c38' : '#b45309', fontWeight: 600 }}>
                  {selectedRow.has_api ? '· Full data access' : '· Limited access (no API token)'}
                </span>
              </>
            ) : 'No account selected'}
          </div>
          <button
            onClick={handleContinue}
            disabled={!selectedRow || loading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '11px 32px', borderRadius: 12, border: 'none',
              background: selectedRow && !loading ? '#14254A' : '#c6cdd7',
              color: '#fff', fontSize: 14, fontWeight: 700,
              cursor: selectedRow && !loading ? 'pointer' : 'not-allowed',
              transition: 'background 0.15s',
              maxWidth: 320,
            }}
          >
            {loading
              ? <span style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
              : <span>→</span>}
            {loading
              ? 'Signing in…'
              : selectedRow ? `Continue as ${selectedRow.account_name}` : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
