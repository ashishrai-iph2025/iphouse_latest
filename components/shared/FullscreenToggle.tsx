'use client'

/*
 * Full-screen, for reading a report.
 *
 * A report is a wide page — a KPI band, a trend, and a grid of breakdowns with a
 * slicer rail beside them — and the portal's own chrome takes a header, a nav
 * row and a footer off the height of it before anything is drawn. On a laptop
 * that is most of a panel. This hands the whole display to the page.
 *
 * ── Why the browser's full-screen and not a "hide the chrome" mode ───────────
 *
 * A mode of our own would have to be remembered, undone on navigation, and
 * explained; and it would still leave the browser's own toolbars in place, which
 * on a laptop are the taller half of what it was trying to reclaim. The platform
 * already has exactly this feature, users already know Escape leaves it, and it
 * takes the OS chrome with it.
 *
 * ── Why it renders nothing when unsupported ──────────────────────────────────
 *
 * requestFullscreen is refused outright in some embedded webviews and by some
 * iOS browsers. A button that is present and does nothing is worse than an
 * absent one: the reader clicks it twice, concludes the portal is broken, and is
 * right. So the control appears only where it works.
 */

import { useCallback, useEffect, useState } from 'react'

/** The vendor-prefixed shapes still in the wild, kept in one place rather than
    cast at each call site. Safari is the one that matters. */
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

function fullscreenElement(): Element | null {
  const d = document as FsDocument
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null
}

function supported(): boolean {
  const el = document.documentElement as FsElement
  return typeof el.requestFullscreen === 'function'
    || typeof el.webkitRequestFullscreen === 'function'
}

interface Props {
  /** Matches the other icons in the bar: 'light' on a coloured navbar, 'dark'
      on a white one. */
  tone?: 'light' | 'dark'
}

export default function FullscreenToggle({ tone = 'dark' }: Props) {
  const [on, setOn] = useState(false)
  /* Decided after mount, never during render: `document` does not exist while
     this is being rendered on the server, and a first paint that guesses would
     flash a control that is about to disappear. */
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    setAvailable(supported())
    /* Listened for rather than assumed. Escape leaves full-screen without going
       anywhere near this button, and so does the browser's own control — an
       icon tracking only its own clicks would be wrong within seconds and would
       then be pointing the wrong way. */
    const sync = () => setOn(!!fullscreenElement())
    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  const toggle = useCallback(() => {
    const d = document as FsDocument
    const el = document.documentElement as FsElement
    try {
      if (fullscreenElement()) {
        void (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.())
      } else {
        void (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.())
      }
    } catch {
      /* Refused — most often because the gesture was not trusted, or a policy
         forbids it in this frame. Swallowed: the state listener above never
         fires, so the icon stays as it was, which is the truth. */
    }
  }, [])

  if (!available) return null

  const light = tone === 'light'
  return (
    <button
      onClick={toggle}
      title={on ? 'Leave full screen (Esc)' : 'View full screen'}
      aria-label={on ? 'Leave full screen' : 'View full screen'}
      aria-pressed={on}
      className={`p-2 rounded-lg transition-colors ${light
        ? 'text-white hover:bg-white/10'
        : 'text-[#14254A] dark:text-white hover:bg-gray-100 dark:hover:bg-white/10'}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {on ? (
          /* Arrows pointing IN — the way out. */
          <>
            <path d="M9 3v4a2 2 0 0 1-2 2H3" />
            <path d="M15 3v4a2 2 0 0 0 2 2h4" />
            <path d="M9 21v-4a2 2 0 0 0-2-2H3" />
            <path d="M15 21v-4a2 2 0 0 1 2-2h4" />
          </>
        ) : (
          /* Arrows pointing OUT — the way in. */
          <>
            <path d="M3 9V5a2 2 0 0 1 2-2h4" />
            <path d="M21 9V5a2 2 0 0 0-2-2h-4" />
            <path d="M3 15v4a2 2 0 0 0 2 2h4" />
            <path d="M21 15v4a2 2 0 0 1-2 2h-4" />
          </>
        )}
      </svg>
    </button>
  )
}
