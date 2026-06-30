'use client'

import { useState } from 'react'
import { useRouter } from '@/lib/router'

export default function DashboardActions({ dashboardId, isActive }: { dashboardId: number; isActive: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function toggle() {
    setBusy(true)
    await fetch('/api/admin/dashboards', {
        credentials: 'include',
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ dashboardId, active: !isActive }),
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
