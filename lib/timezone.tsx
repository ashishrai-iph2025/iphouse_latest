'use client'

// Which clock the portal reads API data in.
//
// Every timestamp upstream returns is UTC. Rendered raw, a takedown logged at
// 22:10 IST reads as "16:40" to the client who watched it happen — so this
// holds one preference, the country whose clock to use, and every timestamp
// goes through `formatUtc` below.
//
// TWO MODES. Auto is the default; picking a country switches to manual, and
// "Auto-detect" switches back.
//
//   auto    Work it out, in this order, re-checked every 30 seconds:
//
//             1. The server's answer to "where does this request come from?"
//                (/api/geo/country). This is the one that follows a VPN or a
//                corporate egress, because it reads the IP the connection
//                actually arrives on. It is empty for a private or loopback
//                peer — which is every request when the portal is opened on
//                localhost, since the browser never puts it on the network.
//             2. The device's own location, if already permitted — coordinates
//                in, country out, offline (lib/countries.ts). This is where
//                the machine IS, and no VPN moves it.
//             3. The browser's IANA zone. Needs no permission, is exact, and
//                already knows whether today is BST or GMT.
//   picked  The user chose a country. Explicit beats inferred, always, and it
//           survives reloads until they switch back to auto.
//
// Auto does NOT pop a location prompt on load. A permission dialog nobody asked
// for is the kind of thing people click away on reflex, and once dismissed the
// browser may not ask again — so the first grant comes from the button in the
// picker, a deliberate act, and every load after that uses it silently.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { COUNTRIES, countryByName, countryForCoords, countryForISO, countryForZone, type Country } from './countries'

const STORAGE_KEY = 'iphouse.timezone'

/** How often auto mode re-reads the device's location. Half a minute is often
    enough to follow someone who has moved, and rare enough to be free. */
const LOCATION_POLL_MS = 30_000

/** How the current zone was arrived at — shown in the picker, not acted on. */
export type ZoneSource = 'picked' | 'network' | 'located' | 'browser'
export type ZoneMode = 'auto' | 'picked'

interface Stored { country?: string; zone: string; source: ZoneSource; mode: ZoneMode }

interface TimeZoneCtx {
  /** The zone every conversion uses. Always set. */
  zone: string
  /** The country behind it, when one is known. Display only. */
  country?: Country
  source: ZoneSource
  /** 'auto' re-detects on every load; 'picked' holds the chosen country. */
  mode: ZoneMode
  /** True while a location lookup is in flight. */
  locating: boolean
  /** Set when the last location attempt failed, for the picker to show. */
  locateError: string
  /** When the device was last asked, so the picker can show the watch ticking
      rather than leaving the reader to guess whether it is running. */
  lastChecked?: number
  /** What that check reported, whether or not it changed anything. */
  lastSeen?: string
  /** Whether this browser can even offer the location option. */
  canLocate: boolean
  setCountry: (name: string) => void
  /** Hand it back to auto-detection, and re-run it now. */
  useAutoDetect: () => void
  /** Ask the device where it is, then keep the country it lands in. */
  detectFromLocation: () => void
  /** What the last network check reported: a country, or why it could not. */
  networkNote?: string
  /** Format a UTC timestamp from the API in the chosen zone. */
  formatUtc: (value: unknown, opts?: FormatOpts) => string
}

export interface FormatOpts {
  /** 'date' → 12 Aug 2026 · 'time' → 14:05 · 'datetime' → both (default). */
  style?: 'date' | 'time' | 'datetime'
  /** Shown when the value is missing or unparseable. */
  fallback?: string
  /** Append the zone's short name, e.g. "IST". Off by default — it belongs on
      a column header or a tooltip, not repeated down a table. */
  withZone?: boolean
}

/** The browser's own zone, or UTC where it cannot be read. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Parse what the API calls a date.
 *
 * The upstream sends UTC but is not consistent about saying so: some fields
 * carry a Z, some are a bare "2026-08-12 14:05:00". A bare stamp parsed by the
 * browser is read as LOCAL time, which silently shifts it by the very offset
 * this module exists to apply — so a missing zone is made explicit here rather
 * than left to the engine.
 */
export function parseApiDate(value: unknown): Date | null {
  if (value == null || value === '') return null
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  let s = String(value).trim()
  if (!s) return null
  const hasZone = /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(s)
  if (!hasZone) {
    // "2026-08-12 14:05:00" and "2026-08-12T14:05:00" are both UTC upstream.
    const iso = s.replace(' ', 'T')
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) s = iso + 'Z'
    else if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) s = iso + 'T00:00:00Z'
    else s = iso
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

/** Format a UTC value in `zone`. Exported for code outside a React tree. */
export function formatInZone(value: unknown, zone: string, opts: FormatOpts = {}): string {
  const { style = 'datetime', fallback = '—', withZone = false } = opts
  const d = parseApiDate(value)
  if (!d) return fallback
  const base: Intl.DateTimeFormatOptions = { timeZone: zone }
  if (style !== 'time') { base.day = '2-digit'; base.month = 'short'; base.year = 'numeric' }
  if (style !== 'date') { base.hour = '2-digit'; base.minute = '2-digit'; base.hour12 = false }
  if (withZone) base.timeZoneName = 'short'
  try {
    return new Intl.DateTimeFormat(undefined, base).format(d)
  } catch {
    // An unknown zone must not blank the column; UTC is the honest fallback.
    return new Intl.DateTimeFormat(undefined, { ...base, timeZone: 'UTC' }).format(d)
  }
}

const Ctx = createContext<TimeZoneCtx | null>(null)

function read(): Stored | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (typeof v?.zone !== 'string') return null
    // `mode` arrived after the first release; anything stored without one was
    // an explicit pick, which is the reading that loses nobody's choice.
    return { ...v, mode: v.mode === 'auto' ? 'auto' : 'picked' } as Stored
  } catch { return null }
}

export function TimeZoneProvider({ children }: { children: React.ReactNode }) {
  // Read storage during the first render, not in an effect: an effect would
  // paint every timestamp in the browser zone and then move them, which reads
  // as the page correcting itself.
  const [stored, setStored] = useState<Stored>(() => {
    const saved = read()
    if (saved) return saved
    // First visit: auto, resolved from the browser zone until — and unless —
    // location is available.
    const zone = browserZone()
    return { zone, country: countryForZone(zone)?.name, source: 'browser', mode: 'auto' }
  })
  const [locating, setLocating] = useState(false)
  const [locateError, setLocateError] = useState('')
  const [lastChecked, setLastChecked] = useState<number | undefined>()
  const [lastSeen, setLastSeen] = useState<string | undefined>()
  const [networkNote, setNetworkNote] = useState<string | undefined>()

  const persist = useCallback((next: Stored) => {
    setStored(next)
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  }, [])

  const setCountry = useCallback((name: string) => {
    const c = countryByName(name)
    if (!c) return
    setLocateError('')
    persist({ country: c.name, zone: c.zone, source: 'picked', mode: 'picked' })
  }, [persist])

  const canLocate = typeof navigator !== 'undefined' && !!navigator.geolocation

  // A mirror of the current preference for the poll to read. The interval is
  // set up once; without this it would close over the value at that moment and
  // rewrite the same country every thirty seconds.
  const storedRef = useRef(stored)
  useEffect(() => { storedRef.current = stored }, [stored])

  /**
   * Read the device's position and keep the country it lands in.
   *
   * `quiet` is the background poll: no spinner, no error banner. A poll that
   * fails is not news — the previous answer still stands — whereas a button
   * press that fails needs to say so.
   *
   * `maximumAge: 0` matters more than it looks. It was 10 minutes, which is a
   * cache: every poll inside that window returned the SAME fix without asking
   * the device, so a location that changed looked like a portal that had
   * stopped detecting. Each check now gets a fresh reading.
   */
  const locate = useCallback((quiet = false) => {
    if (!navigator.geolocation) {
      if (!quiet) setLocateError('This browser cannot share a location.')
      return
    }
    if (!quiet) { setLocating(true); setLocateError('') }
    navigator.geolocation.getCurrentPosition(
      async pos => {
        // Awaited: the country outlines are loaded on demand, not bundled into
        // every page (see countryForCoords).
        const c = await countryForCoords(pos.coords.latitude, pos.coords.longitude)
        if (!quiet) setLocating(false)
        // Recorded on every check, changed or not — "checked 12s ago, still
        // India" is the answer to "is this thing even running?".
        setLastChecked(Date.now())
        setLastSeen(c?.name)
        if (!c) {
          if (!quiet) setLocateError('That location is not in a country we hold a time zone for. Pick one below.')
          return
        }
        // Only write when the answer actually changed. Persisting on every tick
        // would re-render every timestamp on the page twice a minute for
        // nothing.
        const cur = storedRef.current
        if (cur.mode === 'auto' && cur.source === 'located' && cur.country === c.name) return
        persist({ country: c.name, zone: c.zone, source: 'located', mode: 'auto' })
      },
      err => {
        if (quiet) return
        setLocating(false)
        setLocateError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was declined. Pick a country instead.'
            : 'Could not read this device’s location. Pick a country instead.')
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    )
  }, [persist])

  const detectFromLocation = useCallback(() => locate(false), [locate])

  /** Back to auto, and settle on the browser zone until location answers. */
  const useAutoDetect = useCallback(() => {
    setLocateError('')
    const zone = browserZone()
    persist({ zone, country: countryForZone(zone)?.name, source: 'browser', mode: 'auto' })
    if (navigator.geolocation) locate(false)
  }, [persist, locate])

  /**
   * Ask the server which country this connection appears to come from.
   *
   * Ranks ABOVE the device's own location, because it is the answer to the
   * question people actually mean by "where am I": a VPN in another country
   * changes this and cannot change GPS. Returns true when it settled the
   * question, so the caller knows whether to fall back.
   */
  const detectFromNetwork = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/geo/country', { credentials: 'include' })
      if (!res.ok) { setNetworkNote('the server could not be reached'); return false }
      const body = await res.json()
      const code = String(body?.country ?? '')
      if (!code) {
        // Loopback and private peers land here, which is the normal answer in
        // development. Say so, rather than looking like a failure.
        setNetworkNote('this connection has no public address to read')
        return false
      }
      const c = countryForISO(code)
      if (!c) { setNetworkNote(`no clock is mapped for ${code}`); return false }
      setNetworkNote(c.name)
      const cur = storedRef.current
      if (cur.mode === 'auto' && cur.source === 'network' && cur.country === c.name) return true
      persist({ country: c.name, zone: c.zone, source: 'network', mode: 'auto' })
      return true
    } catch {
      setNetworkNote('the server could not be reached')
      return false
    }
  }, [persist])

  /**
   * In auto mode, keep watching: once on load, then every 30 seconds, and again
   * whenever the tab comes back to the front.
   *
   * Only ever where permission is ALREADY granted, so none of this raises a
   * prompt — a browser still at "prompt" simply stays on its own zone until the
   * button in the picker is pressed. Hidden tabs are skipped; a background tab
   * asking the device where it is twice a minute is a battery cost with nobody
   * reading the result.
   */
  useEffect(() => {
    if (stored.mode !== 'auto') return
    const perms = navigator.permissions

    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    // The network answer wins when it has one; the device is the fallback.
    const tick = async () => {
      if (document.hidden || cancelled) return
      setLastChecked(Date.now())
      if (await detectFromNetwork()) return
      locate(true)
    }
    const onVisible = () => { void tick() }

    const start = () => {
      if (cancelled || timer) return
      void tick()
      timer = setInterval(() => { void tick() }, LOCATION_POLL_MS)
      document.addEventListener('visibilitychange', onVisible)
    }

    // The watch runs regardless: the network check needs no permission from
    // anyone, and it is the signal that follows a VPN. The permission query is
    // only so that GRANTING location mid-session starts using it without a
    // reload — the poll itself is already going.
    start()
    if (perms?.query && navigator.geolocation) {
      perms.query({ name: 'geolocation' as PermissionName })
        .then(status => {
          status.onchange = () => { if (!cancelled && status.state === 'granted') void tick() }
        })
        .catch(() => { /* Firefox rejects for geolocation; the poll stands. */ })
    }

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [stored.mode, locate])

  const formatUtc = useCallback(
    (value: unknown, opts?: FormatOpts) => formatInZone(value, stored.zone, opts),
    [stored.zone])

  const value = useMemo<TimeZoneCtx>(() => ({
    zone: stored.zone,
    country: stored.country ? countryByName(stored.country) : countryForZone(stored.zone),
    source: stored.source,
    mode: stored.mode,
    locating, locateError, canLocate, lastChecked, lastSeen, networkNote,
    setCountry, useAutoDetect, detectFromLocation, formatUtc,
  }), [stored, locating, locateError, canLocate, lastChecked, lastSeen, networkNote,
       setCountry, useAutoDetect, detectFromLocation, formatUtc])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * Outside a provider this still returns a working formatter on the browser
 * zone, so a component can render times without the tree having to be wired —
 * it just cannot change the preference.
 */
export function useTimeZone(): TimeZoneCtx {
  const ctx = useContext(Ctx)
  const zone = browserZone()
  const fallback = useMemo<TimeZoneCtx>(() => ({
    zone,
    country: countryForZone(zone),
    source: 'browser',
    mode: 'auto',
    locating: false, locateError: '', canLocate: false,
    setCountry: () => {}, useAutoDetect: () => {}, detectFromLocation: () => {},
    formatUtc: (v, o) => formatInZone(v, zone, o),
  }), [zone])
  return ctx ?? fallback
}

/** The whole selectable list, for the picker. */
export const COUNTRY_OPTIONS = COUNTRIES.map(c => ({ key: c.name, label: c.name }))
