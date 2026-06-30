import AdminShell from '@/components/admin/AdminShell'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // Auth & role redirects are handled by middleware.ts + JWT cookie.
  return <AdminShell>{children}</AdminShell>
}
