'use client'

import { useEffect, useState } from 'react'
import ClientsPageClient from '@/components/admin/ClientsPageClient'

export default function ClientsPage() {
  const [clients, setClients]             = useState<any[]>([])
  const [totalClients, setTotalClients]   = useState(0)
  const [totalDashboards, setTotalDash]   = useState(0)
  const [totalModules, setTotalModules]   = useState(0)

  useEffect(() => {
    fetch('/api/admin/clients', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        setClients(d.clients || [])
        setTotalClients(d.totalActive ?? 0)
      })
      .catch(() => {})

    fetch('/api/admin/dashboards', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        setTotalDash(d.totalDashboards || 0)
        setTotalModules(d.totalModules || 0)
      })
      .catch(() => {})
  }, [])

  return (
    <ClientsPageClient
      clients={clients}
      totalClients={totalClients}
      totalDashboards={totalDashboards}
      totalModules={totalModules}
    />
  )
}
