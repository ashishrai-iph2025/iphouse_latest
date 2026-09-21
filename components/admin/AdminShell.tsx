'use client'

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { usePathname } from '@/lib/router'
import { signOut, useSession } from '@/lib/auth-client'
import { ThemeProvider } from '@/lib/ThemeContext'
import { ThemeCustomizerProvider, useCustomizer } from '@/lib/ThemeCustomizerContext'
import AdminHeaderControls from './AdminHeaderControls'
import PasswordExpiryBanner from '@/components/shared/PasswordExpiryBanner'
import IdleTimeoutGuard from '@/components/shared/IdleTimeoutGuard'

type NavItem = {
  label: string
  href: string
  icon: string
  /** Kept out of the sidebar, kept in this list.
   *
   *  navGroups is read twice: once to draw the rail, once to name the current
   *  page in the top bar. Deleting an entry to hide the link would also delete
   *  the page's NAME — /admin/users still routes and is still linked to from
   *  Clients and Super Admin, and it would sit there with the header reading
   *  "Admin / Admin". So the route stays described here and only the rail
   *  filters it out. */
  hideInNav?: boolean
}
type NavGroup = { label: string; items: NavItem[]; superAdminOnly?: boolean }

const navGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/admin/home',     icon: '🏠', label: 'Home' },
    ],
  },
  {
    label: 'Client Management',
    items: [
      { href: '/admin/clients',       icon: '🏢', label: 'Clients'       },
      { href: '/admin/users',         icon: '👥', label: 'Users',         hideInNav: true },
      { href: '/admin/registrations', icon: '📝', label: 'Registrations' },
      { href: '/admin/registration-requests', icon: '📋', label: 'Reg. Requests' },
    ],
  },
  {
    label: 'Reporting',
    items: [
      { href: '/admin/reports', icon: '📈', label: 'Reports' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { href: '/admin/configuration', icon: '⚙️', label: 'Configuration' },
    ],
  },
  {
    label: 'Super Admin',
    superAdminOnly: true,
    items: [
      { href: '/admin/super-admin', icon: '👑', label: 'Super Admin Control' },
    ],
  },
]

export default function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
    <ThemeCustomizerProvider context="admin">
      <AdminShellInner>{children}</AdminShellInner>
    </ThemeCustomizerProvider>
    </ThemeProvider>
  )
}

function AdminShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { data: session } = useSession()
  const user = session?.user as any
  const isSuperAdmin = user?.role === 2
  const [sidebarOpen,      setSidebarOpen]      = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [hovered,          setHovered]          = useState(false)
  // The horizontal layout's own mobile menu — a separate flag from
  // `sidebarOpen` above since the two layouts never show at once.
  const [mobileMenuOpen,   setMobileMenuOpen]   = useState(false)

  const { sidebarEnabled, headerVisible } = useCustomizer()
  /* headerVisible only means anything with the sidebar on — with it off, the
     nav tabs live in the header itself, so hiding it would take the only way
     to navigate with it. Same rule as ClientShell.tsx. */
  const showHeader = !sidebarEnabled || headerVisible

  // When collapsed, hovering the rail temporarily expands it (as an overlay, so
  // page content never shifts); it collapses again when the pointer leaves.
  const effectiveCollapsed = sidebarCollapsed && !hovered

  useEffect(() => { setSidebarOpen(false); setMobileMenuOpen(false) }, [pathname])

  /* Two filters, in this order: drop the groups this role may not see, then the
     individual items marked hideInNav — and drop any group left with nothing in
     it, so hiding the last item of a group does not leave its heading behind
     with empty space under it. */
  const visibleGroups = navGroups
    .filter(g => !g.superAdminOnly || isSuperAdmin)
    .map(g => ({ ...g, items: g.items.filter(i => !i.hideInNav) }))
    .filter(g => g.items.length > 0)

  // The same items, flattened — the horizontal layout's own nav row has no
  // concept of groups, the same way ClientNavbar's horizontal tabs don't.
  const flatItems = visibleGroups.flatMap(g => g.items)

  const currentLabel = navGroups.flatMap(g => g.items)
    .find(i => pathname === i.href || pathname.startsWith(i.href + '/'))?.label ?? 'Admin'

  if (sidebarEnabled) return (
    <div className="flex h-screen overflow-hidden bg-[#eef2f7] dark:bg-[#0f1f3d]">

      {/* ── Mobile overlay ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ──
          The <aside> is only the layout slot: on desktop its width follows the
          PERSISTENT collapsed state, so hovering never shifts page content. The
          inner panel expands on hover and, while doing so, floats over the
          content (lg:absolute + shadow) instead of pushing it. */}
      <aside
        onMouseEnter={() => { if (sidebarCollapsed) setHovered(true) }}
        onMouseLeave={() => setHovered(false)}
        className={`fixed lg:relative inset-y-0 left-0 z-40 flex-shrink-0 transition-[width] duration-300
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          ${sidebarCollapsed ? 'w-60 lg:w-14' : 'w-60'}`}
      >
        <div className={`flex flex-col h-full bg-[#14254A] text-white overflow-hidden transition-[width] duration-300
          ${effectiveCollapsed ? 'w-60 lg:w-14' : 'w-60'}
          ${sidebarCollapsed && hovered ? 'lg:absolute lg:inset-y-0 lg:left-0 lg:z-50 lg:shadow-2xl' : 'relative'}`}>

          {/* Logo */}
          <div className="flex items-center gap-3 px-3 h-14 border-b border-white/10 flex-shrink-0">
            {!effectiveCollapsed && (
              <Link to="/admin/home" className="flex-1 min-w-0 pl-2">
                <img src="/newlogo.png" alt="IP House" width={120} height={28} className="h-7 w-auto brightness-0 invert" />
              </Link>
            )}
            <button
              onClick={() => setSidebarOpen(false)}
              className="ml-auto text-white/50 hover:text-white lg:hidden transition-colors flex-shrink-0"
            >
              ✕
            </button>
            <button
              onClick={() => setSidebarCollapsed(c => !c)}
              title={sidebarCollapsed ? 'Pin sidebar open' : 'Collapse sidebar'}
              className={`hidden lg:flex items-center justify-center w-7 h-7 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-all flex-shrink-0 ${effectiveCollapsed ? 'mx-auto' : ''}`}
            >
              {sidebarCollapsed ? '›' : '‹'}
            </button>
          </div>

          {/* Nav */}
          <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-5">
            {visibleGroups.map(group => (
              <div key={group.label}>
                {!effectiveCollapsed && (
                  <p className="text-[9px] uppercase tracking-[0.15em] text-white/30 px-3 mb-2 font-semibold whitespace-nowrap">
                    {group.label}
                  </p>
                )}
                <div className="space-y-0.5">
                  {group.items.map(item => {
                    const active = pathname === item.href || pathname.startsWith(item.href + '/')
                    return (
                      <Link
                        key={item.href}
                        to={item.href}
                        onClick={() => setSidebarOpen(false)}
                        title={effectiveCollapsed ? item.label : undefined}
                        className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all
                          ${effectiveCollapsed ? 'justify-center' : ''}
                          ${active
                            ? 'bg-gradient-to-r from-[#FFC82B] to-[#FC934C] text-[#14254A]'
                            : 'text-white/70 hover:text-white hover:bg-white/10'
                          }`}
                      >
                        <span className="text-base leading-none flex-shrink-0">{item.icon}</span>
                        {!effectiveCollapsed && <span className="truncate">{item.label}</span>}
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* With the top header off, this is the only place left to reach
              client-access search, notifications, fullscreen and theme — see
              AdminHeaderControls.tsx. Held back while collapsed since the
              icon row needs the full width to read as anything but broken;
              the identity block below stays unconditional either way. */}
          {!showHeader && !effectiveCollapsed && (
            <div className="flex-shrink-0 border-t border-white/10 px-2 py-3">
              <AdminHeaderControls layout="column" tone="light" showIdentity={false} />
            </div>
          )}

          {/* User + sign-out — always here regardless of the header, the
              same way SideNav.tsx's own identity block works for the client
              portal. Hand-rolled rather than AdminHeaderControls, which has
              no collapsed-width variant of its own to give this the same
              icon-only treatment at w-14. */}
          <div className="flex-shrink-0 border-t border-white/10 px-2 py-3 space-y-1">
            <div className={`flex items-center gap-2.5 px-3 py-2 ${effectiveCollapsed ? 'justify-center' : ''}`}>
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#FFC82B] to-[#FC934C] flex items-center justify-center font-bold text-[#14254A] text-xs flex-shrink-0">
                {(user?.name || 'A').charAt(0).toUpperCase()}
              </div>
              {!effectiveCollapsed && (
                <>
                  <span className="text-sm text-white/80 truncate">{user?.name}</span>
                  {isSuperAdmin && (
                    <span className="ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-400/30 flex-shrink-0">SA</span>
                  )}
                </>
              )}
            </div>
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              title={effectiveCollapsed ? 'Sign Out' : undefined}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium text-white/60 hover:text-white hover:bg-white/10 transition-all
                ${effectiveCollapsed ? 'justify-center' : ''}`}
            >
              <span>🚪</span>
              {!effectiveCollapsed && 'Sign Out'}
            </button>
          </div>
        </div>
      </aside>

      {/* ── Right column ── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

        {/* Top bar */}
        {showHeader && (
        <header className="flex-shrink-0 bg-white dark:bg-[#14213a] border-b border-gray-200 dark:border-white/10 h-14 flex items-center px-5 gap-3 z-20">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-2 rounded-lg text-gray-500 dark:text-white/60 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors -ml-1"
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-gray-400 dark:text-white/40">Admin</span>
            <span className="text-gray-300 dark:text-white/25">/</span>
            <span className="font-semibold text-[#14254A] dark:text-white truncate">
              {currentLabel}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-3.5">
            <AdminHeaderControls layout="row" tone="dark" />
          </div>
        </header>
        )}

        {/* Above the scroll area, not inside it: a warning that scrolls away
            with the page is a warning most people never see. Renders nothing
            unless the server says this password is inside a warning window. */}
        <PasswordExpiryBanner />

        {/* The session countdown. Mounted here and not only in ClientShell,
            which is where it used to live and the reason /admin pages logged
            people out with no warning at all. Renders nothing until the
            session is a minute from expiring. */}
        <IdleTimeoutGuard />

        <main className="flex-1 overflow-y-auto bg-[#eef2f7] dark:bg-[#0f1f3d]">
          {children}
        </main>
      </div>
    </div>
  )

  /*
  Horizontal layout.

  No sidebar at all — the logo, the icon cluster and the nav tabs all live in
  this one header, the same split ClientNavbar.tsx uses for the client
  portal (row 1: logo + controls, row 2: the tabs). headerVisible has no
  effect here — with no sidebar, the header IS the only way to navigate, so
  showHeader is always true the moment sidebarEnabled is false (see its own
  definition above).
  */
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#eef2f7] dark:bg-[#0f1f3d]">
      <header className="flex-shrink-0 bg-white dark:bg-[#14213a] border-b border-gray-200 dark:border-white/10 z-20">
        <div className="h-14 flex items-center px-5 gap-3">
          <Link to="/admin/home" className="flex items-center flex-shrink-0">
            <img src="/newlogo.png" alt="IP House" width={120} height={28} className="h-7 w-auto dark:brightness-0 dark:invert" />
          </Link>

          <div className="ml-auto flex items-center gap-2.5">
            <AdminHeaderControls layout="row" tone="dark" />
            {/* Mobile hamburger for the nav row below */}
            <button onClick={() => setMobileMenuOpen(o => !o)}
              className="md:hidden p-2 rounded-lg text-gray-500 dark:text-white/60 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
              {mobileMenuOpen ? (
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              ) : (
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16"/>
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Row 2: nav tabs, desktop. Flattened — no group headings, the same
            way the client portal's own horizontal tabs carry no category
            labels either. */}
        <div className="hidden md:block border-t border-gray-100 dark:border-white/10 overflow-x-auto">
          <nav className="flex items-center px-5">
            {flatItems.map(item => {
              const active = pathname === item.href || pathname.startsWith(item.href + '/')
              return (
                <Link key={item.href} to={item.href}
                  className={`flex items-center gap-1.5 px-4 py-3.5 text-sm font-semibold whitespace-nowrap transition-all ${
                    active
                      ? 'text-[#FC934C] dark:text-[#FC934C]'
                      : 'text-gray-500 dark:text-white/60 hover:text-[#FC934C] dark:hover:text-[#FC934C]'
                  }`}>
                  <span className="text-base leading-none">{item.icon}</span>
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </div>

        {/* Mobile nav menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-gray-100 dark:border-white/10 px-4 py-3 space-y-0.5 max-h-[calc(100vh-120px)] overflow-y-auto">
            {flatItems.map(item => {
              const active = pathname === item.href || pathname.startsWith(item.href + '/')
              return (
                <Link key={item.href} to={item.href}
                  className={`flex items-center gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                    active ? 'text-[#14254A] bg-[#14254A]/8 font-semibold' : 'text-gray-500 hover:text-[#14254A] hover:bg-gray-50'
                  }`}>
                  <span>{item.icon}</span>{item.label}
                </Link>
              )
            })}
          </div>
        )}
      </header>

      <PasswordExpiryBanner />
      <IdleTimeoutGuard />

      <main className="flex-1 overflow-y-auto bg-[#eef2f7] dark:bg-[#0f1f3d]">
        {children}
      </main>
    </div>
  )
}
