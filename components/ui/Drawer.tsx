'use client'

// An off-canvas panel that slides in from the right.
//
// Used where a dialog has to hold DETAIL as well as a decision — a request to
// read plus the access to grant with it. A centred modal is the wrong shape for
// that: it is as wide as its narrowest content, so a checklist of a dozen
// modules either scrolls inside a small box or forces the box so wide it
// obscures the list it came from. A drawer takes half the screen, keeps the
// table visible beside it, and grows downward rather than outward.
//
// Portalled to <body> for the same reason every overlay here is: the page
// wrappers animate with `fill-mode: both`, and a transformed ancestor becomes
// the containing block for `position: fixed`, which would pin this to the
// content box instead of the viewport.

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export default function Drawer({
  open, onClose, title, subtitle, footer, width = '50vw', children,
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Pinned to the bottom, so the action is reachable without scrolling past
      the content it applies to. */
  footer?: React.ReactNode
  /** Half the screen. Not capped: a maximum width made the panel narrower than
      half on a wide monitor, which is the one place there is room for it. */
  width?: string
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)

    /* The page behind must not scroll while this is open — on a long list,
       a stray wheel event otherwise scrolls the table out from under the
       panel and loses the row being acted on. */
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Focus moves into the panel so Tab stays here and Escape is heard even
    // when the click that opened it landed on a button now covered up.
    panelRef.current?.focus()

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      aria-hidden={!open}
      className="fixed inset-0 z-[9998]"
      style={{ pointerEvents: open ? 'auto' : 'none' }}>

      {/* Scrim. Fades rather than appearing, so the panel reads as sliding over
          the page rather than the page being replaced. */}
      <div
        onClick={onClose}
        className="absolute inset-0 transition-opacity duration-200"
        style={{ background: 'rgba(2,18,46,0.45)', opacity: open ? 1 : 0 }}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="absolute top-0 right-0 h-full bg-white dark:bg-[#1a2d55] shadow-2xl
                   flex flex-col outline-none transition-transform duration-250 ease-out"
        style={{
          width,
          /* The floor, not a ceiling: half of a phone is too narrow for a form,
             so below ~760px the panel takes the whole screen instead. */
          minWidth: 'min(100vw, 380px)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
        }}>

        <div className="flex items-start gap-3 px-6 py-4 border-b border-gray-100 dark:border-white/10 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-[#14254A] dark:text-white truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs text-gray-500 dark:text-white/50 mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="text-gray-400 hover:text-gray-700 dark:hover:text-white text-2xl leading-none -mt-1">
            ×
          </button>
        </div>

        {/* The only scrolling region, so the header and the actions stay put. */}
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer && (
          <div className="px-6 py-4 border-t border-gray-100 dark:border-white/10 flex-shrink-0
                          bg-gray-50/60 dark:bg-white/[0.03]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
