'use client'

// Client-side "View all notifications". The list itself is scoped by the
// server: a Client Admin sees their whole company, everyone else sees only
// the actions they took.

import NotificationsListPage from '@/components/shared/NotificationsListPage'

export default function ClientNotificationsPage() {
  return <NotificationsListPage basePath="/notifications" />
}
