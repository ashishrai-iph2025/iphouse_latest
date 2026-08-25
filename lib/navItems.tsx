'use client'

import React from 'react'

// The nav is DATA-DRIVEN by the module_permission table. Each item is keyed by
// its `pageName` — the STABLE identifier from /admin/modules that does not change
// when an admin renames a module. The displayed label comes from the LIVE module
// name (see navLabel), so renaming a module in /admin/modules relabels the nav
// automatically without the item disappearing. `label` here is only the fallback
// used before the live module list has loaded (or if the row is missing).
//
// href, icon, path-matching and dropdown structure stay in code because the
// pageName (e.g. "PerformQC", "SearchCaseList") is a permission identifier, not
// a URL, so it cannot drive routing directly.

export interface AllowedModule {
  moduleName: string
  pageName:   string
  navOrder?:  number
  // Admin-configured dropdown children for this module (from /admin/modules).
  dropdown?:  { label: string; href: string }[]
}

// The dropdown children to render for a nav item: the admin-configured children
// for its module (keyed by pageName) if any exist, else the code-defined
// fallback (item.dropdown). Children inherit the parent's pageName so their
// visibility follows the parent module's grant.
export function dropdownFor(item: NavItem, allowed: AllowedModule[] | null): NavDropdownItem[] {
  const mod = allowed?.find(a => a.pageName === item.pageName)
  if (mod?.dropdown && mod.dropdown.length > 0) {
    return mod.dropdown.map(d => ({ label: d.label, href: d.href, pageName: item.pageName }))
  }
  return item.dropdown ?? []
}

/**
 * The first page this login may actually open, in the order the nav shows them.
 *
 * Every sign-in path sends clients to /dashboard, which was safe while Dashboard
 * was a floor every login had. It is an ordinary grant now, so that landing can
 * be a page the account was never given — and the fix has to live somewhere that
 * also catches a bookmark or a back-button, not just the redirect after login.
 *
 * Returns null when nothing is granted. That is a real state — an account set up
 * but not yet given any module — and it needs to be SAID, not redirected around,
 * which is why this reports it rather than picking a fallback of its own.
 */
export function firstAllowedHref(allowed: AllowedModule[] | null): string | null {
  if (!allowed || allowed.length === 0) return null
  const ordered = [...NAV_ITEMS].sort(
    (a, b) => navOrderOf(a, allowed) - navOrderOf(b, allowed))
  return ordered.find(it => isItemAllowed(it, allowed))?.href ?? null
}

// The client-nav order for an item's module (from module_permission.nav_order),
// keyed by pageName. 0 (the default) preserves code order via a stable sort.
export function navOrderOf(item: NavItem, allowed: AllowedModule[] | null): number {
  return allowed?.find(a => a.pageName === item.pageName)?.navOrder ?? 0
}

export interface NavDropdownItem {
  label:    string   // fallback label
  href:     string
  pageName: string   // join key into module_permission
}

export interface NavItem {
  label:     string  // fallback label
  href:      string
  matches?:  string[]
  pageName:  string  // join key into module_permission
  dropdown?: NavDropdownItem[]
  icon:      React.ReactNode
}

export const NAV_ITEMS: NavItem[] = [
  {
    label:    'Dashboard',
    href:     '/dashboard',
    pageName: 'dashboard',
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
        <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
      </svg>
    ),
  },
  {
    label:    'War Room',
    href:     '/war-room',
    pageName: 'war-room',
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <path strokeLinecap="round" strokeLinejoin="round" d="m9 12 2 2 4-4"/>
      </svg>
    ),
  },
  {
    // pageName matches the module seeded by ensureReportsModule
    // (go-server/handlers/reportclientmap.go), so the grant, the nav and the API
    // gate all key on the same identifier.
    label:    'Reports',
    href:     '/reports',
    pageName: 'Reports',
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>
      </svg>
    ),
  },
  {
    label:    'Infringements Approval',
    href:     '/pending-count',
    matches:  ['/pending-count', '/qc-action'],
    pageName: 'PerformQC',
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
    ),
  },
  {
    label:    'Submit URLs for Take-down',
    href:     '/upload-url',
    pageName: 'UploadURL',
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
      </svg>
    ),
  },
  {
    label:    'Search Case List',
    href:     '/infringement',
    matches:  ['/infringement', '/search'],
    pageName: 'SearchCaseList',
    // Dropdown children are DB-driven (nav_dropdown_items), managed from
    // /admin/modules. Seeded on first run with Infringement Search + Search by URL.
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
    ),
  },
  {
    label:    'IP Tracking Details',
    href:     '/ip-tracking',
    pageName: 'IPTrackingDetails',
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/>
      </svg>
    ),
  },
  {
    label:    'Download Request',
    href:     '/download-request',
    pageName: 'DownloadRequest',
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
      </svg>
    ),
  },
  {
    label:    'Data Sharing',
    href:     '/data-sharing',
    pageName: 'data-sharing',
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 12V3m0 0L8 7m4-4l4 4"/>
      </svg>
    ),
  },
]

// Live display label for a nav/dropdown item: the current module name from the
// module list (matched by the stable pageName), falling back to the item's own
// label before the list loads or if no matching module row exists.
export function navLabel(item: NavItem | NavDropdownItem, allowed: AllowedModule[] | null): string {
  const m = allowed?.find(a => a.pageName === item.pageName)
  return m?.moduleName || item.label
}

// Whether an item is granted: its pageName is present in the allowed module set.
// Fails closed while the set is unknown (null) so ungranted items never flash.
export function isItemAllowed(item: NavItem | NavDropdownItem, allowed: AllowedModule[] | null): boolean {
  if (allowed === null) return false
  return allowed.some(a => a.pageName === item.pageName)
}

// Pages reachable via a module-permission grant alone, with NO Markscan API
// dependency — nav visibility and the route guard must not gate these behind
// having API credentials. Data Sharing (S3 upload/link) is one such page.
// Client Admin — company user administration.
//
// Deliberately kept OUT of NAV_ITEMS: every entry there is gated by
// module_permission, which is granted per client company, whereas the Client
// Admin grant is per person (dcp_user_login.is_client_admin). Driving it from
// module_permission would show the page to every user of a company as soon as
// one of them was made Client Admin.
//
// It is rendered in the profile dropdown (ClientNavbar), under Switch Account,
// rather than as a nav tab — the grant is personal, like My Profile, and the
// dropdown is the one piece of chrome present in every nav layout. The page and
// its API re-check the grant server-side regardless.
export const CLIENT_ADMIN_NAV_ITEM: NavItem = {
  label:    'Access Details',
  href:     '/account-access',
  pageName: 'account-access',
  icon: (
    <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 0 0-5.36-1.86M17 20H7m10 0v-2c0-.66-.13-1.3-.36-1.86m0 0A5 5 0 0 0 7.36 16.14M7 20H2v-2a3 3 0 0 1 5.36-1.86M7 20v-2c0-.66.13-1.3.36-1.86" />
      <circle cx="12" cy="7" r="3" /><circle cx="19" cy="9" r="2" /><circle cx="5" cy="9" r="2" />
    </svg>
  ),
}

export const API_INDEPENDENT_PAGES = ['data-sharing']

export function isApiIndependentItem(item: NavItem): boolean {
  return API_INDEPENDENT_PAGES.includes(item.pageName)
}

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  const paths = item.matches ?? [item.href]
  return paths.some(p => pathname === p || pathname.startsWith(p + '/'))
}

export const SIDEBAR_LAYOUTS = [
  'default', 'mini', 'detached', 'two-column', 'without-header',
  'overlay', 'menu-aside', 'modern', 'rtl',
]

export function isSidebarLayout(navLayout: string): boolean {
  return SIDEBAR_LAYOUTS.includes(navLayout)
}
