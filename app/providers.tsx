'use client'

import { SessionProvider } from '@/lib/auth-client'

export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>
}
