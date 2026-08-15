'use client'

// The header control for "which clock am I reading this data in?".
//
// It sits beside the theme toggle because it is the same kind of setting: it
// changes nothing about the data, only how the page renders it. Closed, it
// names the COUNTRY — "Germany" is a thing a reader can confirm or correct at a
// glance, where "UTC+2" is a fact about it they have to translate first. The
// offset is still there, beside each country in the list and in the panel
// header, where it settles which of two neighbours you meant.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSession } from '@/lib/auth-client'
import { useTimeZone } from '@/lib/timezone'
import { COUNTRIES } from '@/lib/countries'

/** "+05:30" for the zone right now, which is the thing worth showing small. */
function offsetLabel(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, timeZoneName: 'shortOffset',
    }).formatToParts(new Date())
    const name = parts.find(p => p.type === 'timeZoneName')?.value ?? ''
    return name.replace('GMT', 'UTC') || 'UTC'
  } catch { return 'UTC' }
}

export default function CountryPicker({ tone = 'dark' }: { tone?: 'light' | 'dark' }) {
  const tz = useTimeZone()
  /* How the zone was arrived at — auto vs manual, the geolocation fallback, the
     watch interval, what the connection and the device each reported — is
     diagnostic. It is what you read when someone says "the times look wrong",
     and it is answered by staff, not by the person reporting it. A client sees
     only the setting itself: which country the clock is in, and the list to
     change it. Role 1/2 are Admin and Super Admin; a Client Admin is role 0
     like the rest of its company, and impersonation forces role 0, so staff
     viewing as a client correctly see the client's panel. */
  const { data: session } = useSession()
  const isStaff = session?.user?.role === 1 || session?.user?.role === 2
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rect, setRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setRect(btnRef.current?.getBoundingClientRect() ?? null)
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false); setQuery('')
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { setOpen(false); setQuery('') } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const q = query.trim().toLowerCase()
  const list = q ? COUNTRIES.filter(c => c.name.toLowerCase().includes(q)) : COUNTRIES

  // The country, or the zone when the device sits somewhere with none mapped.
  const label = tz.country?.name ?? tz.zone

  // Re-rendered on a timer purely so "checked 12s ago" keeps counting while the
  // panel is open. Nothing else on the page depends on it.
  const [, tickNow] = useState(0)
  useEffect(() => {
    if (!open || !isStaff) return
    const t = setInterval(() => tickNow(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [open])

  const agoLabel = tz.lastChecked
    ? `${Math.max(0, Math.round((Date.now() - tz.lastChecked) / 1000))}s ago`
    : null

  const btnTone = tone === 'light'
    ? 'text-white hover:bg-white/10'
    : 'text-[#14254A] dark:text-white hover:bg-gray-100 dark:hover:bg-white/10'

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen(o => !o)}
        aria-expanded={open} aria-haspopup="dialog"
        title={`Times shown in ${label} — ${tz.zone}, ${offsetLabel(tz.zone)}`}
        className={`flex items-center gap-1.5 px-2 py-2 rounded-lg transition-colors ${btnTone}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
        </svg>
        <span className="hidden sm:inline text-[11px] font-bold max-w-[110px] truncate">
          {label}
        </span>
      </button>

      {open && rect && createPortal(
        <div ref={panelRef} role="dialog" aria-label="Time zone"
          className="fixed z-[9999] w-[290px] rounded-xl border shadow-2xl overflow-hidden
            bg-white border-gray-200 dark:bg-[#1a2d55] dark:border-white/15"
          style={{
            top: Math.min(rect.bottom + 8, window.innerHeight - 420),
            left: Math.max(8, Math.min(rect.left - 120, window.innerWidth - 300)),
          }}>

          <div className="px-3.5 pt-3 pb-2.5 border-b border-gray-100 dark:border-white/10">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Show times in</p>
            <p className="text-sm font-bold text-[#14254A] dark:text-white mt-0.5 truncate">
              {tz.country?.name ?? tz.zone}
            </p>
            <p className="text-[11px] text-gray-400 mt-0.5">
              {tz.zone} · {offsetLabel(tz.zone)}
            </p>
            {isStaff && (
            <p className="text-[11px] mt-1">
              {tz.mode === 'auto' ? (
                <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Auto-detected
                  <span className="font-normal text-gray-400">
                    {tz.source === 'network' ? '· from your connection'
                      : tz.source === 'located' ? '· from your location'
                      : '· from this device'}
                  </span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-2 text-gray-400">
                  <span className="font-semibold text-[#14254A] dark:text-white">Chosen by you</span>
                  <button type="button" onClick={tz.useAutoDetect}
                    className="font-semibold text-[#FC934C] hover:underline">
                    Auto-detect
                  </button>
                </span>
              )}
            </p>
            )}
            {/* The reason the control exists, said once. */}
            {isStaff && (
            <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">
              Reports arrive in UTC. Every date and time on the portal is converted
              to this country&rsquo;s clock before it is shown.
            </p>
            )}
          </div>

          {/* Geolocation and the detection log: staff only. Nothing in here is a
              setting — it is the evidence for why the clock reads as it does. */}
          {isStaff && (
          <div className="px-3.5 py-2.5 border-b border-gray-100 dark:border-white/10">
            {tz.canLocate && (
              <button type="button" onClick={tz.detectFromLocation} disabled={tz.locating}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold
                  border border-gray-200 text-[#14254A] hover:border-[#FC934C]/60 hover:text-[#FC934C]
                  disabled:opacity-60 transition-colors
                  dark:border-white/15 dark:text-white dark:hover:text-[#FC934C]">
                {tz.locating ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                    Checking…
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" />
                    </svg>
                    {tz.source === 'located' ? 'Refresh from my location' : 'Use my exact location'}
                  </>
                )}
              </button>
            )}
            {tz.canLocate && (
              <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">
                Allowed once, your device&rsquo;s location is used as a fallback.
              </p>
            )}
            {/* Proof the watch is running. Without it, "still India" and
                  "stopped checking" look identical from the outside. */}
            {agoLabel && (
              <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">
                Last checked <span className="font-semibold text-[#14254A] dark:text-white">{agoLabel}</span>,
                and every 30 seconds.
                {tz.networkNote && (
                  <><br />Connection: <span className="font-semibold text-[#14254A] dark:text-white">{tz.networkNote}</span></>
                )}
                {tz.lastSeen && (
                  <><br />Device: <span className="font-semibold text-[#14254A] dark:text-white">{tz.lastSeen}</span></>
                )}
              </p>
            )}
            {tz.locateError && (
              <p className="text-[10px] text-red-500 mt-1.5 leading-relaxed">{tz.locateError}</p>
            )}
          </div>
          )}

          <div className="px-3.5 pt-2.5 pb-2">
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search countries…"
              className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-gray-200 outline-none
                focus:border-[#FC934C] dark:border-white/15 dark:bg-white/5 dark:text-white" />
          </div>

          <div className="max-h-[210px] overflow-y-auto pb-2">
            {list.length === 0 && (
              <p className="px-3.5 py-3 text-xs text-gray-400">No country matches “{query}”.</p>
            )}
            {list.map(c => {
              const on = tz.country?.name === c.name
              return (
                <button key={c.name} type="button"
                  onClick={() => { tz.setCountry(c.name); setOpen(false); setQuery('') }}
                  className={`w-full flex items-center gap-2 px-3.5 py-1.5 text-left text-xs transition-colors ${
                    on
                      ? 'bg-[#14254A]/[0.06] font-bold text-[#14254A] dark:bg-white/10 dark:text-white'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5'
                  }`}>
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto text-[10px] tabular-nums text-gray-400 flex-shrink-0">
                    {offsetLabel(c.zone)}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="px-3.5 py-2 border-t border-gray-100 dark:border-white/10">
            <button type="button" onClick={() => { tz.useAutoDetect(); setOpen(false); setQuery('') }}
              disabled={tz.mode === 'auto'}
              className="text-[11px] font-semibold text-gray-400 enabled:hover:text-[#FC934C]
                disabled:opacity-45 transition-colors">
              {tz.mode === 'auto' ? 'Detecting automatically' : 'Back to auto-detect'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
