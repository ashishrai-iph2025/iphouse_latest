'use client'

import { usePathname } from '@/lib/router'
import ClientNavbar from './ClientNavbar'
import ImpersonationBanner from './ImpersonationBanner'
import SideNav from './SideNav'
import IdleTimeoutGuard from '@/components/shared/IdleTimeoutGuard'
import Footer from '@/components/ui/Footer'
import PasswordExpiryBanner from '@/components/shared/PasswordExpiryBanner'
import ThemeCustomizer from '@/components/ui/ThemeCustomizer'
import { MasterDataProvider } from '@/lib/masterDataContext'
import { ModuleAccessProvider } from '@/lib/moduleAccess'
import { ThemeProvider } from '@/lib/ThemeContext'
import { ThemeCustomizerProvider, useCustomizer } from '@/lib/ThemeCustomizerContext'
import { isSidebarLayout } from '@/lib/navItems'

interface Props {
  children: React.ReactNode
}

/*
Pages that manage their own width.

Most client pages are a column of content and read better inside a measure —
which is what the `maxW` wrapper below gives them. These are not: they are
dashboards with their own rails and grids, and the wrapper leaves a band of
empty page on either side while their charts squeeze into the middle. They set
their own padding, so bypassing the wrapper costs nothing.
*/
/* /welcome is NOT here, and was.

   It opted out on the reasoning that a calendar is a dashboard rather than a
   column of text — true of the calendar, and it took the whole page with it. On
   a wide monitor the panels then ran the full width of the glass with the
   figures strung out across it, which is the band-of-empty-page problem above
   in reverse: not too little room, too much. Inside the measure it reads as one
   page instead of a wall. */
const FULL_WIDTH_PAGES = ['/dashboard', '/war-room', '/reports']

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const fullWidth = FULL_WIDTH_PAGES.includes(pathname)
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

        {/* Directly under the header and outside the scrolling body, for the
            same reason as the admin shell: it must not scroll away. */}
        <PasswordExpiryBanner />

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

  /*
  Horizontal layout (default).

  The shell is exactly one viewport tall and `main` is the thing that scrolls —
  the same arrangement the sidebar layout above and the admin shell already use.
  It was `minHeight: 100dvh` with an `overflow-hidden` main, which scrolled the
  BODY instead, and that quietly broke every `position: sticky` inside a page:
  `overflow-hidden` establishes a scroll container, sticky travels within the
  nearest one, and that container never scrolled. The reports rails were pinned
  to a box that moved with the page, so they scrolled away like ordinary
  content. Nothing was wrong with the rails.

  The footer moves inside `main` for the same reason it already lives there in
  the sidebar layout: it belongs at the end of the content, not pinned as a bar
  the page can never scroll past.
  */
  return (
    <div className="flex flex-col bg-[#eef2f7] dark:bg-[#0f1f3d] layout-container" style={{ height: '100dvh' }}>
      <ImpersonationBanner />
      <ClientNavbar />
      <main className="flex-1 flex flex-col min-h-0 overflow-y-auto">
        {fullWidth ? (
          children
        ) : (
          <div className={`w-full mx-auto px-3 sm:px-5 lg:px-10 py-4 sm:py-6 ${maxW}`}>
            {children}
          </div>
        )}
        <Footer />
      </main>
      <ThemeCustomizer />
    </div>
  )
}

export default function ClientShell({ children }: Props) {
  return (
    <ThemeProvider>
    <ThemeCustomizerProvider>
    <MasterDataProvider>
    <ModuleAccessProvider>
      <IdleTimeoutGuard />
      <Shell>{children}</Shell>
    </ModuleAccessProvider>
    </MasterDataProvider>
    </ThemeCustomizerProvider>
    </ThemeProvider>
  )
}
