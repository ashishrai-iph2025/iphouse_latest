'use client'

import { useState, useEffect, Suspense } from 'react'
import { signIn, useSession } from '@/lib/auth-client'
import { useRouter, useSearchParams } from '@/lib/router'
import { Link } from 'react-router-dom'

function LoginForm() {
  const router  = useRouter()
  const params  = useSearchParams()
  const { data: session, status, update } = useSession()

  const [username,   setUsername]   = useState('')
  const [password,   setPassword]   = useState('')
  const [showPw,     setShowPw]     = useState(false)
  const [error,      setError]      = useState('')
  const [loading,    setLoading]    = useState(false)
  const [idleBanner, setIdleBanner] = useState(false)

  useEffect(() => {
    if (params.get('reason') === 'idle') setIdleBanner(true)
  }, [params])

  useEffect(() => {
    if (status === 'authenticated') {
      const role = (session?.user as any)?.role
      router.replace(role === 1 || role === 2 ? '/admin/home' : '/dashboard')
    }
  }, [status, session])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const checkRes = await fetch('/api/auth/check-multiple-logins', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password }),
      })
      const checkData = await checkRes.json()
      if (!checkData.success) { setError(checkData.error || 'Invalid username or password'); return }

      const loginType = checkData.login_type as number
      const role      = checkData.role as number | null

      sessionStorage.setItem('pending_otp_email',    checkData.email)
      sessionStorage.setItem('pending_otp_userId',   String(checkData.userId))
      sessionStorage.setItem('pending_otp_username', username)
      sessionStorage.setItem('pending_login_rows',   JSON.stringify(checkData.rows))
      if (checkData.tempToken) sessionStorage.setItem('pending_multi_tempToken', checkData.tempToken)
      // Staff (role 1/2) go through OTP only when a Super Admin enabled it
      // (check-multiple-logins returns otpRequired). Their verify step sets the
      // session directly, so remember it's a staff OTP for the verify page.
      const staffOtp = checkData.staff === true && checkData.otpRequired === true
      sessionStorage.setItem('pending_otp_staff', staffOtp ? '1' : '0')

      const needsOtp = staffOtp || ((loginType === 0 || loginType === 1) && role !== 1 && role !== 2)
      if (needsOtp) {
        const otpRes  = await fetch('/api/auth/send-otp', {
          credentials: 'include',
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ userId: checkData.userId, email: checkData.email }),
        })
        const otpData = await otpRes.json()
        if (!otpData.success) { setError(otpData.error || 'Failed to send verification code'); return }
        router.push('/verify-email')
        return
      }

      if (checkData.rows.length > 1) { router.push('/client-selection'); return }

      const result = await signIn('credentials', { redirect: false, username, password })
      if (result?.error) {
        setError('Login failed. Please try again.')
      } else {
        sessionStorage.removeItem('pending_otp_email')
        sessionStorage.removeItem('pending_otp_userId')
        sessionStorage.removeItem('pending_otp_username')
        sessionStorage.removeItem('pending_login_rows')
        await update()
      }
    } catch {
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        @keyframes fade-up {
          from { opacity: 0; transform: translateY(16px) scale(0.99); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse-dot {
          0%, 100% { box-shadow: 0 0 0 0 rgba(252,147,76,0.5); }
          50%       { box-shadow: 0 0 0 5px rgba(252,147,76,0); }
        }

        /* ── ROOT: two columns, exactly one screen tall ── */
        .lp-root {
          display: flex;
          height: 100vh;
          overflow: hidden;
          font-family: 'Poppins', sans-serif;
          background: #eef1f6;
        }

        /* ── LEFT PANEL ── */
        .lp-left {
          display: none;
          width: 52%;
          flex-shrink: 0;
          height: 100vh;
          overflow: hidden;
          flex-direction: column;
          padding: 22px 40px;
          position: relative;
          background: linear-gradient(150deg, #0c1a35 0%, #14254A 55%, #1a3260 100%);
        }
        @media (min-width: 1024px) { .lp-left { display: flex; } }

        /* decorative layers */
        .lp-grid {
          position: fixed; pointer-events: none;
          background-image:
            linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
          background-size: 52px 52px;
          inset: 0; width: 52%;
          z-index: 0;
        }
        .lp-orb-a {
          position: absolute; top: -80px; right: -60px;
          width: 400px; height: 400px; border-radius: 50%;
          background: radial-gradient(circle, rgba(252,147,76,0.15) 0%, transparent 65%);
          pointer-events: none; z-index: 0;
        }
        .lp-orb-b {
          position: absolute; bottom: -60px; left: -60px;
          width: 340px; height: 340px; border-radius: 50%;
          background: radial-gradient(circle, rgba(0,120,212,0.18) 0%, transparent 65%);
          pointer-events: none; z-index: 0;
        }
        .lp-z { position: relative; z-index: 1; }

        /* logo */
        .lp-logo {
          display: flex; align-items: center; gap: 12px;
          margin-bottom: 14px;
        }
        .lp-logo-icon {
          width: 42px; height: 42px; border-radius: 11px;
          background: rgba(255,255,255,0.1);
          border: 1px solid rgba(255,255,255,0.16);
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .lp-logo-name  { font-size: 16px; font-weight: 800; color: #fff; letter-spacing: 0.01em; }
        .lp-logo-sub   { font-size: 9px; color: rgba(255,255,255,0.42); letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; margin-top: 1px; }

        /* live badge */
        .lp-live {
          display: inline-flex; align-items: center; gap: 7px;
          padding: 4px 12px; border-radius: 100px;
          background: rgba(255,255,255,0.07);
          border: 1px solid rgba(255,255,255,0.13);
          margin-bottom: 10px;
          width: fit-content;
        }
        .lp-live-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: #FC934C; animation: pulse-dot 2s infinite;
          flex-shrink: 0;
        }
        .lp-live-txt { font-size: 10px; color: rgba(255,255,255,0.8); font-weight: 600; letter-spacing: 0.04em; }

        /* hero block fills all space between logo and footer */
        .lp-hero { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; scrollbar-width: none; }
        .lp-hero::-webkit-scrollbar { display: none; }
        .lp-center-block { width: 100%; }

        /* headline */
        .lp-headline {
          font-size: clamp(18px, 2.2vw, 28px);
          font-weight: 800; line-height: 1.22;
          color: #fff; letter-spacing: -0.02em;
          margin-top: clamp(16px, 4vh, 50px);
          margin-bottom: 6px;
          text-align: center;
        }
        .lp-headline-acc { color: #FFC82B; }
        .lp-sub {
          font-size: 12px; color: rgba(255,255,255,0.52);
          line-height: 1.6; margin-bottom: clamp(16px, 7vh, 128px);
          text-align: center; text-wrap: balance;
          max-width: min(90%, 640px); margin-left: auto; margin-right: auto;
          padding: 0 16px;
        }
        /* Statement + "Powered by" sit together: tight gap between them,
           the usual large gap kept only after the powered-by line. */
        .lp-sub-tight { margin-bottom: 8px; }
        .lp-powered   { font-size: 11px; color: rgba(255,255,255,0.4); }

        /* KPI strip — same width as chart */
        .lp-kpi {
          display: grid; grid-template-columns: repeat(3,1fr);
          gap: 8px; margin: 0 clamp(20px, 5vw, 75px) 10px;
        }
        .lp-kpi-card {
          padding: 9px 8px; border-radius: 10px; text-align: center;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.1);
        }
        .lp-kpi-val { font-size: 16px; font-weight: 800; }
        .lp-kpi-lbl { font-size: 9px; color: rgba(255,255,255,0.45); margin-top: 1px; letter-spacing: 0.04em; }

        /* illustration card — inset 75px each side */
        .lp-dash {
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,0.09);
          background: rgba(255,255,255,0.04);
          padding: 10px 10px 8px;
          margin: 0 clamp(20px, 5vw, 75px) 8px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.22);
          overflow: hidden;
        }
        .lp-dash-svg {
          width: 100%; height: auto; display: block;
        }
        .lp-dash-api {
          display: flex; align-items: center; gap: 8px;
          font-size: 10px; color: rgba(255,255,255,0.42);
          font-family: monospace; flex-wrap: wrap; margin-top: 8px;
        }
        .lp-dash-pill {
          padding: 2px 8px; border-radius: 5px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
        }

        /* workflow — same width as chart, 25px gap above chart */
        .lp-workflow {
          display: flex; align-items: center;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px; padding: 7px 12px;
          margin: 8px clamp(20px, 5vw, 75px) 10px; gap: 0;
        }
        .lp-wf-step { display: flex; flex-direction: column; align-items: center; flex: 1; }
        .lp-wf-icon {
          width: 24px; height: 24px; border-radius: 6px;
          background: rgba(255,255,255,0.07);
          border: 1px solid rgba(255,255,255,0.1);
          display: flex; align-items: center; justify-content: center;
          font-size: 11px; margin-bottom: 2px;
        }
        .lp-wf-lbl  { font-size: 8px; color: rgba(255,255,255,0.5); font-weight: 600; letter-spacing: 0.05em; }
        .lp-wf-arr  { color: rgba(255,255,255,0.18); font-size: 13px; padding: 0 3px; }

        /* chips */
        .lp-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 12px; }
        .lp-chip {
          font-size: 9px; font-weight: 600; color: rgba(255,255,255,0.65);
          padding: 3px 10px; border-radius: 100px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
        }

        /* left footer */
        .lp-lfooter {
          display: flex; align-items: center; justify-content: space-between;
          font-size: 10px; color: rgba(255,255,255,0.28);
          border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px;
          margin-top: auto;
        }
        .lp-lfooter a { color: rgba(255,255,255,0.4); text-decoration: none; }
        .lp-lfooter a:hover { color: rgba(255,255,255,0.7); }
        .lp-lfooter-links { display: flex; gap: 14px; }

        /* ── RIGHT PANEL ── */
        .lp-right {
          flex: 1;
          height: 100vh;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 24px 20px;
          position: relative;
          background: #eef1f6;
          scrollbar-width: thin;
          scrollbar-color: #d1d5db transparent;
        }
        .lp-right-orb-a {
          position: fixed; top: -60px; right: -60px;
          width: 320px; height: 320px; border-radius: 50%;
          background: radial-gradient(circle, rgba(20,37,74,0.06) 0%, transparent 65%);
          pointer-events: none;
        }
        .lp-right-orb-b {
          position: fixed; bottom: -40px; right: 30%;
          width: 220px; height: 220px; border-radius: 50%;
          background: radial-gradient(circle, rgba(252,147,76,0.06) 0%, transparent 65%);
          pointer-events: none;
        }

        /* mobile logo — hidden on desktop */
        .lp-mobile-logo { display: block; margin-bottom: 24px; }
        @media (min-width: 1024px) { .lp-mobile-logo { display: none; } }

        /* card */
        .lp-card {
          position: relative; z-index: 1;
          width: 100%; max-width: 420px;
          background: #fff;
          border-radius: 20px;
          padding: 40px 40px 34px;
          box-shadow:
            0 0 0 1px rgba(20,37,74,0.06),
            0 4px 6px rgba(20,37,74,0.04),
            0 20px 50px rgba(20,37,74,0.11);
          animation: fade-up 0.42s cubic-bezier(0.22,1,0.36,1) both;
        }
        @media (max-width: 480px) {
          .lp-card { padding: 28px 22px 24px; border-radius: 16px; }
        }

        /* badge */
        .lp-badge {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 4px 12px; border-radius: 100px; margin-bottom: 16px;
          background: rgba(20,37,74,0.06); border: 1px solid rgba(20,37,74,0.1);
        }
        .lp-badge span { font-size: 10.5px; color: #14254A; font-weight: 700; letter-spacing: 0.05em; }

        /* form elements */
        .lp-label {
          display: block; font-size: 10.5px; font-weight: 700;
          color: #6b7280; letter-spacing: 0.07em; text-transform: uppercase; margin-bottom: 6px;
        }
        .lp-input-wrap { position: relative; }
        .lp-input-icon {
          position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
          pointer-events: none; color: #b0bac9; display: flex; align-items: center;
        }
        .lp-input {
          width: 100%; padding: 10px 13px 10px 40px;
          background: #f8fafc; border: 1.5px solid #e5e7eb;
          border-radius: 10px; color: #0f172a;
          font-size: 13.5px; font-family: 'Poppins', sans-serif;
          transition: border-color 0.18s, box-shadow 0.18s, background 0.18s;
          outline: none;
        }
        .lp-input:focus {
          border-color: #14254A; background: #fff;
          box-shadow: 0 0 0 3px rgba(20,37,74,0.09);
        }
        .lp-input::placeholder { color: #c4cad4; }
        .lp-eye {
          position: absolute; right: 11px; top: 50%; transform: translateY(-50%);
          background: none; border: none; cursor: pointer;
          color: #b0bac9; padding: 4px; display: flex; transition: color 0.15s;
        }
        .lp-eye:hover { color: #14254A; }

        /* CTA */
        .lp-btn {
          width: 100%; padding: 12px 20px;
          background: #14254A; border: none; border-radius: 11px;
          color: #fff; font-size: 13.5px; font-weight: 700;
          cursor: pointer; letter-spacing: 0.02em;
          display: flex; align-items: center; justify-content: center; gap: 8px;
          box-shadow: 0 4px 14px rgba(20,37,74,0.26);
          transition: all 0.17s ease;
          font-family: 'Poppins', sans-serif; margin-top: 6px;
        }
        .lp-btn:hover:not(:disabled) {
          background: #1a3260; transform: translateY(-1px);
          box-shadow: 0 8px 24px rgba(20,37,74,0.34);
        }
        .lp-btn:active:not(:disabled) { transform: translateY(0); }
        .lp-spin {
          width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
          border-radius: 50%; animation: spin 0.7s linear infinite; display: inline-block;
        }

        /* alerts */
        .lp-error {
          display: flex; align-items: flex-start; gap: 8px;
          padding: 10px 13px; border-radius: 10px; margin-bottom: 14px;
          background: #fef2f2; border: 1px solid #fecaca; color: #dc2626; font-size: 13px;
        }
        .lp-idle {
          display: flex; align-items: flex-start; gap: 8px;
          padding: 10px 13px; border-radius: 10px; margin-bottom: 14px;
          background: #fffbeb; border: 1px solid #fde68a; color: #92400e; font-size: 13px;
        }

        /* divider */
        .lp-divider { display: flex; align-items: center; gap: 10px; margin: 18px 0; }
        .lp-divider-line { flex: 1; height: 1px; background: #f1f3f6; }
        .lp-divider-txt { font-size: 10.5px; color: #d1d5db; white-space: nowrap; }

        /* trust badges */
        .lp-trust { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
        .lp-trust-badge {
          display: flex; align-items: center; gap: 4px;
          padding: 4px 10px; border-radius: 100px;
          background: #f9fafb; border: 1px solid #e5e7eb;
          font-size: 10.5px; color: #6b7280; font-weight: 500;
        }

        /* right footer */
        .lp-rfooter {
          margin-top: 18px; text-align: center;
          font-size: 10.5px; color: #9ca3af;
        }
      `}</style>

      <div className="lp-root">

        {/* ── LEFT PANEL ── */}
        <aside className="lp-left">
          <div className="lp-grid" />
          <div className="lp-orb-a" />
          <div className="lp-orb-b" />

          {/* Logo */}
          <div className="lp-z lp-logo">
            <img src="/newlogo.png" alt="IP House" style={{ height: 36, width: 'auto', filter: 'brightness(0) invert(1)' }} />
          </div>

          {/* Hero */}
          <div className="lp-z lp-hero">
            <h1 className="lp-headline">
              Online <span className="lp-headline-acc">Dashboard</span>
            </h1>
            <p className="lp-sub lp-sub-tight">
              Live infringement analytics, takedown enforcement and embedded Power BI dashboards.
            </p>
            <p className="lp-sub lp-powered">Powered by IP House</p>

            {/* KPI + illustration + workflow + chips — centered block */}
            <div className="lp-center-block">
            {/* KPI strip */}
            <div className="lp-kpi">
              {([
                { value: '8.2k+', label: 'Takedowns/mo', color: '#FFC82B' },
                { value: '96%',   label: 'Detection rate', color: '#4aa3e8' },
                { value: '150+',  label: 'Clients served', color: '#FC934C' },
              ] as const).map(s => (
                <div key={s.label} className="lp-kpi-card">
                  <div className="lp-kpi-val" style={{ color: s.color }}>{s.value}</div>
                  <div className="lp-kpi-lbl">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Dashboard illustration */}
            <div className="lp-dash">
              <svg viewBox="0 0 460 220" preserveAspectRatio="xMidYMid meet" className="lp-dash-svg" role="img" aria-label="Analytics dashboard">
                <defs>
                  <linearGradient id="gA" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#FC934C"/><stop offset="1" stopColor="#FFC82B"/></linearGradient>
                  <linearGradient id="gB" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#0078D4"/><stop offset="1" stopColor="#4aa3e8"/></linearGradient>
                  <linearGradient id="gC" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#2b7c38"/><stop offset="1" stopColor="#3dba4e"/></linearGradient>
                  <linearGradient id="gLine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4aa3e8" stopOpacity="0.28"/><stop offset="1" stopColor="#4aa3e8" stopOpacity="0"/></linearGradient>
                </defs>
                <rect width="460" height="220" rx="12" fill="#0c1730"/>
                <rect width="460" height="32" rx="12" fill="#111f3e"/>
                <rect y="18" width="460" height="14" fill="#111f3e"/>
                <circle cx="16" cy="16" r="4" fill="#fc5454"/><circle cx="30" cy="16" r="4" fill="#FFC82B"/><circle cx="44" cy="16" r="4" fill="#3dba4e"/>
                <rect x="64" y="11" width="110" height="8" rx="4" fill="#ffffff10"/>
                <rect x="388" y="11" width="56" height="8" rx="4" fill="#ffffff08"/>
                {/* sidebar */}
                <rect x="0" y="32" width="46" height="188" fill="#0a1628"/>
                {[48,74,100,126,152].map((y,i) => (
                  <g key={i}>
                    <rect x="7" y={y} width="32" height="18" rx="5" fill={i===0?'#FC934C1a':'#ffffff06'}/>
                    <rect x="15" y={y+5} width="16" height="8" rx="3" fill={i===0?'#FC934C':'#ffffff1a'}/>
                  </g>
                ))}
                {/* KPIs */}
                {[
                  {x:56,val:'8.2k',c:'#FFC82B'},{x:140,val:'96%',c:'#4aa3e8'},
                  {x:224,val:'150+',c:'#FC934C'},{x:322,val:'✓ Live',c:'#3dba4e',g:'#3dba4e12'},
                ].map(k => (
                  <g key={k.val}>
                    <rect x={k.x} y="40" width="76" height="36" rx="7" fill={k.g??'#ffffff0d'}/>
                    <rect x={k.x+7} y="47" width="28" height="4" rx="2" fill="#ffffff15"/>
                    <text x={k.x+7} y="68" fill={k.c} fontSize="14" fontWeight="700" fontFamily="sans-serif">{k.val}</text>
                  </g>
                ))}
                {/* bar chart */}
                <rect x="56" y="86" width="170" height="122" rx="9" fill="#ffffff08"/>
                <rect x="65" y="94" width="50" height="5" rx="2.5" fill="#ffffff15"/>
                <line x1="65" y1="196" x2="216" y2="196" stroke="#ffffff0e" strokeWidth="1"/>
                {[{x:72,h:54,g:'gA'},{x:91,h:80,g:'gB'},{x:110,h:38,g:'gA'},{x:129,h:95,g:'gB'},{x:148,h:62,g:'gC'},{x:167,h:108,g:'gA'},{x:186,h:44,g:'gB'}].map((b,i)=>(
                  <rect key={i} x={b.x} y={196-b.h} width="12" height={b.h} rx="3.5" fill={`url(#${b.g})`}/>
                ))}
                {/* line chart */}
                <rect x="234" y="86" width="218" height="122" rx="9" fill="#ffffff08"/>
                <rect x="243" y="94" width="50" height="5" rx="2.5" fill="#ffffff15"/>
                <polyline points="242,196 278,176 314,184 350,156 386,166 422,132 446,142"
                  fill="none" stroke="#4aa3e8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                <polygon points="242,196 278,176 314,184 350,156 386,166 422,132 446,142 446,208 242,208"
                  fill="url(#gLine)"/>
                {[[242,196],[278,176],[314,184],[350,156],[386,166],[422,132],[446,142]].map(([cx,cy],i)=>(
                  <circle key={i} cx={cx} cy={cy} r="2.5" fill="#4aa3e8" stroke="#0c1730" strokeWidth="1.5"/>
                ))}
              </svg>
              <div className="lp-dash-api">
                <span className="lp-dash-pill">GET /api/embed-token</span>
                <span style={{ color: '#3dba4e', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3dba4e', display: 'inline-block' }}/>200 OK
                </span>
                <span style={{ marginLeft: 'auto' }} className="lp-dash-pill">api.ip-house.com</span>
              </div>
            </div>

            {/* Workflow — below chart */}
            <div className="lp-workflow">
              {([
                { icon: '🔍', label: 'Detect' }, { icon: '📊', label: 'Analyse' },
                { icon: '🚨', label: 'Enforce' }, { icon: '📈', label: 'Report' },
              ] as const).map((s, i) => (
                <div key={s.label} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
                  <div className="lp-wf-step" style={{ flex: 1 }}>
                    <div className="lp-wf-icon">{s.icon}</div>
                    <div className="lp-wf-lbl">{s.label}</div>
                  </div>
                  {i < 3 && <div className="lp-wf-arr">›</div>}
                </div>
              ))}
            </div>

            {/* Feature chips */}
            <div className="lp-chips" style={{ justifyContent: 'center' }}>
              {['Power BI Embedded','IP House API','Real-time Analytics','Secure OTP Login','Multi-Client Portal'].map(f => (
                <span key={f} className="lp-chip">{f}</span>
              ))}
            </div>
            </div> {/* end lp-center-block */}
          </div>

          {/* Left footer */}
          <div className="lp-z lp-lfooter">
            <span>© {new Date().getFullYear()} IP House. All rights reserved.</span>
            <div className="lp-lfooter-links"><a href="#">Privacy</a><a href="#">Terms</a></div>
          </div>
        </aside>

        {/* ── RIGHT PANEL ── */}
        <main className="lp-right">
          <div className="lp-right-orb-a" />
          <div className="lp-right-orb-b" />

          {/* Mobile logo */}
          <img src="/newlogo.png" alt="IP House" className="lp-mobile-logo"
            style={{ height: 34, width: 'auto' }} />

          {/* Card */}
          <div className="lp-card">
            <div className="lp-badge">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#14254A" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <span>Secure Access Portal</span>
            </div>

            <h2 style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em', lineHeight: 1.2, marginBottom: 6 }}>
              Welcome back
            </h2>
            <p style={{ fontSize: 13.5, color: '#64748b', lineHeight: 1.5, marginBottom: 24 }}>
              Sign in to access your dashboards &amp; reports.
            </p>

            {idleBanner && (
              <div className="lp-idle">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Your session expired due to inactivity. Please sign in again.
              </div>
            )}
            {error && (
              <div className="lp-error">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label className="lp-label">Username</label>
                <div className="lp-input-wrap">
                  <div className="lp-input-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </div>
                  <input type="text" className="lp-input" placeholder="Enter your username"
                    value={username} onChange={e => setUsername(e.target.value)}
                    required autoComplete="username" />
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label className="lp-label" style={{ marginBottom: 0 }}>Password</label>
                  <Link to="/forgot-password" style={{ fontSize: 11.5, color: '#14254A', fontWeight: 600, textDecoration: 'none', opacity: 0.6 }}>
                    Forgot password?
                  </Link>
                </div>
                <div className="lp-input-wrap">
                  <div className="lp-input-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  </div>
                  <input type={showPw ? 'text' : 'password'} className="lp-input"
                    style={{ paddingRight: 42 }} placeholder="••••••••••"
                    value={password} onChange={e => setPassword(e.target.value)}
                    required autoComplete="off" />
                  <button type="button" className="lp-eye" onClick={() => setShowPw(v => !v)}>
                    {showPw
                      ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </div>

              <button type="submit" disabled={loading} className="lp-btn"
                style={{ opacity: loading ? 0.72 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}>
                {loading
                  ? <><span className="lp-spin" /> Signing in…</>
                  : <>Sign in <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg></>
                }
              </button>
            </form>

            <p style={{ marginTop: 18, textAlign: 'center', fontSize: 13, color: '#64748b' }}>
              Don&apos;t have an account?{' '}
              <Link to="/register" style={{ color: '#14254A', fontWeight: 700, textDecoration: 'none' }}>
                Create one
              </Link>
            </p>

          </div>

          <footer className="lp-rfooter">
            © {new Date().getFullYear()} <strong style={{ color: '#6b7280' }}>IP House</strong>. Confidential &amp; proprietary — unauthorized access is prohibited.
          </footer>
        </main>
      </div>
    </>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
