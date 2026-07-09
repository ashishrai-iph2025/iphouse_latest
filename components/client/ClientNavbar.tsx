'use client'

import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { usePathname } from '@/lib/router'
import { useSession, signOut } from '@/lib/auth-client'
import { useTheme } from '@/lib/ThemeContext'
import { useCustomizer, NAVBAR_HEX } from '@/lib/ThemeCustomizerContext'
import { NAV_ITEMS, isNavItemActive, isSidebarLayout, type NavItem, type NavDropdownItem } from '@/lib/navItems'
import { useModuleAccess } from '@/lib/moduleAccess'

function isActive(item: NavItem, pathname: string): boolean {
  return isNavItemActive(item, pathname)
}

interface Notification { notificationId: number; message: string; is_read: number }

export default function ClientNavbar() {
  const pathname = usePathname()
  const { data: session } = useSession()
  const user = session?.user as any

  const [mobileOpen,   setMobileOpen]   = useState(false)
  const [profileOpen,  setProfileOpen]  = useState(false)
  const [notifOpen,    setNotifOpen]    = useState(false)
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)

  const [notifications, setNotifications] = useState<Notification[]>([])

  // Nav permissions + account count — shared, sessionStorage-cached (see
  // lib/moduleAccess) so a refresh paints the granted nav on the first frame.
  const { allowedModuleNames, accountCount } = useModuleAccess()

  const { theme, toggle } = useTheme()
  const { navbarStyle, navLayout, sidebarSize } = useCustomizer()

  const sidebarMode = isSidebarLayout(navLayout)

  const navBg = navLayout === 'transparent' ? 'transparent' : (navbarStyle === 'default' ? '' : (NAVBAR_HEX[navbarStyle] ?? '#14254A'))
  const navIsColored = navbarStyle !== 'default' || navLayout === 'transparent'
  const navText = navIsColored ? 'text-white/90' : 'text-gray-500 dark:text-white/60'
  const navActiveText = navIsColored ? 'text-white font-semibold' : 'text-[#FC934C] dark:text-[#FC934C] font-semibold'
  const navHover = navIsColored ? 'hover:text-white hover:bg-white/10' : 'hover:text-[#FC934C] dark:hover:text-[#FC934C]'

  // nav layout derived flags (only apply when NOT in sidebar mode)
  const hideHeader   = !sidebarMode && navLayout === 'without-header'
  const iconsOnly    = !sidebarMode && (sidebarSize === 'compact' || navLayout === 'mini')
  const hoverLabels  = !sidebarMode && sidebarSize === 'hover'
  const profileRef  = useRef<HTMLDivElement>(null)
  const notifRef    = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const unread = notifications.filter(n => !n.is_read).length

  const hasRealApiToken = !!(user?.apiAccess)

  function moduleAllowed(names: string[]): boolean {
    // Fail closed while permissions are unknown (first-ever load, no cache):
    // briefly showing only Dashboard and then expanding beats flashing
    // modules the user was never granted.
    if (allowedModuleNames === null) return false
    return names.some(n => allowedModuleNames.includes(n))
  }

  // Dashboard is always visible regardless of token or module permissions.
  // All other items require a valid API token + module permission.
  function isNavAllowed(item: NavItem): boolean {
    if (item.href === '/dashboard') return true
    if (!hasRealApiToken) return false
    return moduleAllowed(item.moduleNames)
  }

  // Filter dropdown sub-items to only those the user has access to
  function allowedDropdownItems(item: NavItem): NavDropdownItem[] {
    if (!item.dropdown) return []
    return item.dropdown.filter(sub => moduleAllowed(sub.moduleNames))
  }

  useEffect(() => {
    fetch('/api/notifications', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.success) setNotifications(d.notifications || []) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (profileRef.current  && !profileRef.current.contains(e.target as Node))  setProfileOpen(false)
      if (notifRef.current    && !notifRef.current.contains(e.target as Node))     setNotifOpen(false)
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node))  setOpenDropdown(null)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  // close mobile menu on route change
  useEffect(() => { setMobileOpen(false) }, [pathname])

  async function markAllRead() {
    await fetch('/api/notifications', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    setNotifications(n => n.map(x => ({ ...x, is_read: 1 })))
  }

  return (
    <header className="sticky top-0 z-40 shadow-sm" style={{ background: navBg || undefined }}
      data-navbar={navbarStyle}>

      {/* ── Row 1: Logo + Right controls ── */}
      {!hideHeader && (
      <div className={`border-b ${navIsColored ? 'border-white/10' : 'border-gray-100 dark:border-white/10'} ${!navBg ? 'bg-white dark:bg-[#14254A]' : ''}`}
        style={navBg ? { background: navBg } : undefined}>
        <div className="w-full px-6 h-16 flex items-center justify-between">

          {/* Logo */}
          <Link to="/dashboard" className="flex items-center flex-shrink-0">
            <img src="/newlogo.png" alt="IP House" height={30} width={130} className="object-contain"
              style={{ filter: navIsColored || theme === 'dark' ? 'brightness(0) invert(1)' : 'none' }} />
          </Link>

          {/* Right: notifications + profile + mobile hamburger */}
          <div className="flex items-center gap-1">

            {/* Dark/Light toggle */}
            <button onClick={toggle} className={`p-2 rounded-lg transition-colors ${navIsColored ? 'text-white hover:bg-white/10' : 'text-[#14254A] dark:text-white hover:bg-gray-100 dark:hover:bg-white/10'}`} title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}>
              {theme === 'dark' ? (
                <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 7a5 5 0 100 10A5 5 0 0012 7z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/>
                </svg>
              ) : (
                <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/>
                </svg>
              )}
            </button>

            {/* Profile */}
            <div ref={profileRef} className="relative">
              <button onClick={() => setProfileOpen(o => !o)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-gray-50 dark:hover:bg-white/10 transition-colors">
                <div className="hidden sm:flex flex-col items-end max-w-[160px] md:max-w-[220px]">
                  <span className={`text-sm font-bold leading-tight truncate w-full text-right ${navIsColored ? 'text-white' : 'text-[#14254A] dark:text-white'}`}>
                    {(user as any)?.loginFirstName
                      ? `${(user as any).loginFirstName} ${(user as any).loginLastName ?? ''}`.trim()
                      : (user as any)?.loginUsername ?? user?.name}
                  </span>
                  <span className={`text-[10px] font-semibold leading-tight truncate w-full text-right ${navIsColored ? 'text-white/70' : 'text-[#FC934C] dark:text-[#FC934C]'}`}>
                    {user?.clientName || user?.loginUsername}
                  </span>
                </div>
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" className="text-[#14254A] dark:text-white flex-shrink-0">
                  <path d="M19 9l-7 7-7-7"/>
                </svg>
              </button>
              {profileOpen && (
                <div className="absolute right-0 mt-2 w-60 max-w-[calc(100vw-24px)] bg-white rounded-2xl shadow-xl border border-gray-100 py-2 z-50">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <p className="font-bold text-sm text-[#14254A] truncate">
                      {(user as any)?.loginFirstName
                        ? `${(user as any).loginFirstName} ${(user as any).loginLastName ?? ''}`.trim()
                        : (user as any)?.loginUsername ?? user?.name}
                    </p>
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

            {/* Mobile hamburger */}
            <button onClick={() => setMobileOpen(o => !o)}
              className="md:hidden p-2 rounded-lg hover:bg-gray-50 text-gray-500 transition-colors">
              {mobileOpen ? (
                <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path d="M6 18L18 6M6 6l12 12"/>
                </svg>
              ) : (
                <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path d="M4 6h16M4 12h16M4 18h16"/>
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      )}

      {/* ── Row 2: Navigation tabs (horizontal layouts only) ── */}
      {!sidebarMode && <div className={`hidden md:block border-b ${navIsColored ? 'border-white/10' : 'border-gray-200 dark:border-white/10'}`}
        style={navBg ? { background: navBg } : { background: undefined }}>
        <div className={!navBg ? 'bg-white dark:bg-[#14254A]' : ''}>
        <div className="w-full px-6">
          <nav className="flex items-center gap-0" ref={dropdownRef}>
            {NAV_ITEMS.filter(isNavAllowed).map(item => {
              const active = isActive(item, pathname)
              const iconCls = active ? (navIsColored ? 'text-white' : 'text-[#FC934C]') : (navIsColored ? 'text-white/60' : 'text-gray-400')

              if (item.dropdown) {
                const open    = openDropdown === item.label
                const subItems = allowedDropdownItems(item)
                if (subItems.length === 0) return null
                return (
                  <div key={item.label} className="relative group">
                    <button
                      onClick={() => setOpenDropdown(open ? null : item.label)}
                      title={iconsOnly ? item.label : undefined}
                      className={`relative flex items-center gap-1.5 px-4 py-4 text-sm font-semibold transition-all rounded-sm
                        ${active ? navActiveText : `${navText} ${navHover}`}`}
                    >
                      <span className={iconCls}>{item.icon}</span>
                      {iconsOnly ? null : hoverLabels ? (
                        <span className="max-w-0 overflow-hidden group-hover:max-w-[120px] transition-all duration-200 whitespace-nowrap">
                          {item.label}
                        </span>
                      ) : item.label}
                      {!iconsOnly && (
                        <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                          className={`transition-transform ${open ? 'rotate-180' : ''}`}>
                          <path d="M19 9l-7 7-7-7"/>
                        </svg>
                      )}
                    </button>
                    {open && (
                      <div className="absolute top-full mt-0 left-0 w-52 bg-white rounded-xl shadow-lg border border-gray-100 py-1.5 z-50">
                        {subItems.map(sub => (
                          <Link key={sub.href} to={sub.href}
                            onClick={() => setOpenDropdown(null)}
                            className={`block px-4 py-2.5 text-sm transition-colors
                              ${pathname === sub.href || pathname.startsWith(sub.href + '/')
                                ? 'text-[#14254A] font-semibold bg-[#14254A]/5'
                                : 'text-gray-600 hover:text-[#14254A] hover:bg-gray-50'}`}>
                            {sub.label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )
              }

              return (
                <Link key={item.href} to={item.href}
                  title={iconsOnly ? item.label : undefined}
                  className={`relative flex items-center gap-1.5 px-4 py-4 text-sm font-semibold transition-all rounded-sm group
                    ${active ? navActiveText : `${navText} ${navHover}`}`}
                >
                  <span className={iconCls}>{item.icon}</span>
                  {iconsOnly ? null : hoverLabels ? (
                    <span className="max-w-0 overflow-hidden group-hover:max-w-[120px] transition-all duration-200 whitespace-nowrap">
                      {item.label}
                    </span>
                  ) : item.label}
                </Link>
              )
            })}
          </nav>
        </div>
        </div>
      </div>}

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="md:hidden border-t border-gray-100 dark:border-white/10 bg-white dark:bg-[#14254A] px-4 py-3 space-y-1 max-h-[calc(100vh-120px)] overflow-y-auto">
          {NAV_ITEMS.filter(isNavAllowed).map(item => {
            const active = isActive(item, pathname)
            if (item.dropdown) {
              const subItems = allowedDropdownItems(item)
              if (subItems.length === 0) return null
              return (
                <div key={item.label}>
                  <p className={`flex items-center gap-2 px-3 py-2.5 text-sm font-semibold rounded-lg
                    ${active ? 'text-[#14254A] bg-[#14254A]/8' : 'text-gray-500'}`}>
                    {item.icon} {item.label}
                  </p>
                  <div className="ml-6 space-y-0.5">
                    {subItems.map(sub => (
                      <Link key={sub.href} to={sub.href}
                        className={`block px-3 py-2 text-sm rounded-lg transition-colors
                          ${pathname === sub.href ? 'text-[#14254A] font-semibold bg-[#14254A]/5' : 'text-gray-500 hover:text-[#14254A] hover:bg-gray-50'}`}>
                        {sub.label}
                      </Link>
                    ))}
                  </div>
                </div>
              )
            }
            return (
              <Link key={item.href} to={item.href}
                className={`flex items-center gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors
                  ${active ? 'text-[#14254A] bg-[#14254A]/8 font-semibold' : 'text-gray-500 hover:text-[#14254A] hover:bg-gray-50'}`}>
                {item.icon} {item.label}
              </Link>
            )
          })}
        </div>
      )}
    </header>
  )
}

