'use client'

import { useState, useRef } from 'react'
import { useSession } from '@/lib/auth-client'
import Breadcrumb from '@/components/ui/Breadcrumb'

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-0 py-3 border-b border-gray-50 last:border-0">
      <span className="w-36 text-[11px] font-bold text-gray-400 uppercase tracking-wider flex-shrink-0">{label}</span>
      <span className="text-sm text-gray-800 font-medium">{value || '–'}</span>
    </div>
  )
}

export default function ProfilePage() {
  const { data: session } = useSession()
  const user = session?.user as any

  const [tab,     setTab]     = useState<'info' | 'password'>('info')
  const [logo,    setLogo]    = useState<string | null>(null)
  const [pwForm,  setPwForm]  = useState({ current: '', newPass: '', confirm: '' })
  const [pwMsg,   setPwMsg]   = useState('')
  const [pwLoad,  setPwLoad]  = useState(false)
  const [logoMsg, setLogoMsg] = useState('')

  const fileRef = useRef<HTMLInputElement>(null)

  const displayName = user?.loginFirstName
    ? `${user.loginFirstName} ${user.loginLastName ?? ''}`.trim()
    : user?.loginUsername ?? user?.name ?? 'User'
  const initials = displayName.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { setLogoMsg('File must be under 2MB'); return }
    const reader = new FileReader()
    reader.onload = () => {
      setLogo(reader.result as string)
      setLogoMsg('Logo updated successfully')
      setTimeout(() => setLogoMsg(''), 3000)
    }
    reader.readAsDataURL(file)
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault()
    if (pwForm.newPass !== pwForm.confirm) { setPwMsg('❌ Passwords do not match'); return }
    setPwLoad(true); setPwMsg('')
    try {
      const res  = await fetch('/api/profile/change-password', {
        credentials: 'include',
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ current: pwForm.current, newPass: pwForm.newPass }),
      })
      const data = await res.json()
      setPwMsg(data.success ? '✅ Password updated successfully' : `❌ ${data.error}`)
      if (data.success) setPwForm({ current: '', newPass: '', confirm: '' })
    } finally { setPwLoad(false) }
  }

  return (
    <div className="fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <Breadcrumb items={[{ label: 'My Profile' }]} />
        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A]">My Profile</h1>
          <p className="text-brand-muted text-sm">Manage your account information</p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">

        {/* ── LEFT: Avatar / Logo card ── */}
        <div className="lg:w-72 xl:w-80 flex-shrink-0 space-y-4">

          {/* Avatar card */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
            {/* Gradient banner */}
            <div className="h-20" style={{ background: 'linear-gradient(135deg,#14254A 0%,#FC934C 100%)' }} />

            <div className="px-5 pb-5 -mt-10 flex flex-col items-center text-center">
              {/* Avatar with upload */}
              <div className="relative group mb-3">
                <div className="w-20 h-20 rounded-2xl border-4 border-white shadow-lg overflow-hidden"
                  style={{ background: 'linear-gradient(135deg,#FFC82B,#FC934C)' }}>
                  {logo ? (
                    <img src={logo} alt="Logo" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center font-bold text-2xl text-white">
                      {initials}
                    </div>
                  )}
                </div>
                {/* Hover overlay */}
                <button onClick={() => fileRef.current?.click()}
                  className="absolute inset-0 rounded-2xl bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer">
                  <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/>
                  </svg>
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleLogoChange} />
              </div>

              <h2 className="font-bold text-[#14254A] text-base leading-tight">{displayName}</h2>
              <p className="text-brand-muted text-xs mt-0.5">{user?.loginUsername ? `@${user.loginUsername}` : '–'}</p>
              <div className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gray-50 border border-gray-100">
                <div className="w-5 h-5 rounded flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                  {(user?.name || 'C').charAt(0).toUpperCase()}
                </div>
                <p className="text-xs text-gray-500 font-medium truncate">{user?.name}</p>
              </div>

              {user?.role === 1 && (
                <span className="mt-2 px-3 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                  Administrator
                </span>
              )}

              {logoMsg && (
                <p className={`mt-2 text-xs font-medium ${logoMsg.includes('successfully') ? 'text-emerald-600' : 'text-red-500'}`}>
                  {logoMsg}
                </p>
              )}

              <button onClick={() => fileRef.current?.click()}
                className="mt-4 w-full py-2 rounded-xl border border-gray-200 text-xs font-semibold text-gray-500 hover:border-[#FC934C] hover:text-[#FC934C] transition-colors">
                Upload Photo
              </button>
              {logo && (
                <button onClick={() => setLogo(null)}
                  className="mt-1.5 w-full py-1.5 rounded-xl text-xs text-gray-400 hover:text-red-500 transition-colors">
                  Remove Photo
                </button>
              )}
            </div>
          </div>

          {/* Quick info card */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Quick Info</p>
            {[
              { icon: '👤', label: user?.loginUsername ? `@${user.loginUsername}` : '–' },
              { icon: '🔑', label: user?.role === 1 ? 'Administrator' : 'Client User' },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-2.5 text-sm text-gray-600">
                <span className="text-base">{item.icon}</span>
                <span className="text-xs font-medium">{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── RIGHT: Info / Password ── */}
        <div className="flex-1 min-w-0">

          {/* Tabs */}
          <div className="flex gap-1 p-1 bg-gray-100 dark:bg-white/5 rounded-xl w-full sm:w-fit mb-5">
            {([
              { key: 'info',     label: 'Account Info',     icon: '👤' },
              { key: 'password', label: 'Change Password',  icon: '🔒' },
            ] as const).map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${
                  tab === t.key
                    ? 'bg-white dark:bg-white/10 shadow text-[#14254A] dark:text-white'
                    : 'text-gray-500 dark:text-gray-400'
                }`}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {/* Account Info */}
          {tab === 'info' && (
            <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ background: '#14254A10' }}>
                  <svg className="w-4 h-4 text-[#14254A]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                  </svg>
                </div>
                <h3 className="font-bold text-[#14254A] dark:text-white">Account Information</h3>
              </div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Login Details</p>
              <div className="mb-6">
                <InfoRow label="First Name"  value={user?.loginFirstName ?? '–'} />
                <InfoRow label="Last Name"   value={user?.loginLastName  ?? '–'} />
                <InfoRow label="Username"    value={user?.loginUsername ? `${user.loginUsername}` : '–'} />
                <InfoRow label="Role"        value={user?.role === 2 ? 'Super Admin' : user?.role === 1 ? 'Administrator' : 'Client User'} />
                <InfoRow label="API Access"  value={user?.apiAccess ? 'Active (full access)' : 'Not available (limited access)'} />
              </div>

              {/* Master / Client Account section */}
              <div className="border-t border-gray-100 pt-5">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Client Account</p>
                <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-sm flex-shrink-0"
                    style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                    {(user?.name || 'C').charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-[#14254A] truncate">{user?.name ?? '–'}</p>
                    <p className="text-xs text-gray-400 truncate">{user?.email ?? '–'}</p>
                  </div>
                </div>
              </div>

              <div className="mt-5 p-4 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/30">
                <p className="text-xs text-blue-700 dark:text-blue-400 font-medium">
                  To update your profile information, please contact your administrator.
                </p>
              </div>
            </div>
          )}

          {/* Change Password */}
          {tab === 'password' && (
            <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-orange-50">
                  <svg className="w-4 h-4 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                </div>
                <h3 className="font-bold text-[#14254A] dark:text-white">Change Password</h3>
              </div>

              {pwMsg && (
                <div className={`rounded-xl px-4 py-3 text-sm mb-4 ${pwMsg.startsWith('✅') ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                  {pwMsg}
                </div>
              )}

              <form onSubmit={handlePasswordChange} className="space-y-4 w-full sm:max-w-md">
                {[
                  { name: 'current', label: 'Current Password',    placeholder: 'Enter current password', min: 1 },
                  { name: 'newPass', label: 'New Password',        placeholder: 'Minimum 8 characters',   min: 8 },
                  { name: 'confirm', label: 'Confirm New Password', placeholder: 'Repeat new password',   min: 8 },
                ].map(f => (
                  <div key={f.name}>
                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{f.label}</label>
                    <input autoComplete="off" type="password" placeholder={f.placeholder}
                      value={(pwForm as any)[f.name]}
                      onChange={e => setPwForm(p => ({ ...p, [f.name]: e.target.value }))}
                      required minLength={f.min}
                      className="w-full border border-gray-200 dark:border-white/10 dark:bg-white/5 dark:text-white rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#FC934C]/30 focus:border-[#FC934C] transition-all" />
                  </div>
                ))}

                <button type="submit" disabled={pwLoad}
                  className="w-full py-3 rounded-xl font-semibold text-white text-sm disabled:opacity-60 transition-all hover:opacity-90 flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(135deg,#14254A,#1e3a6e)' }}>
                  {pwLoad
                    ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Updating…</>
                    : '🔒 Update Password'}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

