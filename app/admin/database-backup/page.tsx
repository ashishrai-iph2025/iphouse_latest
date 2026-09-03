'use client'

// /admin/database-backup — Super Admin only.
// On-demand + scheduled MySQL backups streamed to S3, and a paginated view of
// every backup stored there. The schedule replaces a host crontab + shell
// script (which doesn't fit a container whose database lives elsewhere): the
// app runs the backup itself on the schedule you set, and shows its status.

import { useEffect, useMemo, useState } from 'react'
import { Navigate, Link } from 'react-router-dom'
import BackToConfiguration from '@/components/admin/BackToConfiguration'
import { useSession } from '@/lib/auth-client'
import ReportLoader from '@/components/shared/ReportLoader'

interface Backup {
  name: string
  key: string
  size: number
  lastModified: string
  storageClass?: string
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

export default function DatabaseBackupPage() {
  const { data: session, status } = useSession()
  const role = (session?.user as any)?.role

  const [backups, setBackups] = useState<Backup[]>([])
  const [meta,    setMeta]    = useState<{ bucket: string; prefix: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [page,    setPage]    = useState(1)
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)


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

  useEffect(() => { if (role === 2) loadList() }, [role])

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

      <BackToConfiguration />

      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#14254A]">Database Backup</h1>
          {/* Read-only. Taking a backup, on demand or on a schedule, was removed
              on request — the endpoints are gone too, not just the buttons. */}
          <p className="text-brand-muted text-sm mt-1">The database backups stored in Amazon S3.</p>
        </div>
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
          <ReportLoader size={150} label="Loading backups" className="py-16" />
        ) : error ? (
          <div className="text-center py-12 text-red-500 text-sm px-6">{error}</div>
        ) : backups.length === 0 ? (
          <div className="text-center py-14 text-brand-muted text-sm">No backups found in S3 yet.</div>
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
