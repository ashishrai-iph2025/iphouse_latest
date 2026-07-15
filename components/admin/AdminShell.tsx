'use client'

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { usePathname } from '@/lib/router'
import { signOut, useSession } from '@/lib/auth-client'
import { LoadingProvider } from '@/lib/LoadingContext'
import { ThemeProvider, useTheme } from '@/lib/ThemeContext'
import { ThemeCustomizerProvider } from '@/lib/ThemeCustomizerContext'
import ThemeCustomizer from '@/components/ui/ThemeCustomizer'
import ClientAccessSearch from './ClientAccessSearch'

type NavItem = { label: string; href: string; icon: string }
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
      { href: '/admin/users',         icon: '👥', label: 'Users'         },
      { href: '/admin/registrations', icon: '📝', label: 'Registrations' },
      { href: '/admin/registration-requests', icon: '📋', label: 'Reg. Requests' },
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
    <ThemeCustomizerProvider>
      <LoadingProvider>
        <AdminShellInner>{children}</AdminShellInner>
      </LoadingProvider>
    </ThemeCustomizerProvider>
    </ThemeProvider>
  )
}

function AdminShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { data: session } = useSession()
  const user = session?.user as any
  const isSuperAdmin = user?.role === 2
  const [sidebarOpen,     setSidebarOpen]     = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [hovered,          setHovered]          = useState(false)
  const { theme, toggle } = useTheme()
  const isDark = theme === 'dark'

  // When collapsed, hovering the rail temporarily expands it (as an overlay, so
  // page content never shifts); it collapses again when the pointer leaves.
  const effectiveCollapsed = sidebarCollapsed && !hovered

  const visibleGroups = navGroups.filter(g => !g.superAdminOnly || isSuperAdmin)

  return (
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

          {/* User + sign-out */}
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
              {navGroups.flatMap(g => g.items).find(i => pathname === i.href || pathname.startsWith(i.href + '/'))?.label ?? 'Admin'}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-3.5">
            {/* Client access search — real-time client lookup + view-as-client */}
            <ClientAccessSearch />
            {/* Dark / Light toggle — plain icon, no box */}
            <button
              onClick={toggle}
              title={isDark ? 'Switch to Light mode' : 'Switch to Dark mode'}
              className="text-xl leading-none cursor-pointer bg-transparent border-0 p-0 hover:opacity-70 transition-opacity"
            >
              {isDark ? '☀️' : '🌙'}
            </button>
            {/* User info — plain text, no box */}
            <div className="hidden sm:flex flex-col items-end leading-tight">
              <span className="text-sm font-bold text-[#14254A] dark:text-white truncate max-w-[160px]">{user?.name || (isSuperAdmin ? 'Super Admin' : 'Admin')}</span>
              <span className="text-[11px] font-medium text-gray-400 dark:text-white/50">{isSuperAdmin ? 'Super Admin' : 'Admin'}</span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto bg-[#eef2f7] dark:bg-[#0f1f3d]">
          {children}
        </main>
      </div>

      <ThemeCustomizer />
    </div>
  )
}
