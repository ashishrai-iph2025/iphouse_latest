import { Link } from 'react-router-dom'
import AdminPageHeader from '@/components/admin/AdminPageHeader'


const CONFIG_CARDS = [
  {
    href:  '/admin/modules',
    icon:  '🔐',
    title: 'API Modules',
    desc:  'Create, update and delete API modules.',
    color: '#0078D4',
  },
  {
    href:  '/admin/api-credentials',
    icon:  '🔑',
    title: 'Manage API Credentials',
    desc:  'Manage API credentials to access real-time data for clients.',
    color: '#7C3AED',
  },
  {
    href:  '/admin/dashboards',
    icon:  '📊',
    title: 'PowerBI Dashboard Modules',
    desc:  'Manage dashboards like Internet, Social Media, Telegram etc.',
    color: '#F59E0B',
  },
  {
    href:  '/admin/module-permissions',
    icon:  '🛡️',
    title: 'API Module Permissions',
    desc:  'Grant and revoke API module access from/to clients.',
    color: '#10B981',
  },
  {
    href:  '/admin/master-api',
    icon:  '🌐',
    title: 'Manage API Methods',
    desc:  'Manage API URLs and endpoint methods.',
    color: '#EC4899',
  },
  {
    href:  '/admin/powerbi-creds',
    icon:  '📈',
    title: 'PowerBI API Credentials',
    desc:  'Configure PowerBI API credentials.',
    color: '#F97316',
  },
  {
    href:  '/admin/powerbi-workspace',
    icon:  '🗃️',
    title: 'PowerBI Workspace',
    desc:  'View reports, datasets, refresh schedules and refresh history from your PowerBI workspace.',
    color: '#F59E0B',
  },
  {
    href:  '/admin/settings',
    icon:  '📧',
    title: 'Email Credentials',
    desc:  'Manage SMTP/email credentials and configuration.',
    color: '#0078D4',
  },
  {
    href:  '/admin/idle-timeout',
    icon:  '⏱️',
    title: "Client's Session Timeout",
    desc:  'Manage client-wise idle timeout and auto-logout settings.',
    color: '#6366F1',
  },
  {
    href:  '/admin/registration-requests',
    icon:  '📋',
    title: 'User Registration Requests',
    desc:  'Review and approve user registration requests.',
    color: '#14B8A6',
  },
  {
    href:  '/admin/tracking',
    icon:  '📡',
    title: 'Tracking Report',
    desc:  'Application tracking and activity monitoring.',
    color: '#8B5CF6',
  },
  {
    href:  '/admin/asset-access',
    icon:  '🗂️',
    title: 'Asset Based Access',
    desc:  'Manage access based on required asset permissions.',
    color: '#EF4444',
  },
  {
    href:  '/admin/email-templates',
    icon:  '✉️',
    title: 'Email Templates',
    desc:  'Manage and customise system email templates.',
    color: '#0891B2',
  },
  {
    href:  '/admin/email-event-types',
    icon:  '🔔',
    title: 'Email Event Types',
    desc:  'Configure the event types that trigger system emails and manage their variables.',
    color: '#0891B2',
  },
  {
    href:  '/admin/api-playground',
    icon:  '🧪',
    title: 'API Playground',
    desc:  'Browse and test every API endpoint used across the platform.',
    color: '#14254A',
  },
]

export default function ConfigurationPage() {
  return (
    <div className="p-6 fade-in">

      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration' }]}
        title="Configuration"
        description="Manage system settings, API access, credentials, and permissions."
      />

      {/* Cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {CONFIG_CARDS.map(card => (
          <Link
            key={card.href}
            to={card.href}
            className="group bg-white rounded-2xl border border-gray-100 shadow-card hover:shadow-md hover:-translate-y-1 transition-all duration-200 p-5 flex flex-col gap-3 no-underline"
          >
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
              style={{ background: `${card.color}15` }}
            >
              {card.icon}
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-sm text-[#14254A] leading-snug group-hover:text-[#0078D4] transition-colors">
                {card.title}
              </h3>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">{card.desc}</p>
            </div>
            <div className="mt-auto pt-1">
              <span className="text-xs font-semibold transition-colors" style={{ color: card.color }}>
                Open →
              </span>
            </div>
          </Link>
        ))}
      </div>

    </div>
  )
}
