// Shared catalogue of Configuration-page modules.
//
// This is the single source of truth for the cards shown on /admin/configuration
// AND for the per-admin access toggles on the Super Admin → Configuration Access tab.
// Each module's `key` is the stable identifier persisted in dcp_admin_config_access.
// Keep the keys in sync with the Go seed list in handlers/admin/configaccess.go.

export type ConfigGroupKey =
  | 'access'
  | 'integrations'
  | 'reporting'
  | 'comms'
  | 'platform'
  | 'superadmin'

export interface ConfigGroup {
  key:   ConfigGroupKey
  label: string
  /** One line under the section heading — says what decisions live in here. */
  desc:  string
  /** Section accent. Every module inside inherits it, so colour answers
   *  "which part of the system is this" instead of being nineteen unrelated hues. */
  color: string
}

/* Ordered: the sections an admin reaches for daily come first, the ones that are
   set up once and rarely revisited come last. Super Admin sits at the bottom in
   red — it is the only group whose contents can lock people out. */
export const CONFIG_GROUPS: ConfigGroup[] = [
  { key: 'access',       label: 'Access & Security',         desc: 'Who can sign in, what they can reach, and for how long.',       color: '#0078D4' },
  { key: 'integrations', label: 'Integrations & Credentials', desc: 'Keys and connections to the systems this platform talks to.',  color: '#7C3AED' },
  { key: 'reporting',    label: 'Reporting & Dashboards',    desc: 'What gets reported, from which source, to whom.',               color: '#FC934C' },
  { key: 'comms',        label: 'Communications',            desc: 'The emails the platform sends and what triggers them.',         color: '#0891B2' },
  { key: 'platform',     label: 'Platform & Operations',     desc: 'Guides, activity trails and day-to-day housekeeping.',          color: '#10B981' },
  { key: 'superadmin',   label: 'Super Admin',               desc: 'Elevated controls. Changes here affect every account.',         color: '#DC2626' },
]

export const CONFIG_GROUP_BY_KEY = CONFIG_GROUPS.reduce(
  (acc, g) => { acc[g.key] = g; return acc },
  {} as Record<ConfigGroupKey, ConfigGroup>,
)

export interface ConfigModule {
  key:   string
  href:  string
  /** Emoji — still used by the Super Admin → Manage Access toggle grid, a dense
   *  3-across picker where a glyph reads faster than a line icon. The
   *  Configuration page renders the matching SVG from ConfigIcon instead. */
  icon:  string
  title: string
  desc:  string
  color: string
  group: ConfigGroupKey
  /** Extra words the search box should match. Titles are the formal name; these
   *  are what people actually type — "smtp" for Email Credentials, "s3" for
   *  backups, "lockout" for the security policy. Never rendered. */
  keywords?: string[]
  /** Kept out of the /admin/configuration card grid, but still a real module:
   *  the access toggle and the server-side grant check both continue to use it.
   *  For pages the sidebar already links to, where a card is a second door to
   *  the same room rather than the only one. */
  hideCard?: boolean
}

/* Module `color` is the group's colour rather than a per-module choice, so a new
   module cannot drift off-palette. Written out per entry (not computed) so the
   value stays greppable and any single module can still be overridden. */
export const CONFIG_MODULES: ConfigModule[] = [
  /* Deliberately first: it is the card that explains the others. Someone who
     does not yet know which three screens a task spans is exactly the reader
     scanning this grid. */
  { key: 'guidelines',            href: '/admin/guidelines',            icon: '📘', title: 'Setup Guidelines',           desc: 'Step-by-step: enabling API modules, Reports, the Dashboard, and editing email templates.', group: 'platform',     color: '#10B981', keywords: ['help', 'how to', 'docs', 'onboarding', 'getting started'] },
  { key: 'modules',               href: '/admin/modules',               icon: '🔐', title: 'API Modules',                desc: 'Create, update and delete API modules.',                                                   group: 'integrations', color: '#7C3AED', keywords: ['endpoints', 'services', 'catalogue'] },
  { key: 'api-credentials',       href: '/admin/api-credentials',       icon: '🔑', title: 'Manage API Credentials',     desc: 'Manage API credentials to access real-time data for clients.',                             group: 'integrations', color: '#7C3AED', keywords: ['api key', 'token', 'secret', 'realtime'] },
  { key: 'dashboard-modules',     href: '/admin/dashboard-modules',     icon: '📊', title: 'PowerBI Dashboard Modules',  desc: 'Manage dashboards like Open Web, Social Media, Telegram etc.',                              group: 'reporting',    color: '#FC934C', keywords: ['powerbi', 'open web', 'social media', 'telegram'] },
  { key: 'module-permissions',    href: '/admin/module-permissions',    icon: '🛡️', title: 'API Module Permissions',     desc: 'Grant and revoke API module access from/to clients.',                                      group: 'access',       color: '#0078D4', keywords: ['grant', 'revoke', 'entitlement', 'rbac'] },
  { key: 'powerbi-creds',         href: '/admin/powerbi-creds',         icon: '📈', title: 'PowerBI API Credentials',    desc: 'Configure PowerBI API credentials.',                                                       group: 'integrations', color: '#7C3AED', keywords: ['powerbi', 'azure', 'tenant', 'client secret'] },
  { key: 'powerbi-workspace',     href: '/admin/powerbi-workspace',     icon: '🗃️', title: 'PowerBI Workspace',          desc: 'View reports, datasets, refresh schedules and refresh history from your PowerBI workspace.', group: 'reporting',    color: '#FC934C', keywords: ['powerbi', 'dataset', 'refresh', 'schedule'] },
  { key: 'settings',              href: '/admin/settings',              icon: '📧', title: 'Email Credentials',          desc: 'Manage SMTP/email credentials and configuration.',                                          group: 'integrations', color: '#7C3AED', keywords: ['smtp', 'ses', 'mail server', 'sender'] },
  { key: 'idle-timeout',          href: '/admin/idle-timeout',          icon: '⏱️', title: "Client's Session Timeout", desc: 'Manage client-wise idle timeout and auto-logout settings.',                              group: 'access',       color: '#0078D4', keywords: ['idle', 'auto logout', 'session', 'inactivity'] },
  { key: 'registration-requests', href: '/admin/registration-requests', icon: '📋', title: 'User Registration Requests', desc: 'Review and approve user registration requests.',                                           group: 'access',       color: '#0078D4', keywords: ['approve', 'signup', 'pending'], hideCard: true },
  { key: 'tracking',              href: '/admin/tracking',              icon: '📡', title: 'Tracking Report',            desc: 'Application tracking and activity monitoring.',                                            group: 'platform',     color: '#10B981', keywords: ['audit', 'logs', 'activity', 'monitoring'] },
  { key: 'asset-access',          href: '/admin/asset-access',          icon: '🗂️', title: 'Asset Based Access',         desc: 'Manage access based on required asset permissions.',                                       group: 'access',       color: '#0078D4', keywords: ['asset', 'brand', 'title', 'scope'] },
  { key: 'war-room-assets',       href: '/admin/war-room-assets',       icon: '⚔️', title: 'War Room Assets',            desc: 'Per-client War Room settings — enable or disable the Asset Comparison tab.',               group: 'reporting',    color: '#FC934C', keywords: ['war room', 'asset comparison'] },
  { key: 'report-config',         href: '/admin/report-config',         icon: '🧭', title: 'Report Configuration',       desc: 'Map platform reports to warehouse tables and control who can see them.',                   group: 'reporting',    color: '#FC934C', keywords: ['warehouse', 'table', 'mapping', 'platform'] },
  { key: 'email-templates',       href: '/admin/email-templates',       icon: '✉️', title: 'Email Templates',            desc: 'Manage and customise system email templates.',                                             group: 'comms',        color: '#0891B2', keywords: ['template', 'body', 'subject', 'branding'] },
  { key: 'email-event-types',     href: '/admin/email-event-types',     icon: '🔔', title: 'Email Event Types',          desc: 'Configure the event types that trigger system emails and manage their variables.',         group: 'comms',        color: '#0891B2', keywords: ['trigger', 'notification', 'variables', 'event'] },
  { key: 'client-admins',         href: '/admin/client-admins',         icon: '👥', title: 'Client Admins',              desc: 'Let a client user govern Account Access for their own company — view its users and grant or revoke their sign-in.', group: 'access', color: '#0078D4', keywords: ['delegate', 'account access', 'company admin'] },
]

/* Not part of the grant-based module system — visibility is role === 2, full
   stop. Kept in the same shape so the Configuration page can lay them out
   through exactly the same code path as everything else. */
export const SUPER_ADMIN_MODULES: ConfigModule[] = [
  { key: 'security-policy', href: '/admin/security-policy', icon: '🛡️', title: 'Security Policy', desc: 'Password lifetime and expiry warnings, and what happens after too many wrong sign-in attempts.', group: 'superadmin', color: '#DC2626', keywords: ['password', 'lockout', 'expiry', 'attempts'] },
  { key: 'aws-credentials', href: '/admin/aws-credentials', icon: '🔐', title: 'AWS Credentials', desc: 'Securely store the AWS keys used for S3 database backups (encrypted at rest).',                  group: 'superadmin', color: '#DC2626', keywords: ['aws', 's3', 'access key', 'iam'] },
  { key: 'database-backup', href: '/admin/database-backup', icon: '🗄️', title: 'Database Backup', desc: 'Take an on-demand database backup to Amazon S3 and view stored backups.',                        group: 'superadmin', color: '#DC2626', keywords: ['backup', 'restore', 's3', 'dump', 'snapshot'] },
]

export const CONFIG_MODULE_KEYS = CONFIG_MODULES.map(m => m.key)
