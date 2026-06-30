'use client'

import { useEffect, useState } from 'react'
import SettingsClient from '@/components/admin/SettingsClient'

export default function SettingsPage() {
  const [creds, setCreds] = useState<any[]>([])

  useEffect(() => {
    fetch('/api/admin/email-credentials', { credentials: 'include' })
      .then(r => r.json())
      .then(d => d.credentials && setCreds(d.credentials))
      .catch(() => {})
  }, [])

  return <SettingsClient initialCreds={creds} />
}
