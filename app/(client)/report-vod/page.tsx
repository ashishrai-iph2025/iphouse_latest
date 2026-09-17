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
// The access control is server-side, not here: /api/reports/* forces the
// warehouse client from the session for any login that is not staff, and
// refuses the request without the VOD Reports module grant — a SEPARATE
// grant from the plain Reports one, on its own table, so a login can hold
// one without the other. See go-server/handlers/reportclientmap.go
// (mayOpenReport) and dashboardaccess.go (reportsAllowedForClaims,
// vodOnlyPlatformKeys).

import ReportsPage from '@/app/admin/reports/page'

export default function ClientVODReportsPage() {
  return <ReportsPage scoped vod />
}
