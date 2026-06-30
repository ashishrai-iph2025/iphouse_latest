'use client'

import { useState, useMemo } from 'react'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import { useTheme } from '@/lib/ThemeContext'

/* ── brand palette ─────────────────────────────────────────────────────────── */
const NAVY   = '#14254A'
const ORANGE = '#FC934C'
const GREEN  = '#2b7c38'
const BLUE   = '#0a4b9c'
const ROSE   = '#b3091a'
const VIOLET = '#7C3AED'
const SLATE  = '#7C899C'

const METHOD_COLORS: Record<string, string> = {
  GET: GREEN, POST: BLUE, PUT: ORANGE, DELETE: ROSE, PATCH: VIOLET,
}

/* ── theme-aware colors ──────────────────────────────────────────────────── */
function useColors(isDark: boolean) {
  return {
    card:      isDark ? '#1a2d4e' : '#fff',
    cardBorder:isDark ? '#2a3f66' : '#e8ebf0',
    inputBg:   isDark ? '#0f1f3d' : '#f8fafc',
    inputBorder:isDark ? '#2a3f66' : '#e8ebf0',
    text:      isDark ? '#e2e8f5' : NAVY,
    subText:   isDark ? '#8ba3c9' : SLATE,
    rowHover:  isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
    panelBg:   isDark ? '#0f1f3d' : '#f7f9fc',
    codeBg:    isDark ? '#060e1e' : '#0d1b33',
    tagBg:     isDark ? 'rgba(255,255,255,0.07)' : 'rgba(20,37,74,0.06)',
  }
}

interface Endpoint {
  method: string
  path: string
  desc: string
  auth: 'public' | 'session' | 'admin' | 'superadmin'
  params?: { name: string; in: 'query' | 'body' | 'path'; required?: boolean; desc?: string }[]
  sampleBody?: Record<string, any>
}

interface Group { name: string; icon: string; endpoints: Endpoint[] }

/* ── IP House endpoint catalogue ─────────────────────────────────────────── */
const IPHOUSE_GROUPS: Group[] = [
  {
    name: 'Authentication', icon: '🔑',
    endpoints: [
      { method: 'POST', path: '/api/auth/login', desc: 'Authenticate with username/password; may return a temp token requiring OTP/login selection.', auth: 'public', sampleBody: { username: 'user@example.com', password: '••••••••' } },
      { method: 'POST', path: '/api/auth/logout', desc: 'Clear the session cookie and log out.', auth: 'public' },
      { method: 'POST', path: '/api/auth/check-multiple-logins', desc: 'Check whether a username maps to multiple login accounts.', auth: 'public', sampleBody: { username: 'user@example.com' } },
      { method: 'POST', path: '/api/auth/send-otp', desc: 'Send a one-time code to the user email.', auth: 'public', sampleBody: { tempToken: '…' } },
      { method: 'POST', path: '/api/auth/verify-otp', desc: 'Verify the OTP code and issue a session.', auth: 'public', sampleBody: { tempToken: '…', code: '123456' } },
      { method: 'POST', path: '/api/auth/select-login', desc: 'Select a specific login when several share a username.', auth: 'public', sampleBody: { tempToken: '…', loginId: 1 } },
      { method: 'POST', path: '/api/auth/forgot-password', desc: 'Begin the password reset flow.', auth: 'public', sampleBody: { email: 'user@example.com' } },
      { method: 'POST', path: '/api/auth/verify-reset-otp', desc: 'Verify the reset OTP code.', auth: 'public', sampleBody: { email: 'user@example.com', code: '123456' } },
      { method: 'POST', path: '/api/auth/reset-password', desc: 'Set a new password after verification.', auth: 'public', sampleBody: { token: '…', password: '••••••••' } },
      { method: 'POST', path: '/api/auth/register', desc: 'Submit a new user registration request.', auth: 'public', sampleBody: { name: 'Acme', email: 'acme@example.com' } },
      { method: 'GET',  path: '/api/auth/session', desc: 'Return the current authenticated session claims.', auth: 'session' },
      { method: 'GET',  path: '/api/auth/switch-account', desc: 'List accounts available to switch into.', auth: 'session' },
      { method: 'POST', path: '/api/auth/switch-account', desc: 'Switch the active session to another linked account.', auth: 'session', sampleBody: { loginId: 2 } },
    ],
  },
  {
    name: 'Client Portal', icon: '🛡️',
    endpoints: [
      { method: 'POST', path: '/api/infringement', desc: 'Fetch infringement records for the client.', auth: 'session' },
      { method: 'POST', path: '/api/search', desc: 'Search infringement / URL data.', auth: 'session', sampleBody: { query: 'example.com' } },
      { method: 'GET',  path: '/api/download', desc: 'List download requests.', auth: 'session' },
      { method: 'POST', path: '/api/download', desc: 'Trigger a new export/download.', auth: 'session' },
      { method: 'GET',  path: '/api/download/{id}', desc: 'Get a specific download by ID.', auth: 'session', params: [{ name: 'id', in: 'path', required: true }] },
      { method: 'GET',  path: '/api/upload-url', desc: 'Get a pre-signed upload URL.', auth: 'session' },
      { method: 'POST', path: '/api/upload-url', desc: 'Submit uploaded URLs for processing.', auth: 'session' },
      { method: 'POST', path: '/api/enforce', desc: 'Enforce takedown on selected URLs.', auth: 'session' },
      { method: 'POST', path: '/api/qc-urls', desc: 'Fetch URLs pending quality-control review.', auth: 'session' },
      { method: 'POST', path: '/api/qc-enforce', desc: 'Approve/enforce QC-reviewed URLs.', auth: 'session' },
      { method: 'POST', path: '/api/pending-count', desc: 'Get pending-item counts for the client.', auth: 'session' },
      { method: 'GET',  path: '/api/notifications', desc: 'List notifications.', auth: 'session' },
      { method: 'POST', path: '/api/notifications', desc: 'Mark notifications as read / create.', auth: 'session' },
      { method: 'GET',  path: '/api/token', desc: 'Resolve the client IP House API token.', auth: 'session' },
      { method: 'GET',  path: '/api/embed-token', desc: 'Get a PowerBI embed token for the client.', auth: 'session' },
      { method: 'GET',  path: '/api/keepalive', desc: 'Heartbeat to keep the session alive.', auth: 'session' },
      { method: 'GET',  path: '/api/user/nav', desc: 'Get the navigation/menu for the user.', auth: 'session' },
      { method: 'GET',  path: '/api/user/dashboard-data', desc: 'Get dashboard summary data for the user.', auth: 'session' },
      { method: 'GET',  path: '/api/user/idle-timeout', desc: 'Get the idle-timeout setting for the user.', auth: 'session' },
      { method: 'POST', path: '/api/profile/change-password', desc: 'Change the logged-in user password.', auth: 'session', sampleBody: { currentPassword: '••••', newPassword: '••••••••' } },
      { method: 'POST', path: '/api/ip-tracking', desc: 'Query IP-tracking / torrent IP details.', auth: 'session', sampleBody: { startDate: '2026-01-01', endDate: '2026-01-31', copyrightOwner: 'Owner', pageNo: 0 } },
      { method: 'GET',  path: '/api/ip-tracking/client-details', desc: 'Get copyright owners and assets for the client.', auth: 'session' },
      { method: 'GET',  path: '/api/master-data', desc: 'Get master reference data.', auth: 'session' },
      { method: 'POST', path: '/api/master-data', desc: 'Query master reference data.', auth: 'session' },
    ],
  },
  {
    name: 'Admin · Clients & Users', icon: '🏢',
    endpoints: [
      { method: 'GET',    path: '/api/admin/clients', desc: 'List all clients with active count.', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/clients', desc: 'Create a new client.', auth: 'admin', sampleBody: { name: 'Acme', email: 'acme@example.com' } },
      { method: 'PUT',    path: '/api/admin/clients', desc: 'Update / activate / deactivate a client.', auth: 'admin', sampleBody: { userId: 101, deleted: 0 } },
      { method: 'DELETE', path: '/api/admin/clients', desc: 'Delete a client.', auth: 'admin', sampleBody: { userId: 101 } },
      { method: 'GET',    path: '/api/admin/clients/loa', desc: 'Get a client Letter of Authorisation.', auth: 'admin' },
      { method: 'GET',    path: '/api/admin/client-dashboard', desc: 'Get a client dashboard config.', auth: 'admin', params: [{ name: 'userId', in: 'query', required: true }] },
      { method: 'GET',    path: '/api/admin/users', desc: 'List login accounts (joined with users).', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/users', desc: 'Create a login account.', auth: 'admin', sampleBody: { userId: 101, firstName: 'Jane', loginUsername: 'jane', loginType: 0 } },
      { method: 'PUT',    path: '/api/admin/users', desc: 'Update name / login type / active status.', auth: 'admin', sampleBody: { loginId: 5, loginType: 2 } },
    ],
  },
  {
    name: 'Admin · Modules & Permissions', icon: '🔐',
    endpoints: [
      { method: 'GET',    path: '/api/admin/modules', desc: 'List API modules.', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/modules', desc: 'Create an API module.', auth: 'admin' },
      { method: 'PUT',    path: '/api/admin/modules', desc: 'Update an API module.', auth: 'admin' },
      { method: 'GET',    path: '/api/admin/module-permissions', desc: 'List module permission grants.', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/module-permissions', desc: 'Grant a module to a client.', auth: 'admin' },
      { method: 'PUT',    path: '/api/admin/module-permissions', desc: 'Update a module grant.', auth: 'admin' },
      { method: 'DELETE', path: '/api/admin/module-permissions', desc: 'Revoke a module grant.', auth: 'admin' },
      { method: 'GET',    path: '/api/admin/user-module-permissions', desc: 'Per-user module permission map.', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/user-module-permissions', desc: 'Set per-user module permissions.', auth: 'admin' },
      { method: 'GET',    path: '/api/admin/master-api', desc: 'List master API methods/URLs.', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/master-api', desc: 'Create a master API method.', auth: 'admin' },
      { method: 'PUT',    path: '/api/admin/master-api', desc: 'Update a master API method.', auth: 'admin' },
    ],
  },
  {
    name: 'Admin · PowerBI', icon: '📊',
    endpoints: [
      { method: 'GET',    path: '/api/admin/dashboards', desc: 'List published dashboards + totals.', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/dashboards', desc: 'Publish a dashboard mapping.', auth: 'admin' },
      { method: 'PUT',    path: '/api/admin/dashboards', desc: 'Update a dashboard mapping.', auth: 'admin' },
      { method: 'DELETE', path: '/api/admin/dashboards', desc: 'Remove a dashboard mapping.', auth: 'admin' },
      { method: 'GET',    path: '/api/admin/powerbi-creds', desc: 'List PowerBI credentials (masked).', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/powerbi-creds', desc: 'Add PowerBI credentials (encrypted).', auth: 'admin', sampleBody: { clientId: '…', clientSecret: '…', tenantId: '…', workspaceId: '…' } },
      { method: 'PUT',    path: '/api/admin/powerbi-creds', desc: 'Update PowerBI credentials.', auth: 'admin' },
      { method: 'DELETE', path: '/api/admin/powerbi-creds', desc: 'Delete PowerBI credentials.', auth: 'admin', sampleBody: { id: 1 } },
      { method: 'GET',    path: '/api/admin/powerbi-creds/reveal', desc: 'Reveal decrypted credentials for one row.', auth: 'admin', params: [{ name: 'id', in: 'query', required: true }] },
      { method: 'GET',    path: '/api/admin/powerbi-workspace', desc: 'Live workspace: reports, datasets, refresh history.', auth: 'admin' },
      { method: 'GET',    path: '/api/admin/powerbi-workspace/activity', desc: 'Workspace activity-event change log.', auth: 'admin', params: [{ name: 'days', in: 'query', desc: '7 / 14 / 30' }] },
    ],
  },
  {
    name: 'Admin · Settings & Email', icon: '📧',
    endpoints: [
      { method: 'GET',    path: '/api/admin/email-templates', desc: 'List email templates.', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/email-templates', desc: 'Create an email template.', auth: 'admin' },
      { method: 'PUT',    path: '/api/admin/email-templates', desc: 'Update an email template.', auth: 'admin' },
      { method: 'DELETE', path: '/api/admin/email-templates', desc: 'Delete an email template.', auth: 'admin' },
      { method: 'GET',    path: '/api/admin/email-credentials', desc: 'List SMTP credentials (decrypted).', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/email-credentials', desc: 'Add SMTP credentials (encrypted).', auth: 'admin' },
      { method: 'PUT',    path: '/api/admin/email-credentials', desc: 'Update SMTP credentials.', auth: 'admin' },
      { method: 'DELETE', path: '/api/admin/email-credentials', desc: 'Delete SMTP credentials.', auth: 'admin' },
      { method: 'GET',    path: '/api/admin/api-credentials', desc: 'List IP House API credentials (decrypted).', auth: 'admin' },
      { method: 'PUT',    path: '/api/admin/api-credentials', desc: 'Update IP House API credentials (encrypted).', auth: 'admin', sampleBody: { userId: 101, apiUserName: '…', apiPassword: '…' } },
      { method: 'DELETE', path: '/api/admin/api-credentials', desc: 'Clear IP House API credentials.', auth: 'admin', sampleBody: { userId: 101 } },
      { method: 'GET',    path: '/api/admin/settings', desc: 'Get admin settings.', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/settings', desc: 'Create settings entry.', auth: 'admin' },
      { method: 'PUT',    path: '/api/admin/settings', desc: 'Update settings.', auth: 'admin' },
      { method: 'GET',    path: '/api/admin/idle-timeout', desc: 'List client idle-timeout settings.', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/idle-timeout', desc: 'Set a client idle-timeout.', auth: 'admin' },
      { method: 'DELETE', path: '/api/admin/idle-timeout', desc: 'Reset a client idle-timeout.', auth: 'admin' },
      { method: 'GET',    path: '/api/admin/asset-access', desc: 'List asset-based access assignments.', auth: 'admin' },
      { method: 'POST',   path: '/api/admin/asset-access', desc: 'Assign/fetch assets for a client login.', auth: 'admin' },
    ],
  },
  {
    name: 'Admin · Analytics & Tracking', icon: '📡',
    endpoints: [
      { method: 'GET',  path: '/api/admin/activity-stats', desc: 'Aggregate activity statistics.', auth: 'admin' },
      { method: 'GET',  path: '/api/admin/tracking', desc: 'Paginated activity log with filters.', auth: 'admin', params: [{ name: 'limit', in: 'query' }, { name: 'offset', in: 'query' }, { name: 'action', in: 'query' }, { name: 'search', in: 'query' }, { name: 'from', in: 'query' }, { name: 'to', in: 'query' }] },
      { method: 'POST', path: '/api/admin/tracking', desc: 'Record an activity-log event.', auth: 'admin' },
      { method: 'GET',  path: '/api/admin/tracking/analytics', desc: 'Usage analytics for charts.', auth: 'admin' },
      { method: 'GET',  path: '/api/admin/home-analytics', desc: 'Admin home dashboard analytics.', auth: 'admin' },
    ],
  },
  {
    name: 'Admin · Registrations', icon: '📋',
    endpoints: [
      { method: 'GET',  path: '/api/admin/registrations', desc: 'List registrations.', auth: 'admin' },
      { method: 'PUT',  path: '/api/admin/registrations', desc: 'Update a registration.', auth: 'admin' },
      { method: 'GET',  path: '/api/admin/registration-requests', desc: 'List pending registration requests.', auth: 'admin' },
      { method: 'GET',  path: '/api/admin/shared-logins', desc: 'List shared-login mappings.', auth: 'admin' },
      { method: 'POST', path: '/api/admin/shared-logins', desc: 'Create a shared-login mapping.', auth: 'admin' },
    ],
  },
  {
    name: 'Super Admin', icon: '👑',
    endpoints: [
      { method: 'GET',  path: '/api/admin/super-admin', desc: 'Super-admin dashboard data.', auth: 'superadmin' },
      { method: 'PUT',  path: '/api/admin/super-admin', desc: 'Update super-admin settings.', auth: 'superadmin' },
      { method: 'GET',  path: '/api/admin/super-admin/active-sessions', desc: 'List active user sessions.', auth: 'superadmin' },
      { method: 'POST', path: '/api/admin/super-admin/force-logout', desc: 'Force-logout a session.', auth: 'superadmin', sampleBody: { loginId: 5 } },
      { method: 'GET',  path: '/api/admin/super-admin/permissions', desc: 'List permission matrix.', auth: 'superadmin' },
      { method: 'PUT',  path: '/api/admin/super-admin/permissions', desc: 'Update permission matrix.', auth: 'superadmin' },
    ],
  },
]

/* ── Markscan external API catalogue ─────────────────────────────────────── */
const MARKSCAN_BASE = 'https://api.markscan.co.in'

interface MarkscanEndpoint {
  method: 'GET' | 'POST'
  path: string
  desc: string
  auth: 'none' | 'bearer'
  note?: string
  requestBody?: Record<string, any>
  responseBody?: any
}
interface MarkscanGroup { name: string; icon: string; color: string; endpoints: MarkscanEndpoint[] }

const MARKSCAN_GROUPS: MarkscanGroup[] = [
  {
    name: 'Authentication', icon: '🔑', color: BLUE,
    endpoints: [
      {
        method: 'POST', path: '/Login', desc: 'Authenticate and receive a Bearer token used for all subsequent requests.', auth: 'none',
        requestBody: { userName: 'your_api_username', password: 'your_api_password' },
        responseBody: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsIm5hbWUiOiJJUCBIb3VzZSJ9.abc123…',
      },
    ],
  },
  {
    name: 'Reference Data', icon: '📂', color: VIOLET,
    endpoints: [
      {
        method: 'GET', path: '/GetAllPlatforms', desc: 'Returns all platforms available for the authenticated account.', auth: 'bearer',
        responseBody: [{ id: 1, name: 'Facebook', slug: 'facebook' }, { id: 2, name: 'YouTube', slug: 'youtube' }, '...'],
      },
      {
        method: 'GET', path: '/GetAllAssets', desc: 'Returns all copyright assets (brands/titles) linked to the account.', auth: 'bearer',
        responseBody: [{ id: 1, name: 'Asset Title 1' }, { id: 2, name: 'Asset Title 2' }, '...'],
      },
    ],
  },
  {
    name: 'Social Media Infringements', icon: '📱', color: ORANGE,
    endpoints: [
      {
        method: 'POST', path: '/Facebook/Paged', desc: 'Paginated infringement records detected on Facebook.', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 1001, url: 'https://facebook.com/post/…', status: 'Detected', detectedDate: '2026-01-10' }], total: 142, pageNo: 0 },
      },
      {
        method: 'POST', path: '/YouTube/Paged', desc: 'Paginated infringement records detected on YouTube.', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 2001, url: 'https://youtube.com/watch?v=…', status: 'Enforced', detectedDate: '2026-01-12' }], total: 78, pageNo: 0 },
      },
      {
        method: 'POST', path: '/Instagram/Paged', desc: 'Paginated infringement records detected on Instagram.', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 3001, url: 'https://instagram.com/p/…', status: 'Detected', detectedDate: '2026-01-08' }], total: 55, pageNo: 0 },
      },
      {
        method: 'POST', path: '/Twitter/Paged', desc: 'Paginated infringement records detected on Twitter / X.', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 4001, url: 'https://twitter.com/…', status: 'Detected', detectedDate: '2026-01-15' }], total: 33, pageNo: 0 },
      },
      {
        method: 'POST', path: '/Telegram/Paged', desc: 'Paginated infringement records detected on Telegram.', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 5001, url: 'https://t.me/channel/…', status: 'Detected', detectedDate: '2026-01-05' }], total: 19, pageNo: 0 },
      },
      {
        method: 'POST', path: '/Internet/Paged', desc: 'Paginated infringement records detected on general internet (cyberlockers, piracy sites, etc.).', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 6001, url: 'https://piracy-site.com/download/…', status: 'Enforced', detectedDate: '2026-01-03' }], total: 210, pageNo: 0 },
      },
    ],
  },
  {
    name: 'UGC Platforms', icon: '🎵', color: '#0891b2',
    endpoints: [
      {
        method: 'POST', path: '/UGCPlatform/Paged',
        desc: 'Paginated records for UGC/short-form platforms. Supported values for `platform`: tiktok, vk, ok, chomikuj, sharechat, dailymotion, bilibili.',
        auth: 'bearer',
        note: 'The `platform` field is required and selects the target platform within this shared endpoint.',
        requestBody: { platform: 'tiktok', startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 7001, url: 'https://tiktok.com/@user/video/…', platform: 'tiktok', status: 'Detected', detectedDate: '2026-01-20' }], total: 88, pageNo: 0 },
      },
    ],
  },
  {
    name: 'App Store Infringements', icon: '📲', color: GREEN,
    endpoints: [
      {
        method: 'POST', path: '/GetInfringements/ItunesApiUrls', desc: 'Infringing apps and content detected on Apple iTunes / App Store.', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 8001, appName: 'Fake App', url: 'https://apps.apple.com/app/…', status: 'Detected' }], total: 12, pageNo: 0 },
      },
      {
        method: 'POST', path: '/GetInfringements/GooglePlaystoreAPIurls', desc: 'Infringing apps detected on Google Play Store.', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 9001, appName: 'Pirate App', url: 'https://play.google.com/store/apps/details?id=…', status: 'Enforced' }], total: 8, pageNo: 0 },
      },
      {
        method: 'POST', path: '/GetInfringements/ThirdPartyAppAPIurls', desc: 'Infringing content on third-party app distribution sites.', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 10001, url: 'https://apkpure.com/…', status: 'Detected' }], total: 5, pageNo: 0 },
      },
      {
        method: 'POST', path: '/GetInfringements/ThirdPartyMobileAppAPIurls', desc: 'Infringing content on third-party mobile app stores.', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 11001, url: 'https://aptoide.com/…', status: 'Detected' }], total: 3, pageNo: 0 },
      },
    ],
  },
  {
    name: 'Torrent / P2P', icon: '🌊', color: ROSE,
    endpoints: [
      {
        method: 'POST', path: '/GetInfringements/Internet/Test', desc: 'Infringement records from torrent and P2P sharing networks.', auth: 'bearer',
        requestBody: { startDate: '2026-01-01', endDate: '2026-01-31', assetName: 'Your Asset Name', pageNo: 0 },
        responseBody: { data: [{ urlId: 12001, url: 'magnet:?xt=urn:btih:…', infoHash: 'abc123', seeders: 42, status: 'Detected' }], total: 67, pageNo: 0 },
      },
    ],
  },
  {
    name: 'Enforcement Actions', icon: '🚨', color: '#b45309',
    endpoints: [
      {
        method: 'POST', path: '/SendtoEnforcementQc', desc: 'Send selected URL IDs to the enforcement quality-control queue for takedown processing.', auth: 'bearer',
        requestBody: { platform: 'facebook', assetName: 'Your Asset Name', urlids: [1001, 1002, 1003], comment: 'Confirmed copyright infringement', isSourceURL: false },
        responseBody: { success: true, message: 'URLs successfully queued for enforcement QC.', queued: 3 },
      },
      {
        method: 'POST', path: '/MarkAsInvalid', desc: 'Mark selected URL IDs as invalid / not infringing, removing them from the active detection pool.', auth: 'bearer',
        requestBody: { platform: 'facebook', assetName: 'Your Asset Name', urlids: [1004, 1005], comment: 'Official promotional content — not an infringement', isSourceURL: false },
        responseBody: { success: true, message: 'URLs successfully marked as invalid.', updated: 2 },
      },
    ],
  },
  {
    name: 'Search & Download', icon: '🔍', color: VIOLET,
    endpoints: [
      {
        method: 'POST', path: '/SearchandRetriveapi', desc: 'Search for a specific URL across all infringement records and return matching data.', auth: 'bearer',
        requestBody: { url: 'https://facebook.com/post/example', platform: 'facebook', isSrcUrl: false },
        responseBody: { found: true, data: { urlId: 1001, url: 'https://facebook.com/post/example', status: 'Detected', assetName: 'Your Asset', platform: 'facebook', detectedDate: '2026-01-10' } },
      },
      {
        method: 'POST', path: '/DownloadDataExtraction/{downloadId}', desc: 'Get a pre-signed download URL for an export file by its download job ID.', auth: 'bearer',
        note: 'Replace `{downloadId}` in the path with the actual numeric ID of the export job.',
        requestBody: null,
        responseBody: 'https://storage.markscan.co.in/exports/download_20260130_abc123.xlsx',
      },
    ],
  },
]

/* ── auth badge map ──────────────────────────────────────────────────────── */
const AUTH_BADGE: Record<Endpoint['auth'], { label: string; color: string }> = {
  public:     { label: 'Public',      color: SLATE },
  session:    { label: 'Session',     color: BLUE },
  admin:      { label: 'Admin',       color: ORANGE },
  superadmin: { label: 'Super Admin', color: VIOLET },
}

/* ── shared components ───────────────────────────────────────────────────── */
function MethodChip({ method }: { method: string }) {
  const c = METHOD_COLORS[method] ?? SLATE
  return (
    <span style={{ display: 'inline-block', minWidth: 54, textAlign: 'center', padding: '3px 8px', borderRadius: 6, background: `${c}20`, color: c, fontSize: 10, fontWeight: 800, letterSpacing: '0.04em', fontFamily: 'monospace' }}>
      {method}
    </span>
  )
}

function CopyButton({ text, isDark }: { text: string; isDark: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) })
  }
  return (
    <button onClick={copy}
      style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${isDark ? '#2a3f66' : '#e8ebf0'}`, background: isDark ? '#0f1f3d' : '#f8fafc', color: isDark ? '#8ba3c9' : SLATE, fontSize: 10, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
      {copied ? '✓ Copied' : '⧉ Copy'}
    </button>
  )
}

/* ── IP House try-it panel ───────────────────────────────────────────────── */
function TryPanel({ ep, onClose, isDark }: { ep: Endpoint; onClose: () => void; isDark: boolean }) {
  const c = useColors(isDark)
  const [pathVal, setPathVal] = useState(ep.path)
  const [body, setBody] = useState(ep.sampleBody ? JSON.stringify(ep.sampleBody, null, 2) : '')
  const [resp, setResp] = useState<{ status: number; text: string; ms: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const hasBody = ep.method !== 'GET'

  const send = async () => {
    setBusy(true); setResp(null)
    const t0 = performance.now()
    try {
      const opts: RequestInit = { method: ep.method, credentials: 'include', headers: {} }
      if (body.trim() && hasBody) {
        opts.headers = { 'Content-Type': 'application/json' }
        opts.body = body
      }
      const res = await fetch(pathVal, opts)
      const text = await res.text()
      let pretty = text
      try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch { /* keep raw */ }
      setResp({ status: res.status, text: pretty, ms: Math.round(performance.now() - t0) })
    } catch (e: any) {
      setResp({ status: 0, text: String(e?.message || e), ms: Math.round(performance.now() - t0) })
    }
    setBusy(false)
  }

  const statusColor = !resp ? c.subText : resp.status >= 200 && resp.status < 300 ? GREEN : resp.status === 0 ? ROSE : resp.status < 500 ? ORANGE : ROSE

  return (
    <div style={{ background: c.panelBg, borderTop: `1px solid ${c.cardBorder}`, padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <MethodChip method={ep.method} />
        <input value={pathVal} onChange={e => setPathVal(e.target.value)}
          style={{ flex: 1, padding: '7px 10px', borderRadius: 7, border: `1px solid ${c.inputBorder}`, background: c.inputBg, fontSize: 12, fontFamily: 'monospace', color: c.text, outline: 'none' }} />
        <button onClick={send} disabled={busy}
          style={{ padding: '7px 18px', borderRadius: 7, border: 'none', background: busy ? SLATE : NAVY, color: '#fff', fontSize: 12, fontWeight: 700, cursor: busy ? 'default' : 'pointer' }}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        <button onClick={onClose} style={{ padding: '7px 10px', borderRadius: 7, border: `1px solid ${c.cardBorder}`, background: c.card, color: c.subText, fontSize: 12, cursor: 'pointer' }}>✕</button>
      </div>

      {ep.params && ep.params.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: c.subText, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Parameters</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {ep.params.map(p => (
              <span key={p.name} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: c.card, border: `1px solid ${c.cardBorder}`, color: c.text }}>
                <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{p.name}</span>
                <span style={{ color: c.subText }}> · {p.in}{p.required ? ' · required' : ''}{p.desc ? ` · ${p.desc}` : ''}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {hasBody && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: c.subText, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Request Body (JSON)</div>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={Math.min(10, Math.max(3, body.split('\n').length))}
            placeholder="{ }"
            style={{ width: '100%', padding: '10px', borderRadius: 8, border: `1px solid ${c.inputBorder}`, background: c.inputBg, fontSize: 12, fontFamily: 'monospace', color: c.text, outline: 'none', boxSizing: 'border-box', resize: 'vertical' }} />
        </div>
      )}

      {resp && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
            <span style={{ fontSize: 9, fontWeight: 800, color: c.subText, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Response</span>
            <span style={{ fontSize: 11, fontWeight: 800, color: statusColor }}>{resp.status === 0 ? 'NETWORK ERROR' : `HTTP ${resp.status}`}</span>
            <span style={{ fontSize: 10, color: c.subText }}>· {resp.ms} ms</span>
          </div>
          <pre style={{ margin: 0, maxHeight: 320, overflow: 'auto', padding: '12px', borderRadius: 8, background: c.codeBg, color: '#d6e2f5', fontSize: 11.5, lineHeight: 1.6, fontFamily: 'monospace' }}>
            {resp.text || '(empty body)'}
          </pre>
        </div>
      )}
    </div>
  )
}

/* ── Markscan doc card ───────────────────────────────────────────────────── */
function MarkscanCard({ ep, groupColor, isDark }: { ep: MarkscanEndpoint; groupColor: string; isDark: boolean }) {
  const c = useColors(isDark)
  const [open, setOpen] = useState(false)

  const reqStr = ep.requestBody !== null && ep.requestBody !== undefined
    ? JSON.stringify(ep.requestBody, null, 2)
    : null
  const resStr = ep.responseBody !== undefined
    ? (typeof ep.responseBody === 'string' ? ep.responseBody : JSON.stringify(ep.responseBody, null, 2))
    : null

  const curlAuth = ep.auth === 'bearer' ? ' \\\n  -H "Authorization: Bearer <token>"' : ''
  const curlBody = reqStr ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${reqStr}'` : ''
  const curlStr = `curl -X ${ep.method} "${MARKSCAN_BASE}${ep.path}"${curlAuth}${curlBody}`

  return (
    <div style={{ border: `1px solid ${c.cardBorder}`, borderRadius: 12, overflow: 'hidden', background: c.card }}>
      {/* header row */}
      <button onClick={() => setOpen(v => !v)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <MethodChip method={ep.method} />
        <code style={{ fontSize: 13, fontWeight: 700, color: c.text, fontFamily: 'monospace', flexShrink: 0 }}>{ep.path}</code>
        {ep.auth === 'bearer' && (
          <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 5, background: `${groupColor}18`, color: groupColor, flexShrink: 0 }}>Bearer Auth</span>
        )}
        {ep.auth === 'none' && (
          <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 5, background: `${SLATE}15`, color: SLATE, flexShrink: 0 }}>Public</span>
        )}
        <span style={{ fontSize: 12, color: c.subText, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ep.desc}</span>
        <span style={{ color: c.subText, fontSize: 12, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ borderTop: `1px solid ${c.cardBorder}`, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* description */}
          <p style={{ fontSize: 13, color: c.subText, margin: 0, lineHeight: 1.6 }}>{ep.desc}</p>

          {/* note */}
          {ep.note && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: `${ORANGE}12`, border: `1px solid ${ORANGE}30`, fontSize: 12, color: isDark ? '#fbbf7a' : '#92400e' }}>
              ⚠️ {ep.note}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* request body */}
            {reqStr && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: c.subText, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Request Body</span>
                  <CopyButton text={reqStr} isDark={isDark} />
                </div>
                <pre style={{ margin: 0, padding: '12px 14px', borderRadius: 8, background: c.codeBg, color: '#d6e2f5', fontSize: 12, fontFamily: 'monospace', lineHeight: 1.6, overflow: 'auto', maxHeight: 260 }}>{reqStr}</pre>
              </div>
            )}
            {ep.requestBody === null && (
              <div style={{ padding: '8px 14px', borderRadius: 8, background: c.panelBg, border: `1px solid ${c.cardBorder}`, fontSize: 12, color: c.subText }}>
                No request body required.
              </div>
            )}

            {/* response body */}
            {resStr && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: c.subText, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Sample Response</span>
                  <CopyButton text={resStr} isDark={isDark} />
                </div>
                <pre style={{ margin: 0, padding: '12px 14px', borderRadius: 8, background: c.codeBg, color: '#a8f0c0', fontSize: 12, fontFamily: 'monospace', lineHeight: 1.6, overflow: 'auto', maxHeight: 260 }}>{resStr}</pre>
              </div>
            )}

            {/* cURL */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: c.subText, textTransform: 'uppercase', letterSpacing: '0.08em' }}>cURL</span>
                <CopyButton text={curlStr} isDark={isDark} />
              </div>
              <pre style={{ margin: 0, padding: '12px 14px', borderRadius: 8, background: c.codeBg, color: '#c9d8f0', fontSize: 11.5, fontFamily: 'monospace', lineHeight: 1.7, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{curlStr}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── main page ───────────────────────────────────────────────────────────── */
export default function ApiPlaygroundPage() {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const c = useColors(isDark)

  const [tab, setTab] = useState<'iphouse' | 'markscan'>('iphouse')
  const [search, setSearch]       = useState('')
  const [methodSel, setMethodSel] = useState<string>('all')
  const [open, setOpen]           = useState<string | null>(null)

  const totalIPH = useMemo(() => IPHOUSE_GROUPS.reduce((s, g) => s + g.endpoints.length, 0), [])
  const totalMS  = useMemo(() => MARKSCAN_GROUPS.reduce((s, g) => s + g.endpoints.length, 0), [])

  const filteredIPH = useMemo(() => {
    const q = search.toLowerCase()
    return IPHOUSE_GROUPS.map(g => ({
      ...g,
      endpoints: g.endpoints.filter(e =>
        (methodSel === 'all' || e.method === methodSel) &&
        (!q || e.path.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q))
      ),
    })).filter(g => g.endpoints.length > 0)
  }, [search, methodSel])

  const filteredMS = useMemo(() => {
    const q = search.toLowerCase()
    return MARKSCAN_GROUPS.map(g => ({
      ...g,
      endpoints: g.endpoints.filter(e =>
        (methodSel === 'all' || e.method === methodSel) &&
        (!q || e.path.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q))
      ),
    })).filter(g => g.endpoints.length > 0)
  }, [search, methodSel])

  const shownCount = tab === 'iphouse'
    ? filteredIPH.reduce((s, g) => s + g.endpoints.length, 0)
    : filteredMS.reduce((s, g) => s + g.endpoints.length, 0)
  const totalCount = tab === 'iphouse' ? totalIPH : totalMS

  return (
    <div className="p-6 fade-in">
      <AdminPageHeader
        backHref="/admin/configuration"
        breadcrumb={[{ label: 'API Playground' }]}
        title="API Playground"
        description="Browse and test every API endpoint used across the IP House platform"
      />

      {/* tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, padding: 4, background: c.panelBg, border: `1px solid ${c.cardBorder}`, borderRadius: 12, width: 'fit-content' }}>
        {([
          { id: 'iphouse',  label: '🏠 IP House API',      count: totalIPH },
          { id: 'markscan', label: '🌐 Markscan External', count: totalMS },
        ] as const).map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSearch(''); setMethodSel('all'); setOpen(null) }}
            style={{ padding: '8px 18px', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', transition: 'all 0.15s',
              background: tab === t.id ? NAVY : 'transparent',
              color: tab === t.id ? '#fff' : c.subText }}>
            {t.label}
            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, padding: '1px 6px', borderRadius: 100,
              background: tab === t.id ? 'rgba(255,255,255,0.2)' : (isDark ? '#1a2d4e' : '#e8ebf0'),
              color: tab === t.id ? '#fff' : c.subText }}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Markscan banner */}
      {tab === 'markscan' && (
        <div style={{ marginBottom: 18, padding: '14px 18px', borderRadius: 12, background: isDark ? '#0f2040' : '#f0f5ff', border: `1px solid ${isDark ? '#2a3f66' : '#c7d7f5'}`, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: BLUE, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Base URL</span>
          <code style={{ fontSize: 13, fontWeight: 700, color: isDark ? '#93c5fd' : BLUE, fontFamily: 'monospace' }}>{MARKSCAN_BASE}</code>
          <CopyButton text={MARKSCAN_BASE} isDark={isDark} />
          <span style={{ marginLeft: 'auto', fontSize: 11, color: c.subText }}>Server-side only · Bearer token auth · SSL bypass enabled</span>
        </div>
      )}

      {/* toolbar */}
      <div style={{ background: c.card, border: `1px solid ${c.cardBorder}`, borderRadius: 12, padding: '14px 16px', marginBottom: 20, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by path or description…"
          style={{ flex: 1, minWidth: 200, height: 38, padding: '0 12px', borderRadius: 8, border: `1px solid ${c.inputBorder}`, background: c.inputBg, fontSize: 13, color: c.text, outline: 'none', fontFamily: 'inherit' }} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['all', 'GET', 'POST', 'PUT', 'DELETE'].map(m => (
            <button key={m} onClick={() => setMethodSel(m)}
              style={{ padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: methodSel === m ? (m === 'all' ? NAVY : `${METHOD_COLORS[m]}20`) : c.inputBg,
                color: methodSel === m ? (m === 'all' ? '#fff' : METHOD_COLORS[m]) : c.subText,
                border: `1px solid ${methodSel === m && m !== 'all' ? METHOD_COLORS[m] + '60' : c.cardBorder}` }}>
              {m === 'all' ? 'All' : m}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 12, color: c.subText, marginLeft: 'auto' }}>{shownCount} of {totalCount} endpoints</span>
      </div>

      {/* ── IP House tab ── */}
      {tab === 'iphouse' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {filteredIPH.map(group => (
            <div key={group.name} style={{ background: c.card, borderRadius: 16, overflow: 'hidden', border: `1px solid ${c.cardBorder}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', background: NAVY }}>
                <span style={{ fontSize: 16 }}>{group.icon}</span>
                <h3 style={{ fontWeight: 700, fontSize: 13, color: '#fff', margin: 0 }}>{group.name}</h3>
                <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 100, background: 'rgba(255,255,255,0.15)', color: '#fff' }}>
                  {group.endpoints.length}
                </span>
              </div>
              <div>
                {group.endpoints.map((ep, i) => {
                  const key = ep.method + ep.path
                  const isOpen = open === key
                  const badge = AUTH_BADGE[ep.auth]
                  return (
                    <div key={key} style={{ borderTop: i === 0 ? 'none' : `1px solid ${c.cardBorder}` }}>
                      <button onClick={() => setOpen(isOpen ? null : key)}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                        onMouseEnter={e => (e.currentTarget.style.background = c.rowHover)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                        <MethodChip method={ep.method} />
                        <code style={{ fontSize: 13, fontWeight: 600, color: c.text, fontFamily: 'monospace', flexShrink: 0 }}>{ep.path}</code>
                        <span style={{ fontSize: 12, color: c.subText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'none' }} className="md:block">{ep.desc}</span>
                        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: `${badge.color}18`, color: badge.color }}>{badge.label}</span>
                          <span style={{ color: c.subText, fontSize: 11 }}>{isOpen ? '▲ Try' : '▼ Try'}</span>
                        </span>
                      </button>
                      {isOpen && <TryPanel ep={ep} onClose={() => setOpen(null)} isDark={isDark} />}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {filteredIPH.length === 0 && (
            <div style={{ background: c.card, border: `1px solid ${c.cardBorder}`, borderRadius: 16, padding: '64px 0', textAlign: 'center', fontSize: 14, color: c.subText }}>
              No endpoints match your filter.
            </div>
          )}
        </div>
      )}

      {/* ── Markscan tab ── */}
      {tab === 'markscan' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {filteredMS.map(group => (
            <div key={group.name}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{ width: 4, height: 20, borderRadius: 2, background: group.color }} />
                <span style={{ fontSize: 16 }}>{group.icon}</span>
                <h3 style={{ fontWeight: 800, fontSize: 14, color: c.text, margin: 0 }}>{group.name}</h3>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 100, background: `${group.color}18`, color: group.color }}>
                  {group.endpoints.length} endpoint{group.endpoints.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {group.endpoints.map(ep => (
                  <MarkscanCard key={ep.method + ep.path} ep={ep} groupColor={group.color} isDark={isDark} />
                ))}
              </div>
            </div>
          ))}
          {filteredMS.length === 0 && (
            <div style={{ background: c.card, border: `1px solid ${c.cardBorder}`, borderRadius: 16, padding: '64px 0', textAlign: 'center', fontSize: 14, color: c.subText }}>
              No endpoints match your filter.
            </div>
          )}
        </div>
      )}

      <p style={{ marginTop: 24, fontSize: 11, textAlign: 'center', color: c.subText }}>
        IP House Platform · API Reference · {new Date().getFullYear()}
      </p>
    </div>
  )
}
