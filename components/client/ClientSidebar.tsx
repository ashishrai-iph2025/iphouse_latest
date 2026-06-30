'use client'

import { Link } from 'react-router-dom'
import { usePathname } from '@/lib/router'
import { signOut } from '@/lib/auth-client'

interface SidebarProps {
  userName: string
  userLogo: string
  companyLogo: string
  open: boolean
  onClose: () => void
}

const navItems = [
  { href: '/dashboard',         icon: '⊞', label: 'Dashboard'         },
  { href: '/infringement',      icon: '🔍', label: 'Infringement'      },
  { href: '/pending-count',     icon: '⏳', label: 'Pending QC Count'  },
  { href: '/upload-url',        icon: '📤', label: 'Upload URLs'       },
  { href: '/download-request',  icon: '📥', label: 'Download Request'  },
  { href: '/search',            icon: '🔎', label: 'Search by URL'     },
  { href: '/ip-tracking',       icon: '🌐', label: 'IP Tracking'       },
  { href: '/profile',           icon: '👤', label: 'Profile'           },
]

export default function ClientSidebar({ userName, companyLogo, open, onClose }: SidebarProps) {
  const pathname = usePathname()

  return (
    <>
      {/* Overlay (mobile) */}
      {open && (
        <div className="fixed inset-0 bg-black/40 z-30 lg:hidden" onClick={onClose} />
      )}

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
            <p className="font-bold text-sm leading-tight">IP House</p>
            <p className="text-white/50 text-[10px]">Reports Portal</p>
          </div>
          {/* Close (mobile) */}
          <button onClick={onClose} className="ml-auto text-white/60 hover:text-white lg:hidden">✕</button>
        </div>

        {/* Company name */}
        <div className="px-5 py-3 border-b border-white/10">
          <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Account</p>
          <p className="text-sm font-medium text-white/90 truncate">{userName}</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-0.5">
          {navItems.map(item => {
            const active = pathname === item.href
              || pathname.startsWith(item.href + '/')
              || (item.href === '/pending-count' && pathname.startsWith('/qc-action'))
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
                <span className="text-base">{item.icon}</span>
                {item.label}
              </Link>
            )
          })}
        </nav>

        {/* Sign out */}
        <div className="px-3 pb-5 pt-2 border-t border-white/10">
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-white/60 hover:text-white hover:bg-white/10 transition-all"
          >
            <span className="text-base">🚪</span> Sign Out
          </button>
        </div>
      </aside>
    </>
  )
}

