'use client'

import { useEffect, useState } from 'react'
import { useSession } from '@/lib/auth-client'
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

  return (
    <DashboardClient
      userName={(session?.user as any)?.name || 'User'}
      userLogo={userLogo}
      companyLogo={companyLogo}
      modules={modules}
    />
  )
}
