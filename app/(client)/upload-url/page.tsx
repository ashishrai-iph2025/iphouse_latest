'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import Breadcrumb from '@/components/ui/Breadcrumb'
import Portal from '@/components/ui/Portal'
import { useMasterData } from '@/lib/masterDataContext'
import { platformLabel } from '@/lib/platformCategories'

interface HistoryRow {
  id: string
  date: string
  platform: string
  assetName: string
  urlCount: number
  urls: string[]
  /** Distinct logins whose URLs are in this batch — only populated for a
      company-wide view; empty when nothing in it could be attributed. */
  submitters?: string[]
}

const PER_PAGE = 10

/* ── Platform detection ───────────────────────────────────────────────────
   The platform is no longer picked by hand — it is read off each submitted
   URL, whether typed into the textarea or extracted from the Excel file. A
   URL's host maps to a canonical token, and that token is then resolved
   against the account's real platform list (master data) so the value posted
   is exactly what the API expects. Anything unrecognised is Open Web. */

const HOST_TOKENS: [RegExp, string][] = [
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/,                         'youtube'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.watch$|(^|\.)fb\.com$/,         'facebook'],
  [/(^|\.)instagram\.com$/,                                        'instagram'],
  [/(^|\.)twitter\.com$|(^|\.)x\.com$/,                            'twitter'],
  [/(^|\.)t\.me$|(^|\.)telegram\.(me|org)$/,                       'telegram'],
  [/(^|\.)(tiktok\.com|vk\.com|ok\.ru|dailymotion\.com|dai\.ly|bilibili\.com|sharechat\.com|chomikuj\.pl)$/, 'ugc'],
  [/(^|\.)(itunes|music|apps)\.apple\.com$/,                       'itunes'],
  [/(^|\.)play\.google\.com$/,                                     'play store'],
]

// Substrings that identify each token inside a real platform label.
const TOKEN_ALIASES: Record<string, string[]> = {
  youtube:      ['youtube'],
  facebook:     ['facebook'],
  instagram:    ['instagram'],
  twitter:      ['twitter', 'x (twitter)'],
  telegram:     ['telegram'],
  ugc:          ['ugc'],
  itunes:       ['i-tunes', 'itunes'],
  'play store': ['play store', 'playstore'],
  internet:     ['internet'],
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}

function tokenFor(url: string): string {
  const host = hostOf(url)
  if (!host) return 'internet'
  for (const [re, token] of HOST_TOKENS) if (re.test(host)) return token
  return 'internet'
}

/** Resolve a token to the account's own platform option; falls back to Open
    Web, then to the token itself so a submission is never silently dropped. */
function resolvePlatform(token: string, platforms: { key: string; label: string }[]): string {
  // Matched on `key`, never on `label`: the label is a display string ("Internet"
  // reads as "Open Web"), so matching it would miss the very platform it names.
  const aliases = TOKEN_ALIASES[token] ?? [token]
  const hit = platforms.find(p => aliases.some(a => p.key.toLowerCase().includes(a)))
  if (hit) return hit.key
  const web = platforms.find(p => p.key.toLowerCase().includes('internet'))
  return web?.key ?? token
}

/** Split raw text (textarea or file contents) into URLs, matching how the
    server tokenises an uploaded file. */
function extractUrls(text: string): string[] {
  return text
    .split(/[\r\n,;\t]+/)
    .map(u => u.trim())
    .filter(u => /^https?:\/\//i.test(u))
}

const isSourcePlatformName = (name: string) => {
  const lc = name.toLowerCase()
  return lc.includes('internet') || lc.includes('thirdpartyapp') || lc.includes('third party app')
}

export default function UploadURLPage() {
  const [mode,        setMode]        = useState<'manual' | 'file'>('manual')
  const [assetName,   setAssetName]   = useState('')
  const [officialUrl, setOfficialUrl] = useState('')
  const [urls,        setUrls]        = useState('')
  const [file,        setFile]        = useState<File | null>(null)
  const [fileUrls,    setFileUrls]    = useState<string[]>([])
  const [fileError,   setFileError]   = useState('')
  const [remarks,     setRemarks]     = useState('')
  const [loading,     setLoading]     = useState(false)
  const [toast,       setToast]       = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const [history,     setHistory]     = useState<HistoryRow[]>([])
  const [histLoading, setHistLoading] = useState(true)
  const [page,        setPage]        = useState(1)
  const [modal,       setModal]       = useState<HistoryRow | null>(null)
  // 'self' = only URLs this login submitted; 'company' = every login's, for a
  // Client Admin and IP House staff. Decided server-side — the MarkScan history
  // itself is company-wide (go-server/handlers/requestledger.go).
  const [scope,       setScope]       = useState<'self' | 'company'>('self')

  const { platforms, assets } = useMasterData()
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadHistory() }, [])

  // Lock page scroll + close on Escape while the URL detail modal is open
  useEffect(() => {
    if (!modal) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModal(null) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [modal])

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
      setScope(data.scope === 'company' ? 'company' : 'self')
    } catch {
      setHistory([])
    } finally {
      setHistLoading(false)
    }
  }

  // The URLs actually being submitted, whichever input method is active.
  const activeUrls = mode === 'manual' ? extractUrls(urls) : fileUrls

  /* Detected platforms, in submission order. Every URL is routed to the
     platform its host implies; a batch spanning several platforms is posted as
     one submission per platform, because the API takes a single platform per
     call. */
  const groups = useMemo(() => {
    const byPlatform = new Map<string, { platform: string; urls: string[] }>()
    for (const u of activeUrls) {
      const name = resolvePlatform(tokenFor(u), platforms)
      const g = byPlatform.get(name) ?? { platform: name, urls: [] }
      g.urls.push(u); byPlatform.set(name, g)
    }
    return [...byPlatform.values()].sort((a, b) => b.urls.length - a.urls.length)
  }, [activeUrls, platforms])

  // Official URL is required as soon as any group lands on a source platform.
  const needsOfficialUrl = groups.some(g => isSourcePlatformName(g.platform))

  /* Excel/CSV files are read in the browser so the platform can be detected
     before submitting — the same "keep every http token" rule the server used
     when it parsed the upload itself. */
  async function onFileChosen(f: File | null) {
    setFile(f); setFileUrls([]); setFileError('')
    if (!f) return
    try {
      const text = await f.text()
      const found = extractUrls(text)
      if (found.length === 0) {
        setFileError('No URLs could be read from this file. Save it as CSV (or paste the URLs manually) so the platform can be detected.')
        return
      }
      setFileUrls(found)
    } catch {
      setFileError('Could not read this file. Please try again or paste the URLs manually.')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!assetName) { showToast('Please select an Asset', 'error'); return }
    if (mode === 'file' && !file) { showToast('Please select an Excel file', 'error'); return }
    if (activeUrls.length === 0) {
      showToast(mode === 'manual' ? 'Please enter at least one URL' : 'No URLs were found in the selected file', 'error')
      return
    }
    if (needsOfficialUrl && !officialUrl.trim()) {
      showToast('Official URL is required for Open Web / third-party app URLs', 'error'); return
    }

    setLoading(true)
    try {
      // One call per detected platform; report the batch as a whole.
      const outcomes = await Promise.all(groups.map(async g => {
        try {
          const res = await fetch('/api/upload-url', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              platform: g.platform, assetName, officialUrl, remarks,
              mode: 'manual', urls: g.urls,
            }),
          })
          const data = await res.json()
          return { platform: g.platform, count: g.urls.length, ok: !!data.success, error: data.error as string | undefined }
        } catch (err: any) {
          return { platform: g.platform, count: g.urls.length, ok: false, error: err?.message }
        }
      }))

      const okGroups = outcomes.filter(o => o.ok)
      const failed   = outcomes.filter(o => !o.ok)
      const okUrls   = okGroups.reduce((n, o) => n + o.count, 0)

      if (failed.length === 0) {
        showToast(`${okUrls} URL${okUrls === 1 ? '' : 's'} submitted across ${okGroups.length} platform${okGroups.length === 1 ? '' : 's'}`)
        setUrls(''); setRemarks(''); setOfficialUrl(''); setFile(null); setFileUrls([])
        if (fileRef.current) fileRef.current.value = ''
      } else {
        const detail = failed.map(o => `${o.platform}: ${o.error || 'failed'}`).join(' · ')
        showToast(
          okGroups.length > 0
            ? `Submitted ${okUrls} URL(s); ${failed.length} platform(s) failed — ${detail}`
            : `Submission failed — ${detail}`,
          'error')
      }
      loadHistory()
    } catch (err: any) {
      showToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  function clearForm() {
    setUrls(''); setRemarks(''); setFile(null); setFileUrls([]); setFileError('')
    setAssetName(''); setOfficialUrl('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const totalPages = Math.max(1, Math.ceil(history.length / PER_PAGE))
  const pageRows   = history.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const urlCount   = activeUrls.length

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

              {/* Asset */}
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Asset <span className="text-red-400">*</span>
                </label>
                <SearchableSelect options={assets} value={assetName} onChange={setAssetName}
                  placeholder="Select asset…" emptyLabel="— Select asset —" />
              </div>

              {/* Official URL */}
              {needsOfficialUrl && (
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
                      <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.txt"
                        onChange={e => onFileChosen(e.target.files?.[0] || null)} className="hidden" />
                      <svg className="w-7 h-7 mx-auto mb-2 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      {file ? (
                        <>
                          <p className="text-xs font-semibold text-emerald-700">{file.name}</p>
                          {fileUrls.length > 0 && (
                            <p className="text-[10px] text-gray-400 mt-0.5">{fileUrls.length} URL{fileUrls.length === 1 ? '' : 's'} read</p>
                          )}
                        </>
                      ) : (
                        <>
                          <p className="text-xs text-gray-500">Drag & drop or <span className="font-semibold text-[#14254A]">browse</span></p>
                          <p className="text-[10px] text-gray-400 mt-0.5">.xls, .xlsx, .csv or .txt</p>
                        </>
                      )}
                    </div>
                    {fileError && (
                      <p className="text-[10px] text-red-500 mt-1.5">{fileError}</p>
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
                </div>
              )}

              {/* Detected platforms — derived from the submitted URLs, so there
                  is no platform to pick. One submission is sent per platform. */}
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  Detected Platform{groups.length === 1 ? '' : 's'}
                </label>
                {groups.length === 0 ? (
                  <p className="text-[11px] text-gray-400 rounded-xl border border-dashed border-gray-200 px-3 py-2.5">
                    Add URLs above — the platform is detected automatically from each URL.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {groups.map(g => (
                        <span key={g.platform}
                          className="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-full text-[11px] font-semibold bg-[#14254A]/5 text-[#14254A] border border-[#14254A]/10">
                          {platformLabel(g.platform)}
                          <span className="font-black px-1.5 rounded-full bg-[#14254A] text-[#FFC82B]">{g.urls.length}</span>
                        </span>
                      ))}
                    </div>
                    {groups.length > 1 && (
                      <p className="text-[10px] text-gray-400 mt-1.5">
                        Sent as {groups.length} separate submissions, one per platform.
                      </p>
                    )}
                  </>
                )}
              </div>

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
                  {/* The account can be shared by several logins, so the list
                      states whose submissions it is showing. */}
                  <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${
                    scope === 'company'
                      ? 'bg-[#14254A]/5 text-[#14254A] border-[#14254A]/15'
                      : 'bg-orange-50 text-[#c2691f] border-orange-200'
                  }`}>
                    {scope === 'company' ? 'All users' : 'Yours'}
                  </span>
                </h2>
                <p className="text-xs text-brand-muted mt-0.5">
                  {scope === 'company'
                    ? 'Every URL batch submitted on this account'
                    : 'Only the URL batches you submitted'}
                </p>
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
                      {scope === 'company' && (
                        <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">Submitted By</th>
                      )}
                      <th className="text-left px-5 py-3.5 text-[10px] font-bold text-white/60 uppercase tracking-widest">URLs</th>
                      <th className="px-5 py-3.5 w-28"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {histLoading ? (
                      Array.from({ length: 6 }).map((_, i) => (
                        <tr key={i} className="border-b border-gray-50">
                          {[100, 110, 130, ...(scope === 'company' ? [90] : []), 45, 70].map((w, j) => (
                            <td key={j} className="px-5 py-4">
                              <div className="h-2.5 rounded-full animate-pulse bg-gray-100" style={{ width: w }} />
                            </td>
                          ))}
                        </tr>
                      ))
                    ) : pageRows.length === 0 ? (
                      <tr>
                        <td colSpan={scope === 'company' ? 6 : 5} className="text-center py-24 px-5">
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
                              {platformLabel(row.platform)}
                            </span>
                          </td>
                          <td className="px-5 py-4 max-w-[180px]">
                            <span className="text-sm text-gray-500 truncate block" title={row.assetName}>
                              {row.assetName || '—'}
                            </span>
                          </td>
                          {scope === 'company' && (
                            <td className="px-5 py-4 max-w-[170px]">
                              {row.submitters && row.submitters.length > 0 ? (
                                <span className="text-xs font-semibold text-gray-700 truncate block"
                                  title={row.submitters.join(', ')}>
                                  {row.submitters[0]}
                                  {row.submitters.length > 1 && (
                                    <span className="text-gray-400 font-normal"> +{row.submitters.length - 1}</span>
                                  )}
                                </span>
                              ) : (
                                /* Batches submitted before attribution existed, or
                                   pushed straight to the API. */
                                <span className="text-xs text-gray-300 italic">Unattributed</span>
                              )}
                            </td>
                          )}
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

      {/* URL Detail Modal — portalled to <body> so the overlay covers the whole
          screen rather than the page's content box (see components/ui/Portal) */}
      {modal && (
        <Portal>
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 backdrop-blur-sm"
          style={{ background: 'rgba(20,37,74,0.62)' }}
          role="dialog" aria-modal="true"
          onClick={() => setModal(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col"
            style={{ maxHeight: 'min(80dvh, 640px)', border: '1px solid rgba(20,37,74,0.12)' }}
            onClick={e => e.stopPropagation()}>

            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="font-bold text-[#14254A] text-sm">{platformLabel(modal.platform)}</h3>
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
        </Portal>
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
