'use client'

// Amazon SES configuration — lives on the same /admin/settings page as the
// existing SMTP master email credentials. Saving SES credentials here does
// NOT change how mail is sent: the server only switches to SES once "Use
// Amazon SES for sending" is turned on, so this can be configured and tested
// ahead of the cutover while the existing SMTP setup keeps working.

import { useEffect, useState } from 'react'

interface Status {
  configured: boolean
  accessKeyId?: string // masked
  region?: string
  fromEmail?: string
  fromName?: string
  hasSecret?: boolean
  is_active?: number
  updatedAt?: string
}

export default function SESSettingsClient() {
  const [info,    setInfo]    = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [testing, setTesting] = useState(false)
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const [accessKeyId,     setAccessKeyId]     = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [region,          setRegion]          = useState('')
  const [fromEmail,       setFromEmail]       = useState('')
  const [fromName,        setFromName]        = useState('')
  const [isActive,        setIsActive]        = useState(false)
  const [testTo,          setTestTo]          = useState('')

  const [revealed,   setRevealed]   = useState<{ accessKeyId: string; secretAccessKey: string } | null>(null)
  const [showSecret, setShowSecret] = useState(false)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/ses-credentials', { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        setInfo(data)
        setRegion(data.region || '')
        setFromEmail(data.fromEmail || '')
        setFromName(data.fromName || '')
        setIsActive(!!Number(data.is_active))
      }
    } catch { /* ignore */ }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/admin/ses-credentials', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessKeyId: accessKeyId.trim(),
          secretAccessKey,
          region: region.trim(),
          fromEmail: fromEmail.trim(),
          fromName: fromName.trim(),
          isActive: isActive ? 1 : 0,
        }),
      })
      const data = await res.json()
      if (data.success) {
        showToast('SES configuration saved securely')
        setAccessKeyId(''); setSecretAccessKey(''); setRevealed(null)
        await load()
      } else {
        showToast(data.error || 'Failed to save', 'error')
      }
    } catch {
      showToast('Network error', 'error')
    }
    setSaving(false)
  }

  async function reveal() {
    if (revealed) { setRevealed(null); return }
    try {
      const res = await fetch('/api/admin/ses-credentials/reveal', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setRevealed({ accessKeyId: data.accessKeyId || '', secretAccessKey: data.secretAccessKey || '' })
      else showToast(data.error || 'Failed to reveal', 'error')
    } catch { showToast('Failed to reveal', 'error') }
  }

  async function sendTest() {
    if (!testTo.trim()) { showToast('Enter a recipient email first', 'error'); return }
    setTesting(true)
    try {
      const res = await fetch('/api/admin/ses-credentials/test', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo.trim() }),
      })
      const data = await res.json()
      if (data.success) showToast(data.message || 'Test email sent')
      else showToast(data.error || 'Test email failed', 'error')
    } catch {
      showToast('Network error', 'error')
    }
    setTesting(false)
  }

  const editing = info?.configured

  return (
    <div className="mt-8">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 text-white flex-wrap gap-2"
          style={{ background: '#14254A' }}>
          <div>
            <h3 className="font-bold text-sm">Amazon SES Configuration</h3>
            <p className="text-white/60 text-xs mt-0.5">
              Configure SES ahead of time — existing SMTP sending keeps working until you switch it on below.
            </p>
          </div>
          {!loading && (
            <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full ${isActive ? 'bg-emerald-500 text-white' : 'bg-white/15 text-white'}`}>
              {isActive ? '✓ Active — sending via SES' : 'Sending via existing SMTP'}
            </span>
          )}
        </div>

        <div className="p-5">
          {!loading && editing && (
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 mb-5">
              <div className="flex items-center gap-2 flex-wrap">
                <code className="text-xs bg-white border border-gray-200 px-2 py-1 rounded font-mono text-gray-700">{info?.accessKeyId}</code>
                <span className="text-xs text-gray-500">Region <b className="text-gray-700">{info?.region || '—'}</b></span>
                <span className="text-xs text-gray-500">·</span>
                <span className="text-xs text-gray-500">From <b className="text-gray-700">{info?.fromEmail || '—'}</b></span>
                <button onClick={reveal} type="button" className="ml-auto text-xs font-semibold text-[#14254A] hover:text-[#FC934C]">
                  {revealed ? '🙈 Hide' : '👁 Reveal'}
                </button>
              </div>
              {revealed && (
                <div className="mt-3 grid gap-2 text-xs">
                  <div className="flex items-center gap-2"><span className="text-gray-400 w-28">Access Key ID</span><code className="font-mono bg-white px-2 py-1 rounded border border-gray-200 break-all">{revealed.accessKeyId}</code></div>
                  <div className="flex items-center gap-2"><span className="text-gray-400 w-28">Secret Access Key</span><code className="font-mono bg-white px-2 py-1 rounded border border-gray-200 break-all">{revealed.secretAccessKey}</code></div>
                </div>
              )}
            </div>
          )}

          <form onSubmit={save} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Access Key ID *</label>
              <input type="text" value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} autoComplete="off"
                placeholder={editing ? info?.accessKeyId : 'AKIA…'}
                required
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                Secret Access Key {editing ? <span className="text-gray-400 font-normal">(leave blank to keep current)</span> : '*'}
              </label>
              <div className="relative">
                <input type={showSecret ? 'text' : 'password'} value={secretAccessKey} onChange={e => setSecretAccessKey(e.target.value)} autoComplete="new-password"
                  placeholder={editing ? '••••••••••••••••••••' : 'Secret access key'}
                  required={!editing}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 pr-10 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
                <button type="button" onClick={() => setShowSecret(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">
                  {showSecret ? '🙈' : '👁'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Region *</label>
                <input type="text" value={region} onChange={e => setRegion(e.target.value)} autoComplete="off"
                  placeholder="e.g. ap-south-1" required
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">From Email *</label>
                <input type="email" value={fromEmail} onChange={e => setFromEmail(e.target.value)} autoComplete="off"
                  placeholder="noreply@example.com" required
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">From Name</label>
                <input type="text" value={fromName} onChange={e => setFromName(e.target.value)} autoComplete="off"
                  placeholder="IP House"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
              </div>
            </div>

            <p className="text-[11px] text-gray-400">
              The From Email must be a verified identity in Amazon SES (or its domain must be verified), otherwise sending will fail.
            </p>

            <label className="flex items-center gap-2 pt-1 cursor-pointer select-none">
              <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-[#14254A] focus:ring-[#14254A]/30" />
              <span className="text-sm text-gray-700">Use Amazon SES for sending emails (replaces the SMTP credentials above)</span>
            </label>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
              <button type="submit" disabled={saving}
                className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#14254A' }}>
                {saving ? 'Saving…' : editing ? 'Update SES Configuration' : 'Save SES Configuration'}
              </button>
            </div>
          </form>

          {editing && (
            <div className="mt-5 pt-4 border-t border-gray-100 flex flex-wrap items-center gap-2">
              <input type="email" value={testTo} onChange={e => setTestTo(e.target.value)}
                placeholder="you@example.com"
                className="flex-1 min-w-[220px] border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
              <button type="button" onClick={sendTest} disabled={testing}
                className="px-4 py-2 rounded-xl text-sm font-semibold border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                {testing ? 'Sending…' : 'Send Test Email'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
