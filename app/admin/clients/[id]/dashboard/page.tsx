'use client'

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import DashboardClient from '@/components/client/DashboardClient'
import PageLoader from '@/components/ui/PageLoader'

export default function AdminClientDashboardPage({ id }: { id: string }) {
  const [data, setData]       = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    fetch(`/api/admin/client-dashboard?userId=${id}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [id])

  if (loading) return <PageLoader />
  if (!data?.success) return (
    <div className="p-6 text-center text-red-500">Client not found.</div>
  )

  const { user, modules } = data

  return (
    <div>
      <div className="flex items-center gap-3 px-6 py-3 text-white text-xs font-semibold" style={{ background: '#14254A' }}>
        <Link to="/admin/clients" className="text-white/70 hover:text-white">← Back to Clients</Link>
        <span className="text-white/40">|</span>
        <span>Previewing dashboard for: <strong>{user?.name}</strong> (ID: {id})</span>
      </div>
      <DashboardClient
        userName={user?.name || ''}
        userLogo={user?.userLogo || 'userimg.jpg'}
        companyLogo={user?.companyLogo || 'default-company-logo.png'}
        modules={modules || []}
      />
    </div>
  )
}
