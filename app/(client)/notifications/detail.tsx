'use client'

import NotificationDetailPage from '@/components/shared/NotificationDetailPage'

export default function ClientNotificationDetail({ id }: { id: string }) {
  return <NotificationDetailPage id={id} basePath="/notifications" />
}
