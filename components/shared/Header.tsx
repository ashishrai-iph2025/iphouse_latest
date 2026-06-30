'use client'

import { useState, useEffect, useRef } from 'react'
import { useSession, signOut } from '@/lib/auth-client'
import { Link } from 'react-router-dom'

interface Notification { notificationId: number; message: string; type: string; is_read: number }

interface HeaderProps {
  title?: string
  sidebarToggle?: () => void
}

export default function Header({ title, sidebarToggle }: HeaderProps) {
  const { data: session } = useSession()
  const user = session?.user as any

  const [notifications, setNotifications]   = useState<Notification[]>([])
  const [notifOpen,     setNotifOpen]        = useState(false)
  const [profileOpen,   setProfileOpen]      = useState(false)
  const notifRef   = useRef<HTMLDivElement>(null)
  const profileRef = useRef<HTMLDivElement>(null)

  const unread = notifications.filter(n => !n.is_read).length

  useEffect(() => {
    fetch('/api/notifications', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.success) setNotifications(d.items) })
      .catch(() => {})
  }, [])

  // Close dropdowns on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false)
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  async function markAllRead() {
    await fetch('/api/notifications', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) })
    setNotifications(n => n.map(x => ({ ...x, is_read: 1 })))
  }

  return (
    <header className="sticky top-0 z-40 flex items-center justify-between px-5 py-3 bg-white border-b border-gray-100 shadow-sm">
      <div className="flex items-center gap-3">
        {sidebarToggle && (
          <button onClick={sidebarToggle}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors lg:hidden">
            <span className="block w-5 h-0.5 bg-gray-600 mb-1" />
            <span className="block w-5 h-0.5 bg-gray-600 mb-1" />
            <span className="block w-5 h-0.5 bg-gray-600" />
          </button>
        )}
        {title && <h2 className="text-base font-semibold text-gray-700 hidden sm:block">{title}</h2>}
      </div>

      <div className="flex items-center gap-3">
        {/* Notifications */}
        <div ref={notifRef} className="relative">
          <button onClick={() => setNotifOpen(o => !o)}
            className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors">
            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 00-5-5.917V4a1 1 0 10-2 0v1.083A6 6 0 006 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>

          {notifOpen && (
            <div className="absolute right-0 mt-2 w-80 bg-white rounded-2xl shadow-lg2 border border-gray-100 py-2 z-50">
              <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
                <span className="font-semibold text-sm text-gray-800">Notifications</span>
                {unread > 0 && (
                  <button onClick={markAllRead} className="text-xs text-blue-600 hover:underline">Mark all read</button>
                )}
              </div>
              <div className="max-h-72 overflow-y-auto">
                {notifications.length === 0 ? (
                  <p className="text-center text-xs text-brand-muted py-6">No notifications</p>
                ) : notifications.map(n => (
                  <div key={n.notificationId}
                    className={`px-4 py-3 border-b border-gray-50 last:border-0 ${!n.is_read ? 'bg-blue-50/50' : ''}`}>
                    <p className="text-xs text-gray-700 leading-relaxed">{n.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Profile */}
        <div ref={profileRef} className="relative">
          <button onClick={() => setProfileOpen(o => !o)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-gray-100 transition-colors">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-white text-xs"
              style={{ background: 'linear-gradient(135deg,#FFC82B,#FC934C)' }}>
              {(user?.name || 'U').charAt(0).toUpperCase()}
            </div>
            <span className="text-sm font-medium text-gray-700 hidden sm:block max-w-[120px] truncate">
              {user?.name}
            </span>
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {profileOpen && (
            <div className="absolute right-0 mt-2 w-52 bg-white rounded-2xl shadow-lg2 border border-gray-100 py-2 z-50">
              <div className="px-4 py-3 border-b border-gray-100">
                <p className="font-semibold text-sm text-gray-800 truncate">{user?.name}</p>
                <p className="text-xs text-brand-muted truncate">{user?.email}</p>
              </div>
              <Link to="/profile"
                className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                👤 My Profile
              </Link>
              <button
                onClick={() => signOut({ callbackUrl: '/login' })}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">
                🚪 Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

