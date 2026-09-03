'use client'

/**
 * An embedded Power BI report.
 *
 * Extracted from ClientShell's dashboard page rather than written twice: the
 * sequence is fiddly and every step of it has a way of failing that says
 * nothing useful if it is not handled — load the client library from a CDN, ask
 * our own server for an embed token, then hand Power BI a token, a URL and an
 * id together. Two copies would be two of those to keep in step, and the second
 * one would drift the first time Microsoft changed a field name.
 *
 * WHAT IT DOES NOT DO. It does not mint the token. /api/embed-token performs the
 * Azure client-credentials hand-off and the GenerateToken call, which is where
 * the Power BI credentials live and the only place they should be. This
 * component knows a report reference and nothing else.
 */

import { useEffect, useRef, useState } from 'react'
import ReportLoader from '@/components/shared/ReportLoader'

/**
 * The id out of whatever was pasted.
 *
 * An operator assigning a dashboard pastes what the Power BI address bar gave
 * them, which is usually a full URL carrying the id in ?reportId=. Sometimes it
 * is the bare id. Both are accepted because both are what people actually have,
 * and refusing the URL would mean a support conversation about which half of it
 * to keep.
 */
export function extractReportId(ref: string): string {
  const raw = String(ref || '').trim()
  try {
    return new URL(raw).searchParams.get('reportId') || raw
  } catch {
    return raw
  }
}

/** Loaded once per document, and shared. Two embeds on one page must not fetch
 *  the library twice, and the global it defines is the thing being waited for. */
let pbiScript: Promise<void> | null = null

function loadPowerBI(): Promise<void> {
  if ((window as any).powerbi) return Promise.resolve()
  if (pbiScript) return pbiScript
  pbiScript = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/powerbi-client/dist/powerbi.js'
    s.onload = () => resolve()
    s.onerror = () => {
      /* Cleared so a later mount can try again. Left set, one blocked request
         would make every embed for the rest of the session fail instantly on a
         rejected promise nobody can retry. */
      pbiScript = null
      reject(new Error('The Power BI viewer could not be loaded.'))
    }
    document.head.appendChild(s)
  })
  return pbiScript
}

export default function PowerBIReport({
  reportRef, title, className = '', height = 'calc(100dvh - 15rem)',
}: {
  /** The report id, or the Power BI URL it came in. */
  reportRef: string
  /** Named in the waiting state, so a slow embed says what it is waiting for. */
  title?: string
  className?: string
  /**
   * A DEFINITE height, and that is not a preference.
   *
   * Power BI embeds an iframe styled height:100%. A percentage resolves against
   * the parent's height, and a parent with only a MIN-height has a content
   * height of zero — so the iframe collapsed to a couple of hundred pixels with
   * its page tabs sitting over the visuals, which is exactly what it did when
   * this took a minHeight instead.
   *
   * Viewport-relative rather than a fixed number of pixels: the report is the
   * whole page here, so it should take the screen it is given. The subtraction
   * is the shell's header and the card's own chrome; a floor underneath keeps it
   * usable on a short window.
   */
  height?: string
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const id = extractReportId(reportRef)
    if (!id) {
      setErr('This report has no Power BI reference.')
      setLoading(false)
      return
    }

    setLoading(true)
    setErr('')

    ;(async () => {
      try {
        await loadPowerBI()
        if (!alive) return

        const res = await fetch(`/api/embed-token?reportId=${encodeURIComponent(id)}`,
          { credentials: 'include' })
        /*
          The CONTENT TYPE before the body, because the failure this catches is
          not our server's. Something in front of the app — a gateway, a proxy,
          a security check — can answer first with an HTML page, and JSON.parse
          on that throws a syntax error mentioning "<" that tells the reader
          nothing. Checked, so the message names the situation instead.
        */
        const ct = res.headers.get('content-type') || ''
        if (!ct.includes('application/json')) {
          throw new Error(res.ok
            ? 'Unexpected response from the server — please try again.'
            : `The reporting service is unavailable (error ${res.status}).`)
        }
        const d = await res.json().catch(() => {
          throw new Error('Invalid response from the server — please try again.')
        })
        if (!alive) return
        if (!res.ok || d.error) {
          throw new Error(d.error || `Server error (${res.status}).`)
        }

        const pbi = (window as any).powerbi
        if (!pbi || !host.current) return
        // Reset first: embedding into a container that already holds a report
        // leaves the old one attached and the new one silently does nothing.
        pbi.reset(host.current)
        pbi.embed(host.current, {
          type: 'report',
          tokenType: 1, // Embed, not Azure AD — the token came from our server.
          accessToken: d.embedToken,
          embedUrl: d.embedUrl,
          id: d.reportId,
          settings: {
            panes: {
              /* The report's own filter pane stays shut. This page has its own
                 rail, and two sets of filters that do not know about each other
                 is worse than one. Page navigation stays: a Power BI report's
                 pages are its own structure and there is nothing here to
                 replace them with. */
              filters: { visible: false },
              pageNavigation: { visible: true },
            },
          },
        })
      } catch (e: any) {
        if (alive) setErr(e?.message || 'The report could not be loaded.')
      } finally {
        if (alive) setLoading(false)
      }
    })()

    return () => { alive = false }
  }, [reportRef])

  return (
    /* The height is set HERE and inherited down: this element, the host inside
       it and the iframe Power BI puts in the host all need a definite one, and
       the chain breaks at whichever link is left to auto. */
    <div className={`relative ${className}`} style={{ height, minHeight: 460 }}>
      {/* The host is always mounted. Power BI embeds into a live element, so
          rendering it only once loading finished would hand embed() a container
          that does not exist yet. */}
      <div ref={host} className="w-full h-full rounded-2xl overflow-hidden" />

      {loading && (
        <div className="absolute inset-0 grid place-items-center rounded-2xl
          bg-white/90 dark:bg-[#1a2d55]/90">
          <ReportLoader size={150} label="Opening the report"
            sublabel={title || undefined} />
        </div>
      )}

      {err && !loading && (
        <div className="absolute inset-0 grid place-items-center rounded-2xl
          bg-white dark:bg-[#1a2d55] px-6">
          <div className="max-w-md text-center">
            <p className="text-sm font-bold text-amber-800 dark:text-amber-200">
              This report could not be opened
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-300/80 mt-1.5 leading-relaxed">
              {err}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
