'use client'

import { useEffect, useState } from 'react'
import { useSession } from '@/lib/auth-client'
import { Navigate } from '@/lib/router'
import { useModuleAccess } from '@/lib/moduleAccess'
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
  /* Dashboard and Reports show the same figures, and a login gets exactly one
     of them — Reports wins where it is granted. See UserNav, which is where the
     rule is decided and which this reads through allowedModuleNames.

     The redirect matters because EVERY login lands here: sign-in, client
     selection, e-mail verification and the War Room's own fallback all send
     people to /dashboard. Suppressing it in the nav alone would leave a
     Reports login sitting on a page its nav no longer offers. */
  const { allowedModuleNames } = useModuleAccess()
  const { data: session } = useSession()
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
  if (allowedModuleNames.some(n => n.toUpperCase() === 'REPORTS')) {
    return <Navigate to="/reports" replace />
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
