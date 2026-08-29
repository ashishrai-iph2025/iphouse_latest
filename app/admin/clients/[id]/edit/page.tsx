'use client'

import { useEffect, useState } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
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
    <div className="p-6 max-w-7xl mx-auto fade-in">
      {/* The shared header every other admin sub-page uses, rather than a bare
          "← Back" beside a heading.

          Three things it brings that the old pair did not: a labelled way out
          that says WHERE it goes, a breadcrumb naming the client so the page
          says which company is open without reading the first field, and the
          same title/description block the rest of the console has. The chevron
          link and the arrow-plus-heading were two shapes for one control, and
          this page had the one nothing else used. */}
      <AdminPageHeader
        backHref="/admin/clients"
        backLabel="Clients"
        breadcrumb={[
          { label: 'Clients', href: '/admin/clients' },
          { label: client.name || 'Edit Client' },
        ]}
        title="Edit Client"
        description="Company details, where its figures come from, and how long its people stay signed in."
      />
      <EditClientForm client={client} />
    </div>
  )
}
