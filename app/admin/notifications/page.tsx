'use client'

// Staff "View all notifications" — every client's activity, scoped server-side.

import NotificationsListPage from '@/components/shared/NotificationsListPage'

export default function AdminNotificationsPage() {
  return (
    <div className="p-6">
      <NotificationsListPage basePath="/admin/notifications" />
    </div>
  )
}
