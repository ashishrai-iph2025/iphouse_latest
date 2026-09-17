'use client'

import { lazy, Suspense, ReactNode, Component, ErrorInfo, useEffect, useState } from 'react'
import { Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom'
import { useSession } from '@/lib/auth-client'
import { usePathname } from '@/lib/router'
import { NAV_ITEMS, isNavItemActive, isApiIndependentItem } from '@/lib/navItems'
import { CONFIG_MODULES } from '@/lib/configModules'
import PageLoader from '@/components/ui/PageLoader'
import ClientShell from '@/components/client/ClientShell'
import AdminShell from '@/components/admin/AdminShell'
import MaintenancePage from '@/components/MaintenancePage'

// ── Auth pages ────────────────────────────────────────────────────────────────
const LoginPage            = lazy(() => import('@/app/(auth)/login/page'))
const VerifyEmailPage      = lazy(() => import('@/app/(auth)/verify-email/page'))
const ClientSelectionPage  = lazy(() => import('@/app/(auth)/client-selection/page'))
const ForgotPasswordPage   = lazy(() => import('@/app/(auth)/forgot-password/page'))
const ResetPasswordPage    = lazy(() => import('@/app/(auth)/reset-password/page'))
const RegisterPage         = lazy(() => import('@/app/(auth)/register/page'))

// ── Client pages ─────────────────────────────────────────────────────────────
const DashboardPage        = lazy(() => import('@/app/(client)/dashboard/page'))
const InfringementPage     = lazy(() => import('@/app/(client)/infringement/page'))
// The staff report in scoped mode — see app/(client)/reports/page.tsx.
const ClientReportsPage    = lazy(() => import('@/app/(client)/reports/page'))
// Same report, scoped + narrowed to VOD platforms — see app/(client)/report-vod/page.tsx.
const ClientVODReportsPage = lazy(() => import('@/app/(client)/report-vod/page'))
/* The client landing page for a login holding the Calendar grant — see the
   redirect in app/(client)/dashboard/page.tsx. Also its own nav tab
   (lib/navItems.tsx), reached directly rather than through /dashboard when
   clicked there. */
const WelcomePage          = lazy(() => import('@/app/(client)/welcome/page'))
const InfringementPlatPage = lazy(() => import('@/app/(client)/infringement/[platform]/page'))
const InfringementCatPage  = lazy(() => import('@/app/(client)/infringement/category/page'))
const SearchPage           = lazy(() => import('@/app/(client)/search/page'))
const DownloadRequestPage  = lazy(() => import('@/app/(client)/download-request/page'))
const UploadUrlPage        = lazy(() => import('@/app/(client)/upload-url/page'))
const PendingCountPage     = lazy(() => import('@/app/(client)/pending-count/page'))
const QcActionPage         = lazy(() => import('@/app/(client)/qc-action/page'))
const ProfilePage          = lazy(() => import('@/app/(client)/profile/page'))
const SwitchAccountPage    = lazy(() => import('@/app/(client)/switch-account/page'))
const IpTrackingPage       = lazy(() => import('@/app/(client)/ip-tracking/page'))
const WarRoomPage          = lazy(() => import('@/app/(client)/war-room/page'))
const DataSharingPage      = lazy(() => import('@/app/(client)/data-sharing/page'))
const AccountAccessPage    = lazy(() => import('@/app/(client)/account-access/page'))
const NotificationsPage    = lazy(() => import('@/app/(client)/notifications/page'))
const NotificationDetail   = lazy(() => import('@/app/(client)/notifications/detail'))

// ── Admin pages ───────────────────────────────────────────────────────────────
const AdminHomePage        = lazy(() => import('@/app/admin/home/page'))
const AdminClientsPage     = lazy(() => import('@/app/admin/clients/page'))
const AdminClientDashPage  = lazy(() => import('@/app/admin/clients/[id]/dashboard/page'))
const AdminClientEditPage  = lazy(() => import('@/app/admin/clients/[id]/edit/page'))
const AdminClientsAddPage  = lazy(() => import('@/app/admin/clients/add/page'))
const AdminUsersPage       = lazy(() => import('@/app/admin/users/page'))
const AdminUsersAddPage    = lazy(() => import('@/app/admin/users/add/page'))
const AdminGuidelinesPage   = lazy(() => import('@/app/admin/guidelines/page'))
const AdminNotificationsPage = lazy(() => import('@/app/admin/notifications/page'))
const AdminNotificationDetail = lazy(() => import('@/app/admin/notifications/detail'))
const RegistrationsPage    = lazy(() => import('@/app/admin/registrations/page'))
const RegRequestsPage      = lazy(() => import('@/app/admin/registration-requests/page'))
const ConfigurationPage    = lazy(() => import('@/app/admin/configuration/page'))
const DashboardsPage       = lazy(() => import('@/app/admin/dashboards/page'))
const DashboardsAddPage    = lazy(() => import('@/app/admin/dashboards/add/page'))
const DashboardsEditPage   = lazy(() => import('@/app/admin/dashboards/edit/page'))
const EmailTemplatesPage   = lazy(() => import('@/app/admin/email-templates/page'))
const EmailEventTypesPage  = lazy(() => import('@/app/admin/email-event-types/page'))
const AdminReportsPage     = lazy(() => import('@/app/admin/reports/page'))
const ReportConfigPage     = lazy(() => import('@/app/admin/report-config/page'))
const ModulesPage          = lazy(() => import('@/app/admin/modules/page'))
const DashboardModulesPage = lazy(() => import('@/app/admin/dashboard-modules/page'))
const ModulePermsPage      = lazy(() => import('@/app/admin/module-permissions/page'))
const SettingsPage         = lazy(() => import('@/app/admin/settings/page'))
const AssetAccessPage      = lazy(() => import('@/app/admin/asset-access/page'))
const AssetRegisterAccessPage = lazy(() => import('@/app/admin/asset-register/page'))
const WarRoomAssetsPage    = lazy(() => import('@/app/admin/war-room-assets/page'))
const PlatformBriefPage    = lazy(() => import('@/app/admin/platform-brief/page'))
const DatabaseBackupPage   = lazy(() => import('@/app/admin/database-backup/page'))
const AwsCredentialsPage   = lazy(() => import('@/app/admin/aws-credentials/page'))
const SecurityPolicyPage   = lazy(() => import('@/app/admin/security-policy/page'))
const ApiCredsPage         = lazy(() => import('@/app/admin/api-credentials/page'))
const ActivityPage         = lazy(() => import('@/app/admin/activity/page'))
const TrackingPage         = lazy(() => import('@/app/admin/tracking/page'))
const PowerBICredsPage     = lazy(() => import('@/app/admin/powerbi-creds/page'))
const PowerBIWorkspacePage = lazy(() => import('@/app/admin/powerbi-workspace/page'))
const SuperAdminPage       = lazy(() => import('@/app/admin/super-admin/page'))
const AdminWarRoomPage     = lazy(() => import('@/app/admin/war-room/page'))

// ── Route guards ──────────────────────────────────────────────────────────────
function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession()
  if (status === 'loading') return <PageLoader />
  if (status === 'unauthenticated') return <Navigate to="/login" replace />
  return <>{children}</>
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession()
  if (status === 'loading') return <PageLoader />
  if (status === 'unauthenticated') return <Navigate to="/login" replace />
  const role = (session?.user as any)?.role
  if (role !== 1 && role !== 2) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

// ── Full-page access denied ───────────────────────────────────────────────────
/*
 * Two DIFFERENT failures used to wear the same face.
 *
 * "You don't have permission to access the Reports module" is true when the
 * module was never granted. It is a lie when the grant is fine and the portal
 * simply has no Markscan token this minute — an upstream login that was
 * rate-limited, or a service that is briefly down. The reader is told to go and
 * ask for access they already hold, and the admin is told the same, so the real
 * fault (transient, self-healing) gets chased as a permissions bug.
 *
 * `reason` splits them: 'grant' is the permissions card, 'api' says the
 * reporting service could not be reached and offers to try again.
 */
function AccessDenied({ moduleName, reason = 'grant' }: {
  moduleName: string
  reason?: 'grant' | 'api' | 'error'
}) {
  /* 'error' is the third answer, and it is deliberately NOT drawn as a refusal.
     The check itself failed — a dropped request, a reload mid-flight — so the
     reader's permissions are not in question and the card must not imply they
     are. It borrows the API card's shape because the two share a remedy: wait a
     moment and try again. */
  const err = reason === 'error'
  const api = reason === 'api' || err
  const tint = api ? '#FC934C' : '#b3091a'
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Inter, system-ui, sans-serif', padding: 24,
    }}>
      <div style={{
        maxWidth: 520, width: '100%', background: '#fff', borderRadius: 20,
        border: '1px solid #e8ebf0', boxShadow: '0 12px 40px rgba(13,36,75,0.10)',
        padding: '44px 36px', textAlign: 'center',
      }}>
        {/* shield icon */}
        <div style={{
          width: 72, height: 72, borderRadius: 20, background: `${tint}12`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 22px',
        }}>
          <svg width="36" height="36" fill="none" viewBox="0 0 24 24" stroke={tint} strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <line x1="12" y1="9" x2="12" y2="13" stroke={tint} strokeWidth={2} strokeLinecap="round" />
            <circle cx="12" cy="16" r="0.75" fill={tint} stroke={tint} />
          </svg>
        </div>

        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#14254A' }}>
          {err ? 'Could not check your access' : api ? 'Reporting service unavailable' : 'Access Restricted'}
        </h2>
        {err ? (
          <>
            <p style={{ margin: '10px 0 6px', fontSize: 14, color: '#5b6678', lineHeight: 1.6 }}>
              The portal could not confirm whether you have access to
              {moduleName ? <> <strong style={{ color: '#14254A' }}>{moduleName}</strong></> : ' this page'}, so
              it has not been opened.
            </p>
            <p style={{ margin: '0 0 28px', fontSize: 13, color: '#8a96a8' }}>
              This is a connection problem, not a permissions one &mdash; nothing about your account
              has changed. Try again in a moment.
            </p>
          </>
        ) : api ? (
          <>
            <p style={{ margin: '10px 0 6px', fontSize: 14, color: '#5b6678', lineHeight: 1.6 }}>
              The portal could not reach the reporting service, so
              {moduleName ? <> <strong style={{ color: '#14254A' }}>{moduleName}</strong></> : ' this page'} cannot
              be shown right now.
            </p>
            {/* NOT "this usually clears on its own within a few minutes", which
                is what it used to say.

                That is true of two of the four causes — an upstream rate-limit,
                or a service briefly down — and false of the commonest one, which
                is that this login holds no API credentials at all. That never
                clears, and the old wording sent people away to wait for
                something that was not coming. It cannot be told apart from here,
                so this says both and commits to neither. */}
            <p style={{ margin: '0 0 28px', fontSize: 13, color: '#8a96a8' }}>
              Your permissions have not changed. This is often temporary and clears within a few
              minutes &mdash; but it can also mean this account has no API credentials set up, which
              will not resolve on its own. If it persists, contact support.
            </p>
          </>
        ) : (
          <>
            <p style={{ margin: '10px 0 6px', fontSize: 14, color: '#5b6678', lineHeight: 1.6 }}>
              You don&apos;t have permission to access
              {moduleName ? <> the <strong style={{ color: '#14254A' }}>{moduleName}</strong> module</> : ' this page'}.
            </p>
            <p style={{ margin: '0 0 28px', fontSize: 13, color: '#8a96a8' }}>
              Please contact the <strong style={{ color: '#FC934C' }}>IP House team</strong> to request access.
            </p>
          </>
        )}

        {/* divider */}
        <div style={{ borderTop: '1px solid #f0f2f5', margin: '0 0 24px' }} />

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          {api && (
            <button onClick={() => window.location.reload()}
              style={{
                padding: '10px 28px', borderRadius: 12, border: 'none',
                background: 'linear-gradient(135deg,#14254A,#1e3a6e)', color: '#fff',
                fontSize: 14, fontWeight: 700, cursor: 'pointer',
              }}>
              Try again
            </button>
          )}
          <a href="/dashboard"
            style={{
              padding: '10px 28px', borderRadius: 12, border: 'none',
              background: 'linear-gradient(135deg,#14254A,#1e3a6e)', color: '#fff',
              fontSize: 14, fontWeight: 700, cursor: 'pointer', textDecoration: 'none',
              display: 'inline-block',
            }}>
            ← Back to Dashboard
          </a>
          <a href="mailto:India-itsupport@ip-house.com"
            style={{
              padding: '10px 24px', borderRadius: 12, border: '1px solid #e8ebf0',
              background: '#fff', color: '#14254A',
              fontSize: 14, fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
              display: 'inline-block',
            }}>
            Contact Support
          </a>
        </div>

        <p style={{ marginTop: 22, fontSize: 11, color: '#adb5bd' }}>
          IP House Anti-Piracy Platform — Unauthorized access is logged and monitored.
        </p>
      </div>
    </div>
  )
}

/* ── Module permission guard (client routes only) ─────────────────────────────

   THIS IS NOT THE ACCESS CONTROL. Every client endpoint behind these pages is
   gated on the same module grant on the SERVER — see handlers/modulegate.go and
   the `mod` wrapper in main.go. This decides what to RENDER, so an ungranted
   page says so plainly instead of drawing a shell that then fills with 403s.

   It used to be the only check, and it leaked in three ways, all of which are
   the same mistake — defaulting to "allowed" when the answer was not known yet:

     · `state` was not reset when the path changed. The verdict from the PREVIOUS
       route stayed on screen while the new route's check was in flight, so a
       navigation from a granted page to an ungranted one rendered the ungranted
       page — and its data — until the fetch came back. First load was fine;
       every click was not.
     · a slow answer for path A could land after the user had moved to path B and
       be applied to B, because nothing tied a response to the path that asked.
     · any network error resolved to allowed, on the reasoning that a blip should
       not lock people out. With the server enforcing, an unknown answer can be
       reported as unknown instead of guessed in the permissive direction.
*/
function ClientModuleGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { data: session, status } = useSession()
  const user = session?.user as any
  const [state, setState] = useState<{
    checked: boolean; allowed: boolean; label: string; reason: 'grant' | 'api' | 'error'
  }>({ checked: false, allowed: false, label: '', reason: 'grant' })

  useEffect(() => {
    if (status === 'loading') return

    /* Unchecked until this path's own answer arrives. The pathname is in the
       dependency list, so this runs on every navigation and each one starts
       from "not known yet" — which renders the loader, not the page. */
    setState({ checked: false, allowed: false, label: '', reason: 'grant' })

    /* Ties the answer to the path that asked for it. A response that arrives
       after the reader has moved on is dropped rather than applied to whatever
       is on screen now. */
    let live = true
    const settle = (s: { allowed: boolean; label: string; reason: 'grant' | 'api' | 'error' }) => {
      if (live) setState({ checked: true, ...s })
    }

    // Utility pages, reachable on any grant: the dashboard landing, your own
    // profile, and the account switcher.
    if (pathname === '/dashboard' || pathname === '/profile' || pathname === '/switch-account') {
      settle({ allowed: true, label: '', reason: 'grant' })
      return
    }

    /* No nav item owns this path — notification detail, Access Details and the
       like. Allowed HERE because these are not module pages and have no grant to
       check; the ones that need a permission check it in their own handler (see
       Client Admin in lib/navItems.tsx). A module page always has a nav item, so
       nothing gated falls through this. */
    const item = NAV_ITEMS.find(i => isNavItemActive(i, pathname))
    if (!item) {
      settle({ allowed: true, label: '', reason: 'grant' })
      return
    }

    // Fetch allowed modules from server and check. API access comes from the
    // live response (it heals after a transient Markscan failure at login);
    // the session's apiAccess claim — frozen at select-login — is the fallback.
    fetch('/api/user/nav', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!d.success) {
          settle({ allowed: false, label: item.label, reason: 'grant' })
          return
        }
        const liveApiAccess = typeof d.apiAccess === 'boolean' ? d.apiAccess : !!user?.apiAccess
        if (!liveApiAccess && !isApiIndependentItem(item)) {
          // No API token → API-dependent non-dashboard routes are restricted.
          // API-independent modules (e.g. Data Sharing) fall through to the
          // grant check below so they work without API credentials.
          settle({ allowed: false, label: item.label, reason: 'api' })
          return
        }
        // Match on the stable pageName (not the module name), so renaming a
        // module in /admin/modules never revokes access.
        const allowedPages = (d.allowedModules as { pageName: string }[]).map(m => m.pageName)
        settle({ allowed: allowedPages.includes(item.pageName), label: item.label, reason: 'grant' })
      })
      .catch(() => {
        /* Could not find out — which is neither "you may" nor "you may not", and
           is reported as itself. Guessing "allowed" here is what let an
           ungranted page render on a dropped request; guessing "denied" would
           tell a reader their permissions had been taken away, which is a
           worse thing to say wrongly. The card offers a retry. */
        settle({ allowed: false, label: item.label, reason: 'error' })
      })

    return () => { live = false }
  }, [pathname, status, user?.apiAccess])

  if (!state.checked || status === 'loading') return <PageLoader />
  if (!state.allowed) return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <AccessDenied moduleName={state.label} reason={state.reason} />
    </div>
  )
  return <>{children}</>
}

// ── Admin permission guard (admin routes) ──────────────────────────────────────
// RequireAdmin only proves role >= 1. This additionally enforces, per page:
//   • Super-Admin-only pages require role === 2.
//   • Configuration-module pages require the specific grant (Super Admin passes
//     implicitly). This mirrors the server-side grant enforcement so a plain
//     Admin can't reach a page — by pasting its URL — that they weren't granted.
// Every other admin page stays available to any admin (role >= 1).
const SUPER_ADMIN_PATHS = ['/admin/super-admin', '/admin/platform-brief', '/admin/database-backup', '/admin/aws-credentials', '/admin/security-policy']

function AdminAccessGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { data: session, status } = useSession()
  const role = (session?.user as any)?.role
  const [granted, setGranted] = useState<Set<string> | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/admin/my-config-access', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (alive) setGranted(new Set<string>(d?.success && Array.isArray(d.granted) ? d.granted : [])) })
      .catch(() => { if (alive) setGranted(new Set<string>()) })
    return () => { alive = false }
  }, [])

  if (status === 'loading') return <PageLoader />

  const denied = (label: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <AccessDenied moduleName={label} />
    </div>
  )

  // Super-Admin-only pages.
  if (SUPER_ADMIN_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return role === 2 ? <>{children}</> : denied('Super Admin')
  }

  // Configuration-module pages: require the module grant (Super Admin implicit).
  const mod = CONFIG_MODULES.find(m => pathname === m.href || pathname.startsWith(m.href + '/'))
  if (mod && role !== 2) {
    if (granted === null) return <PageLoader />
    if (!granted.has(mod.key)) return denied(mod.title)
  }

  return <>{children}</>
}

// ── Maintenance mode guard ────────────────────────────────────────────────────
// Polls /api/maintenance; while the flag is on, non-admin visitors get the
// full-screen maintenance page on every route except /login (kept reachable so
// staff can sign in and turn it off). Admins (role 1/2) bypass and see a banner.
function MaintenanceGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { data: session, status } = useSession()
  const [maint, setMaint] = useState<{ on: boolean; message: string } | null>(null)

  useEffect(() => {
    let alive = true
    const check = () =>
      fetch('/api/maintenance', { credentials: 'include' })
        .then(r => r.json())
        .then(d => { if (alive) setMaint({ on: !!d.maintenance, message: d.message || '' }) })
        .catch(() => { if (alive) setMaint(m => m ?? { on: false, message: '' }) }) // fail open
    check()
    const id = setInterval(check, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (maint === null) return <PageLoader />
  if (!maint.on) return <>{children}</>

  const role = (session?.user as any)?.role
  const isStaff = role === 1 || role === 2
  if (status === 'loading') return <PageLoader />

  if (!isStaff && pathname !== '/login') return <MaintenancePage message={maint.message} />

  return (
    <>
      {children}
      {isStaff && (
        <div style={{
          position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)', zIndex: 9999,
          background: '#FC934C', color: '#fff', borderRadius: 999, padding: '9px 22px',
          fontSize: 13, fontWeight: 700, boxShadow: '0 6px 20px rgba(252,147,76,0.45)',
          fontFamily: 'Inter, system-ui, sans-serif', whiteSpace: 'nowrap',
        }}>
          🛠️ Maintenance mode is ON — clients see the maintenance page
        </div>
      )}
    </>
  )
}

// ── Layout wrappers ───────────────────────────────────────────────────────────
function ClientLayout() {
  return (
    <RequireAuth>
      <ClientShell>
        <ClientModuleGuard>
          <Outlet />
        </ClientModuleGuard>
      </ClientShell>
    </RequireAuth>
  )
}

function AdminLayout() {
  return (
    <RequireAdmin>
      <AdminShell>
        <AdminAccessGuard><Outlet /></AdminAccessGuard>
      </AdminShell>
    </RequireAdmin>
  )
}

// ── Param-bridge components (Next.js params → React Router useParams) ─────────
function InfringementPlatformRoute() {
  const { platform } = useParams<{ platform: string }>()
  return <InfringementPlatPage platform={platform!} />
}

function InfringementCategoryRoute() {
  const { category } = useParams<{ category: string }>()
  return <InfringementCatPage category={category!} />
}

function NotificationDetailRoute() {
  const { id } = useParams<{ id: string }>()
  return <NotificationDetail id={id!} />
}

function AdminNotificationDetailRoute() {
  const { id } = useParams<{ id: string }>()
  return <AdminNotificationDetail id={id!} />
}

function AdminClientDashRoute() {
  const { id } = useParams<{ id: string }>()
  return <AdminClientDashPage id={id!} />
}

function AdminClientEditRoute() {
  const { id } = useParams<{ id: string }>()
  return <AdminClientEditPage id={id!} />
}

// ── Error boundary ────────────────────────────────────────────────────────────
// Detects a "stale chunk" failure — happens when the app was rebuilt while a tab
// was open, so the old hashed chunk filenames no longer exist on the server.
function isChunkLoadError(e: Error | null): boolean {
  if (!e) return false
  const msg = `${e.name} ${e.message}`.toLowerCase()
  return (
    msg.includes('failed to fetch dynamically imported module') ||
    msg.includes('error loading dynamically imported module') ||
    msg.includes('importing a module script failed') ||
    msg.includes('chunkloaderror') ||
    msg.includes('unable to preload css')
  )
}

const RELOAD_GUARD_KEY = 'iph_chunk_reload_at'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; reloading: boolean }> {
  state = { error: null as Error | null, reloading: false }

  static getDerivedStateFromError(e: Error) { return { error: e, reloading: false } }

  componentDidCatch(e: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', e, info)
    if (isChunkLoadError(e)) {
      // Auto-recover once: a new build is live, fetch the fresh index + chunks.
      // Guard against reload loops — only auto-reload if we haven't in the last 10s.
      const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0)
      if (Date.now() - last > 10_000) {
        sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
        this.setState({ reloading: true })
        // small delay so the message paints before the reload
        setTimeout(() => window.location.reload(), 600)
      }
    }
  }

  render() {
    const { error, reloading } = this.state

    if (error && isChunkLoadError(error)) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f6f8fb', fontFamily: 'Inter, system-ui, sans-serif', padding: 24 }}>
          <div style={{ maxWidth: 460, width: '100%', background: '#fff', borderRadius: 16, border: '1px solid #e8ebf0', boxShadow: '0 8px 30px rgba(13,36,75,0.10)', padding: '32px 28px', textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: '#FC934C18', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px', fontSize: 28 }}>🔄</div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#14254A' }}>A new version is available</h2>
            <p style={{ margin: '8px 0 22px', fontSize: 13.5, color: '#5b6678', lineHeight: 1.6 }}>
              The app was updated while this tab was open. {reloading ? 'Refreshing now…' : 'Reload to get the latest version.'}
            </p>
            {reloading ? (
              <span style={{ width: 26, height: 26, border: '3px solid #e8ebf0', borderTopColor: '#FC934C', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
            ) : (
              <button onClick={() => { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); window.location.reload() }}
                style={{ padding: '10px 28px', borderRadius: 10, border: 'none', background: '#14254A', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                Reload Now
              </button>
            )}
          </div>
        </div>
      )
    }

    if (error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f6f8fb', fontFamily: 'Inter, system-ui, sans-serif', padding: 24 }}>
          <div style={{ maxWidth: 560, width: '100%', background: '#fff', borderRadius: 16, border: '1px solid #e8ebf0', boxShadow: '0 8px 30px rgba(13,36,75,0.10)', padding: '32px 28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: '#b3091a14', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, flexShrink: 0 }}>⚠️</div>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#14254A' }}>Something went wrong</h2>
                <p style={{ margin: '2px 0 0', fontSize: 13, color: '#5b6678' }}>An unexpected error occurred while loading this page.</p>
              </div>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff5f5', border: '1px solid #f3d4d4', color: '#b3091a', padding: 14, borderRadius: 10, fontSize: 12, margin: '0 0 20px', maxHeight: 200, overflow: 'auto' }}>
              {error.message}
            </pre>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => this.setState({ error: null })}
                style={{ padding: '9px 20px', borderRadius: 10, border: '1px solid #e8ebf0', background: '#fff', color: '#14254A', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                Try Again
              </button>
              <button onClick={() => window.location.reload()}
                style={{ padding: '9px 20px', borderRadius: 10, border: 'none', background: '#14254A', color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
                Reload Page
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <ErrorBoundary>
    <MaintenanceGuard>
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Root redirect */}
        <Route path="/" element={<Navigate to="/login" replace />} />

        {/* Auth pages (no shell) */}
        <Route path="/login"            element={<LoginPage />} />
        <Route path="/verify-email"     element={<VerifyEmailPage />} />
        <Route path="/client-selection" element={<ClientSelectionPage />} />
        <Route path="/forgot-password"  element={<ForgotPasswordPage />} />
        <Route path="/reset-password"   element={<ResetPasswordPage />} />
        <Route path="/register"         element={<RegisterPage />} />

        {/* Client pages */}
        <Route element={<ClientLayout />}>
          <Route path="/dashboard"                element={<DashboardPage />} />
          <Route path="/welcome"                  element={<WelcomePage />} />
          <Route path="/war-room"                 element={<WarRoomPage />} />
          <Route path="/reports"                  element={<ClientReportsPage />} />
          <Route path="/report-vod"               element={<ClientVODReportsPage />} />
          <Route path="/infringement"             element={<InfringementPage />} />
          {/* Three segments, so it never competes with /infringement/:platform. */}
          <Route path="/infringement/category/:category" element={<InfringementCategoryRoute />} />
          <Route path="/infringement/:platform"   element={<InfringementPlatformRoute />} />
          <Route path="/search"                   element={<SearchPage />} />
          <Route path="/download-request"         element={<DownloadRequestPage />} />
          <Route path="/upload-url"               element={<UploadUrlPage />} />
          <Route path="/pending-count"            element={<PendingCountPage />} />
          <Route path="/qc-action"                element={<QcActionPage />} />
          <Route path="/profile"                  element={<ProfilePage />} />
          <Route path="/switch-account"           element={<SwitchAccountPage />} />
          <Route path="/ip-tracking"              element={<IpTrackingPage />} />
          <Route path="/data-sharing"             element={<DataSharingPage />} />
          <Route path="/account-access"           element={<AccountAccessPage />} />
          <Route path="/notifications"            element={<NotificationsPage />} />
          <Route path="/notifications/:id"        element={<NotificationDetailRoute />} />
        </Route>

        {/* Admin pages */}
        <Route element={<AdminLayout />}>
          <Route path="/admin/home"                       element={<AdminHomePage />} />
          <Route path="/admin/clients"                    element={<AdminClientsPage />} />
          <Route path="/admin/clients/add"                element={<AdminClientsAddPage />} />
          <Route path="/admin/clients/:id/dashboard"      element={<AdminClientDashRoute />} />
          <Route path="/admin/clients/:id/edit"           element={<AdminClientEditRoute />} />
          <Route path="/admin/users"                      element={<AdminUsersPage />} />
          <Route path="/admin/users/add"                  element={<AdminUsersAddPage />} />
          <Route path="/admin/guidelines"                 element={<AdminGuidelinesPage />} />
          <Route path="/admin/notifications"              element={<AdminNotificationsPage />} />
          <Route path="/admin/notifications/:id"          element={<AdminNotificationDetailRoute />} />
          <Route path="/admin/registrations"              element={<RegistrationsPage />} />
          <Route path="/admin/registration-requests"      element={<RegRequestsPage />} />
          <Route path="/admin/configuration"              element={<ConfigurationPage />} />
          <Route path="/admin/dashboards"                 element={<DashboardsPage />} />
          <Route path="/admin/dashboards/add"             element={<DashboardsAddPage />} />
          <Route path="/admin/dashboards/edit"            element={<DashboardsEditPage />} />
          <Route path="/admin/email-templates"            element={<EmailTemplatesPage />} />
          <Route path="/admin/email-event-types"         element={<EmailEventTypesPage />} />
          <Route path="/admin/reports"                   element={<AdminReportsPage />} />
          {/* Staff preview of the VOD Reports page — same component, unscoped
              (staff pick the client) and narrowed to VOD platforms. */}
          <Route path="/admin/report-vod"                element={<AdminReportsPage vod />} />
          <Route path="/admin/report-config"             element={<ReportConfigPage />} />
          <Route path="/admin/modules"                    element={<ModulesPage />} />
          <Route path="/admin/dashboard-modules"          element={<DashboardModulesPage />} />
          <Route path="/admin/module-permissions"         element={<ModulePermsPage />} />
          <Route path="/admin/settings"                   element={<SettingsPage />} />
          <Route path="/admin/asset-access"               element={<AssetAccessPage />} />
          <Route path="/admin/asset-register"             element={<AssetRegisterAccessPage />} />
          <Route path="/admin/war-room-assets"            element={<WarRoomAssetsPage />} />
          <Route path="/admin/platform-brief"             element={<PlatformBriefPage />} />
          <Route path="/admin/database-backup"            element={<DatabaseBackupPage />} />
          <Route path="/admin/aws-credentials"            element={<AwsCredentialsPage />} />
          <Route path="/admin/security-policy"            element={<SecurityPolicyPage />} />
          <Route path="/admin/api-credentials"            element={<ApiCredsPage />} />
          <Route path="/admin/activity"                   element={<ActivityPage />} />
          <Route path="/admin/tracking"                   element={<TrackingPage />} />
          <Route path="/admin/powerbi-creds"              element={<PowerBICredsPage />} />
          <Route path="/admin/powerbi-workspace"          element={<PowerBIWorkspacePage />} />
          <Route path="/admin/super-admin"                element={<SuperAdminPage />} />
          <Route path="/admin/war-room"                   element={<AdminWarRoomPage />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
    </MaintenanceGuard>
    </ErrorBoundary>
  )
}
