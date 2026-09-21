'use client'

/*
The icon cluster + identity/sign-out that sits at the right of an admin top
header — client-access search, notifications, fullscreen, theme customizer,
name/role, sign out.

Admin's equivalent of components/client/HeaderControls.tsx, and for the same
reason: AdminShell now supports both a sidebar layout and a horizontal one,
and either can have its header turned off. In sidebar mode the sidebar's own
footer already carries a collapse-aware identity+Sign-Out block of its own
(AdminShell.tsx) — turning the header off there only needs somewhere for the
ICON row to go, so `showIdentity` stays false for that one call site rather
than this component growing a second, non-collapse-aware copy of the same
block. In horizontal mode there is no sidebar at all, so the header's own row
1 is the only place either half lives — that call passes both true.
*/

import { useSession, signOut } from '@/lib/auth-client'
import ClientAccessSearch from './ClientAccessSearch'
import NotificationBell from '@/components/shared/NotificationBell'
import FullscreenToggle from '@/components/shared/FullscreenToggle'
import ThemeCustomizer from '@/components/ui/ThemeCustomizer'

export default function AdminHeaderControls({ layout, tone, showIcons = true, showIdentity = true }: {
  /** 'row' — a header's own icon row. 'column' — stacked in the sidebar's
      own footer, used only while the header itself is hidden (icons only —
      see the file header for why `showIdentity` is never true there). */
  layout: 'row' | 'column'
  tone: 'light' | 'dark'
  showIcons?: boolean
  showIdentity?: boolean
}) {
  const { data: session } = useSession()
  const user = session?.user as any
  const isSuperAdmin = user?.role === 2
  const isColumn = layout === 'column'

  return (
    <div className={isColumn ? 'flex items-center flex-wrap justify-center gap-1 w-full' : 'flex items-center gap-2.5'}>
      {showIcons && (
        <>
          {/* Real-time client lookup + view-as-client. Always the compact
              icon trigger in a narrow column — the wide pill's own `md:`
              breakpoint keys off viewport width, not this container's, and
              would overflow a sidebar rail regardless of how wide the
              screen actually is. */}
          <ClientAccessSearch compact={isColumn} tone={tone} />
          {/* Portal activity — staff see every client's events. */}
          <NotificationBell variant="admin" tone={tone} align={isColumn ? 'up' : 'down'} />
          {/* The same full-screen control as the client bar: staff read
              these reports too, off the same wide grid. */}
          <FullscreenToggle tone={tone} />
          {/* Small anchored popover — see ThemeCustomizer.tsx. */}
          <ThemeCustomizer context="admin" tone={tone} align={isColumn ? 'up' : 'down'} />
        </>
      )}

      {!isColumn && showIdentity && (
        <>
          <div className="hidden sm:flex flex-col items-end leading-tight">
            <span className="text-sm font-bold text-[#14254A] dark:text-white truncate max-w-[160px]">
              {user?.name || (isSuperAdmin ? 'Super Admin' : 'Admin')}
            </span>
            <span className="text-[11px] font-medium text-gray-400 dark:text-white/50">
              {isSuperAdmin ? 'Super Admin' : 'Admin'}
            </span>
          </div>
          <button onClick={() => signOut({ callbackUrl: '/login' })} title="Sign Out"
            className="p-2 rounded-lg text-gray-500 dark:text-white/60 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
            <svg width="17" height="17" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
            </svg>
          </button>
        </>
      )}
    </div>
  )
}
