'use client'

import { useState } from 'react'
import { useRouter } from '@/lib/router'

interface Props { requestId: number; email: string; username: string; fullName: string }

export default function RegistrationActions({ requestId }: Props) {
  const router  = useRouter()
  const [busy,  setBusy]  = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState('')

  async function act(action: 'approve' | 'reject') {
    setBusy(action); setError('')
    const res  = await fetch('/api/admin/registrations', {
        credentials: 'include',
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ requestId, action }),
    })
    const data = await res.json()
    if (!data.success) setError(data.error || 'Failed')
    else { setBusy(null); router.refresh() }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button onClick={() => act('approve')} disabled={busy !== null}
        className="text-xs font-medium text-green-600 hover:underline disabled:opacity-50">
        {busy === 'approve' ? '...' : '✓ Approve'}
      </button>
      <button onClick={() => act('reject')} disabled={busy !== null}
        className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50">
        {busy === 'reject' ? '...' : '✗ Reject'}
      </button>
    </div>
  )
}
