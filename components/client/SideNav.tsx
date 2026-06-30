'use client'

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { usePathname } from '@/lib/router'
import { useSession } from '@/lib/auth-client'
import { useCustomizer, SIDEBAR_HEX } from '@/lib/ThemeCustomizerContext'
import { NAV_ITEMS, isNavItemActive, type NavItem, type NavDropdownItem } from '@/lib/navItems'

// Sidebar bg now driven by CSS variable --sidebar-bg (set by ThemeCustomizerContext)


export default function SideNav() {
  const pathname = usePathname()
  const { data: session } = useSession()
  const user = session?.user as any
  const { navLayout, sidebarSize, sidebarColor } = useCustomizer()

  const [openDropdown, setOpenDropdown] = useState<string | null>(null)
  const [allowedModuleNames, setAllowedModuleNames] = useState<string[] | null>(null)
  const [hovered, setHovered] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)

  useEffect(() => {
    fetch('/api/user/nav', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.success) setAllowedModuleNames(d.allowedModules.map((m: { moduleName: string }) => m.moduleName))
      })
      .catch(() => {})
  }, [])

  // close dropdown on route change
  useEffect(() => { setOpenDropdown(null); setOverlayOpen(false) }, [pathname])

  // apiAccess is set on the session when an IP House API token was generated for
  // the selected account (apiToken itself is no longer exposed to the client).
  const hasRealApiToken = !!(user?.apiAccess)

  function moduleAllowed(names: string[]): boolean {
    if (allowedModuleNames === null) return true
    return names.some(n => allowedModuleNames.includes(n))
  }
  function isNavAllowed(item: NavItem): boolean {
    if (item.href === '/dashboard') return true
    if (!hasRealApiToken) return false
    return moduleAllowed(item.moduleNames)
  }
  function allowedDropdownItems(item: NavItem): NavDropdownItem[] {
    if (!item.dropdown) return []
    return item.dropdown.filter(sub => moduleAllowed(sub.moduleNames))
  }

  const bg = SIDEBAR_HEX[sidebarColor] ?? '#14254A'
  const isOverlay = navLayout === 'overlay'
  const isTwoCol  = navLayout === 'two-column'
  const isModern  = navLayout === 'modern'
  const isDetach  = navLayout === 'detached'

  // Icon-only: mini layout or compact sidebar size
  const iconsOnly      = navLayout === 'mini' || sidebarSize === 'compact'
  // Hover expand: sidebarSize === 'hover'
  const isHoverExpand  = sidebarSize === 'hover'
  // Show labels based on mode
  const showLabels = iconsOnly ? false : isHoverExpand ? hovered : true

  const w = (iconsOnly || (isHoverExpand && !hovered)) ? 'w-16' : isTwoCol ? 'w-60' : 'w-60'

  /* ── Overlay mode: trigger button + backdrop ── */
  if (isOverlay) {
    return (
      <>
        {/* Trigger button */}
        <button onClick={() => setOverlayOpen(true)}
          className="fixed left-0 top-1/2 -translate-y-1/2 z-40 w-6 flex items-center justify-center h-16 rounded-r-lg shadow-lg text-white"
          style={{ background: bg }}>
          <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </button>

        {/* Backdrop */}
        {overlayOpen && (
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setOverlayOpen(false)} />
        )}

        {/* Overlay panel */}
        <aside className={`fixed top-0 left-0 h-full w-60 z-50 flex flex-col transition-transform duration-300 shadow-2xl ${overlayOpen ? 'translate-x-0' : '-translate-x-full'}`}
          style={{ background: bg }}>
          <SidebarLogo showLabels />
          <SideNavInner bg={bg} showLabels pathname={pathname} navLayout={navLayout}
            isModern={false} isDetach={false} isTwoCol={false}
            openDropdown={openDropdown} setOpenDropdown={setOpenDropdown}
            items={NAV_ITEMS.filter(isNavAllowed)}
            allowedDropdownItems={allowedDropdownItems} />
        </aside>
      </>
    )
  }

  /* ── Normal sidebar ── */
  return (
    <aside
      onMouseEnter={() => isHoverExpand && setHovered(true)}
      onMouseLeave={() => isHoverExpand && setHovered(false)}
      className={`
        hidden md:flex flex-col flex-shrink-0 transition-all duration-300 overflow-hidden
        ${w}
        ${isDetach ? 'rounded-2xl my-3 ml-3 shadow-xl' : ''}
        ${isModern ? 'rounded-2xl my-3 ml-3 shadow-lg' : ''}
      `}
      style={{ background: bg }}>
      <SidebarLogo showLabels={showLabels} />
      <SideNavInner bg={bg} showLabels={showLabels} pathname={pathname} navLayout={navLayout}
        isModern={isModern} isDetach={isDetach} isTwoCol={isTwoCol}
        openDropdown={openDropdown} setOpenDropdown={setOpenDropdown}
        items={NAV_ITEMS.filter(isNavAllowed)}
        allowedDropdownItems={allowedDropdownItems} />
    </aside>
  )
}

function SidebarLogo({ showLabels }: { showLabels: boolean }) {
  return (
    <Link to="/dashboard"
      className="flex items-center gap-3 px-4 h-16 flex-shrink-0 border-b border-white/10">
      <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center">
        <img src="/newlogo.png" alt="IP House" width={32} height={32}
          className="object-contain"
          style={{ filter: 'brightness(0) invert(1)' }} />
      </div>
      {showLabels && (
        <span className="text-white font-bold text-sm tracking-wide whitespace-nowrap">IP House</span>
      )}
    </Link>
  )
}

interface InnerProps {
  bg: string
  showLabels: boolean
  pathname: string
  navLayout: string
  isModern: boolean
  isDetach: boolean
  isTwoCol: boolean
  openDropdown: string | null
  setOpenDropdown: (v: string | null) => void
  items: NavItem[]
  allowedDropdownItems: (item: NavItem) => NavDropdownItem[]
}

function SideNavInner({ bg, showLabels, pathname, navLayout, isModern, isTwoCol,
  openDropdown, setOpenDropdown, items, allowedDropdownItems }: InnerProps) {

  const itemBase = `flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all text-sm font-medium w-full`
  const activeStyle = 'bg-white/15 text-white font-semibold'
  const inactiveStyle = 'text-white/70 hover:bg-white/10 hover:text-white'

  if (isTwoCol) {
    return (
      <div className="flex flex-1 overflow-hidden">
        {/* Icon column */}
        <div className="w-14 flex flex-col items-center pt-4 gap-1 border-r border-white/10">
          {items.map(item => {
            const active = isNavItemActive(item, pathname)
            return (
              <button key={item.href} title={item.label}
                onClick={() => setOpenDropdown(openDropdown === item.label ? null : item.label)}
                className={`w-10 h-10 flex items-center justify-center rounded-xl transition-all ${active ? 'bg-white/20 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}>
                {item.icon}
              </button>
            )
          })}
        </div>
        {/* Label column */}
        <div className="flex-1 pt-4 overflow-y-auto">
          {items.map(item => {
            const active = isNavItemActive(item, pathname)
            if (item.dropdown) {
              const subs = allowedDropdownItems(item)
              return (
                <div key={item.label}>
                  <button onClick={() => setOpenDropdown(openDropdown === item.label ? null : item.label)}
                    className={`${itemBase} ${active ? activeStyle : inactiveStyle} justify-between`}>
                    <span className="truncate">{item.label}</span>
                    <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                      className={`flex-shrink-0 transition-transform ${openDropdown === item.label ? 'rotate-90' : ''}`}>
                      <path d="M9 18l6-6-6-6"/>
                    </svg>
                  </button>
                  {openDropdown === item.label && (
                    <div className="ml-3">
                      {subs.map(sub => (
                        <Link key={sub.href} to={sub.href}
                          className={`block px-4 py-2 text-xs rounded-lg transition-colors ${
                            pathname === sub.href ? 'text-white font-semibold bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/5'
                          }`}>
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
                className={`${itemBase} ${active ? activeStyle : inactiveStyle}`}>
                <span className="truncate">{item.label}</span>
              </Link>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <nav className="flex flex-col flex-1 pt-4 pb-4 overflow-y-auto gap-0.5 px-2">
      {items.map(item => {
        const active = isNavItemActive(item, pathname)

        if (item.dropdown) {
          const subs = allowedDropdownItems(item)
          if (subs.length === 0) return null
          const isOpen = openDropdown === item.label
          return (
            <div key={item.label}>
              <button onClick={() => setOpenDropdown(isOpen ? null : item.label)}
                title={!showLabels ? item.label : undefined}
                className={`${itemBase} ${active ? activeStyle : inactiveStyle} ${!showLabels ? 'justify-center px-0' : 'justify-between'}`}>
                <span className={`flex items-center gap-3 ${!showLabels ? 'justify-center' : ''}`}>
                  <span className="flex-shrink-0">{item.icon}</span>
                  {showLabels && <span className="truncate">{item.label}</span>}
                </span>
                {showLabels && (
                  <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                    className={`flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}>
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                )}
              </button>
              {isOpen && showLabels && (
                <div className="ml-4 mt-0.5 mb-1 border-l border-white/15 pl-3 space-y-0.5">
                  {subs.map(sub => (
                    <Link key={sub.href} to={sub.href}
                      className={`block px-3 py-2 text-xs rounded-lg transition-colors ${
                        pathname === sub.href ? 'text-white font-semibold bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/5'
                      }`}>
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
            title={!showLabels ? item.label : undefined}
            className={`${itemBase} ${active ? activeStyle : inactiveStyle} ${!showLabels ? 'justify-center px-0' : ''}`}>
            <span className="flex-shrink-0">{item.icon}</span>
            {showLabels && <span className="truncate">{item.label}</span>}
          </Link>
        )
      })}
    </nav>
  )
}

