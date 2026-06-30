'use client'

import { useEffect, useState } from 'react'
import DashboardsPageClient from '@/components/admin/DashboardsPageClient'

export default function DashboardsPage() {
  const [dashboards, setDashboards]       = useState<any[]>([])
  const [totalClients, setTotalClients]   = useState(0)
  const [totalDashboards, setTotalDash]   = useState(0)
  const [totalModules, setTotalModules]   = useState(0)

  useEffect(() => {
    fetch('/api/admin/dashboards', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        setDashboards(d.dashboards || [])
        setTotalClients(d.totalClients || 0)
        setTotalDash(d.totalDashboards || 0)
        setTotalModules(d.totalModules || 0)
      })
      .catch(() => {})
  }, [])

  return (
    <DashboardsPageClient
      dashboards={dashboards}
      totalClients={totalClients}
      totalDashboards={totalDashboards}
      totalModules={totalModules}
    />
  )
}
