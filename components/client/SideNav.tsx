'use client'

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { usePathname } from '@/lib/router'
import { useSession } from '@/lib/auth-client'
import { useCustomizer } from '@/lib/ThemeCustomizerContext'
import { NAV_ITEMS, isNavItemActive, isApiIndependentItem, isItemAllowed, navLabel, navOrderOf, dropdownFor, type NavItem, type NavDropdownItem } from '@/lib/navItems'
import { useModuleAccess } from '@/lib/moduleAccess'
import HeaderControls from './HeaderControls'

const SIDEBAR_BG = '#14254A'

export default function SideNav({ mobileOpen, onOpenChange }: {
  /** The mobile drawer's open state, lifted to ClientShell.tsx — its trigger
      is normally ClientNavbar's own hamburger (see there), but this sidebar
      is otherwise completely off-screen below md, so it also carries its own
      fallback trigger for when the header itself is turned off and that
      hamburger doesn't exist to click. */
  mobileOpen: boolean
  onOpenChange: (v: boolean) => void
}) {
  const pathname = usePathname()
  const { data: session } = useSession()
  const user = session?.user as any
  const { headerVisible } = useCustomizer()
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)
  /* Pinned collapsed/expanded state, plus a hover-driven temporary expand —
     the same two-state mechanic AdminShell.tsx already uses for its own
     rail: `collapsed` reserves the narrow width in the page's layout so
     hovering never reflows the content beside it, while the rail itself
     floats wider OVER that content while the pointer is over it. Neither is
     persisted — AdminShell's own toggle isn't either, so a reader who
     collapses one and not the other would find that surprising. Desktop-only
     concepts — mobileOpen forces both off below, since a mobile drawer is
     either fully open or fully closed, never a docked icon-only rail. */
  const [collapsed, setCollapsed] = useState(false)
  const [hovered, setHovered] = useState(false)
  const effectiveCollapsed = collapsed && !hovered && !mobileOpen

  // Shared, sessionStorage-cached nav permissions (see lib/moduleAccess) — a
  // refresh paints the granted nav on the first frame instead of flashing all.
  const { allowedModules, apiAccess: liveApiAccess } = useModuleAccess()

  // Prefer the LIVE token availability reported by /api/user/nav — it heals
  // when a transient Markscan failure at select-login resolves. The session's
  // apiAccess claim (frozen at login) is only the fallback, same as
  // ClientNavbar.tsx.
  const hasRealApiToken = liveApiAccess ?? !!(user?.apiAccess)

  /* Dashboard is exempt from the TOKEN check and from nothing else — see
     ClientNavbar.tsx for the full reasoning, kept in step with it here. */
  function isNavAllowed(item: NavItem): boolean {
    if (item.pageName === 'dashboard') return isItemAllowed(item, allowedModules)
    if (!hasRealApiToken && !isApiIndependentItem(item)) return false
    return isItemAllowed(item, allowedModules)
  }
  function allowedDropdownItems(item: NavItem): NavDropdownItem[] {
    if (!item.dropdown) return []
    return item.dropdown.filter(sub => isItemAllowed(sub, allowedModules))
  }

  const navItems = NAV_ITEMS
    .map(it => {
      const dd = dropdownFor(it, allowedModules)
      return { ...it, label: navLabel(it, allowedModules), dropdown: dd.length ? dd : undefined }
    })
    .sort((a, b) => navOrderOf(a, allowedModules) - navOrderOf(b, allowedModules))

  const visibleItems: NavItem[] = navItems.filter(isNavAllowed)

  /* Whether the open page lives inside this item's dropdown — checked
     against the ACTUAL resolved sub-items (dropdownFor, above), not a
     hardcoded list, since dropdown children are admin-configured per
     lib/navItems.tsx and their hrefs aren't knowable in advance. Used both to
     highlight the parent and to decide which dropdown auto-opens below. */
  function holdsActivePage(item: NavItem): boolean {
    return !!item.dropdown?.some(sub => pathname === sub.href || pathname.startsWith(sub.href + '/'))
  }

  /* Keeps the dropdown holding the open page expanded — so a reload or a
     direct link lands with it visibly open, not collapsed with nothing
     showing where you are — and collapses any other. Also closes the mobile
     drawer, the same way a tap on any nav link should. Runs only when the
     route itself changes, not on every render, so manually collapsing the
     open one back down (while staying on that page) is respected instead of
     being forced open again on the next re-render. */
  useEffect(() => {
    setOpenDropdown(navItems.find(holdsActivePage)?.label ?? null)
    onOpenChange(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  // No items-center/items-start here — that's decided per use, expanded vs
  // collapsed (see below), and having both in one className string leaves it
  // to Tailwind's internal ordering which one wins.
  const itemBase = 'flex gap-3 px-4 py-2.5 rounded-xl transition-all text-sm font-medium w-full'
  // Same gradient pill AdminShell.tsx uses for its own active item — this
  // sidebar is meant to read as the same design, not a translucent variant.
  const activeStyle = 'bg-gradient-to-r from-[#FFC82B] to-[#FC934C] text-[#14254A] font-semibold'
  const inactiveStyle = 'text-white/70 hover:bg-white/10 hover:text-white'

  return (
    <>
      {/* Fallback mobile trigger. ClientNavbar's own hamburger already opens
          this same drawer whenever the header is on — this one exists only
          for when it's off (ThemeCustomizer's "Show header"), since nothing
          else on the page would be left to open it with. */}
      {!headerVisible && (
        <button onClick={() => onOpenChange(true)} title="Open menu"
          className="md:hidden fixed top-3 left-3 z-40 w-9 h-9 rounded-lg flex items-center justify-center text-white shadow-lg"
          style={{ background: SIDEBAR_BG }}>
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16"/>
          </svg>
        </button>
      )}

      {/* Mobile backdrop — this sidebar floats OVER the page below md rather
          than sharing width with it, so something has to darken the rest and
          give a tap-outside way to close it. */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-40" onClick={() => onOpenChange(false)} />
      )}

      <aside className={`fixed md:relative inset-y-0 left-0 z-50 flex-shrink-0 w-60 transition-transform md:transition-[width] duration-300
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0
        ${collapsed ? 'md:w-16' : 'md:w-60'}`}>
        <div
          onMouseEnter={() => { if (collapsed) setHovered(true) }}
          onMouseLeave={() => setHovered(false)}
          /* No overflow-hidden here, unlike AdminShell's otherwise-identical
             rail — its footer never hosts a popover. This one does once the
             header is off (HeaderControls' theme/country/notification
             dropdowns), and an ancestor with overflow-hidden would clip any
             of them the moment they tried to render outside this box. */
          className={`flex flex-col h-full w-60 transition-[width] duration-300
            ${effectiveCollapsed ? 'md:w-16' : 'md:w-60'}
            ${collapsed && hovered ? 'md:absolute md:inset-y-0 md:left-0 md:z-50 md:shadow-2xl' : 'relative'}`}
          style={{ background: SIDEBAR_BG }}>

          {/* Logo + collapse toggle. /newlogo.png is a single wide icon+wordmark
              lockup — the same file ClientNavbar and AdminShell.tsx both render
              at this same natural ratio (height 28, width auto) — not a square
              icon on its own. Squaring it off here (an earlier pass did, at
              28×28) crushed the "IP HOUSE" wordmark down to an illegible
              sliver; there's no separate hardcoded text label needed once the
              image renders at its own proportions. The collapse toggle itself
              is desktop-only — a mobile drawer has no docked, icon-only state
              for it to switch to (see effectiveCollapsed above). */}
          <div className="flex items-center gap-2 px-3 h-16 flex-shrink-0 border-b border-white/10">
            {!effectiveCollapsed && (
              <Link to="/dashboard" className="flex items-center flex-1 min-w-0 pl-1 overflow-hidden">
                <img src="/newlogo.png" alt="IP House" width={120} height={28}
                  className="h-7 w-auto flex-shrink-0 brightness-0 invert" />
              </Link>
            )}
            <button onClick={() => setCollapsed(c => !c)}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={`hidden md:flex items-center justify-center w-7 h-7 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-all flex-shrink-0 ${effectiveCollapsed ? 'mx-auto' : ''}`}>
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                className={`transition-transform ${collapsed ? 'rotate-180' : ''}`}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
              </svg>
            </button>
            {/* Mobile close — the collapse toggle above is hidden here, so the
                drawer needs its own way to dismiss besides the backdrop. */}
            <button onClick={() => onOpenChange(false)} title="Close menu"
              className="md:hidden ml-auto flex items-center justify-center w-7 h-7 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-all flex-shrink-0">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>

          <nav className="flex flex-col flex-1 pt-3 pb-4 overflow-y-auto gap-0.5 px-2">
            {visibleItems.map(item => {
              const active = isNavItemActive(item, pathname) || holdsActivePage(item)

              if (item.dropdown) {
                const subs = allowedDropdownItems(item)
                if (subs.length === 0) return null
                const isOpen = !effectiveCollapsed && openDropdown === item.label
                return (
                  <div key={item.label}>
                    <button onClick={() => setOpenDropdown(isOpen ? null : item.label)}
                      title={effectiveCollapsed ? item.label : undefined}
                      className={`${itemBase} ${active ? activeStyle : inactiveStyle} ${effectiveCollapsed ? 'items-center justify-center px-0' : 'items-start justify-between'}`}>
                      <span className={`flex gap-3 ${effectiveCollapsed ? 'justify-center' : 'items-start'}`}>
                        <span className="flex-shrink-0 mt-0.5">{item.icon}</span>
                        {/* Wraps rather than truncating — a label like
                            "Infringements Approval" was cut down to
                            "Infringements Approv…" at this width, and every
                            label here is admin-set text with no length cap. */}
                        {!effectiveCollapsed && <span className="text-left leading-snug">{item.label}</span>}
                      </span>
                      {!effectiveCollapsed && (
                        <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                          className={`flex-shrink-0 mt-1.5 transition-transform ${isOpen ? 'rotate-90' : ''}`}>
                          <path d="M9 18l6-6-6-6"/>
                        </svg>
                      )}
                    </button>
                    {isOpen && (
                      <div className="ml-4 mt-0.5 mb-1 border-l border-white/10 pl-3 space-y-0.5">
                        {subs.map(sub => (
                          <Link key={sub.href} to={sub.href}
                            className={`block px-3 py-2 text-xs rounded-lg transition-colors ${
                              pathname === sub.href ? 'bg-white/15 text-white font-semibold' : 'text-white/70 hover:bg-white/10 hover:text-white'
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
                  title={effectiveCollapsed ? item.label : undefined}
                  className={`${itemBase} ${active ? activeStyle : inactiveStyle} ${effectiveCollapsed ? 'items-center justify-center px-0' : 'items-start'}`}>
                  <span className="flex-shrink-0 mt-0.5">{item.icon}</span>
                  {/* Wraps rather than truncating — see the dropdown branch
                      above for why. */}
                  {!effectiveCollapsed && <span className="text-left leading-snug">{item.label}</span>}
                </Link>
              )
            })}
          </nav>

          {/* With the top header off, this is the only place left to reach
              notifications, fullscreen, country and theme — see
              HeaderControls.tsx. Held back while collapsed-and-not-hovered
              since the icon row needs the full width to read as anything but
              broken; the profile block below stays unconditional either way. */}
          {!headerVisible && !effectiveCollapsed && (
            <div className="flex-shrink-0 border-t border-white/10 px-2 py-3">
              <HeaderControls layout="column" tone="light" showProfile={false} />
            </div>
          )}

          {/* Identity — Profile / Switch Account / Access Details / Sign Out —
              always here, the same way AdminShell.tsx's own rail always
              carries one regardless of whatever the top header shows or hides.
              Not conditional on headerVisible: with the header off, this is
              the only place these live at all. */}
          {!effectiveCollapsed && (
            <div className="flex-shrink-0 border-t border-white/10 px-2 py-3">
              <HeaderControls layout="column" tone="light" showIcons={false} />
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
