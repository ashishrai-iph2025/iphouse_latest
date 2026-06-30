'use client'

import { useSession } from '@/lib/auth-client'
import AdminHomeClient from '@/components/admin/AdminHomeClient'

export default function AdminHomePage() {
  const { data: session } = useSession()
  const name  = (session?.user as any)?.name || 'Admin'
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
  const role  = Number((session?.user as any)?.role)
  return <AdminHomeClient name={name} today={today} role={role} />
}
