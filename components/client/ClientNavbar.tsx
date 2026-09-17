'use client'

import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { usePathname } from '@/lib/router'
import { useSession } from '@/lib/auth-client'
import { useCustomizer } from '@/lib/ThemeCustomizerContext'
import { NAV_ITEMS, isNavItemActive, isApiIndependentItem, isItemAllowed, navLabel, navOrderOf, dropdownFor, type NavItem, type NavDropdownItem } from '@/lib/navItems'
import { useModuleAccess } from '@/lib/moduleAccess'
import HeaderControls from './HeaderControls'

/* A dropdown parent's own `matches` list is hardcoded in lib/navItems.tsx and
   can't know about admin-configured dropdown children with hrefs outside it
   (see the dropdown-children comment there) — so a page reached only through
   one of those wouldn't highlight its parent tab. Checked against item.dropdown
   directly (already the resolved live list by the time this is called — see
   the .map in ClientNavbar below), not the further permission-filtered one:
   being ON one of these pages already means it was reachable. */
function isActive(item: NavItem, pathname: string): boolean {
  if (isNavItemActive(item, pathname)) return true
  return !!item.dropdown?.some(sub => pathname === sub.href || pathname.startsWith(sub.href + '/'))
}

export default function ClientNavbar({ sidebarMobileOpen, onSidebarMobileOpenChange }: {
  /** SideNav.tsx's own mobile drawer, lifted to ClientShell.tsx since these
      are siblings — when both are given (sidebar layout), the hamburger
      below opens THAT drawer instead of the flat menu it opens otherwise.
      Undefined in horizontal layout, where there is no sidebar to open. */
  sidebarMobileOpen?: boolean
  onSidebarMobileOpenChange?: (v: boolean) => void
} = {}) {
  const pathname = usePathname()
  const { data: session } = useSession()
  const user = session?.user as any

  // The flat, inline dropdown this hamburger has always opened — still used
  // in horizontal layout, where there is no sidebar drawer to open instead.
  const [flatMenuOpen, setFlatMenuOpen] = useState(false)
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)


  // Nav permissions — shared, sessionStorage-cached (see lib/moduleAccess)
  // so a refresh paints the granted nav on the first frame.
  const { allowedModules, apiAccess: liveApiAccess } = useModuleAccess()

  const { sidebarEnabled } = useCustomizer()

  // Whether this render actually has a sidebar drawer to hand the hamburger
  // off to — sidebarEnabled alone isn't enough, since a page could theoretically
  // render this without the props (it can't today, but the props are optional
  // for the horizontal branch, and this keeps the two facts checked together
  // rather than trusting one to imply the other).
  const opensSidebarDrawer = sidebarEnabled && onSidebarMobileOpenChange !== undefined
  const hamburgerOpen = opensSidebarDrawer ? !!sidebarMobileOpen : flatMenuOpen
  function toggleHamburger() {
    if (opensSidebarDrawer) onSidebarMobileOpenChange!(!sidebarMobileOpen)
    else setFlatMenuOpen(o => !o)
  }

  const dropdownRef = useRef<HTMLDivElement>(null)

  // Live token availability from /api/user/nav wins; the session's apiAccess
  // claim (frozen at select-login) is only the fallback.
  const hasRealApiToken = liveApiAccess ?? !!(user?.apiAccess)

  /* Dashboard needs no API token, but it is NOT unconditional — it is exempt
     from the TOKEN check only, and still has to be in allowedModules to show.

     API-independent modules (e.g. Data Sharing) need only the grant. All other
     items require a valid API token + module permission. Matching is by the
     stable pageName (see isItemAllowed), so renaming a module never hides it. */
  function isNavAllowed(item: NavItem): boolean {
    if (item.pageName === 'dashboard') return isItemAllowed(item, allowedModules)
    if (!hasRealApiToken && !isApiIndependentItem(item)) return false
    return isItemAllowed(item, allowedModules)
  }

  // Filter dropdown sub-items to only those the user has access to
  function allowedDropdownItems(item: NavItem): NavDropdownItem[] {
    if (!item.dropdown) return []
    return item.dropdown.filter(sub => isItemAllowed(sub, allowedModules))
  }

  // Resolve each top-level item's display label from the live module name
  // (keyed by pageName), so renaming a module in /admin/modules relabels the
  // nav. Dropdown children keep their own page-level labels. Ordered by the
  // module's nav_order (set on /admin/modules); stable sort keeps code order
  // for the default (all-zero) case.
  const navItems = NAV_ITEMS
    .map(it => {
      const dd = dropdownFor(it, allowedModules)
      return { ...it, label: navLabel(it, allowedModules), dropdown: dd.length ? dd : undefined }
    })
    .sort((a, b) => navOrderOf(a, allowedModules) - navOrderOf(b, allowedModules))

  const visibleItems: NavItem[] = navItems.filter(isNavAllowed)

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node))  setOpenDropdown(null)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  // close the flat menu on route change — the sidebar drawer closes itself,
  // in SideNav.tsx's own pathname effect.
  useEffect(() => { setFlatMenuOpen(false) }, [pathname])

  return (
    <header className="z-40 shadow-sm sticky top-0">

      {/* ── Row 1: Logo + Right controls ── */}
      <div className="border-b border-gray-100 dark:border-white/10 bg-white dark:bg-[#14254A]">
        <div className="w-full px-6 h-16 flex items-center">

          {/* Logo. When the sidebar is on, IT carries the logo (SideNav.tsx)
              and this one steps aside from md upward — two logos stacked one
              above the other otherwise. Kept for mobile even then: the
              sidebar itself is off-screen there until its drawer is opened
              (this hamburger, or SideNav's own fallback trigger), so below
              md it's the only logo actually on screen by default. */}
          <Link to="/dashboard" className={`items-center flex-shrink-0 ${sidebarEnabled ? 'flex md:hidden' : 'flex'}`}>
            <img src="/newlogo.png" alt="IP House" height={30} width={130} className="object-contain dark:brightness-0 dark:invert" />
          </Link>

          {/* Right: notifications + theme + profile + mobile hamburger */}
          <div className="flex items-center gap-1 ml-auto">
            <HeaderControls layout="row" tone="dark" />

            {/* Mobile hamburger — opens SideNav's own drawer in sidebar
                layout (see opensSidebarDrawer above), or this header's own
                flat menu otherwise. */}
            <button onClick={toggleHamburger}
              className="md:hidden p-2 rounded-lg hover:bg-gray-50 text-gray-500 transition-colors">
              {hamburgerOpen ? (
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

      {/* ── Row 2: Navigation tabs (horizontal layout only) ── */}
      {!sidebarEnabled && <div className="hidden md:block border-b border-gray-200 dark:border-white/10 bg-white dark:bg-[#14254A]">
        <div className="w-full px-6">
          <nav className="flex items-center gap-0" ref={dropdownRef}>
            {visibleItems.map(item => {
              const active = isActive(item, pathname)
              const iconCls = active ? 'text-[#FC934C]' : 'text-gray-400'

              if (item.dropdown) {
                const open    = openDropdown === item.label
                const subItems = allowedDropdownItems(item)
                if (subItems.length === 0) return null
                return (
                  <div key={item.label} className="relative group">
                    <button
                      onClick={() => setOpenDropdown(open ? null : item.label)}
                      className={`relative flex items-center gap-1.5 px-4 py-4 text-sm font-semibold transition-all rounded-sm
                        ${active ? 'text-[#FC934C] dark:text-[#FC934C] font-semibold' : 'text-gray-500 dark:text-white/60 hover:text-[#FC934C] dark:hover:text-[#FC934C]'}`}
                    >
                      <span className={iconCls}>{item.icon}</span>
                      {item.label}
                      <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                        className={`transition-transform ${open ? 'rotate-180' : ''}`}>
                        <path d="M19 9l-7 7-7-7"/>
                      </svg>
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
                  className={`relative flex items-center gap-1.5 px-4 py-4 text-sm font-semibold transition-all rounded-sm group
                    ${active ? 'text-[#FC934C] dark:text-[#FC934C] font-semibold' : 'text-gray-500 dark:text-white/60 hover:text-[#FC934C] dark:hover:text-[#FC934C]'}`}
                >
                  <span className={iconCls}>{item.icon}</span>
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </div>
      </div>}

      {/* Flat mobile menu — horizontal layout only; sidebar layout opens
          SideNav's own drawer instead (see opensSidebarDrawer above), which
          already carries this same nav list. */}
      {!opensSidebarDrawer && flatMenuOpen && (
        <div className="md:hidden border-t border-gray-100 dark:border-white/10 bg-white dark:bg-[#14254A] px-4 py-3 space-y-1 max-h-[calc(100vh-120px)] overflow-y-auto">
          {visibleItems.map(item => {
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

