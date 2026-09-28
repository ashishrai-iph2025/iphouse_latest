'use client'

// The page header of the analytics pages, in the portal's own layout:
// breadcrumb left, title + description right, actions on a row below.
// Staff see the admin header (Home → /admin/home); a client login, under
// Business Intelligence, sees the client portal's (Home → /dashboard).

import type { ReactNode } from 'react'
import Breadcrumb from '@/components/ui/Breadcrumb'
import AdminPageHeader from '@/components/admin/AdminPageHeader'

export default function AnalyticsHeader({ client, title, description, actions }:
  { client: boolean; title: string; description: string; actions?: ReactNode }) {
  if (!client) {
    return <AdminPageHeader breadcrumb={[{ label: 'Reporting' }, { label: title }]} title={title} description={description} actions={actions} />
  }
  return (
    <div className="mb-4 sm:mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <Breadcrumb items={[{ label: 'Business Intelligence' }, { label: title }]} />
        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A]">{title}</h1>
          <p className="text-brand-muted text-sm">{description}</p>
        </div>
      </div>
      {actions && <div className="flex items-center justify-end gap-2 mt-3">{actions}</div>}
    </div>
  )
}
