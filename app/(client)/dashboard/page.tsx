'use client'

import { useEffect, useState } from 'react'
import { useSession } from '@/lib/auth-client'
import { Navigate, useSearchParams } from '@/lib/router'
import { useModuleAccess } from '@/lib/moduleAccess'
import { firstAllowedHref } from '@/lib/navItems'
import DashboardClient from '@/components/client/DashboardClient'

interface Module {
  moduleId: number
  moduleName: string
  moduleIcon: string
  link: string
  noLinkMsg: string
  active: number
  default: number
}

export default function DashboardPage() {
  /* A login holding the LANDING PAGE lands on it: the week in summary and the
     programme calendar, with the full report one click away. A DASHBOARD-only
     login is untouched and still falls through to DashboardClient at the foot
     of this file — the two grants keep their own landing pages where a login
     holds only one of them.

     It used to be the Reports grant that sent people here, from when /welcome
     was not something an admin could grant separately. It is now, so sending a
     Reports login to a page it may not hold would be a redirect straight into
     the guard's refusal notice. The page decides, and the page is "welcome".

     The redirect matters because EVERY GENERIC landing lands here: sign-in,
     client selection, e-mail verification, the logo and the War Room's own
     fallback all send people to plain /dashboard with no signal about why.
     Welcome wins there whenever it is granted — that is the whole point of
     giving a login the landing page.

     The one exception is `viaNav` below: a reader who has just clicked the
     Dashboard tab itself has already chosen, and sending that click back to
     Welcome would make the tab permanently unreachable for any login holding
     both grants. See the `nav` marker on the Dashboard NAV_ITEM in
     lib/navItems.tsx for where that signal comes from. */
  const { allowedModules, allowedModuleNames } = useModuleAccess()
  const { data: session } = useSession()
  const params = useSearchParams()
  const viaNav = params.get('nav') === '1'
  const [modules,     setModules]     = useState<Module[]>([])
  const [userLogo,    setUserLogo]    = useState('userimg.jpg')
  const [companyLogo, setCompanyLogo] = useState('default-company-logo.png')

  useEffect(() => {
    fetch('/api/user/dashboard-data', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.modules) setModules(d.modules)
        if (d.logo?.userLogo)    setUserLogo(d.logo.userLogo)
        if (d.logo?.companyLogo) setCompanyLogo(d.logo.companyLogo)
      })
      .catch(() => {})
  }, [])

  // Fail closed while the grants are unknown (null = fetch in flight), so a
  // Reports login never sees the dashboard flash before being moved on.
  if (allowedModuleNames === null) return null
  /* Matched on pageName, not on the module's name: the name is an admin's label
     and changes, the key is what the nav, the guard and the page all join on. */
  const granted = allowedModules ?? []
  const hasDashboard = granted.some(m => m.pageName === 'dashboard')
  const hasWelcome = granted.some(m => m.pageName === 'welcome')
  if (hasWelcome && !(viaNav && hasDashboard)) {
    return <Navigate to="/welcome" replace />
  }

  /* Dashboard is a grant now, not a floor, so landing here no longer implies
     entitlement — and EVERY sign-in path lands here. Send them to the first
     module they do have rather than to a page their nav does not offer.

     Checked against allowedModules (pageName) rather than the names, because
     pageName is what the nav matches on and the seeded row's name and pageName
     disagree. */
  if (!hasDashboard) {
    const target = firstAllowedHref(granted)
    if (target) return <Navigate to={target} replace />

    /* Nothing at all is granted. Said plainly rather than redirected around:
       the account exists and its modules have not been assigned yet, and a
       redirect loop between two pages the login cannot open would tell them
       nothing about why. */
    return (
      <div className="flex items-center justify-center min-h-[60vh] p-6">
        <div className="max-w-md text-center bg-white dark:bg-[#14254A] rounded-2xl shadow-card border border-gray-100 dark:border-white/10 p-8">
          <div className="w-12 h-12 rounded-xl bg-amber-50 grid place-items-center mx-auto mb-4 text-2xl" aria-hidden>🔒</div>
          <h1 className="font-bold text-[#14254A] dark:text-white mb-2">No modules enabled yet</h1>
          <p className="text-sm text-gray-500 dark:text-gray-300 leading-relaxed">
            This account does not have access to any section of the portal yet.
            Please contact your administrator to have your modules enabled.
          </p>
        </div>
      </div>
    )
  }

  return (
    <DashboardClient
      userName={(session?.user as any)?.name || 'User'}
      userLogo={userLogo}
      companyLogo={companyLogo}
      modules={modules}
    />
  )
}
