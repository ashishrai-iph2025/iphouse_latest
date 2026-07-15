'use client'

// /admin/aws-credentials — Super Admin only.
// Securely store the AWS credentials used by the S3 database-backup feature.
// The access key id and secret are encrypted at rest; the secret is never
// returned to the browser except through the on-demand reveal.

import { useEffect, useState } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { useSession } from '@/lib/auth-client'

interface Status {
  configured: boolean
  accessKeyId?: string   // masked
  region?: string
  s3Uri?: string
  hasSecret?: boolean
  updatedAt?: string
}

export default function AwsCredentialsPage() {
  const { data: session, status } = useSession()
  const role = (session?.user as any)?.role

  const [info,    setInfo]    = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [toast,   setToast]   = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const [accessKeyId,     setAccessKeyId]     = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [region,          setRegion]          = useState('')
  const [s3Uri,           setS3Uri]           = useState('')
  const [revealed,        setRevealed]        = useState<{ accessKeyId: string; secretAccessKey: string } | null>(null)
  const [showSecret,      setShowSecret]      = useState(false)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/aws-credentials', { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        setInfo(data)
        setRegion(data.region || '')
        setS3Uri(data.s3Uri || '')
      }
    } catch { /* ignore */ }
    setLoading(false)
  }
  useEffect(() => { if (role === 2) load() }, [role])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/admin/aws-credentials', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessKeyId: accessKeyId.trim(), secretAccessKey, region: region.trim(), s3Uri: s3Uri.trim() }),
      })
      const data = await res.json()
      if (data.success) {
        showToast('AWS credentials saved securely')
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
      const res = await fetch('/api/admin/aws-credentials/reveal', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setRevealed({ accessKeyId: data.accessKeyId || '', secretAccessKey: data.secretAccessKey || '' })
      else showToast(data.error || 'Failed to reveal', 'error')
    } catch { showToast('Failed to reveal', 'error') }
  }

  if (status === 'loading') return null
  if (role !== 2) return <Navigate to="/admin/home" replace />

  const editing = info?.configured

  return (
    <div className="p-6 fade-in max-w-3xl">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm font-semibold shadow-xl ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <div className="mb-6">
        <Link to="/admin/configuration" className="text-brand-muted hover:text-[#FC934C] text-xs font-medium">← Configuration</Link>
        <h1 className="text-2xl font-bold text-[#14254A] mt-1">AWS Credentials</h1>
        <p className="text-brand-muted text-sm mt-1">
          Credentials used by the database backup to upload to Amazon S3. Stored encrypted (AES-256) — the secret key is never shown again unless you reveal it.
        </p>
      </div>

      {/* Current status */}
      {!loading && (
        <div className={`rounded-2xl border p-4 mb-5 ${editing ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full ${editing ? 'bg-emerald-500 text-white' : 'bg-amber-500 text-white'}`}>
              {editing ? '✓ Configured' : '⚠ Not configured'}
            </span>
            {editing && (
              <>
                <code className="text-xs bg-white/70 border border-emerald-200 px-2 py-1 rounded font-mono text-gray-700">{info?.accessKeyId}</code>
                <span className="text-xs text-gray-500">Region <b className="text-gray-700">{info?.region || '—'}</b></span>
                <span className="text-xs text-gray-500">·</span>
                <code className="text-xs text-gray-600 font-mono">{info?.s3Uri}</code>
                <button onClick={reveal} className="ml-auto text-xs font-semibold text-[#14254A] hover:text-[#FC934C]">
                  {revealed ? '🙈 Hide' : '👁 Reveal'}
                </button>
              </>
            )}
          </div>
          {revealed && (
            <div className="mt-3 grid gap-2 text-xs">
              <div className="flex items-center gap-2"><span className="text-gray-400 w-28">Access Key ID</span><code className="font-mono bg-white px-2 py-1 rounded border border-gray-200 break-all">{revealed.accessKeyId}</code></div>
              <div className="flex items-center gap-2"><span className="text-gray-400 w-28">Secret Access Key</span><code className="font-mono bg-white px-2 py-1 rounded border border-gray-200 break-all">{revealed.secretAccessKey}</code></div>
            </div>
          )}
        </div>
      )}

      {/* Form */}
      <form onSubmit={save} className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 space-y-4">
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Access Key ID <span className="text-red-500">*</span></label>
          <input type="text" value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} autoComplete="off"
            placeholder={editing ? info?.accessKeyId : 'AKIA…'}
            required
            className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">
            Secret Access Key {editing && <span className="text-gray-400 font-normal">(leave blank to keep current)</span>} {!editing && <span className="text-red-500">*</span>}
          </label>
          <div className="relative">
            <input type={showSecret ? 'text' : 'password'} value={secretAccessKey} onChange={e => setSecretAccessKey(e.target.value)} autoComplete="new-password"
              placeholder={editing ? '••••••••••••••••••••' : 'Secret access key'}
              required={!editing}
              className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 pr-10 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
            <button type="button" onClick={() => setShowSecret(s => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">
              {showSecret ? '🙈' : '👁'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Region <span className="text-red-500">*</span></label>
            <input type="text" value={region} onChange={e => setRegion(e.target.value)} autoComplete="off"
              placeholder="e.g. ap-south-1"
              required
              className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">S3 Destination URI <span className="text-red-500">*</span></label>
            <input type="text" value={s3Uri} onChange={e => setS3Uri(e.target.value)} autoComplete="off"
              placeholder="s3://bucket/prefix"
              required
              className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#14254A]/20" />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-2">
          <p className="text-[11px] text-gray-400">
            Backups upload to this bucket. If left unconfigured, the server's IAM role is used instead.
          </p>
          <button type="submit" disabled={saving}
            className="px-6 py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 shadow-sm flex-shrink-0"
            style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
            {saving ? 'Saving…' : editing ? 'Update Credentials' : 'Save Credentials'}
          </button>
        </div>
      </form>

      <div className="mt-4 flex items-center gap-2 text-xs text-gray-400">
        <span>Ready to back up?</span>
        <Link to="/admin/database-backup" className="font-semibold text-[#FC934C] hover:underline">Go to Database Backup →</Link>
      </div>
    </div>
  )
}
