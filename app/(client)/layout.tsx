import ClientShell from '@/components/client/ClientShell'

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  // Auth & role redirects are handled by middleware.ts + JWT cookie.
  return <ClientShell>{children}</ClientShell>
}
