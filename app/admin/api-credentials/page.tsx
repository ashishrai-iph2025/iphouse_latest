'use client'

import { useEffect, useState } from 'react'
import ApiCredentialsClient from '@/components/admin/ApiCredentialsClient'

export default function ApiCredentialsPage() {
  const [credentials, setCredentials] = useState<any[]>([])

  useEffect(() => {
    fetch('/api/admin/api-credentials', { credentials: 'include' })
      .then(r => r.json())
      .then(d => d.credentials && setCredentials(d.credentials))
      .catch(() => {})
  }, [])

  return (
    <div className="p-6">
      <ApiCredentialsClient credentials={credentials} />
    </div>
  )
}
