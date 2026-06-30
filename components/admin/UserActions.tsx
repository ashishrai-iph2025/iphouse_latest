'use client'

import { useState } from 'react'
import { useRouter } from '@/lib/router'

export default function UserActions({ loginId, isActive }: { loginId: number; isActive: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function toggle() {
    setBusy(true)
    await fetch('/api/admin/users', {
        credentials: 'include',
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ loginId, isActive: !isActive }),
    })
    router.refresh()
    setBusy(false)
  }

  return (
    <button onClick={toggle} disabled={busy}
      className={`text-xs font-medium hover:underline disabled:opacity-50 ${isActive ? 'text-red-600' : 'text-green-600'}`}>
      {busy ? '...' : isActive ? 'Deactivate' : 'Activate'}
    </button>
  )
}
