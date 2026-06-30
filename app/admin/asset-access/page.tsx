'use client'

import { useEffect, useState } from 'react'
import AssetAccessClient from '@/components/admin/AssetAccessClient'

export default function AssetAccessPage() {
  const [users, setUsers] = useState<any[]>([])

  useEffect(() => {
    fetch('/api/admin/asset-access', { credentials: 'include' })
      .then(r => r.json())
      .then(d => d.items && setUsers(d.items))
      .catch(() => {})
  }, [])

  return <AssetAccessClient initialUsers={users} />
}
