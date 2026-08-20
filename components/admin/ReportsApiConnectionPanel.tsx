'use client'

// Where the reports come from: the base URL and the API key, editable here
// rather than only in a .env file.
//
// The key is write-mostly. It is stored encrypted, returned as a mask, and the
// real value is only ever fetched by an explicit Reveal — which is Super-Admin
// only and logged on the server. Nothing on this screen holds it otherwise: it
// is not in the form's initial state and it is not fetched to render.

import { useEffect, useState } from 'react'

interface Config {
  baseUrl: string
  hasKey: boolean
  keyMasked: string
  effectiveBaseUrl: string
  effectiveHasKey: boolean
  baseUrlSource: 'database' | 'environment'
  keySource: 'database' | 'environment'
  updatedBy: string
  updatedAt: string
  /* How many calls a minute the portal will make, and how many of those a
     background job may have. These two decide how long a cache warm takes and
     nothing else does — see go-server/reportsapi/pace.go. */
  rateLimit: number
  bgShare: number
  budget?: Budget
}

interface Budget {
  perMinute: number
  background: number
  usedThisMinute: number
  calls: number
  backgroundCalls: number
  /** Calls that had to wait for a window to turn over. */
  throttled: number
  /** Total time spent waiting. The number that says whether pacing is the
      constraint: small, and something else is slow. */
  waitedSeconds: number
}

interface TestResult {
  reachable: boolean
  authorized: boolean
  warehouse: boolean
  datasets: number
  detail: string
}

export default function ReportsApiConnectionPanel() {
  const [cfg,     setCfg]     = useState<Config | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState('')
  /* Separate from `err` on purpose. A warning means the save WORKED and there
     is something to know about it — plain http to a public host puts the key on
     the wire in clear text. Rendering that in the red box would say the opposite
     of what happened, and rendering it nowhere is how it stops being true. */
  const [warn,    setWarn]    = useState('')

  const [baseUrl, setBaseUrl] = useState('')
  /* Empty means "leave the stored key alone" — which is what lets someone
     change the URL without re-typing a 70-character secret. */
  const [apiKey,  setApiKey]  = useState('')
  const [rateLimit, setRateLimit] = useState(480)
  const [bgShare,   setBgShare]   = useState(300)
  const [showKey, setShowKey] = useState(false)

  const [saving,  setSaving]  = useState(false)
  const [savedAt, setSavedAt] = useState('')
  const [testing, setTesting] = useState(false)
  const [test,    setTest]    = useState<TestResult | null>(null)
  const [revealed, setRevealed] = useState('')

  async function load() {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/admin/reports-api-config', { credentials: 'include' })
      const d = await res.json()
      if (!d.success) { setErr(d.error || 'Could not load the configuration'); return }
      setCfg(d)
      setBaseUrl(d.baseUrl || '')
      if (typeof d.rateLimit === 'number') setRateLimit(d.rateLimit)
      if (typeof d.bgShare === 'number') setBgShare(d.bgShare)
    } catch (e: any) { setErr(e?.message || 'Network error') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function save() {
    setSaving(true); setErr(''); setWarn(''); setSavedAt('')
    try {
      const res = await fetch('/api/admin/reports-api-config', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, rateLimit, bgShare }),
      })
      const d = await res.json()
      if (!d.success) { setErr(d.error || 'Could not save'); return }
      // Cleared from memory the moment it is stored; the mask comes back from
      // the reload.
      setApiKey(''); setShowKey(false); setRevealed('')
      setSavedAt(new Date().toLocaleTimeString())
      // Set AFTER the success path, so it can only ever appear beside a save
      // that actually happened.
      if (d.warning) setWarn(d.warning)
      await load()
    } catch (e: any) { setErr(e?.message || 'Network error') }
    finally { setSaving(false) }
  }

  async function clearKey() {
    if (!confirm('Remove the stored key? The service will fall back to REPORTS_API_KEY from the environment, if one is set.')) return
    setSaving(true); setErr(''); setWarn('')
    try {
      const res = await fetch('/api/admin/reports-api-config', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, clearKey: true, rateLimit, bgShare }),
      })
      const d = await res.json()
      if (!d.success) { setErr(d.error || 'Could not clear the key'); return }
      setRevealed(''); await load()
    } finally { setSaving(false) }
  }

  /* Tests what is TYPED where something is typed, and what is stored otherwise —
     so a key can be checked before it is written, which is the whole point.
     Otherwise saving is the only way to find out, and a wrong one is discovered
     later by someone who did not make the change. */
  async function runTest() {
    setTesting(true); setTest(null); setErr('')
    try {
      const res = await fetch('/api/admin/reports-api-config/test', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, rateLimit, bgShare }),
      })
      const d = await res.json()
      if (!d.success) { setErr(d.error || 'Test failed'); return }
      setTest(d)
    } catch (e: any) { setErr(e?.message || 'Network error') }
    finally { setTesting(false) }
  }

  async function reveal() {
    setErr('')
    try {
      const res = await fetch('/api/admin/reports-api-config/reveal', { credentials: 'include' })
      if (res.status === 403) { setErr('Only a Super Admin can reveal the key.'); return }
      const d = await res.json()
      if (!d.success) { setErr(d.error || 'Could not reveal the key'); return }
      setRevealed(d.apiKey || '')
    } catch (e: any) { setErr(e?.message || 'Network error') }
  }

  if (loading) return <p className="text-sm text-gray-500 p-6">Loading…</p>

  /* The pacing counts as a change too. Without it Save stayed disabled when the
     only edit was a ceiling — the field accepted the number, the button refused
     to store it, and the screen showed a limit that was never in force. */
  const dirty = cfg && (
    baseUrl !== (cfg.baseUrl || '') || apiKey !== '' ||
    rateLimit !== cfg.rateLimit || bgShare !== cfg.bgShare)

  return (
    <div className="max-w-3xl">
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
        <h3 className="font-semibold text-[#14254A]">Reports API connection</h3>
        <p className="text-xs text-gray-500 mt-1 mb-5 leading-relaxed">
          The service the reports are read from. Stored here so it can be changed without a
          redeploy — the key is encrypted in the database and never sent back to this page.
        </p>

        {err && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mb-4">{err}</p>
        )}

        {/* Amber, not red, and dismissible: the save succeeded. It stays until
            it is acknowledged or the next save replaces it, rather than
            disappearing on a timer nobody is watching. */}
        {warn && (
          <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-4">
            <span aria-hidden className="mt-px">⚠</span>
            <p className="flex-1 leading-relaxed">{warn}</p>
            <button type="button" onClick={() => setWarn('')}
              className="text-amber-700/70 hover:text-amber-900 font-semibold px-1"
              aria-label="Dismiss warning">×</button>
          </div>
        )}

        {/* Base URL */}
        <label className="block text-xs font-medium text-gray-700 mb-1">Base URL</label>
        <input
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder="https://api-reports.ip-house.in"
          className="w-full px-4 py-2.5 text-sm rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 font-mono"
        />
        <p className="text-[11px] text-gray-500 mt-1">
          Currently in use: <span className="font-mono">{cfg?.effectiveBaseUrl || '— none —'}</span>
          {' '}<Source which={cfg?.baseUrlSource} />
        </p>
        {/* Says what is allowed, so nobody has to discover it by being refused.
            The distinction is where the address goes, not which scheme it uses. */}
        <p className="text-[11px] text-gray-400 mt-0.5 mb-4 leading-relaxed">
          <span className="font-mono">http://</span> is fine for a container or LAN address
          (<span className="font-mono">http://reports_api:8090</span>, <span className="font-mono">localhost</span>,
          a <span className="font-mono">192.168.*</span> host). Over the internet use{' '}
          <span className="font-mono">https://</span> — the API key is sent on every request.
        </p>

        {/* API key */}
        <label className="block text-xs font-medium text-gray-700 mb-1">API key</label>
        <div className="flex gap-2">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            autoComplete="new-password"
            placeholder={cfg?.hasKey ? `Stored — ${cfg.keyMasked} · leave blank to keep it` : 'Paste the key'}
            className="flex-1 px-4 py-2.5 text-sm rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 font-mono"
          />
          <button type="button" onClick={() => setShowKey(s => !s)}
            className="px-3 py-2 text-xs border border-gray-200 rounded-xl text-gray-600 hover:bg-gray-50"
            title={showKey ? 'Hide what you are typing' : 'Show what you are typing'}>
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="text-[11px] text-gray-500 mt-1">
          {cfg?.hasKey
            ? <>A key is stored ({cfg.keyMasked}) <Source which={cfg?.keySource} />. Leave the box empty to keep it.</>
            : <>No key stored <Source which={cfg?.keySource} />.</>}
        </p>

        {/* Reveal — deliberately separate, Super Admin only, logged server-side */}
        {cfg?.hasKey && (
          <div className="mt-2">
            {revealed ? (
              <div className="flex items-center gap-2">
                <code className="text-[11px] bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 break-all">{revealed}</code>
                <button type="button" onClick={() => setRevealed('')}
                  className="text-[11px] text-gray-500 hover:text-gray-800">Hide</button>
              </div>
            ) : (
              <button type="button" onClick={reveal}
                className="text-[11px] font-semibold text-[#14254A] hover:underline">
                Reveal stored key
              </button>
            )}
            <span className="text-[11px] text-gray-400 ml-2">Super Admin only · every reveal is logged</span>
          </div>
        )}

        {/* Test */}
        <div className="mt-6 pt-5 border-t border-gray-100">
          <div className="flex items-center gap-3">
            <button type="button" onClick={runTest} disabled={testing}
              className="px-4 py-2 text-sm rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-60">
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" onClick={save} disabled={saving || !dirty}
              className="px-5 py-2 text-sm font-semibold text-white rounded-xl disabled:opacity-50"
              style={{ background: '#14254A' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {cfg?.hasKey && (
              <button type="button" onClick={clearKey} disabled={saving}
                className="px-3 py-2 text-xs text-red-600 hover:bg-red-50 rounded-xl">
                Remove stored key
              </button>
            )}
            {savedAt && <span className="text-xs text-emerald-700">Saved at {savedAt}</span>}
          </div>

          {/* Three separate facts, because they fail separately and are fixed
              differently — one green tick would send someone to check a key
              when the fault is DNS. */}
          {test && (
            <div className="mt-4 rounded-xl border border-gray-200 p-4 text-sm">
              <Row ok={test.reachable}  label="Service reachable" />
              <Row ok={test.authorized} label={`Key accepted${test.authorized ? ` · ${test.datasets} datasets` : ''}`} />
              <Row ok={test.warehouse}  label="That service can reach its warehouse" />
              {test.detail && <p className="text-xs text-gray-600 mt-2">{test.detail}</p>}
            </div>
          )}
        </div>

        {/* ── Request pacing ─────────────────────────────────────────────
            Put here rather than on the cache screen because it describes what
            the FAR END will tolerate. It is also the only setting in the
            product that materially changes how long a cache warm takes: a warm
            of 160 clients is roughly 80,000 calls, so at 300 a minute it is
            four and a half hours, and no number of extra workers moves that —
            they all wait on the same window. */}
        <div className="mt-6 pt-5 border-t border-gray-100">
          <h4 className="font-semibold text-[#14254A] text-sm">Request pacing</h4>
          <p className="text-xs text-gray-500 mt-0.5 mb-3">
            The portal holds itself under a calls-per-minute ceiling so it cannot be refused by the
            service — a refusal lands on whichever request is in flight, which is usually a page
            someone has open. Raise these only as far as the service actually allows.
          </p>
          <div className="grid grid-cols-2 gap-3 max-w-lg">
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Calls per minute</span>
              <input type="number" min={30} value={rateLimit}
                onChange={e => setRateLimit(+e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200
                           focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
              <span className="block text-[10px] text-gray-400 mt-0.5">
                Keep under the service&rsquo;s own limit (600 by default) — the two windows are not aligned.
              </span>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Of which, background</span>
              <input type="number" min={10} value={bgShare}
                onChange={e => setBgShare(+e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200
                           focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
              <span className="block text-[10px] text-gray-400 mt-0.5">
                What a cache warm may use. The remainder stays free for live pages.
              </span>
            </label>
          </div>
          <p className="text-[11px] text-gray-500 mt-2">
            A warm pass is roughly <strong>50 calls per report</strong>. At {bgShare || '—'}/min that is about{' '}
            <strong>{bgShare > 0 ? Math.round((50 * 60) / bgShare * 10) / 10 : '—'}</strong> reports a minute
            {rateLimit > bgShare
              ? <> · {rateLimit - bgShare}/min held back for live pages.</>
              : <span className="text-amber-700"> · nothing is held back for live pages — a warm pass
                  can make someone wait on the minute boundary.</span>}
          </p>

          {/* What the pacing has actually cost. Without this, "the warm is
              slow" and "the warm has hung" look identical. */}
          {cfg?.budget && (
            <p className="text-[11px] text-gray-500 mt-2">
              {cfg.budget.calls.toLocaleString()} call(s) sent
              {cfg.budget.backgroundCalls > 0 && <> · {cfg.budget.backgroundCalls.toLocaleString()} of them background</>}
              {' '}· {cfg.budget.usedThisMinute} used this minute
              {cfg.budget.throttled > 0
                ? <> · <strong>{cfg.budget.throttled.toLocaleString()}</strong> waited for the ceiling,
                    {' '}<strong>{Math.round(cfg.budget.waitedSeconds / 60)} min</strong> in total</>
                : <> · nothing has had to wait yet</>}
            </p>
          )}
        </div>

        {cfg?.updatedAt && (
          <p className="text-[11px] text-gray-400 mt-4">
            Last changed {cfg.updatedAt}{cfg.updatedBy ? ` by ${cfg.updatedBy}` : ''}
          </p>
        )}
      </div>
    </div>
  )
}

function Source({ which }: { which?: string }) {
  if (!which) return null
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full border ml-1"
      style={which === 'database'
        ? { borderColor: '#a7f3d0', background: '#ecfdf5', color: '#047857' }
        : { borderColor: '#e5e7eb', background: '#f9fafb', color: '#6b7280' }}>
      {which === 'database' ? 'from this screen' : 'from environment'}
    </span>
  )
}

function Row({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className="flex items-center gap-2 py-0.5">
      <span style={{ color: ok ? '#059669' : '#dc2626' }}>{ok ? '✓' : '✕'}</span>
      <span className={ok ? 'text-gray-800' : 'text-red-700'}>{label}</span>
    </p>
  )
}
