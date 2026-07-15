'use client'

// /admin/database-backup — Super Admin only.
// Take an on-demand MySQL backup streamed to S3, and view every backup already
// stored there (name, size, timestamp).

import { useEffect, useState } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { useSession } from '@/lib/auth-client'

interface Backup {
  name: string
  key: string
  size: number
  lastModified: string
  storageClass?: string
}

function fmtSize(bytes: number): string {
  if (!bytes || bytes < 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes, i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

function fmtDate(v: string): string {
  const d = new Date(v)
  if (isNaN(d.getTime())) return v || '—'
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function DatabaseBackupPage() {
  const { data: session, status } = useSession()
  const role = (session?.user as any)?.role

  const [backups, setBackups] = useState<Backup[]>([])
  const [meta,    setMeta]    = useState<{ bucket: string; prefix: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [running, setRunning] = useState(false)
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success', ms = 5000) {
    setToast({ msg, type })
    setTimeout(() => setToast(null), ms)
  }

  async function loadList() {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/backup/list', { credentials: 'include' })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to load backups'); return }
      setBackups(data.backups || [])
      setMeta({ bucket: data.bucket, prefix: data.prefix })
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { if (role === 2) loadList() }, [role])

  async function runBackup() {
    setRunning(true)
    showToast('Backup in progress — this can take a little while…', 'success', 60000)
    try {
      const res = await fetch('/api/admin/backup/run', { method: 'POST', credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        showToast(`Backup completed in ${data.duration || 'a moment'} — uploaded as ${data.file}`, 'success')
        await loadList()
      } else {
        showToast(data.error || 'Backup failed', 'error', 8000)
      }
    } catch {
      showToast('Network error while running the backup', 'error', 8000)
    } finally {
      setRunning(false)
    }
  }

  if (status === 'loading') return null
  if (role !== 2) return <Navigate to="/admin/home" replace />

  const totalSize = backups.reduce((n, b) => n + (b.size || 0), 0)

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
          <p className="text-brand-muted text-sm mt-1">
            Take an on-demand backup of the database and stream it straight to Amazon S3.
          </p>
        </div>
        <button onClick={runBackup} disabled={running}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 shadow-sm"
          style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
          {running ? (
            <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Backing up…</>
          ) : (
            <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round"/></svg> Take Backup Now</>
          )}
        </button>
      </div>

      {/* Summary strip */}
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
          <p className="text-sm font-bold text-[#14254A] mt-1.5 truncate" title={backups[0]?.lastModified}>
            {loading ? '—' : backups[0] ? fmtDate(backups[0].lastModified) : 'None yet'}
          </p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Destination</p>
          <p className="text-xs font-mono text-gray-600 mt-1.5 break-all">
            {meta ? `s3://${meta.bucket}/${meta.prefix}` : '—'}
          </p>
        </div>
      </div>

      {/* Backups table */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-[#14254A]">
            {loading ? 'Loading…' : `${backups.length} backup${backups.length !== 1 ? 's' : ''} on S3`}
          </span>
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
          <div className="text-center py-14 text-brand-muted text-sm">
            No backups found in S3 yet. Click <b className="text-[#14254A]">Take Backup Now</b> to create the first one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Backup File</th>
                  <th>Size</th>
                  <th>Created</th>
                  <th>Storage Class</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b, i) => (
                  <tr key={b.key}>
                    <td className="text-xs text-gray-400">{i + 1}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ background: '#14254A12' }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#14254A" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0" strokeLinecap="round"/></svg>
                        </div>
                        {i === 0 && <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">Latest</span>}
                        <code className="text-xs bg-gray-100 px-2 py-0.5 rounded font-mono text-gray-700">{b.name}</code>
                      </div>
                    </td>
                    <td className="text-xs text-gray-600 whitespace-nowrap tabular-nums">{fmtSize(b.size)}</td>
                    <td className="text-xs text-gray-600 whitespace-nowrap">{fmtDate(b.lastModified)}</td>
                    <td className="text-xs text-gray-500">{b.storageClass || 'STANDARD'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-gray-400 mt-4 leading-relaxed">
        Backups are produced with <code className="font-mono">mysqldump</code> (consistent snapshot) and streamed directly to S3 — no copy is written to the server disk. Uploads use the server's IAM role; ensure the AWS CLI and <code className="font-mono">mysqldump</code> are installed on the host.
      </p>
    </div>
  )
}
