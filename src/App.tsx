'use client'

import { lazy, Suspense, ReactNode, Component, ErrorInfo, useEffect, useState } from 'react'
import { Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom'
import { useSession } from '@/lib/auth-client'
import { usePathname } from '@/lib/router'
import { NAV_ITEMS, isNavItemActive } from '@/lib/navItems'
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
const InfringementPlatPage = lazy(() => import('@/app/(client)/infringement/[platform]/page'))
const SearchPage           = lazy(() => import('@/app/(client)/search/page'))
const DownloadRequestPage  = lazy(() => import('@/app/(client)/download-request/page'))
const UploadUrlPage        = lazy(() => import('@/app/(client)/upload-url/page'))
const PendingCountPage     = lazy(() => import('@/app/(client)/pending-count/page'))
const QcActionPage         = lazy(() => import('@/app/(client)/qc-action/page'))
const ProfilePage          = lazy(() => import('@/app/(client)/profile/page'))
const SwitchAccountPage    = lazy(() => import('@/app/(client)/switch-account/page'))
const IpTrackingPage       = lazy(() => import('@/app/(client)/ip-tracking/page'))
const WarRoomPage          = lazy(() => import('@/app/(client)/war-room/page'))

// ── Admin pages ───────────────────────────────────────────────────────────────
const AdminHomePage        = lazy(() => import('@/app/admin/home/page'))
const AdminClientsPage     = lazy(() => import('@/app/admin/clients/page'))
const AdminClientDashPage  = lazy(() => import('@/app/admin/clients/[id]/dashboard/page'))
const AdminClientEditPage  = lazy(() => import('@/app/admin/clients/[id]/edit/page'))
const AdminClientsAddPage  = lazy(() => import('@/app/admin/clients/add/page'))
const AdminUsersPage       = lazy(() => import('@/app/admin/users/page'))
const AdminUsersAddPage    = lazy(() => import('@/app/admin/users/add/page'))
const RegistrationsPage    = lazy(() => import('@/app/admin/registrations/page'))
const RegRequestsPage      = lazy(() => import('@/app/admin/registration-requests/page'))
const ConfigurationPage    = lazy(() => import('@/app/admin/configuration/page'))
const DashboardsPage       = lazy(() => import('@/app/admin/dashboards/page'))
const DashboardsAddPage    = lazy(() => import('@/app/admin/dashboards/add/page'))
const DashboardsEditPage   = lazy(() => import('@/app/admin/dashboards/edit/page'))
const EmailTemplatesPage   = lazy(() => import('@/app/admin/email-templates/page'))
const EmailEventTypesPage  = lazy(() => import('@/app/admin/email-event-types/page'))
const ModulesPage          = lazy(() => import('@/app/admin/modules/page'))
const DashboardModulesPage = lazy(() => import('@/app/admin/dashboard-modules/page'))
const ModulePermsPage      = lazy(() => import('@/app/admin/module-permissions/page'))
const SettingsPage         = lazy(() => import('@/app/admin/settings/page'))
const IdleTimeoutPage      = lazy(() => import('@/app/admin/idle-timeout/page'))
const AssetAccessPage      = lazy(() => import('@/app/admin/asset-access/page'))
const WarRoomAssetsPage    = lazy(() => import('@/app/admin/war-room-assets/page'))
const ApiCredsPage         = lazy(() => import('@/app/admin/api-credentials/page'))
const MasterApiPage        = lazy(() => import('@/app/admin/master-api/page'))
const ActivityPage         = lazy(() => import('@/app/admin/activity/page'))
const TrackingPage         = lazy(() => import('@/app/admin/tracking/page'))
const PowerBICredsPage     = lazy(() => import('@/app/admin/powerbi-creds/page'))
const PowerBIWorkspacePage = lazy(() => import('@/app/admin/powerbi-workspace/page'))
const SuperAdminPage       = lazy(() => import('@/app/admin/super-admin/page'))
const ApiPlaygroundPage    = lazy(() => import('@/app/admin/api-playground/page'))
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
function AccessDenied({ moduleName }: { moduleName: string }) {
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
          width: 72, height: 72, borderRadius: 20, background: '#b3091a0e',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 22px',
        }}>
          <svg width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="#b3091a" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <line x1="12" y1="9" x2="12" y2="13" stroke="#b3091a" strokeWidth={2} strokeLinecap="round" />
            <circle cx="12" cy="16" r="0.75" fill="#b3091a" stroke="#b3091a" />
          </svg>
        </div>

        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#14254A' }}>
          Access Restricted
        </h2>
        <p style={{ margin: '10px 0 6px', fontSize: 14, color: '#5b6678', lineHeight: 1.6 }}>
          You don&apos;t have permission to access
          {moduleName ? <> the <strong style={{ color: '#14254A' }}>{moduleName}</strong> module</> : ' this page'}.
        </p>
        <p style={{ margin: '0 0 28px', fontSize: 13, color: '#8a96a8' }}>
          Please contact the <strong style={{ color: '#FC934C' }}>IP House team</strong> to request access.
        </p>

        {/* divider */}
        <div style={{ borderTop: '1px solid #f0f2f5', margin: '0 0 24px' }} />

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
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

// ── Module permission guard (client routes only) ──────────────────────────────
function ClientModuleGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { data: session, status } = useSession()
  const user = session?.user as any
  const [state, setState] = useState<{ checked: boolean; allowed: boolean; label: string }>(
    { checked: false, allowed: true, label: '' }
  )

  useEffect(() => {
    if (status === 'loading') return

    // Profile and switch-account are utility pages — always accessible
    if (pathname === '/dashboard' || pathname === '/profile' || pathname === '/switch-account') {
      setState({ checked: true, allowed: true, label: '' })
      return
    }

    // Find which nav item owns this path
    const item = NAV_ITEMS.find(i => isNavItemActive(i, pathname))
    if (!item) {
      // No nav item matches — allow through (unknown path)
      setState({ checked: true, allowed: true, label: '' })
      return
    }

    // Fetch allowed modules from server and check. API access comes from the
    // live response (it heals after a transient Markscan failure at login);
    // the session's apiAccess claim — frozen at select-login — is the fallback.
    fetch('/api/user/nav', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!d.success) {
          setState({ checked: true, allowed: false, label: item.label })
          return
        }
        const liveApiAccess = typeof d.apiAccess === 'boolean' ? d.apiAccess : !!user?.apiAccess
        if (!liveApiAccess) {
          // No API token → every non-dashboard route is restricted
          setState({ checked: true, allowed: false, label: item.label })
          return
        }
        const allowedNames = (d.allowedModules as { moduleName: string }[]).map(m => m.moduleName)
        const allowed = item.moduleNames.some(n => allowedNames.includes(n))
        setState({ checked: true, allowed, label: item.label })
      })
      .catch(() => {
        // Network error — fail open to avoid locking users out on transient errors
        setState({ checked: true, allowed: true, label: '' })
      })
  }, [pathname, status, user?.apiAccess])

  if (!state.checked || status === 'loading') return <PageLoader />
  if (!state.allowed) return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <AccessDenied moduleName={state.label} />
    </div>
  )
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
      <AdminShell><Outlet /></AdminShell>
    </RequireAdmin>
  )
}

// ── Param-bridge components (Next.js params → React Router useParams) ─────────
function InfringementPlatformRoute() {
  const { platform } = useParams<{ platform: string }>()
  return <InfringementPlatPage platform={platform!} />
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
          <Route path="/war-room"                 element={<WarRoomPage />} />
          <Route path="/infringement"             element={<InfringementPage />} />
          <Route path="/infringement/:platform"   element={<InfringementPlatformRoute />} />
          <Route path="/search"                   element={<SearchPage />} />
          <Route path="/download-request"         element={<DownloadRequestPage />} />
          <Route path="/upload-url"               element={<UploadUrlPage />} />
          <Route path="/pending-count"            element={<PendingCountPage />} />
          <Route path="/qc-action"                element={<QcActionPage />} />
          <Route path="/profile"                  element={<ProfilePage />} />
          <Route path="/switch-account"           element={<SwitchAccountPage />} />
          <Route path="/ip-tracking"              element={<IpTrackingPage />} />
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
          <Route path="/admin/registrations"              element={<RegistrationsPage />} />
          <Route path="/admin/registration-requests"      element={<RegRequestsPage />} />
          <Route path="/admin/configuration"              element={<ConfigurationPage />} />
          <Route path="/admin/dashboards"                 element={<DashboardsPage />} />
          <Route path="/admin/dashboards/add"             element={<DashboardsAddPage />} />
          <Route path="/admin/dashboards/edit"            element={<DashboardsEditPage />} />
          <Route path="/admin/email-templates"            element={<EmailTemplatesPage />} />
          <Route path="/admin/email-event-types"         element={<EmailEventTypesPage />} />
          <Route path="/admin/modules"                    element={<ModulesPage />} />
          <Route path="/admin/dashboard-modules"          element={<DashboardModulesPage />} />
          <Route path="/admin/module-permissions"         element={<ModulePermsPage />} />
          <Route path="/admin/settings"                   element={<SettingsPage />} />
          <Route path="/admin/idle-timeout"               element={<IdleTimeoutPage />} />
          <Route path="/admin/asset-access"               element={<AssetAccessPage />} />
          <Route path="/admin/war-room-assets"            element={<WarRoomAssetsPage />} />
          <Route path="/admin/api-credentials"            element={<ApiCredsPage />} />
          <Route path="/admin/master-api"                 element={<MasterApiPage />} />
          <Route path="/admin/activity"                   element={<ActivityPage />} />
          <Route path="/admin/tracking"                   element={<TrackingPage />} />
          <Route path="/admin/powerbi-creds"              element={<PowerBICredsPage />} />
          <Route path="/admin/powerbi-workspace"          element={<PowerBIWorkspacePage />} />
          <Route path="/admin/super-admin"                element={<SuperAdminPage />} />
          <Route path="/admin/api-playground"             element={<ApiPlaygroundPage />} />
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
