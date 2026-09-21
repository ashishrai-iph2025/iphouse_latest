'use client'

// Reports, for a client login.
//
// The SAME component staff use, in scoped mode: one company's numbers, with the
// client chosen by the mapping IP House set rather than by a slicer. A second
// copy for clients would drift from the staff one within a release, and the
// difference between them is genuinely only "who picks the client, and what may
// be said about the warehouse when something is wrong".
//
// The access control is server-side first: /api/reports/* forces the warehouse
// client from the session for any login that is not staff, and refuses the
// request without the Reports module grant. See
// go-server/handlers/reportclientmap.go.
//
// This page ALSO checks the grant itself, mirroring war-room/page.tsx — not
// because the router-level guard (ClientModuleGuard, src/App.tsx) misses this
// route, but because ReportsPage has its own fail-open window: it used to
// render the full report shell — sidebar, rails, a report actively running —
// for the whole round trip before its own /api/reports/scope check answered,
// regardless of how the page was reached. Matched by pageName, not by
// display name: module names are admin-renamable on /admin/modules, and
// "Reports" has genuinely been renamed in at least one deployment, so
// checking against the literal string would refuse a login that holds the
// grant under its renamed label.

import ReportsPage from '@/app/admin/reports/page'
import { Navigate } from '@/lib/router'
import { useModuleAccess } from '@/lib/moduleAccess'

export default function ClientReportsPage() {
  const { allowedModules } = useModuleAccess()

  // Fail closed while permissions are unknown (null = fetch in flight).
  if (allowedModules === null) return null
  if (!allowedModules.some(m => m.pageName === 'Reports')) {
    return <Navigate to="/dashboard" replace />
  }
  return <ReportsPage scoped />
}
