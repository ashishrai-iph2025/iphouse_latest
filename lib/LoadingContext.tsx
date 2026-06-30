'use client'

import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { usePathname } from '@/lib/router'

interface LoadingCtx {
  show: () => void
  hide: () => void
}

const Ctx = createContext<LoadingCtx>({ show: () => {}, hide: () => {} })

export function useLoading() { return useContext(Ctx) }

export function LoadingProvider({ children }: { children: React.ReactNode }) {
  const [visible,  setVisible]  = useState(false)
  const pathname                 = usePathname()
  const prevPath                 = useRef(pathname)
  const maxTimer                 = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer                = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
    setVisible(true)
    // Failsafe: always hide after 2s even if navigation stalls
    if (maxTimer.current) clearTimeout(maxTimer.current)
    maxTimer.current = setTimeout(() => setVisible(false), 2000)
  }, [])

  const hide = useCallback(() => {
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null }
    // Small delay so the loader is visible for at least a flash
    hideTimer.current = setTimeout(() => setVisible(false), 300)
  }, [])

  // Detect navigation start via history patching
  useEffect(() => {
    const origPush    = history.pushState.bind(history)
    const origReplace = history.replaceState.bind(history)

    history.pushState = function (...args) {
      show()
      return origPush(...args)
    }
    history.replaceState = function (...args) {
      show()
      return origReplace(...args)
    }

    function onPop() { show() }
    window.addEventListener('popstate', onPop)

    return () => {
      history.pushState    = origPush
      history.replaceState = origReplace
      window.removeEventListener('popstate', onPop)
    }
  }, [show])

  // Hide when the new page pathname settles
  useEffect(() => {
    if (pathname !== prevPath.current) {
      prevPath.current = pathname
      hide()
    }
  }, [pathname, hide])

  // Cleanup on unmount
  useEffect(() => () => {
    if (maxTimer.current)  clearTimeout(maxTimer.current)
    if (hideTimer.current) clearTimeout(hideTimer.current)
  }, [])

  const show_ = useCallback(() => show(), [show])
  const hide_ = useCallback(() => hide(), [hide])

  return (
    <Ctx.Provider value={{ show: show_, hide: hide_ }}>
      {children}
      <GlobalLoader visible={visible} />
    </Ctx.Provider>
  )
}

// â”€â”€ Loader overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function GlobalLoader({ visible }: { visible: boolean }) {
  const [rendered, setRendered] = useState(false)

  useEffect(() => {
    if (visible) {
      setRendered(true)
    } else {
      const t = setTimeout(() => setRendered(false), 350)
      return () => clearTimeout(t)
    }
  }, [visible])

  if (!rendered) return null

  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
      style={{
        background:    'rgba(20, 37, 74, 0.85)',
        backdropFilter:'blur(6px)',
        opacity:       visible ? 1 : 0,
        transition:    'opacity 0.3s ease',
        pointerEvents: visible ? 'all' : 'none',
      }}
    >
      {/* Spinning rings + logo */}
      <div className="relative flex items-center justify-center" style={{ width: 120, height: 120 }}>
        <div style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          border: '3px solid transparent',
          borderTopColor: '#FFC82B', borderRightColor: '#FC934C',
          animation: 'spin 1.4s linear infinite',
        }} />
        <div style={{
          position: 'absolute', inset: 14, borderRadius: '50%',
          border: '2px solid transparent',
          borderTopColor: 'rgba(255,200,43,0.35)',
          borderLeftColor: 'rgba(252,147,76,0.35)',
          animation: 'spin 0.8s linear infinite reverse',
        }} />
        <div style={{
          position: 'relative', width: 72, height: 72,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'ipPulse 1.6s ease-in-out infinite',
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/newlogo.png" alt="IP House"
            style={{ width: 68, objectFit: 'contain', filter: 'brightness(0) invert(1)' }} />
        </div>
      </div>

      {/* Bouncing dots */}
      <div style={{ display: 'flex', gap: 8, marginTop: 28 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{
            width: 7, height: 7, borderRadius: '50%',
            background: 'linear-gradient(135deg,#FFC82B,#FC934C)',
            animation: `ipBounce 1s ease-in-out ${i * 0.18}s infinite`,
          }} />
        ))}
      </div>

      <style>{`
        @keyframes ipPulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:.7; transform:scale(0.93); }
        }
        @keyframes ipBounce {
          0%,100% { transform:translateY(0); opacity:.5; }
          50%      { transform:translateY(-8px); opacity:1; }
        }
      `}</style>
    </div>
  )
}
