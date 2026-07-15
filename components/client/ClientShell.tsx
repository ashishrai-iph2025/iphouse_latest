'use client'

import { usePathname } from '@/lib/router'
import ClientNavbar from './ClientNavbar'
import ImpersonationBanner from './ImpersonationBanner'
import SideNav from './SideNav'
import IdleTimeoutGuard from './IdleTimeoutGuard'
import Footer from '@/components/ui/Footer'
import ThemeCustomizer from '@/components/ui/ThemeCustomizer'
import { MasterDataProvider } from '@/lib/masterDataContext'
import { ModuleAccessProvider } from '@/lib/moduleAccess'
import { ThemeProvider } from '@/lib/ThemeContext'
import { ThemeCustomizerProvider, useCustomizer } from '@/lib/ThemeCustomizerContext'
import { LoadingProvider } from '@/lib/LoadingContext'
import { isSidebarLayout } from '@/lib/navItems'

interface Props {
  children: React.ReactNode
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const fullWidth = pathname === '/dashboard' || pathname === '/war-room'
  const { layoutWidth, navLayout, navbarStyle } = useCustomizer()

  const sidebar = isSidebarLayout(navLayout)
  const isRightSide = navLayout === 'menu-aside' || navLayout === 'rtl'
  const noHeader = sidebar && navLayout === 'without-header'

  const maxW = layoutWidth === 'boxed' ? 'max-w-6xl' : 'max-w-screen-2xl'

  if (sidebar) {
    return (
      <div className="flex flex-col layout-container" style={{ minHeight: '100dvh' }}>
        <ImpersonationBanner />
        {/* Top header (logo + profile) – hidden for without-header layout */}
        {!noHeader && <ClientNavbar />}

        {/* Body: sidebar + main content */}
        <div className={`flex flex-1 min-h-0 overflow-hidden ${isRightSide ? 'flex-row-reverse' : 'flex-row'}`}>
          <SideNav />

          <main className="flex-1 flex flex-col overflow-auto bg-[#eef2f7] dark:bg-[#0f1f3d]">
            {fullWidth ? (
              children
            ) : (
              <div className={`w-full mx-auto px-3 sm:px-5 lg:px-8 py-4 sm:py-6 ${maxW}`}>
                {children}
              </div>
            )}
            <Footer />
          </main>
        </div>

        <ThemeCustomizer />
      </div>
    )
  }

  // Horizontal layout (default)
  return (
    <div className="flex flex-col bg-[#eef2f7] dark:bg-[#0f1f3d] layout-container" style={{ minHeight: '100dvh' }}>
      <ImpersonationBanner />
      <ClientNavbar />
      <main className="flex-1 flex flex-col overflow-hidden">
        {fullWidth ? (
          children
        ) : (
          <div className={`w-full mx-auto px-3 sm:px-5 lg:px-10 py-4 sm:py-6 ${maxW}`}>
            {children}
          </div>
        )}
      </main>
      <Footer />
      <ThemeCustomizer />
    </div>
  )
}

export default function ClientShell({ children }: Props) {
  return (
    <ThemeProvider>
    <ThemeCustomizerProvider>
    <LoadingProvider>
    <MasterDataProvider>
    <ModuleAccessProvider>
      <IdleTimeoutGuard />
      <Shell>{children}</Shell>
    </ModuleAccessProvider>
    </MasterDataProvider>
    </LoadingProvider>
    </ThemeCustomizerProvider>
    </ThemeProvider>
  )
}
