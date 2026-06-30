'use client'

import React from 'react'

export interface NavDropdownItem {
  label:       string
  href:        string
  moduleNames: string[]
}

export interface NavItem {
  label:       string
  href:        string
  matches?:    string[]
  moduleNames: string[]
  dropdown?:   NavDropdownItem[]
  icon:        React.ReactNode
}

export const NAV_ITEMS: NavItem[] = [
  {
    label:       'Dashboard',
    href:        '/dashboard',
    moduleNames: ['Dashboard'],
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
        <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
      </svg>
    ),
  },
  {
    label:       'Approvals',
    href:        '/pending-count',
    matches:     ['/pending-count', '/qc-action'],
    moduleNames: ['Infringements Approval'],
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
    ),
  },
  {
    label:       'Submit Take-downs',
    href:        '/upload-url',
    moduleNames: ['Submit URLs for Take-down'],
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
      </svg>
    ),
  },
  {
    label:       'Find Infringements',
    href:        '/infringement',
    matches:     ['/infringement', '/search'],
    moduleNames: ['Search Case List'],
    dropdown: [
      { label: 'Infringement Search', href: '/infringement', moduleNames: ['Search Case List'] },
      { label: 'Search by URL',       href: '/search',       moduleNames: ['Search Case List'] },
    ],
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
    ),
  },
  {
    label:       'IP Tracking',
    href:        '/ip-tracking',
    moduleNames: ['IP Tracking Details'],
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/>
      </svg>
    ),
  },
  {
    label:       'Reporting',
    href:        '/download-request',
    moduleNames: ['Download Request'],
    icon: (
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
      </svg>
    ),
  },
]

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
