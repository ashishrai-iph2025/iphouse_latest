'use client'

/*
 * The product's one message box.
 *
 * Written here rather than pulled in. The request was for a SweetAlert-style
 * notification, and SweetAlert is not among this product's five runtime
 * dependencies — adding it would mean a library, a lockfile entry, an SBOM
 * entry and a standing patch obligation (DEPENDENCY_PATCH_CADENCE.md) for a
 * panel that is a box, a heading, a paragraph and a button. It would also
 * arrive with its own palette and its own light-only styling, on a product with
 * a dark theme and a navy/orange identity, so most of what it brought would be
 * overridden anyway.
 *
 * What it replaces is `alert()`, which the download page still calls: an OS
 * dialog that blocks the tab, cannot say two things, and cannot offer the link
 * that is the whole point of the message.
 *
 * Portalled for the reason every overlay in this product is — the page wrappers
 * carry `.fade-in`, whose `fill-mode: both` leaves a permanent transform behind,
 * and a transformed ancestor makes `position: fixed` resolve against the content
 * box instead of the viewport.
 */

import { useEffect, useRef } from 'react'
import Portal from '@/components/ui/Portal'

export type AlertTone = 'success' | 'info' | 'error'

const TONES: Record<AlertTone, { ring: string; icon: React.ReactNode }> = {
  success: {
    ring: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    icon: <path d="M20 6 9 17l-5-5" />,
  },
  info: {
    ring: 'bg-[#FC934C]/10 text-[#FC934C]',
    icon: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5h.01" /></>,
  },
  error: {
    ring: 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300',
    icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16h.01" /></>,
  },
}

export interface AlertAction {
  label: string
  onClick: () => void
  /** The one the eye should land on. At most one, or none. */
  primary?: boolean
}

export default function AlertDialog({
  open, tone = 'info', title, body, actions = [], onClose,
}: {
  open: boolean
  tone?: AlertTone
  title: string
  /** Lines, not a paragraph — a message with a consequence and a where-to-look
      reads as two sentences and should be laid out as two. */
  body: React.ReactNode
  actions?: AlertAction[]
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    /* Focus moves into the dialog so a keyboard reader is not left behind on
       the button that opened it, and so Escape reaches the handler above. */
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const t = TONES[tone]

  return (
    <Portal>
      <style>{`@keyframes alertIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}`}</style>
      <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 backdrop-blur-[2px]"
        style={{ background: 'rgba(20,37,74,0.45)' }}
        role="alertdialog" aria-modal="true" aria-label={title}
        onClick={onClose}>
        <div ref={panelRef} tabIndex={-1}
          className="w-full max-w-[420px] rounded-2xl shadow-2xl outline-none
            bg-white dark:bg-[#1a2d55] border border-gray-100 dark:border-white/10"
          style={{ animation: 'alertIn .18s ease-out' }}
          onClick={e => e.stopPropagation()}>

          <div className="px-6 pt-6 pb-4 text-center">
            <span className={`w-12 h-12 mx-auto mb-3 grid place-items-center rounded-full ${t.ring}`}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                {t.icon}
              </svg>
            </span>
            <h2 className="text-base font-extrabold text-[#14254A] dark:text-white">{title}</h2>
            <div className="mt-2 text-[13px] leading-relaxed text-gray-500 dark:text-white/60 space-y-1.5">
              {body}
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 px-6 pb-6 flex-wrap">
            {actions.map(a => (
              <button key={a.label} type="button" onClick={a.onClick}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                  a.primary
                    ? 'text-white hover:opacity-90'
                    : 'border border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/15 dark:text-white/70 dark:hover:bg-white/5'}`}
                style={a.primary ? { background: 'linear-gradient(135deg,#14254A,#1e3a6e)' } : undefined}>
                {a.label}
              </button>
            ))}
            {/* A dialog with no actions still needs a way out that is not the
                backdrop — a reader who does not know the backdrop closes it is
                otherwise stuck looking at a message. */}
            {actions.length === 0 && (
              <button type="button" onClick={onClose}
                className="px-5 py-2 rounded-xl text-xs font-bold text-white hover:opacity-90"
                style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                OK
              </button>
            )}
          </div>
        </div>
      </div>
    </Portal>
  )
}
