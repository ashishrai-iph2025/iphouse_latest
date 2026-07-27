'use client'

import { useState, useEffect, useRef } from 'react'
import Breadcrumb from '@/components/ui/Breadcrumb'

interface HistoryRow {
  id:            number
  uploaded_by:   string
  client_name:   string
  file_name:     string
  file_size:     number
  presigned_url: string
  url_expires_at: string
  created_at:    string
  expired:       number
}

const PER_PAGE = 10

function fmtDateTime(dt: string) {
  const d = new Date(dt.includes('T') ? dt : dt.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime()) ? dt : d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function fmtSize(bytes: number) {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function DataSharingPage() {
  const [file,       setFile]       = useState<File | null>(null)
  const [loading,    setLoading]    = useState(false)
  const [result,     setResult]     = useState<{ url: string; expiresAt: string; fileName: string } | null>(null)
  const [toast,      setToast]      = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const [history,    setHistory]    = useState<HistoryRow[]>([])
  const [histLoading,setHistLoading]= useState(true)
  const [page,       setPage]       = useState(1)
  const [dragActive, setDragActive] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadHistory() }, [])

  const MAX_BYTES = 50 * 1024 * 1024

  function handleDrag(e: React.DragEvent, active: boolean) {
    e.preventDefault()
    e.stopPropagation()
    if (!loading) setDragActive(active)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (loading) return
    const dropped = e.dataTransfer.files?.[0] ?? null
    pickFile(dropped)
  }

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  async function loadHistory() {
    setHistLoading(true)
    try {
      const res  = await fetch('/api/data-sharing/history', { credentials: 'include' })
      const data = await res.json()
      setHistory(Array.isArray(data.items) ? data.items : [])
    } catch {
      setHistory([])
    } finally {
      setHistLoading(false)
    }
  }

  function pickFile(f: File | null) {
    if (!f) { setFile(null); return }
    if (!f.name.toLowerCase().endsWith('.xlsx')) {
      showToast('Only .xlsx files are allowed', 'error')
      return
    }
    if (f.size > MAX_BYTES) {
      showToast('File is too large (max 50 MB)', 'error')
      return
    }
    setFile(f)
    setResult(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) { showToast('Please choose an .xlsx file', 'error'); return }

    setLoading(true)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res  = await fetch('/api/data-sharing/upload', { method: 'POST', credentials: 'include', body: fd })
      const data = await res.json()

      if (data.success) {
        showToast(data.message || 'File uploaded')
        setResult({ url: data.presignedUrl, expiresAt: data.expiresAt, fileName: data.fileName })
        setFile(null)
        if (fileRef.current) fileRef.current.value = ''
        loadHistory()
      } else {
        showToast(data.error || 'Upload failed', 'error')
      }
    } catch (err: any) {
      showToast(err.message || 'Upload failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      showToast('Link copied to clipboard')
    } catch {
      showToast('Could not copy link', 'error')
    }
  }

  const totalPages = Math.max(1, Math.ceil(history.length / PER_PAGE))
  const pageRows   = history.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  return (
    <div className="fade-in">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 mb-4 sm:mb-6">
        <Breadcrumb items={[{ label: 'Data Sharing' }, { label: 'Upload & Share' }]} />
        <div className="sm:text-right hidden sm:block">
          <h1 className="text-xl font-bold text-[#14254A]">Data Sharing</h1>
          <p className="text-brand-muted text-sm">Upload an Excel file and share a secure 7-day link.</p>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl flex items-center gap-2 ${
          toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'
        }`}>
          {toast.type === 'success'
            ? <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
            : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          }
          {toast.msg}
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-5 lg:items-start">

        {/* ── LEFT: upload form ── */}
        <aside className="w-full lg:w-80 lg:flex-shrink-0 bg-white rounded-2xl border border-gray-100 shadow-card lg:self-start lg:sticky lg:top-5">
          <div className="h-1 rounded-t-2xl" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />
          <div className="p-5">
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#14254A,#FC934C)' }}>
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 12V3m0 0L8 7m4-4l4 4"/>
                </svg>
              </div>
              <div>
                <div className="font-bold text-[#14254A] text-sm">Upload File</div>
                <div className="text-[10px] text-gray-400">Excel (.xlsx) up to 50 MB</div>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Excel File <span className="text-red-400">*</span>
                </label>

                {/* Hidden native input, driven by the dropzone */}
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx"
                  className="hidden"
                  onChange={e => pickFile(e.target.files?.[0] ?? null)}
                />

                {!file ? (
                  /* Drag & drop zone */
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => !loading && fileRef.current?.click()}
                    onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !loading) fileRef.current?.click() }}
                    onDragEnter={e => handleDrag(e, true)}
                    onDragOver={e => handleDrag(e, true)}
                    onDragLeave={e => handleDrag(e, false)}
                    onDrop={handleDrop}
                    className={[
                      'flex flex-col items-center justify-center text-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 cursor-pointer transition-all',
                      dragActive
                        ? 'border-[#FC934C] bg-[#FC934C]/5 scale-[1.01]'
                        : 'border-gray-200 bg-gray-50/60 hover:border-[#14254A]/40 hover:bg-gray-50',
                    ].join(' ')}
                  >
                    <div className="w-12 h-12 rounded-full flex items-center justify-center"
                      style={{ background: dragActive ? '#FC934C' : 'linear-gradient(135deg,#14254A,#FC934C)' }}>
                      <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M12 12v6m0-6l-2.5 2.5M12 12l2.5 2.5"/>
                      </svg>
                    </div>
                    <div className="text-sm font-semibold text-[#14254A]">
                      {dragActive ? 'Drop your file here' : 'Drag & drop your Excel file'}
                    </div>
                    <div className="text-[11px] text-gray-400">
                      or <span className="text-[#FC934C] font-semibold">browse</span> — .xlsx up to 50 MB
                    </div>
                  </div>
                ) : (
                  /* Selected file preview */
                  <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-emerald-50 border border-emerald-100">
                      <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 4H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V18a2 2 0 01-2 2z"/>
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-[#14254A] truncate" title={file.name}>{file.name}</div>
                      <div className="text-[11px] text-gray-400">{fmtSize(file.size)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => { if (!loading) { setFile(null); if (fileRef.current) fileRef.current.value = '' } }}
                      disabled={loading}
                      title="Remove file"
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-40 flex-shrink-0"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={loading || !file}
                className="w-full py-2.5 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                style={{ background: 'linear-gradient(135deg,#14254A,#FC934C)' }}
              >
                {loading && <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                {loading ? 'Uploading…' : 'Upload & Generate Link'}
              </button>
            </form>

            {/* Result: generated link */}
            {result && (
              <div className="mt-5 p-4 rounded-xl bg-emerald-50 border border-emerald-200">
                <div className="text-xs font-bold text-emerald-700 mb-1">Share link ready</div>
                <div className="text-[11px] text-gray-500 mb-2 truncate">{result.fileName}</div>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={result.url}
                    className="flex-1 min-w-0 text-[11px] px-2 py-1.5 rounded-lg border border-emerald-200 bg-white text-gray-600"
                  />
                  <button
                    onClick={() => copyLink(result.url)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 flex-shrink-0"
                  >
                    Copy
                  </button>
                </div>
                <div className="text-[10px] text-gray-400 mt-2">
                  Valid until {fmtDateTime(result.expiresAt)} (7 days)
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* ── RIGHT: history ── */}
        <div className="flex-1 min-w-0 bg-white rounded-2xl border border-gray-100 shadow-card">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-bold text-[#14254A] text-sm">Upload History</h2>
            <span className="text-xs text-gray-400">{history.length} file{history.length === 1 ? '' : 's'}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100">
                  <th className="px-5 py-3">File</th>
                  <th className="px-5 py-3">Uploaded By</th>
                  <th className="px-5 py-3">Uploaded</th>
                  <th className="px-5 py-3">Expires</th>
                  <th className="px-5 py-3 text-right">Link</th>
                </tr>
              </thead>
              <tbody>
                {histLoading ? (
                  <tr><td colSpan={5} className="px-5 py-10 text-center text-gray-400">Loading…</td></tr>
                ) : pageRows.length === 0 ? (
                  <tr><td colSpan={5} className="px-5 py-10 text-center text-gray-400">No files shared yet.</td></tr>
                ) : pageRows.map(row => {
                  const expired = row.expired === 1 || new Date(row.url_expires_at.replace(' ', 'T') + 'Z') <= new Date()
                  return (
                    <tr key={row.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-5 py-3">
                        <div className="font-semibold text-[#14254A] truncate max-w-[220px]" title={row.file_name}>{row.file_name}</div>
                        <div className="text-[10px] text-gray-400">{fmtSize(row.file_size)}</div>
                      </td>
                      <td className="px-5 py-3 text-gray-600">{row.uploaded_by || '—'}</td>
                      <td className="px-5 py-3 text-gray-500 whitespace-nowrap">{fmtDateTime(row.created_at)}</td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {expired ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-600">Expired</span>
                        ) : (
                          <span className="text-gray-500">{fmtDateTime(row.url_expires_at)}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        {expired ? (
                          <span className="text-gray-300 text-xs">—</span>
                        ) : (
                          <div className="inline-flex gap-2">
                            <button onClick={() => copyLink(row.presigned_url)}
                              className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-gray-100 text-[#14254A] hover:bg-gray-200">Copy</button>
                            <a href={row.presigned_url} target="_blank" rel="noopener noreferrer"
                              className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#14254A] text-white hover:bg-[#1e3a6e]">Open</a>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100">
              <span className="text-xs text-gray-400">Page {page} of {totalPages}</span>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
                  className="px-3 py-1 rounded-lg text-xs font-semibold bg-gray-100 text-[#14254A] disabled:opacity-40">Prev</button>
                <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
                  className="px-3 py-1 rounded-lg text-xs font-semibold bg-gray-100 text-[#14254A] disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
