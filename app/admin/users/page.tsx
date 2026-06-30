'use client'

import { Link } from 'react-router-dom'
import UsersTableClient from '@/components/admin/UsersTableClient'
import AdminPageHeader from '@/components/admin/AdminPageHeader'

export default function UsersPage() {
  return (
    <div className="p-6 fade-in">
      <AdminPageHeader
        breadcrumb={[{ label: 'Users' }]}
        title="User Management"
        description="User login accounts"
        actions={
          <Link to="/admin/users/add"
            className="px-5 py-2.5 rounded-xl font-semibold text-white text-sm hover:opacity-90"
            style={{ background: '#14254A' }}>
            + Add User
          </Link>
        }
      />
      <UsersTableClient />
    </div>
  )
}
