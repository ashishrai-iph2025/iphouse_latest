'use client'

import { useEffect, useState } from 'react'
import DashboardModulesClient, { type DashModule } from '@/components/admin/DashboardModulesClient'

export default function DashboardModulesPage() {
  const [modules, setModules] = useState<DashModule[]>([])

  useEffect(() => {
    fetch('/api/admin/dashboard-modules?showDeleted=1', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.success) setModules(d.modules ?? []) })
      .catch(() => {})
  }, [])

  return <DashboardModulesClient initialModules={modules} />
}
