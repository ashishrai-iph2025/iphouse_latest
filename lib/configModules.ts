// Shared catalogue of Configuration-page modules.
//
// This is the single source of truth for the cards shown on /admin/configuration
// AND for the per-admin access toggles on the Super Admin → Configuration Access tab.
// Each module's `key` is the stable identifier persisted in dcp_admin_config_access.
// Keep the keys in sync with the Go seed list in handlers/admin/configaccess.go.

export interface ConfigModule {
  key:   string
  href:  string
  icon:  string
  title: string
  desc:  string
  color: string
}

export const CONFIG_MODULES: ConfigModule[] = [
  { key: 'modules',               href: '/admin/modules',               icon: '🔐', title: 'API Modules',                desc: 'Create, update and delete API modules.',                                          color: '#0078D4' },
  { key: 'api-credentials',       href: '/admin/api-credentials',       icon: '🔑', title: 'Manage API Credentials',     desc: 'Manage API credentials to access real-time data for clients.',                    color: '#7C3AED' },
  { key: 'dashboard-modules',     href: '/admin/dashboard-modules',     icon: '📊', title: 'PowerBI Dashboard Modules',  desc: 'Manage dashboards like Internet, Social Media, Telegram etc.',                     color: '#F59E0B' },
  { key: 'module-permissions',    href: '/admin/module-permissions',    icon: '🛡️', title: 'API Module Permissions',     desc: 'Grant and revoke API module access from/to clients.',                              color: '#10B981' },
  { key: 'master-api',            href: '/admin/master-api',            icon: '🌐', title: 'Manage API Methods',         desc: 'Manage API URLs and endpoint methods.',                                           color: '#EC4899' },
  { key: 'powerbi-creds',         href: '/admin/powerbi-creds',         icon: '📈', title: 'PowerBI API Credentials',    desc: 'Configure PowerBI API credentials.',                                              color: '#F97316' },
  { key: 'powerbi-workspace',     href: '/admin/powerbi-workspace',     icon: '🗃️', title: 'PowerBI Workspace',          desc: 'View reports, datasets, refresh schedules and refresh history from your PowerBI workspace.', color: '#F59E0B' },
  { key: 'settings',              href: '/admin/settings',              icon: '📧', title: 'Email Credentials',          desc: 'Manage SMTP/email credentials and configuration.',                                color: '#0078D4' },
  { key: 'idle-timeout',          href: '/admin/idle-timeout',          icon: '⏱️', title: "Client's Session Timeout",   desc: 'Manage client-wise idle timeout and auto-logout settings.',                       color: '#6366F1' },
  { key: 'registration-requests', href: '/admin/registration-requests', icon: '📋', title: 'User Registration Requests', desc: 'Review and approve user registration requests.',                                  color: '#14B8A6' },
  { key: 'tracking',              href: '/admin/tracking',              icon: '📡', title: 'Tracking Report',            desc: 'Application tracking and activity monitoring.',                                    color: '#8B5CF6' },
  { key: 'asset-access',          href: '/admin/asset-access',          icon: '🗂️', title: 'Asset Based Access',         desc: 'Manage access based on required asset permissions.',                              color: '#EF4444' },
  { key: 'email-templates',       href: '/admin/email-templates',       icon: '✉️', title: 'Email Templates',            desc: 'Manage and customise system email templates.',                                    color: '#0891B2' },
  { key: 'email-event-types',     href: '/admin/email-event-types',     icon: '🔔', title: 'Email Event Types',          desc: 'Configure the event types that trigger system emails and manage their variables.', color: '#0891B2' },
  { key: 'api-playground',        href: '/admin/api-playground',        icon: '🧪', title: 'API Playground',             desc: 'Browse and test every API endpoint used across the platform.',                    color: '#14254A' },
]

export const CONFIG_MODULE_KEYS = CONFIG_MODULES.map(m => m.key)
