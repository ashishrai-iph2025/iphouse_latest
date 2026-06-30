'use client'

import { useState, useEffect, useRef } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import Breadcrumb from '@/components/ui/Breadcrumb'
import { useMasterData } from '@/lib/masterDataContext'

interface HistoryRow {
  id: string
  date: string
  platform: string
  assetName: string
  urlCount: number
  urls: string[]
}

const PER_PAGE = 10

export default function UploadURLPage() {
  const [mode,        setMode]        = useState<'manual' | 'file'>('manual')
  const [platform,    setPlatform]    = useState('')
  const [assetName,   setAssetName]   = useState('')
  const [officialUrl, setOfficialUrl] = useState('')
  const [urls,        setUrls]        = useState('')
  const [file,        setFile]        = useState<File | null>(null)
  const [remarks,     setRemarks]     = useState('')
  const [loading,     setLoading]     = useState(false)
  const [toast,       setToast]       = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const [history,     setHistory]     = useState<HistoryRow[]>([])
  const [histLoading, setHistLoading] = useState(true)
  const [page,        setPage]        = useState(1)
  const [modal,       setModal]       = useState<HistoryRow | null>(null)

  const { platforms, assets } = useMasterData()
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadHistory() }, [])

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  async function loadHistory() {
    setHistLoading(true)
    try {
      const res  = await fetch('/api/upload-url', { credentials: 'include' })
      const data = await res.json()
      setHistory(Array.isArray(data.items) ? data.items : [])
    } catch {
      setHistory([])
    } finally {
      setHistLoading(false)
    }
  }

  const platformLc       = platform.toLowerCase()
  const isSourcePlatform = platformLc.includes('internet') || platformLc.includes('thirdpartyapp')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!platform)  { showToast('Please select a Platform', 'error'); return }
    if (!assetName) { showToast('Please select an Asset',   'error'); return }
    if (isSourcePlatform && !officialUrl.trim()) { showToast('Official URL is required for this platform', 'error'); return }
    if (mode === 'manual' && !urls.trim()) { showToast('Please enter at least one URL', 'error'); return }
    if (mode === 'file'   && !file)        { showToast('Please select an Excel file',   'error'); return }

    setLoading(true)
    try {
      let body: FormData | string
      const headers: Record<string, string> = {}

      if (mode === 'file' && file) {
        const fd = new FormData()
        fd.append('platform',  platform)
        fd.append('assetName', assetName)
        if (officialUrl) fd.append('officialUrl', officialUrl)
        if (remarks)     fd.append('remarks',     remarks)
        fd.append('mode', 'file')
        fd.append('urlFile', file)
        body = fd
      } else {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify({
          platform, assetName, officialUrl, remarks, mode: 'manual',
          urls: urls.split('\n').map(u => u.trim()).filter(Boolean),
        })
      }

      const res  = await fetch('/api/upload-url', { method: 'POST', credentials: 'include', headers, body })
      const data = await res.json()

      if (data.success) {
        showToast(data.message || 'Submission successful')
        setUrls(''); setRemarks(''); setOfficialUrl(''); setFile(null)
        if (fileRef.current) fileRef.current.value = ''
        loadHistory()
      } else {
        showToast(data.error || 'Submission failed', 'error')
      }
    } catch (err: any) {
      showToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  function clearForm() {
    setUrls(''); setRemarks(''); setFile(null)
    setPlatform(''); setAssetName(''); setOfficialUrl('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const totalPages = Math.max(1, Math.ceil(history.length / PER_PAGE))
  const pageRows   = history.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const urlCount   = urls.split('\n').filter(u => u.trim()).length

  function fmtDate(dt: string) {
    const d = new Date(dt)
    return isNaN(d.getTime()) ? dt : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  }

  return (
    <div className="fade-in">

      {/* ── Header row ── */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 mb-4 sm:mb-6">
        <Breadcrumb items={[{ label: 'Submit Take-downs' }, { label: 'Report Submission' }]} />
        <div className="sm:text-right hidden sm:block">
          <h1 className="text-xl font-bold text-[#14254A]">Report Submission</h1>
          <p className="text-brand-muted text-sm">Submit takedown requests and track history.</p>
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

        {/* ── LEFT SIDEBAR: form ── */}
        <aside className="w-full lg:w-72 xl:w-80 lg:flex-shrink-0 bg-white rounded-2xl border border-gray-100 shadow-card lg:self-start lg:sticky lg:top-5">
          <div className="h-1 rounded-t-2xl" style={{ background: 'linear-gradient(90deg,#14254A,#FC934C)' }} />

          <div className="p-5">

            {/* Header */}
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#14254A,#FC934C)' }}>
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              <div>
                <div className="font-bold text-[#14254A] text-sm">Report Submission</div>
                <div className="text-[10px] text-gray-400">Submit URLs for Takedown</div>
              </div>
            </div>

            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4">
              Submission Details
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">

              {/* Platform */}
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Platform <span className="text-red-400">*</span>
                </label>
                <SearchableSelect options={platforms} value={platform} onChange={setPlatform}
                  placeholder="Select platform…" emptyLabel="— Select platform —" />
              </div>

              {/* Asset */}
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Asset <span className="text-red-400">*</span>
                </label>
                <SearchableSelect options={assets} value={assetName} onChange={setAssetName}
                  placeholder="Select asset…" emptyLabel="— Select asset —" />
              </div>

              {/* Official URL */}
              {isSourcePlatform && (
                <div>
                  <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                    Official URL <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="url" value={officialUrl}
                    onChange={e => setOfficialUrl(e.target.value)}
                    placeholder="https://…"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A]"
                  />
                </div>
              )}

              <div className="border-t border-gray-100" />

              {/* Mode toggle */}
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Input Method
                </label>
                <div className="flex p-1 gap-1 rounded-xl bg-gray-100">
                  {(['manual', 'file'] as const).map(m => (
                    <button key={m} type="button" onClick={() => setMode(m)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                        mode === m ? 'bg-white text-[#14254A] shadow-sm' : 'text-gray-400 hover:text-gray-600'
                      }`}>
                      {m === 'manual' ? '✏ Manual' : '📊 Excel'}
                    </button>
                  ))}
                </div>
              </div>

              {mode === 'manual' ? (
                <>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                      URL List
                    </label>
                    <textarea value={urls} onChange={e => setUrls(e.target.value)} rows={6}
                      placeholder={"https://…\nhttps://…"}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A] resize-none font-mono"
                    />
                    {urlCount > 0 && (
                      <p className="text-[10px] text-brand-muted mt-1">{urlCount} URL{urlCount > 1 ? 's' : ''} entered</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                      Remarks
                    </label>
                    <textarea value={remarks} onChange={e => setRemarks(e.target.value)} rows={2}
                      placeholder="Optional notes…"
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20 focus:border-[#14254A] resize-none"
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  <a href="/templates/urls_template.xlsx" download
                    className="flex items-center justify-center gap-2 w-full rounded-xl py-2 px-4 text-xs font-semibold text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 transition-colors">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download Excel Template
                  </a>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                      Select File
                    </label>
                    <div
                      onClick={() => fileRef.current?.click()}
                      className={`rounded-xl border-2 border-dashed p-5 text-center cursor-pointer transition-all hover:border-[#14254A]/30 hover:bg-[#14254A]/[0.02] ${
                        file ? 'border-emerald-300 bg-emerald-50/40' : 'border-gray-200'
                      }`}>
                      <input ref={fileRef} type="file" accept=".xls,.xlsx"
                        onChange={e => setFile(e.target.files?.[0] || null)} className="hidden" />
                      <svg className="w-7 h-7 mx-auto mb-2 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      {file ? (
                        <p className="text-xs font-semibold text-emerald-700">{file.name}</p>
                      ) : (
                        <>
                          <p className="text-xs text-gray-500">Drag & drop or <span className="font-semibold text-[#14254A]">browse</span></p>
                          <p className="text-[10px] text-gray-400 mt-0.5">.xls or .xlsx only</p>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="space-y-2 pt-2">
                <button type="submit" disabled={loading}
                  className="w-full py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                  {loading ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Submitting…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                      </svg>
                      Submit for Takedown
                    </>
                  )}
                </button>
                <button type="button" onClick={clearForm}
                  className="w-full py-2 rounded-xl text-xs font-semibold text-gray-400 hover:text-gray-600 hover:bg-gray-50 border border-gray-200 transition-all flex items-center justify-center gap-1.5">
                  ↺ Clear Form
                </button>
              </div>
            </form>
          </div>
        </aside>

        {/* ── RIGHT PANEL: history ── */}
        <div className="flex-1 min-w-0">
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">

            {/* Header bar */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="font-bold text-[#14254A] text-base flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  Submission History
                </h2>
                <p className="text-xs text-brand-muted mt-0.5">All your previously submitted URL batches</p>
              </div>
              {!histLoading && history.length > 0 && (
                <span className="text-xs font-semibold px-3 py-1.5 rounded-full bg-[#14254A]/5 text-[#14254A] border border-[#14254A]/10">
                  {history.length} record{history.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Table */}
            <div className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[540px]">
                  <thead>
                    <tr style={{ background: '#14254A' }}>
                      <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">Date</th>
                      <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">Platform</th>
                      <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">Asset</th>
                      <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">URLs</th>
                      <th className="px-5 py-3.5 w-28"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {histLoading ? (
                      Array.from({ length: 6 }).map((_, i) => (
                        <tr key={i} className="border-b border-gray-50">
                          {[100, 110, 130, 45, 70].map((w, j) => (
                            <td key={j} className="px-5 py-4">
                              <div className="h-2.5 rounded-full animate-pulse bg-gray-100" style={{ width: w }} />
                            </td>
                          ))}
                        </tr>
                      ))
                    ) : pageRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center py-24 px-5">
                          <div className="w-16 h-16 rounded-2xl bg-[#14254A]/5 flex items-center justify-center mx-auto mb-4">
                            <svg className="w-8 h-8 text-[#14254A]/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                            </svg>
                          </div>
                          <p className="font-semibold text-gray-600 mb-1">No submissions yet</p>
                          <p className="text-sm text-gray-400">Submit URLs using the form on the left.</p>
                        </td>
                      </tr>
                    ) : (
                      pageRows.map((row, i) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-[#14254A]/[0.02] transition-colors group">
                          <td className="px-5 py-4">
                            <span className="text-sm font-semibold text-[#14254A]">{fmtDate(row.date)}</span>
                          </td>
                          <td className="px-5 py-4">
                            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-[#14254A]/8 text-[#14254A] border border-[#14254A]/10">
                              {row.platform}
                            </span>
                          </td>
                          <td className="px-5 py-4 max-w-[180px]">
                            <span className="text-sm text-gray-500 truncate block" title={row.assetName}>
                              {row.assetName || '—'}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <span className="inline-flex items-center justify-center min-w-[2.5rem] px-2.5 py-1 rounded-lg text-xs font-black bg-[#14254A] text-[#FFC82B]">
                              {row.urlCount}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-right">
                            <button onClick={() => setModal(row)}
                              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-[#FC934C] hover:text-[#FC934C] hover:bg-orange-50/50 transition-all">
                              View
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {history.length > PER_PAGE && (
                <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 bg-gray-50/50">
                  <span className="text-xs text-brand-muted">
                    Showing{' '}
                    <strong className="text-[#14254A]">{(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, history.length)}</strong>
                    {' '}of <strong className="text-[#14254A]">{history.length}</strong>
                  </span>
                  <div className="flex items-center gap-1">
                    <PgBtn onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>‹</PgBtn>
                    {pgRange(page, totalPages).map((p, i) =>
                      p === '…'
                        ? <span key={i} className="px-1 text-xs text-gray-400">…</span>
                        : <PgBtn key={p} active={p === page} onClick={() => setPage(p as number)}>{p}</PgBtn>
                    )}
                    <PgBtn onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>›</PgBtn>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* URL Detail Modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={() => setModal(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col"
            style={{ maxHeight: '80vh' }}
            onClick={e => e.stopPropagation()}>

            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="font-bold text-[#14254A] text-sm">{modal.platform}</h3>
                <p className="text-xs text-brand-muted mt-0.5">{fmtDate(modal.date)} · {modal.urls?.length ?? 0} URLs</p>
              </div>
              <button onClick={() => setModal(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="overflow-y-auto flex-1 divide-y divide-gray-50">
              {(modal.urls || []).slice(0, 50).map((u, i) => {
                const urlText = typeof u === 'string' ? u : (u as any).url || ''
                return (
                  <div key={i} className="flex items-center justify-between px-5 py-2.5 hover:bg-gray-50 transition-colors">
                    <a href={urlText} target="_blank" rel="noopener"
                      className="text-xs text-[#0078D4] hover:text-[#FC934C] transition-colors truncate max-w-xs">
                      {urlText}
                    </a>
                    <span className="text-xs text-gray-300 ml-3 flex-shrink-0 tabular-nums">#{i + 1}</span>
                  </div>
                )
              })}
              {(modal.urls?.length ?? 0) > 50 && (
                <div className="py-3 text-center text-xs text-gray-400 bg-gray-50">
                  Showing first 50 of {modal.urls?.length} URLs
                </div>
              )}
            </div>

            <div className="flex justify-end px-6 py-3 border-t border-gray-100 flex-shrink-0">
              <button onClick={() => setModal(null)}
                className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PgBtn({ children, onClick, disabled, active }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`min-w-[28px] h-[28px] px-2 rounded-lg text-xs font-bold border transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
        active
          ? 'border-transparent bg-[#14254A] text-[#FFC82B]'
          : 'border-gray-200 bg-white text-[#14254A] hover:bg-gray-50'
      }`}>
      {children}
    </button>
  )
}

function pgRange(cur: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  if (cur <= 4)         return [1, 2, 3, 4, 5, '…', total]
  if (cur >= total - 3) return [1, '…', total - 4, total - 3, total - 2, total - 1, total]
  return [1, '…', cur - 1, cur, cur + 1, '…', total]
}
