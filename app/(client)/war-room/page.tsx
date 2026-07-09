'use client'

import WarRoomPage from '@/components/shared/WarRoomPage'
import { Navigate } from '@/lib/router'
import { useModuleAccess } from '@/lib/moduleAccess'

// Client-side mirror of the /api/warroom gate: only logins granted the
// "WAR ROOM" module on /admin/module-permissions may open this page.
// Admins and super admins use /admin/war-room instead.
export default function ClientWarRoomPage() {
  const { allowedModuleNames } = useModuleAccess()

  // Fail closed while permissions are unknown (null = fetch in flight).
  if (allowedModuleNames === null) return null
  if (!allowedModuleNames.some(n => n.toUpperCase() === 'WAR ROOM')) {
    return <Navigate to="/dashboard" replace />
  }
  return <WarRoomPage area="Dashboard" />
}
