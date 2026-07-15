'use client'

// /admin/database-backup — Super Admin only.
// On-demand + scheduled MySQL backups streamed to S3, and a paginated view of
// every backup stored there. The schedule replaces a host crontab + shell
// script (which doesn't fit a container whose database lives elsewhere): the
// app runs the backup itself on the schedule you set, and shows its status.

import { useEffect, useMemo, useState } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { useSession } from '@/lib/auth-client'

interface Backup {
  name: string
  key: string
  size: number
  lastModified: string
  storageClass?: string
}

interface Schedule {
  enabled: boolean
  cronExpr: string
  nextRun?: string
  lastRunAt?: string
  lastStatus?: string
  lastFile?: string
  lastError?: string
}

const PER_PAGE = 10

function fmtSize(bytes: number): string {
  if (!bytes || bytes < 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes, i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

function fmtDate(v?: string): string {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return v
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Human-friendly description of a 5-field cron expression (best-effort).
function describeCron(expr: string): string {
  const m = expr.trim().split(/\s+/)
  if (m.length !== 5) return expr
  const [min, hr, dom, mon, dow] = m
  const hhmm = (h: string, mi: string) => `${h.padStart(2, '0')}:${mi.padStart(2, '0')}`
  const numeric = (s: string) => /^\d+$/.test(s)
  if (dom === '*' && mon === '*' && dow === '*' && numeric(hr) && numeric(min)) return `Daily at ${hhmm(hr, min)}`
  if (dom === '*' && mon === '*' && dow === '*' && /^\*\/\d+$/.test(hr) && min === '0') return `Every ${hr.slice(2)} hours`
  if (dom === '*' && mon === '*' && numeric(dow) && numeric(hr) && numeric(min)) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    return `Weekly on ${days[+dow] ?? dow} at ${hhmm(hr, min)}`
  }
  return `Cron: ${expr}`
}

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Daily · 02:00',    expr: '0 2 * * *' },
  { label: 'Daily · midnight', expr: '0 0 * * *' },
  { label: 'Every 6 hours',    expr: '0 */6 * * *' },
  { label: 'Every 12 hours',   expr: '0 */12 * * *' },
  { label: 'Weekly · Sun 03:00', expr: '0 3 * * 0' },
]

export default function DatabaseBackupPage() {
  const { data: session, status } = useSession()
  const role = (session?.user as any)?.role

  const [backups, setBackups] = useState<Backup[]>([])
  const [meta,    setMeta]    = useState<{ bucket: string; prefix: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [running, setRunning] = useState(false)
  const [page,    setPage]    = useState(1)
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  // Schedule
  const [sched,   setSched]   = useState<Schedule | null>(null)
  const [cronExpr, setCronExpr] = useState('0 2 * * *')
  const [dailyTime, setDailyTime] = useState('02:00')
  const [savingSched, setSavingSched] = useState(false)

  function showToast(msg: string, type: 'success' | 'error' = 'success', ms = 5000) {
    setToast({ msg, type }); setTimeout(() => setToast(null), ms)
  }

  async function loadList() {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/backup/list', { credentials: 'include' })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to load backups'); return }
      setBackups(data.backups || [])
      setMeta({ bucket: data.bucket, prefix: data.prefix })
    } catch { setError('Network error') }
    finally { setLoading(false) }
  }

  async function loadSchedule() {
    try {
      const res = await fetch('/api/admin/backup/schedule', { credentials: 'include' })
      const data = await res.json()
      if (data.success) { setSched(data); setCronExpr(data.cronExpr || '0 2 * * *') }
    } catch { /* ignore */ }
  }

  useEffect(() => { if (role === 2) { loadList(); loadSchedule() } }, [role])

  async function runBackup() {
    setRunning(true)
    showToast('Backup in progress — this can take a little while…', 'success', 60000)
    try {
      const res = await fetch('/api/admin/backup/run', { method: 'POST', credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        showToast(`Backup completed in ${data.duration || 'a moment'} — uploaded as ${data.file}`, 'success')
        await loadList(); await loadSchedule(); setPage(1)
      } else {
        showToast(data.error || 'Backup failed', 'error', 8000)
      }
    } catch { showToast('Network error while running the backup', 'error', 8000) }
    finally { setRunning(false) }
  }

  async function saveSchedule(nextEnabled: boolean, expr: string) {
    setSavingSched(true)
    try {
      const res = await fetch('/api/admin/backup/schedule', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled, cronExpr: expr }),
      })
      const data = await res.json()
      if (data.success) { showToast(nextEnabled ? 'Automatic backup schedule saved' : 'Automatic backups turned off'); await loadSchedule() }
      else showToast(data.error || 'Failed to save schedule', 'error', 7000)
    } catch { showToast('Network error', 'error') }
    finally { setSavingSched(false) }
  }

  const totalSize = useMemo(() => backups.reduce((n, b) => n + (b.size || 0), 0), [backups])
  const totalPages = Math.max(1, Math.ceil(backups.length / PER_PAGE))
  const safePage = Math.min(page, totalPages)
  const pageRows = backups.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)

  if (status === 'loading') return null
  if (role !== 2) return <Navigate to="/admin/home" replace />

  return (
    <div className="p-6 fade-in">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl max-w-sm ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-3 flex-wrap">
        <div>
          <Link to="/admin/configuration" className="text-brand-muted hover:text-[#FC934C] text-xs font-medium">← Configuration</Link>
          <h1 className="text-2xl font-bold text-[#14254A] mt-1">Database Backup</h1>
          <p className="text-brand-muted text-sm mt-1">Take an on-demand backup or schedule automatic backups to Amazon S3.</p>
        </div>
        <button onClick={runBackup} disabled={running}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 shadow-sm"
          style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
          {running
            ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Backing up…</>
            : <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round"/></svg> Take Backup Now</>}
        </button>
      </div>

      {/* ── Automatic backup schedule ── */}
      <div className={`rounded-2xl border shadow-card p-5 mb-6 ${sched?.enabled ? 'bg-emerald-50/60 border-emerald-200' : 'bg-white border-gray-100'}`}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0" style={{ background: sched?.enabled ? '#16A34A18' : '#14254A10' }}>⏰</div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm text-[#14254A]">Automatic Backup</h3>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide ${sched?.enabled ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
                  {sched?.enabled ? 'ON' : 'OFF'}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {sched?.enabled
                  ? <>Runs <b className="text-[#14254A]">{describeCron(sched.cronExpr)}</b> · Next run <b className="text-[#14254A]">{fmtDate(sched.nextRun)}</b></>
                  : 'No automatic backups scheduled. The app runs backups itself — no server cron or script needed.'}
              </p>
            </div>
          </div>
          <button onClick={() => saveSchedule(!sched?.enabled, cronExpr)} disabled={savingSched}
            className={`px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-all ${sched?.enabled ? 'bg-gray-500 hover:bg-gray-600' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
            {savingSched ? 'Saving…' : sched?.enabled ? 'Turn OFF' : 'Turn ON'}
          </button>
        </div>

        {/* Schedule editor */}
        <div className="mt-4 pt-4 border-t border-gray-200/70 grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Presets</span>
            {CRON_PRESETS.map(p => (
              <button key={p.expr} onClick={() => setCronExpr(p.expr)}
                className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors ${cronExpr === p.expr ? 'border-[#14254A] bg-[#14254A]/5 text-[#14254A]' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Daily at (server time)</label>
              <div className="flex items-center gap-2">
                <input type="time" value={dailyTime} onChange={e => setDailyTime(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                <button onClick={() => { const [h, m] = dailyTime.split(':'); setCronExpr(`${Number(m)} ${Number(h)} * * *`) }}
                  className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">Apply</button>
              </div>
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Cron expression (min hour dom mon dow)</label>
              <input type="text" value={cronExpr} onChange={e => setCronExpr(e.target.value)}
                placeholder="0 2 * * *"
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
              <p className="text-[11px] text-gray-400 mt-1">{describeCron(cronExpr)} · all times are the server timezone.</p>
            </div>
            <button onClick={() => saveSchedule(sched?.enabled ?? true, cronExpr)} disabled={savingSched}
              className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-semibold text-[#14254A] hover:bg-gray-50 disabled:opacity-50">
              Save Schedule
            </button>
          </div>
        </div>

        {/* Last run status */}
        {sched?.lastRunAt && (
          <div className="mt-4 pt-3 border-t border-gray-200/70 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-400 font-semibold uppercase tracking-widest text-[10px]">Last run</span>
            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-bold ${sched.lastStatus === 'success' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'}`}>
              {sched.lastStatus === 'success' ? '✓ Success' : '✕ Failed'}
            </span>
            <span className="text-gray-500">{fmtDate(sched.lastRunAt)}</span>
            {sched.lastStatus === 'success' && sched.lastFile && <code className="font-mono text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{sched.lastFile}</code>}
            {sched.lastStatus !== 'success' && sched.lastError && <span className="text-red-500 truncate max-w-[420px]" title={sched.lastError}>{sched.lastError}</span>}
          </div>
        )}
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Backups stored</p>
          <p className="text-2xl font-bold text-[#14254A] mt-1 tabular-nums">{loading ? '—' : backups.length}</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Total size</p>
          <p className="text-2xl font-bold text-[#14254A] mt-1">{loading ? '—' : fmtSize(totalSize)}</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Latest backup</p>
          <p className="text-sm font-bold text-[#14254A] mt-1.5 truncate">{loading ? '—' : backups[0] ? fmtDate(backups[0].lastModified) : 'None yet'}</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Destination</p>
          <p className="text-xs font-mono text-gray-600 mt-1.5 break-all">{meta ? `s3://${meta.bucket}/${meta.prefix}` : '—'}</p>
        </div>
      </div>

      {/* Backups table */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-[#14254A]">{loading ? 'Loading…' : `${backups.length} backup${backups.length !== 1 ? 's' : ''} on S3`}</span>
          <button onClick={loadList} disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-gray-100 border-t-[#14254A] rounded-full animate-spin" /></div>
        ) : error ? (
          <div className="text-center py-12 text-red-500 text-sm px-6">{error}</div>
        ) : backups.length === 0 ? (
          <div className="text-center py-14 text-brand-muted text-sm">No backups found in S3 yet. Click <b className="text-[#14254A]">Take Backup Now</b> to create the first one.</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr><th>#</th><th>Backup File</th><th>Size</th><th>Created</th><th>Storage Class</th></tr>
                </thead>
                <tbody>
                  {pageRows.map((b, i) => {
                    const rowNum = (safePage - 1) * PER_PAGE + i + 1
                    return (
                      <tr key={b.key}>
                        <td className="text-xs text-gray-400">{rowNum}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#14254A12' }}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#14254A" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0" strokeLinecap="round"/></svg>
                            </div>
                            {rowNum === 1 && <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">Latest</span>}
                            <code className="text-xs bg-gray-100 px-2 py-0.5 rounded font-mono text-gray-700">{b.name}</code>
                          </div>
                        </td>
                        <td className="text-xs text-gray-600 whitespace-nowrap tabular-nums">{fmtSize(b.size)}</td>
                        <td className="text-xs text-gray-600 whitespace-nowrap">{fmtDate(b.lastModified)}</td>
                        <td className="text-xs text-gray-500">{b.storageClass || 'STANDARD'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {backups.length > PER_PAGE && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 text-xs text-gray-500">
                <span>Showing {(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, backups.length)} of {backups.length}</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPage(1)} disabled={safePage === 1} className="px-2 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">«</button>
                  <button onClick={() => setPage(p => p - 1)} disabled={safePage === 1} className="px-2 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">‹</button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
                    .reduce<(number | '...')[]>((acc, p, idx, arr) => { if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push('...'); acc.push(p); return acc }, [])
                    .map((p, idx) => p === '...'
                      ? <span key={`e${idx}`} className="px-2">…</span>
                      : <button key={p} onClick={() => setPage(p as number)} className={`px-2.5 py-1 rounded border text-xs font-medium transition-colors ${safePage === p ? 'bg-[#14254A] text-white border-[#14254A]' : 'border-gray-200 hover:bg-gray-50'}`}>{p}</button>)}
                  <button onClick={() => setPage(p => p + 1)} disabled={safePage === totalPages} className="px-2 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">›</button>
                  <button onClick={() => setPage(totalPages)} disabled={safePage === totalPages} className="px-2 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">»</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <p className="text-[11px] text-gray-400 mt-4 leading-relaxed">
        Backups are generated in-process (a consistent point-in-time snapshot) and streamed directly to S3 — nothing is written to the container's disk, and no external tools (mysqldump / AWS CLI) or server cron are required. Uploads use the AWS credentials on the <Link to="/admin/aws-credentials" className="text-[#FC934C] hover:underline">AWS Credentials</Link> page, or the server's IAM role if none are set.
      </p>
    </div>
  )
}
