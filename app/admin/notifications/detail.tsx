'use client'

import NotificationDetailPage from '@/components/shared/NotificationDetailPage'

export default function AdminNotificationDetail({ id }: { id: string }) {
  return (
    <div className="p-6">
      <NotificationDetailPage id={id} basePath="/admin/notifications" />
    </div>
  )
}
