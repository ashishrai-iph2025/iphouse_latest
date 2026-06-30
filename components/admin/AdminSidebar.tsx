'use client'

import { Link } from 'react-router-dom'
import { usePathname } from '@/lib/router'
import { signOut } from '@/lib/auth-client'

const navGroups = [
  {
    label: 'Overview',
    items: [
      { href: '/admin/home', icon: '🏠', label: 'Home' },
    ],
  },
  {
    label: 'Client Management',
    items: [
      { href: '/admin/clients',      icon: '🏢', label: 'Clients'    },
      { href: '/admin/users',        icon: '👥', label: 'Users'      },
      { href: '/admin/registrations',icon: '📝', label: 'Registrations' },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { href: '/admin/activity', icon: '📡', label: 'Activity Tracking' },
      { href: '/admin/tracking', icon: '🔍', label: 'Raw Logs'          },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { href: '/admin/dashboards',      icon: '📊', label: 'Dashboards'       },
      { href: '/admin/modules',         icon: '🔐', label: 'Module Access'    },
      { href: '/admin/api-credentials', icon: '🔑', label: 'API Credentials'  },
      { href: '/admin/settings',        icon: '⚙️', label: 'Settings'         },
    ],
  },
]

interface Props { open: boolean; onClose: () => void }

export default function AdminSidebar({ open, onClose }: Props) {
  const pathname = usePathname()

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/40 z-30 lg:hidden" onClick={onClose} />}

      <aside className={`
        fixed lg:static inset-y-0 left-0 z-40 flex flex-col
        w-64 bg-[#14254A] text-white transition-transform duration-300
        ${open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-white/10">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#FFC82B] to-[#FC934C] flex items-center justify-center font-bold text-[#14254A] text-sm">
            IP
          </div>
          <div>
            <p className="font-bold text-sm">IP House</p>
            <p className="text-[10px] text-white/40">Admin Panel</p>
          </div>
          <button onClick={onClose} className="ml-auto text-white/60 hover:text-white lg:hidden">✕</button>
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-5">
          {navGroups.map(group => (
            <div key={group.label}>
              <p className="text-[9px] uppercase tracking-widest text-white/30 px-3 mb-2">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map(item => {
                  const active = pathname === item.href || pathname.startsWith(item.href + '/')
                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      onClick={onClose}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all
                        ${active
                          ? 'bg-gradient-to-r from-[#FFC82B] to-[#FC934C] text-[#14254A]'
                          : 'text-white/70 hover:text-white hover:bg-white/10'
                        }`}
                    >
                      <span>{item.icon}</span>
                      {item.label}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-3 pb-5 pt-2 border-t border-white/10">
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-white/60 hover:text-white hover:bg-white/10 transition-all"
          >
            <span>🚪</span> Sign Out
          </button>
        </div>
      </aside>
    </>
  )
}

