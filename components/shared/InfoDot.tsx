'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/*
The product's one ⓘ.

It lived inside the reports page, where it was written, and the live counts card
needed the same thing — a note that explains a figure without spending a line of
the card on it. Copying it would have been two tooltips that drift apart in
behaviour and in styling, on screens a reader moves between, so it moved here
instead. The reports page imports it from this file unchanged.
*/
/**
 * The ⓘ an admin's description sits behind — written per panel in Report
 * Configuration → Page Layout. No text at all renders nothing, so a card nobody
 * annotated looks exactly as it always did.
 *
 * HOVERED, and rendered rather than left to the browser's own `title`: a native
 * tooltip waits about a second, wraps a paragraph into one long line, and cannot
 * be styled to match the card it belongs to. This opens at once and reads as
 * part of the page.
 *
 * It stays open while the pointer is over the BUBBLE too, with a short grace
 * period crossing the gap between the two — the notes run to a couple of lines,
 * and one that vanishes as you move to read it is a note you cannot read. Focus
 * opens it as well, which is what gives it to the keyboard and, since a tap
 * focuses, to touch.
 *
 * Portalled for one reason: both the card and the KPI tile are `overflow-hidden`,
 * so a bubble positioned inside either is clipped at the card edge.
 */
export default function InfoDot({ text }: { text?: string }) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const dotRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | null>(null)

  const cancelClose = () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
  }
  /* Measured as it opens rather than in an effect afterwards, so the bubble
     never paints one frame at the previous icon's position. */
  const show = () => {
    cancelClose()
    setRect(dotRef.current?.getBoundingClientRect() ?? null)
    setOpen(true)
  }
  const hide = () => {
    cancelClose()
    timer.current = window.setTimeout(() => setOpen(false), 140)
  }

  // A pending close must not fire into an unmounted component.
  useEffect(() => cancelClose, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    /* The bubble is pinned to where the icon was, so anything that moves the
       icon leaves it stranded. Closing is honest and cheap; following the
       scroll would mean re-measuring on every frame for a transient note. */
    const onMove = () => setOpen(false)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  if (!text) return null
  const W = 280

  /* ── Where the bubble goes, and how tall it may be ────────────────────────
     Both decided from the space actually available, because the note is no
     longer always short: the live counts card explains a figure in paragraphs,
     and a bubble sized for one line ran off the bottom of the window. Nothing
     could be done about that from the reader's side either — SCROLLING CLOSES
     IT, by design above, so text below the fold was unreachable rather than
     merely awkward.

     Placed above by `bottom` rather than by a computed `top`, which is what
     makes this work without knowing the rendered height: the browser grows the
     box upward from a fixed lower edge. Whichever side is chosen, maxHeight is
     the room on that side, and a note longer than that scrolls INSIDE the
     bubble — where the pointer is already being kept, so scrolling it does not
     dismiss it. */
  const gap = 8
  const roomBelow = rect ? window.innerHeight - rect.bottom - gap * 2 : 0
  const roomAbove = rect ? rect.top - gap * 2 : 0
  const above = roomBelow < 180 && roomAbove > roomBelow
  const place: React.CSSProperties = rect
    ? {
        width: W,
        maxHeight: Math.max(120, above ? roomAbove : roomBelow),
        left: Math.max(gap, Math.min(rect.left - gap, window.innerWidth - W - gap)),
        ...(above
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
      }
    : {}

  return (
    <>
      {/* The description is the accessible name, so a screen reader reads it on
          focus without depending on the bubble being open. */}
      <span ref={dotRef} tabIndex={0} role="note" aria-label={text}
        onMouseEnter={show} onMouseLeave={hide}
        onFocus={show} onBlur={hide}
        className={`inline-grid place-items-center w-4 h-4 flex-shrink-0 rounded-full
          cursor-help transition-colors ${open
            ? 'text-[#FC934C]'
            : 'text-gray-300 hover:text-[#FC934C] dark:text-white/30 dark:hover:text-[#FDBE94]'}`}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={2} strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" /><path d="M12 7.5h.01" />
        </svg>
      </span>

      {open && rect && createPortal(
        <div role="tooltip"
          onMouseEnter={cancelClose} onMouseLeave={hide}
          className="fixed z-[9999] rounded-xl border shadow-2xl px-3 py-2.5 overflow-y-auto
            bg-white border-gray-200 dark:bg-[#1a2d55] dark:border-white/15"
          style={place}>
          <p className="text-[11.5px] leading-relaxed text-[#14254A] dark:text-white/85 whitespace-pre-wrap">
            {text}
          </p>
        </div>,
        document.body,
      )}
    </>
  )
}
