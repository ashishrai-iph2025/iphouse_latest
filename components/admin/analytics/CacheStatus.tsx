// The report cache's status, for a page header: is Redis answering, which data
// version the cached answers belong to (and when it was seen), and what was
// prepared ahead of time. Reads reports_api's own status route through the
// portal — /v1/traffic/cache or /v1/torrent/report/cache — every minute.

import { useEffect, useRef, useState } from 'react'
import { useTok, BODY_FONT } from './ui'

export default function CacheStatus({ url, kind }: { url: string; kind: 'traffic' | 'torrent' }) {
  const t = useTok()
  const { d } = t
  const [st, setSt] = useState<any>(null)
  const [err, setErr] = useState(false)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    const load = () => fetch(url, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(b => { if (live) { setSt(b); setErr(false) } })
      .catch(() => { if (live) setErr(true) })
    load()
    const id = setInterval(load, 60_000)
    return () => { live = false; clearInterval(id) }
  }, [url])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const redis = !!st?.redis
  const dot = err ? d.bad : !st ? d.sub : redis ? d.good : '#d97706'
  const label = err ? 'Cache status unavailable' : !st ? 'Checking cache…' : redis ? 'Redis cache on' : 'Redis down — memory cache only'
  const when = (v?: string) => (v && !v.startsWith('0001') ? new Date(v).toLocaleString() : '—')
  const prep = st?.prepared || {}
  const searches: any[] = st?.searches || []
  const busy = searches.filter(s => s.status === 'running' || s.status === 'queued').length

  return (
    <div className="relative" ref={ref} style={BODY_FONT}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg"
        style={{ background: d.card, color: d.text, border: `1px solid ${d.cardBorder}` }}
        title="Where these numbers come from, and how fresh they are">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: dot, boxShadow: redis ? `0 0 0 3px ${dot}33` : undefined }} />
        {label}
      </button>
      {open && st && (
        <div className="absolute right-0 z-20 mt-2 w-[340px] rounded-xl p-4 text-xs space-y-2.5 shadow-xl"
          style={{ background: d.card, border: `1px solid ${d.cardBorder}`, color: d.text }}>
          <Row k="Redis" v={redis ? 'Connected — answers survive restarts' : 'Not reachable — answers kept in memory only'} />
          <Row k="Data version" v={st.dataVersion || '—'} mono />
          {kind === 'traffic' && st.versionFrom && (
            <Row k="Version from" v={`Domains to ${String(st.versionFrom.inf ?? '').slice(0, 10)} · traffic ${Number(st.versionFrom.sw ?? 0).toLocaleString()} rows`} />
          )}
          {kind === 'torrent' && <Row k="Version seen" v={when(st.versionSeenAt)} />}
          <Row k="Prepared" v={prep.at && !String(prep.at).startsWith('0001')
            ? `${(prep.clients || []).length} client(s) at ${when(prep.at)}${prep.running ? ' · running now' : ''}`
            : 'Nothing yet for this version'} />
          {kind === 'traffic' && <Row k="Recently opened" v={`${st.recentClients ?? 0} client(s) — kept ready after each refresh`} />}
          {kind === 'torrent' && <Row k="Searches" v={`${searches.length} held${busy ? ` · ${busy} running or queued` : ''}`} />}
          <p className="pt-1" style={{ color: d.sub }}>
            An answer is cached under the data version, so it is reused until new data lands in the warehouse — then
            the next request rebuilds it. Checked every 10 minutes.
          </p>
        </div>
      )}
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  const { d } = useTok()
  return (
    <div className="flex gap-3">
      <span className="w-28 shrink-0 font-semibold uppercase tracking-wider text-[10px] pt-0.5" style={{ color: d.sub }}>{k}</span>
      <span className={mono ? 'font-mono' : ''}>{v}</span>
    </div>
  )
}
