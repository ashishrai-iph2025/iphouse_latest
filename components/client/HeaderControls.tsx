'use client'

/*
The icon cluster + profile menu that sits at the right of the top header —
notifications, fullscreen, country, theme customizer, dark/light, profile.

Pulled out of ClientNavbar.tsx so SideNav.tsx can show the same controls in
its own footer when the header is turned off (see ThemeCustomizer's "Show
header" toggle) — with the header gone, this is the only place left to reach
them, and duplicating ~100 lines of profile-dropdown markup in two files
would have drifted the moment one of them changed.
*/

import { useRef, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useSession, signOut } from '@/lib/auth-client'
import { useModuleAccess } from '@/lib/moduleAccess'
import { CLIENT_ADMIN_NAV_ITEM } from '@/lib/navItems'
import NotificationBell from '@/components/shared/NotificationBell'
import FullscreenToggle from '@/components/shared/FullscreenToggle'
import CountryPicker from '@/components/shared/CountryPicker'
import ThemeCustomizer from '@/components/ui/ThemeCustomizer'

export default function HeaderControls({ layout, tone, showIcons = true, showProfile = true }: {
  /** 'row' — the top header's own icon row. 'column' — stacked in the
      sidebar's footer, used only while the header itself is hidden. */
  layout: 'row' | 'column'
  tone: 'light' | 'dark'
  /** SideNav.tsx calls this component twice in column layout, on/off for
      each half: the icon row only while the header itself is hidden (it's
      the only place left to reach them), and the profile block always
      (Profile / Switch Account / Access Details / Sign Out have nowhere
      else to live once the header is off, so it can't be conditional on
      that the way the icon row is). */
  showIcons?: boolean
  showProfile?: boolean
}) {
  const { data: session } = useSession()
  const user = session?.user as any
  const { accountCount } = useModuleAccess()
  const [profileOpen, setProfileOpen] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)

  const isColumn = layout === 'column'
  const showAccessDetails = !!user?.clientAdmin

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  const name = (user as any)?.loginFirstName
    ? `${(user as any).loginFirstName} ${(user as any).loginLastName ?? ''}`.trim()
    : (user as any)?.loginUsername ?? user?.name

  return (
    <div className={isColumn ? 'flex flex-col items-stretch gap-2 w-full' : 'flex items-center gap-1'}>
      {showIcons && (
      <div className={isColumn ? 'flex items-center flex-wrap justify-center gap-1' : 'flex items-center gap-1'}>
        {/* Notifications — the server scopes the feed: a Client Admin sees
            their whole company, everyone else sees their own actions. */}
        <NotificationBell variant="client" tone={tone} align={isColumn ? 'up' : 'down'} />

        {/* Hand the whole display to the page — about the window, not
            about reports, so it lives here rather than on any one page. */}
        <FullscreenToggle tone={tone} />

        {/* Which clock the portal reads UTC data in — see lib/timezone.tsx */}
        <CountryPicker tone={tone} />

        {/* Colour mode lives inside this popover now (see ThemeCustomizer.tsx)
            — a separate Dark/Light button next to it was the same setting
            twice. */}
        <ThemeCustomizer context="client" tone={tone} align={isColumn ? 'up' : 'down'} />
      </div>
      )}

      {/* Profile */}
      {showProfile && (
      <div ref={profileRef} className={`relative ${isColumn ? 'w-full' : ''}`}>
        <button onClick={() => setProfileOpen(o => !o)}
          className={`flex items-center gap-1.5 rounded-xl transition-colors ${
            isColumn
              ? 'w-full px-2.5 py-2 hover:bg-white/10'
              : 'px-2.5 py-1.5 hover:bg-gray-50 dark:hover:bg-white/10'}`}>
          <div className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 ${
            isColumn ? '' : 'hidden'}`}
            style={{ background: 'linear-gradient(135deg,#FFC82B,#FC934C)', color: '#14254A' }}>
            {(name || 'A').charAt(0).toUpperCase()}
          </div>
          <div className={`flex flex-col ${isColumn ? 'items-start flex-1 min-w-0' : 'hidden sm:flex items-end max-w-[160px] md:max-w-[220px]'}`}>
            <span className={`text-sm font-bold leading-tight truncate w-full ${isColumn ? 'text-left text-white' : 'text-right text-[#14254A] dark:text-white'}`}>
              {name}
            </span>
            <span className={`text-[10px] font-semibold leading-tight truncate w-full ${isColumn ? 'text-left text-white/60' : 'text-right text-[#FC934C] dark:text-[#FC934C]'}`}>
              {user?.clientName || user?.loginUsername}
            </span>
          </div>
          <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"
            className={`flex-shrink-0 ${isColumn ? 'text-white/60 ml-auto' : 'text-[#14254A] dark:text-white'}`}>
            <path d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
        {profileOpen && (
          <div className={`absolute w-60 max-w-[calc(100vw-24px)] bg-white rounded-2xl shadow-xl border border-gray-100 py-2 z-50 ${
            isColumn ? 'bottom-full mb-2 left-0' : 'right-0 mt-2'}`}>
            <div className="px-4 py-3 border-b border-gray-100">
              <p className="font-bold text-sm text-[#14254A] truncate">{name}</p>
              {user?.clientName && (
                <p className="text-[11px] font-semibold text-[#FC934C] truncate mt-0.5">{user.clientName}</p>
              )}
              <p className="text-[11px] text-gray-400 truncate mt-0.5">{(user as any)?.loginUsername}</p>
            </div>
            <Link to="/profile" onClick={() => setProfileOpen(false)}
              className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
              <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
              My Profile
            </Link>
            {accountCount > 1 && (
              <Link to="/switch-account" onClick={() => setProfileOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/>
                </svg>
                Switch Account
              </Link>
            )}
            {showAccessDetails && (
              <Link to={CLIENT_ADMIN_NAV_ITEM.href} onClick={() => setProfileOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                {CLIENT_ADMIN_NAV_ITEM.icon}
                {CLIENT_ADMIN_NAV_ITEM.label}
              </Link>
            )}
            <button onClick={() => signOut({ callbackUrl: '/login' })}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">
              <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
              </svg>
              Sign Out
            </button>
          </div>
        )}
      </div>
      )}
    </div>
  )
}
