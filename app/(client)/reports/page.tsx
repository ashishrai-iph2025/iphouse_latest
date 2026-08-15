'use client'

// Reports, for a client login.
//
// The SAME component staff use, in scoped mode: one company's numbers, with the
// client chosen by the mapping IP House set rather than by a slicer. A second
// copy for clients would drift from the staff one within a release, and the
// difference between them is genuinely only "who picks the client, and what may
// be said about the warehouse when something is wrong".
//
// The access control is server-side, not here: /api/reports/* forces the
// warehouse client from the session for any login that is not staff, and refuses
// the request without the Reports module grant. See
// go-server/handlers/reportclientmap.go.

import ReportsPage from '@/app/admin/reports/page'

export default function ClientReportsPage() {
  return <ReportsPage scoped />
}
