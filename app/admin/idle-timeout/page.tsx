'use client'

import { useEffect, useState } from 'react'
import IdleTimeoutClient from '@/components/admin/IdleTimeoutClient'

export default function IdleTimeoutPage() {
  const [rows, setRows] = useState<any[]>([])

  useEffect(() => {
    fetch('/api/admin/idle-timeout', { credentials: 'include' })
      .then(r => r.json())
      .then(d => d.settings && setRows(d.settings))
      .catch(() => {})
  }, [])

  return <IdleTimeoutClient initialRows={rows} />
}
