'use client'

import { useState } from 'react'
import { usePathname } from '@/lib/router'
import ClientNavbar from './ClientNavbar'
import ImpersonationBanner from './ImpersonationBanner'
import SideNav from './SideNav'
import IdleTimeoutGuard from '@/components/shared/IdleTimeoutGuard'
import Footer from '@/components/ui/Footer'
import PasswordExpiryBanner from '@/components/shared/PasswordExpiryBanner'
import { MasterDataProvider } from '@/lib/masterDataContext'
import { ModuleAccessProvider } from '@/lib/moduleAccess'
import { ThemeProvider } from '@/lib/ThemeContext'
import { ThemeCustomizerProvider, useCustomizer } from '@/lib/ThemeCustomizerContext'

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
const FULL_WIDTH_PAGES = ['/dashboard', '/war-room', '/reports', '/report-vod']

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const fullWidth = FULL_WIDTH_PAGES.includes(pathname)
  const { sidebarEnabled, headerVisible } = useCustomizer()

  /* headerVisible only means anything with the sidebar on — with it off, the
     nav tabs themselves live in the header (ClientNavbar's row 2), so hiding
     it there would take the only way to navigate with it. */
  const showHeader = !sidebarEnabled || headerVisible

  // The sidebar drawer's open/closed state on mobile, where SideNav is
  // normally off-screen entirely — lifted here rather than owned by either
  // component, since the trigger for it lives in ClientNavbar (the header's
  // own hamburger, repurposed) while the drawer itself lives in SideNav, and
  // they're siblings with no other way to talk to each other.
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  if (sidebarEnabled) {
    /* The sidebar spans the full height on the far left; the header sits in
       the column to its RIGHT, not above it — it used to run the page's full
       width, above the sidebar, which put its logo directly over the
       sidebar's own logo one row down. Mirrors AdminShell.tsx's own
       sidebar/right-column split. ImpersonationBanner stays outside that
       split, full width, since it is a page-level alert rather than
       something the header/sidebar distinction applies to. */
    return (
      <div className="flex flex-col layout-container" style={{ height: '100dvh' }}>
        <ImpersonationBanner />
        <div className="flex flex-1 min-h-0 overflow-hidden flex-row">
          <SideNav mobileOpen={mobileNavOpen} onOpenChange={setMobileNavOpen} />

          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            {showHeader && (
              <ClientNavbar sidebarMobileOpen={mobileNavOpen} onSidebarMobileOpenChange={setMobileNavOpen} />
            )}

            {/* Directly under the header and outside the scrolling body, for
                the same reason as the admin shell: it must not scroll away. */}
            <PasswordExpiryBanner />

            <main className="flex-1 flex flex-col overflow-auto bg-[#eef2f7] dark:bg-[#0f1f3d]">
              {fullWidth ? (
                children
              ) : (
                <div className="w-full mx-auto px-3 sm:px-5 lg:px-8 py-4 sm:py-6 max-w-screen-2xl">
                  {children}
                </div>
              )}
              <Footer />
            </main>
          </div>
        </div>
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
          <div className="w-full mx-auto px-3 sm:px-5 lg:px-10 py-4 sm:py-6 max-w-screen-2xl">
            {children}
          </div>
        )}
        <Footer />
      </main>
    </div>
  )
}

export default function ClientShell({ children }: Props) {
  return (
    <ThemeProvider>
    <ThemeCustomizerProvider context="client">
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
