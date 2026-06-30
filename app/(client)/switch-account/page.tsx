'use client'

import { useState, useEffect, useMemo } from 'react'
import { useSession } from '@/lib/auth-client'
import { useTheme } from '@/lib/ThemeContext'

interface Account {
  userId:        number
  loginId:       number
  client_name:   string
  client_email?: string
  has_api?:      number | boolean
}

/* brand palette */
const NAVY   = '#14254A'
const ORANGE = '#FC934C'
const YELLOW = '#FFC82B'
const GREEN  = '#2b7c38'
const SLATE  = '#7C899C'
const BORD   = '#e8ebf0'

const AVATAR_GRAD = 'linear-gradient(135deg,#FFC82B 0%,#FC934C 100%)'

export default function SwitchAccountPage() {
  const { data: session } = useSession()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  // theme-aware surface colors
  const CARD_BG   = isDark ? '#1c2f58' : '#fff'
  const CARD_BORD = isDark ? 'rgba(255,255,255,0.1)' : BORD
  const TITLE     = isDark ? '#e2e8f0' : NAVY
  const SUBTLE    = isDark ? '#7f9ab4' : SLATE
  const INPUT_BG  = isDark ? 'rgba(255,255,255,0.06)' : '#fff'
  const currentLoginId = (session?.user as any)?.loginId

  const [accounts,  setAccounts]  = useState<Account[]>([])
  const [loading,   setLoading]   = useState(true)
  const [switching, setSwitching] = useState<number | null>(null)
  const [error,     setError]     = useState('')
  const [filter,    setFilter]    = useState('')

  useEffect(() => {
    fetch('/api/auth/switch-account', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.success) setAccounts(d.accounts)
        else setError(d.error || 'Failed to load accounts')
      })
      .catch(() => setError('Network error'))
      .finally(() => setLoading(false))
  }, [])

  async function handleSwitch(account: Account) {
    if (account.loginId === currentLoginId) return
    setError(''); setSwitching(account.loginId)
    try {
      const res  = await fetch('/api/auth/switch-account', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:    JSON.stringify({ loginId: account.loginId }),
      })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Switch failed'); setSwitching(null); return }
      const role = data.user?.role
      if (role !== undefined) {
        document.cookie = `userRole=${role ?? ''}; path=/; max-age=1800; SameSite=Lax`
      }
      window.location.href = '/dashboard'
    } catch {
      setError('An unexpected error occurred.')
      setSwitching(null)
    }
  }

  const currentAccount = accounts.find(a => a.loginId === currentLoginId)
  const others = accounts.filter(a => a.loginId !== currentLoginId)
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? others.filter(a => a.client_name.toLowerCase().includes(q) || (a.client_email || '').toLowerCase().includes(q)) : others
  }, [others, filter])

  const initials = (s: string) => (s || '?').slice(0, 2).toUpperCase()

  return (
    <div className="fade-in" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>

      {/* ── Breadcrumb ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: SUBTLE, marginBottom: 14 }}>
        <span style={{ fontWeight: 700, color: TITLE }}>Switch Account</span>
      </div>

      {/* ── Hero: current session ── */}
      <div style={{ background: `linear-gradient(135deg,${NAVY} 0%,#22386b 100%)`, borderRadius: 18, padding: '24px 28px', marginBottom: 22, position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          {currentAccount && (
            <div style={{ width: 56, height: 56, borderRadius: 14, background: AVATAR_GRAD, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 800, color: '#fff', flexShrink: 0, boxShadow: '0 4px 14px rgba(252,147,76,0.4)' }}>
              {initials(currentAccount.client_name)}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>Currently Active</p>
            <h1 style={{ margin: '3px 0 0', fontSize: 22, fontWeight: 800, color: '#fff' }}>
              {currentAccount?.client_name || 'Your Account'}
            </h1>
            {currentAccount?.client_email && (
              <p style={{ margin: '3px 0 0', fontSize: 12.5, color: 'rgba(255,255,255,0.6)' }}>{currentAccount.client_email}</p>
            )}
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 20, background: 'rgba(43,124,56,0.25)', border: '1px solid rgba(74,222,128,0.4)', color: '#bbf7d0', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#4ade80' }} />
            Active Session
          </span>
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div style={{ background: '#fff5f5', border: '1px solid #f3d4d4', color: '#b3091a', borderRadius: 12, padding: '12px 16px', fontSize: 13, marginBottom: 18 }}>
          {error}
        </div>
      )}

      {/* ── Available accounts ── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: TITLE }}>Switch to another account</h2>
          <p style={{ margin: '3px 0 0', fontSize: 12.5, color: SUBTLE }}>
            {loading ? 'Loading…' : `${others.length} other account${others.length !== 1 ? 's' : ''} available`}
          </p>
        </div>
        {others.length > 5 && (
          <div style={{ position: 'relative' }}>
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search accounts…"
              style={{ padding: '9px 12px', borderRadius: 10, border: `1px solid ${CARD_BORD}`, fontSize: 13, color: TITLE, background: INPUT_BG, outline: 'none', width: 240, boxSizing: 'border-box' }} />
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '64px 0', gap: 14 }}>
          <span style={{ width: 36, height: 36, border: `3px solid ${BORD}`, borderTopColor: NAVY, borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
          <p style={{ fontSize: 13, color: SLATE }}>Loading accounts…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ background: CARD_BG, border: `1px dashed ${CARD_BORD}`, borderRadius: 16, padding: '56px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>🗂️</div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: TITLE }}>No accounts found</p>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: SUBTLE }}>
            {filter ? 'Try a different search term.' : 'No other accounts are linked to your login.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 16 }}>
          {filtered.map(account => {
            const isSwitching = switching === account.loginId
            const full = !!account.has_api
            return (
              <div key={account.loginId}
                style={{ background: CARD_BG, border: `1px solid ${CARD_BORD}`, borderRadius: 16, padding: 18, boxShadow: isDark ? '0 4px 18px rgba(0,0,0,0.35)' : '0 2px 10px rgba(13,36,75,0.05)', display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 44, height: 44, borderRadius: 12, background: AVATAR_GRAD, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: '#fff', flexShrink: 0 }}>
                    {initials(account.client_name)}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: TITLE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={account.client_name}>{account.client_name}</p>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 10.5, fontWeight: 700, color: full ? GREEN : SLATE }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: full ? GREEN : '#c6cdd7' }} />
                      {full ? 'Full access' : 'Limited access'}
                    </span>
                  </div>
                </div>
                <button onClick={() => handleSwitch(account)} disabled={switching !== null}
                  style={{
                    width: '100%', padding: '9px 0', borderRadius: 10, border: 'none',
                    background: switching !== null && !isSwitching ? (isDark ? 'rgba(255,255,255,0.12)' : '#c6cdd7') : (isDark ? AVATAR_GRAD : NAVY),
                    color: '#fff', fontSize: 13, fontWeight: 700,
                    cursor: switching !== null ? 'default' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  }}>
                  {isSwitching
                    ? <><span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />Switching…</>
                    : <>⇄ Switch to this account</>}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Full-screen switching overlay ── */}
      {switching !== null && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: '#fff', borderRadius: 18, boxShadow: '0 12px 40px rgba(13,36,75,0.18)', padding: '40px 48px', textAlign: 'center', maxWidth: 360 }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: `linear-gradient(135deg,${YELLOW},${ORANGE})`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px', fontSize: 24, color: '#fff' }}>⇄</div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: NAVY }}>Switching account</h3>
            <p style={{ margin: '6px 0 18px', fontSize: 13, color: SLATE }}>Setting up your new session…</p>
            <span style={{ width: 32, height: 32, border: `3px solid ${BORD}`, borderTopColor: NAVY, borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
          </div>
        </div>
      )}
    </div>
  )
}
