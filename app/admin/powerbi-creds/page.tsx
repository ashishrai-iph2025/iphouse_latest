'use client'

import { useEffect, useState } from 'react'
import PowerBICredsClient from '@/components/admin/PowerBICredsClient'

export default function PowerBICredsPage() {
  const [creds, setCreds] = useState<any[]>([])

  useEffect(() => {
    fetch('/api/admin/powerbi-creds', { credentials: 'include' })
      .then(r => r.json())
      .then(d => d.creds && setCreds(d.creds))
      .catch(() => {})
  }, [])

  return <PowerBICredsClient initialCreds={creds} />
}
