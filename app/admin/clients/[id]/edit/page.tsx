'use client'

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import EditClientForm from '@/components/admin/EditClientForm'
import PageLoader from '@/components/ui/PageLoader'

export default function EditClientPage({ id }: { id: string }) {
  const [client, setClient]   = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    fetch(`/api/admin/clients`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const found = (d.clients || []).find((c: any) => String(c.userId) === String(id))
        setClient(found || null)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [id])

  if (loading) return <PageLoader />
  if (!client) return (
    <div className="p-6 text-center text-red-500">Client not found.</div>
  )

  return (
    <div className="p-6 max-w-2xl mx-auto fade-in">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/admin/clients" className="text-brand-muted hover:text-[#FC934C] text-sm">← Back</Link>
        <h1 className="text-2xl font-bold text-[#14254A]">Edit Client</h1>
      </div>
      <EditClientForm client={client} />
    </div>
  )
}
