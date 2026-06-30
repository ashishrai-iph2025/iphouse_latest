'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { signOut } from '@/lib/auth-client'
import { createPortal } from 'react-dom'

const WARN_BEFORE_MS = 60_000 // show warning 1 minute before logout
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'] as const

export default function IdleTimeoutGuard() {
  const [timeoutMs, setTimeoutMs] = useState<number | null>(null)
  const [state, setState] = useState<'idle' | 'warning' | 'expired'>('idle')
  const [countdown, setCountdown] = useState(60)
  const [mounted, setMounted] = useState(false)

  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const warnRef     = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutMsRef = useRef<number>(30 * 60_000)

  useEffect(() => { setMounted(true) }, [])

  // Fetch user's configured timeout (only activate if is_active = true)
  useEffect(() => {
    fetch('/api/user/idle-timeout', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (data.success && data.active) {
          const ms = (data.minutes ?? 30) * 60_000
          setTimeoutMs(ms)
          timeoutMsRef.current = ms
        }
        // if not active, timeoutMs stays null → guard stays dormant
      })
      .catch(() => { /* stay dormant on error */ })
  }, [])

  const clearAllTimers = useCallback(() => {
    if (timerRef.current)  clearTimeout(timerRef.current)
    if (warnRef.current)   clearTimeout(warnRef.current)
    if (countRef.current)  clearInterval(countRef.current)
  }, [])

  const startTimers = useCallback(() => {
    clearAllTimers()
    const total = timeoutMsRef.current
    const warnAt = total - WARN_BEFORE_MS

    if (warnAt > 0) {
      warnRef.current = setTimeout(() => {
        setState('warning')
        setCountdown(60)
        countRef.current = setInterval(() => {
          setCountdown(c => {
            if (c <= 1) {
              clearInterval(countRef.current!)
              return 0
            }
            return c - 1
          })
        }, 1000)
      }, warnAt)
    }

    timerRef.current = setTimeout(() => {
      clearAllTimers()
      setState('expired')
      signOut({ redirect: false }).then(() => {
        window.location.href = '/login?reason=idle'
      })
    }, total)
  }, [clearAllTimers])

  const resetTimer = useCallback(() => {
    if (state === 'expired') return
    setState('idle')
    setCountdown(60)
    clearAllTimers()
    startTimers()
  }, [state, clearAllTimers, startTimers])

  // Start timers once timeout is loaded
  useEffect(() => {
    if (timeoutMs === null) return
    startTimers()
    return clearAllTimers
  }, [timeoutMs, startTimers, clearAllTimers])

  // Attach activity listeners
  useEffect(() => {
    if (timeoutMs === null) return
    const handler = () => { if (state !== 'expired') resetTimer() }
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, handler, { passive: true }))
    return () => ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, handler))
  }, [timeoutMs, state, resetTimer])

  if (!mounted || state === 'idle' || timeoutMs === null) return null

  // Warning modal
  if (state === 'warning') {
    return createPortal(
      <div className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
        style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
          <div className="px-6 pt-6 pb-4 text-center">
            <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-amber-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-800 mb-1">Session Expiring Soon</h2>
            <p className="text-sm text-gray-500 mb-4">
              You will be automatically logged out in{' '}
              <span className="font-bold text-amber-600">{countdown} second{countdown !== 1 ? 's' : ''}</span>{' '}
              due to inactivity.
            </p>
            {/* Countdown bar */}
            <div className="w-full bg-gray-100 rounded-full h-1.5 mb-5">
              <div
                className="h-1.5 rounded-full bg-amber-500 transition-all duration-1000"
                style={{ width: `${(countdown / 60) * 100}%` }}
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { signOut({ callbackUrl: '/login' }) }}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                Logout Now
              </button>
              <button
                onClick={resetTimer}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
                style={{ background: '#14254A' }}>
                Stay Logged In
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body
    )
  }

  // Expired – redirect is already in flight; show brief overlay
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="px-6 py-8 text-center">
          <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-red-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m0 0v2m0-2h2m-2 0H10m2-11a9 9 0 110 18A9 9 0 0112 4z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-800 mb-2">Session Expired</h2>
          <p className="text-sm text-gray-500">You have been logged out due to inactivity. Redirecting to login…</p>
        </div>
      </div>
    </div>,
    document.body
  )
}

