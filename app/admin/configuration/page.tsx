'use client'

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import { CONFIG_MODULES } from '@/lib/configModules'

// Cards shown only to Super Admins — not part of the grant-based module system.
const SUPER_ADMIN_CARDS = [
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
  const grantCards = granted ? CONFIG_MODULES.filter(c => granted.has(c.key)) : []
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

      {/* Cards grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
        {cards.map(card => (
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

      {!loading && cards.length === 0 && (
        <div className="mt-6 bg-white rounded-2xl border border-gray-100 shadow-card p-10 text-center text-gray-400 text-sm">
          You don't have access to any configuration modules. Contact a Super Admin to request access.
        </div>
      )}

    </div>
  )
}
