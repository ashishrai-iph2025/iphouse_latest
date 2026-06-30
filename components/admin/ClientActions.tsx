'use client'

import { useState } from 'react'
import { useRouter } from '@/lib/router'
import { Link } from 'react-router-dom'

export default function ClientActions({ userId, isDeleted }: { userId: number; isDeleted: boolean }) {
  const router  = useRouter()
  const [busy,  setBusy]  = useState(false)

  async function toggleStatus() {
    setBusy(true)
    await fetch('/api/admin/clients', {
        credentials: 'include',
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, deleted: isDeleted ? 0 : 1 }),
    })
    router.refresh()
    setBusy(false)
  }

  return (
    <div className="flex items-center gap-2">
      <Link to={`/admin/clients/${userId}/edit`}
        className="text-xs text-blue-600 hover:underline font-medium">
        Edit
      </Link>
      <button onClick={toggleStatus} disabled={busy}
        className={`text-xs font-medium hover:underline disabled:opacity-50 ${isDeleted ? 'text-green-600' : 'text-red-600'}`}>
        {busy ? '...' : isDeleted ? 'Activate' : 'Deactivate'}
      </button>
    </div>
  )
}
