'use client'

/*
The session countdown.

WHAT WENT WRONG BEFORE

People were logged out mid-task, thirty minutes after signing in, with no
warning. Four things had to be true at once for that, and all four were:

  · this guard was mounted in ClientShell only, so nothing watched the session
    on any /admin page — the reports pages included;
  · it stayed dormant unless the user had a row in user_idle_settings, and most
    do not, so even where mounted it usually did nothing;
  · /api/keepalive reported a new expiry without re-issuing the cookie, so the
    JWT still died thirty minutes after LOGIN no matter what happened after;
  · "Stay Logged In" reset a timer in this file and called no one, so it bought
    exactly nothing.

The last two are the ones that make the difference: a countdown is only worth
drawing if the thing it counts down to is real, and if the button on it works.

HOW IT WORKS NOW

The server owns the deadline. /api/keepalive re-signs the cookie and returns the
expiry of the one it just set; this asks on mount, and again on real user input,
throttled — see PING_MIN_GAP_MS. Every answer rebases the countdown. So working
in the tab keeps the session alive, and leaving it alone lets it run out.

WHY THE COUNTDOWN IS COMPUTED FROM A DEADLINE AND NOT DECREMENTED

The old version held a number and took one off it every second. Browsers throttle
timers in background tabs to about once a minute and stop them across a laptop
sleep, so that number drifted from the truth exactly when it mattered — a tab
resumed after lunch showed "58 seconds" over an hour-dead session. Everything
here is derived from `Date.now()` against an absolute deadline instead, so a
throttled or suspended tab renders the correct remaining time the moment it is
looked at, and the visibility listener makes it look immediately.
*/

import { useEffect, useRef, useState, useCallback } from 'react'
import { signOut } from '@/lib/auth-client'
import { createPortal } from 'react-dom'

// How long the warning is on screen before the session goes.
const WARN_BEFORE_MS = 60_000

/* The floor on how often user input may renew the session.

   Every renewal is a request and a Set-Cookie, and a mousemove fires hundreds of
   times a minute, so this is what stops a moving pointer becoming a request per
   frame. The cost of raising it is that the last renewal can be this stale when
   someone walks away, which shortens the effective idle window by up to this
   much — five minutes off thirty, which is why it is minutes and not tens of
   them. */
const PING_MIN_GAP_MS = 5 * 60_000

/* Input that means a person is present.

   `mousemove` and `scroll` are here and are the reason PING_MIN_GAP_MS exists.
   Deliberately NOT here: anything the page does to itself. The reports page
   polls its realtime card every few seconds, and if that counted as presence a
   tab left open on an empty desk would renew itself forever. */
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'] as const

type Phase = 'ok' | 'warning' | 'expired'

export default function IdleTimeoutGuard() {
  /* When the SERVER says this session dies, in epoch ms. Null until the first
     keepalive answers — and while it is null nothing is drawn, because a
     countdown to a guessed deadline is worse than no countdown. */
  const [serverExpiry, setServerExpiry] = useState<number | null>(null)

  /* A shorter window this user asked for, from user_idle_settings. Enforced
     here and nowhere else: the JWT's lifetime is the server's and this cannot
     lengthen it, only bring the deadline forward. Null when unset. */
  const [customWindowMs, setCustomWindowMs] = useState<number | null>(null)

  // Re-render tick. Every visible number below is derived from this.
  const [now, setNow] = useState(() => Date.now())
  const [phase, setPhase] = useState<Phase>('ok')
  const [mounted, setMounted] = useState(false)
  const [renewing, setRenewing] = useState(false)

  const lastActivityAt = useRef(Date.now())
  const lastPingAt = useRef(0)
  const pingInFlight = useRef(false)
  const goingRef = useRef(false)

  useEffect(() => { setMounted(true) }, [])

  /*
  ping renews the session and rebases the countdown.

  `force` is the button: it skips the throttle, because a person who has just
  been told they are about to be logged out and clicked to stay must not have
  that click swallowed by a rate limit they cannot see.

  A 401 here is the session already being gone. Going straight to the login page
  is the honest response — the alternative is a countdown still ticking against a
  deadline that has passed.
  */
  const ping = useCallback(async (force = false) => {
    if (goingRef.current || pingInFlight.current) return
    if (!force && Date.now() - lastPingAt.current < PING_MIN_GAP_MS) return

    pingInFlight.current = true
    if (force) setRenewing(true)
    try {
      const res = await fetch('/api/keepalive', { credentials: 'include', cache: 'no-store' })
      if (res.status === 401) {
        goingRef.current = true
        setPhase('expired')
        signOut({ redirect: false }).finally(() => {
          window.location.href = '/login?reason=idle'
        })
        return
      }
      const body = await res.json().catch(() => null)
      const expiry = Number(body?.expiryMs ?? body?.data?.expiryMs)
      if (Number.isFinite(expiry) && expiry > Date.now()) {
        lastPingAt.current = Date.now()
        lastActivityAt.current = Date.now()
        setServerExpiry(expiry)
        setPhase('ok')
      }
    } catch {
      /* Network blip. The existing deadline still stands and the countdown keeps
         running against it, which is the safe direction to fail: the worst case
         is a warning for a session that turned out to be fine. */
    } finally {
      pingInFlight.current = false
      setRenewing(false)
    }
  }, [])

  // The deadline on mount, and the user's own window if they set one.
  useEffect(() => {
    ping(true)
    fetch('/api/user/idle-timeout', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const body = d?.data ?? d
        if (body?.active && Number(body?.minutes) > 0) {
          setCustomWindowMs(Number(body.minutes) * 60_000)
        }
      })
      .catch(() => { /* the server's own window still applies */ })
  }, [ping])

  /*
  deadline is whichever limit bites first.

  Read live rather than held in state: `lastActivityAt` changes on every mousemove
  and re-rendering for that would be absurd, so the tick below is what makes this
  visible and this is a plain function of the refs at the moment it is called.
  */
  const deadlineAt = useCallback((): number | null => {
    if (serverExpiry === null) return null
    if (customWindowMs === null) return serverExpiry
    return Math.min(serverExpiry, lastActivityAt.current + customWindowMs)
  }, [serverExpiry, customWindowMs])

  // User input: note it, and renew if the throttle has opened.
  useEffect(() => {
    if (serverExpiry === null) return
    const onActivity = () => {
      if (goingRef.current) return
      lastActivityAt.current = Date.now()
      /* NOT while the warning is up. Moving the pointer must not silently
         dismiss it: the modal is there to be answered, and a warning that
         vanishes when the mouse twitches is one nobody ever finds out they
         had. The button is the way out. */
      if (phase !== 'warning') ping(false)
    }
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, onActivity, { passive: true }))
    return () => ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, onActivity))
  }, [serverExpiry, phase, ping])

  /*
  The clock. One second while the session is quiet, four times a second once the
  warning is up, so the number on screen and the bar under it move together.
  */
  useEffect(() => {
    if (serverExpiry === null) return
    const tick = () => {
      const at = deadlineAt()
      setNow(Date.now())
      if (at === null || goingRef.current) return
      const left = at - Date.now()
      if (left <= 0) {
        goingRef.current = true
        setPhase('expired')
        signOut({ redirect: false }).finally(() => {
          window.location.href = '/login?reason=idle'
        })
        return
      }
      setPhase(left <= WARN_BEFORE_MS ? 'warning' : 'ok')
    }
    tick()
    const every = phase === 'warning' ? 250 : 1000
    const id = setInterval(tick, every)
    return () => clearInterval(id)
  }, [serverExpiry, customWindowMs, phase, deadlineAt])

  /* A tab that was in the background had its interval throttled to roughly once
     a minute, so its idea of the remaining time can be a minute stale the moment
     it is looked at. This recomputes on the way back, before anything is read. */
  useEffect(() => {
    const recheck = () => setNow(Date.now())
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('focus', recheck)
    return () => {
      document.removeEventListener('visibilitychange', recheck)
      window.removeEventListener('focus', recheck)
    }
  }, [])

  if (!mounted || serverExpiry === null) return null
  if (phase === 'ok') return null

  const at = deadlineAt()
  const msLeft = Math.max(0, (at ?? now) - now)
  const secsLeft = Math.ceil(msLeft / 1000)
  const pct = Math.max(0, Math.min(100, (msLeft / WARN_BEFORE_MS) * 100))

  if (phase === 'warning') {
    return createPortal(
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-warn-title"
        aria-describedby="idle-warn-body"
        className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
        style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      >
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
          <div className="px-6 pt-6 pb-6 text-center">
            <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-amber-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>

            <h2 id="idle-warn-title" className="text-lg font-bold text-gray-800 mb-1">
              Session expiring
            </h2>

            {/* The seconds, big enough to be the thing you see. `tabular-nums`
                so the digits do not shift the layout as they count down. */}
            <div
              className="text-4xl font-bold text-amber-600 mb-1"
              style={{ fontVariantNumeric: 'tabular-nums' }}
              aria-hidden="true"
            >
              {secsLeft}
            </div>
            <p id="idle-warn-body" className="text-sm text-gray-500 mb-4">
              {/* aria-live so a screen reader is told, but only every five
                  seconds — announcing each tick would talk over everything
                  else on the page. */}
              You will be logged out due to inactivity.{' '}
              <span aria-live="polite" aria-atomic="true">
                {secsLeft % 5 === 0 || secsLeft <= 5
                  ? `${secsLeft} second${secsLeft === 1 ? '' : 's'} remaining.`
                  : ''}
              </span>
            </p>

            <div className="w-full bg-gray-100 rounded-full h-1.5 mb-5 overflow-hidden">
              {/* No CSS transition: the bar is redrawn four times a second from
                  the real remaining time, and a 1s ease on top of that would
                  animate towards a value already out of date. */}
              <div className="h-1.5 rounded-full bg-amber-500" style={{ width: `${pct}%` }} />
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => { goingRef.current = true; signOut({ callbackUrl: '/login' }) }}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Log out now
              </button>
              <button
                type="button"
                autoFocus
                disabled={renewing}
                onClick={() => ping(true)}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60"
                style={{ background: '#14254A' }}
              >
                {renewing ? 'Staying…' : 'Stay logged in'}
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body
    )
  }

  // Expired. The redirect is already in flight; this covers the gap.
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
          <h2 className="text-lg font-bold text-gray-800 mb-2">Session expired</h2>
          <p className="text-sm text-gray-500">
            You have been logged out due to inactivity. Redirecting to login…
          </p>
        </div>
      </div>
    </div>,
    document.body
  )
}
