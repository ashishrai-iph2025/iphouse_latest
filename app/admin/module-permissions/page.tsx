'use client'

import { useEffect, useState } from 'react'
import UserModulePermissionsClient from '@/components/admin/UserModulePermissionsClient'

export default function ModulePermissionsPage() {
  const [users, setUsers]     = useState<any[]>([])
  const [modules, setModules] = useState<any[]>([])

  useEffect(() => {
    fetch('/api/admin/user-module-permissions', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        d.users   && setUsers(d.users)
        d.modules && setModules(d.modules)
      })
      .catch(() => {})
  }, [])

  return <UserModulePermissionsClient users={users} modules={modules} />
}
