'use client'

// VOD Reports, for a client login.
//
// The SAME component as /reports, in scoped + VOD mode: one company's
// numbers, narrowed to VOD-category platforms only, with the client chosen by
// the mapping IP House set rather than by a slicer. See ReportsPage's own
// header for why this is one component rather than a second copy — the
// reasoning is identical, and `vod` is independent of `scoped` for the same
// reason `scoped` is independent of everything else it sits beside.
//
// The access control is server-side first: /api/reports/* forces the
// warehouse client from the session for any login that is not staff, and
// refuses the request without the VOD Reports module grant — a SEPARATE
// grant from the plain Reports one, on its own table, so a login can hold
// one without the other. See go-server/handlers/reportclientmap.go
// (mayOpenReport) and dashboardaccess.go (reportsAllowedForClaims,
// vodOnlyPlatformKeys).
//
// This page ALSO checks the grant itself — see reports/page.tsx's own header
// for why (ReportsPage's fail-open window while its /api/reports/scope check
// is in flight) and why pageName rather than display name.

import ReportsPage from '@/app/admin/reports/page'
import { Navigate } from '@/lib/router'
import { useModuleAccess } from '@/lib/moduleAccess'

export default function ClientVODReportsPage() {
  const { allowedModules } = useModuleAccess()

  if (allowedModules === null) return null
  if (!allowedModules.some(m => m.pageName === 'report-vod')) {
    return <Navigate to="/dashboard" replace />
  }
  return <ReportsPage scoped vod />
}
