'use client'

import { useEffect, useState } from 'react'
import ModulePermissionsClient from '@/components/admin/ModulePermissionsClient'

export default function ModulesPage() {
  const [modules, setModules] = useState<any[]>([])

  useEffect(() => {
    fetch('/api/admin/modules', { credentials: 'include' })
      .then(r => r.json())
      .then(d => d.modules && setModules(d.modules))
      .catch(() => {})
  }, [])

  return <ModulePermissionsClient initialModules={modules} />
}
