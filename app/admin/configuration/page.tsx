'use client'

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import { CONFIG_MODULES } from '@/lib/configModules'

// Cards shown only to Super Admins — not part of the grant-based module system.
const SUPER_ADMIN_CARDS = [
  { key: 'security-policy', href: '/admin/security-policy', icon: '🛡️', title: 'Security Policy',
    desc: 'Password lifetime and expiry warnings, and what happens after too many wrong sign-in attempts.', color: '#DC2626' },
  { key: 'aws-credentials', href: '/admin/aws-credentials', icon: '🔐', title: 'AWS Credentials',
    desc: 'Securely store the AWS keys used for S3 database backups (encrypted at rest).', color: '#F59E0B' },
  { key: 'database-backup', href: '/admin/database-backup', icon: '🗄️', title: 'Database Backup',
    desc: 'Take an on-demand database backup to Amazon S3 and view stored backups.', color: '#0EA5E9' },
]

export default function ConfigurationPage() {
  // Modules the current admin is allowed to see (grant-based: default deny).
  // A Super Admin shares specific modules; an admin sees only those.
  const [granted, setGranted] = useState<Set<string> | null>(null)
  const [role,    setRole]    = useState<number>(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/admin/my-config-access', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.success && Array.isArray(d.granted)) setGranted(new Set(d.granted))
        else setGranted(new Set())
        setRole(Number(d.role ?? 0))
      })
      .catch(() => setGranted(new Set()))
      .finally(() => setLoading(false))
  }, [])

  // Grant-based cards (default deny), plus any Super-Admin-only cards.
  const grantCards = granted ? CONFIG_MODULES.filter(c => !c.hideCard && granted.has(c.key)) : []
  const cards = [
    ...grantCards,
    ...(role === 2 ? SUPER_ADMIN_CARDS : []),
  ]

  return (
    <div className="p-6 fade-in">

      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration' }]}
        title="Configuration"
        description="Manage system settings, API access, credentials, and permissions."
      />

      {/* Cards grid — capped at 4 across. items-stretch + h-full keeps every
          card in a row the same height regardless of description length, so the
          "Open →" affordance sits on a consistent baseline. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 items-stretch">
        {cards.map(card => (
          <Link
            key={card.href}
            to={card.href}
            className="group relative h-full bg-white rounded-2xl border border-gray-100 shadow-card hover:shadow-lg hover:-translate-y-1 transition-all duration-200 p-5 flex flex-col gap-3.5 no-underline overflow-hidden"
          >
            {/* Accent rail — picks up the module's colour on hover */}
            <span
              className="absolute left-0 top-0 bottom-0 w-1 opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ background: card.color }}
              aria-hidden
            />
            <div className="flex items-start gap-3">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl flex-shrink-0"
                style={{ background: `${card.color}15` }}
              >
                {card.icon}
              </div>
              <h3 className="font-semibold text-sm text-[#14254A] leading-snug pt-1 group-hover:text-[#0078D4] transition-colors">
                {card.title}
              </h3>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">{card.desc}</p>
            <div className="mt-auto pt-1 flex items-center gap-1">
              <span className="text-xs font-semibold transition-colors" style={{ color: card.color }}>
                Open
              </span>
              <span
                className="text-xs font-semibold transition-transform group-hover:translate-x-0.5"
                style={{ color: card.color }}
                aria-hidden
              >
                →
              </span>
            </div>
          </Link>
        ))}
      </div>

      {!loading && cards.length === 0 && (
        <div className="mt-6 bg-white rounded-2xl border border-gray-100 shadow-card p-10 text-center text-gray-400 text-sm">
          You don't have access to any configuration modules. Contact a Super Admin to request access.
        </div>
      )}

    </div>
  )
}
