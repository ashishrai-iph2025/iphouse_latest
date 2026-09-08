'use client'

import AssetRegisterAccessClient from '@/components/admin/AssetRegisterAccessClient'

export default function AssetRegisterAccessPage() {
  /* The client component owns its own fetch. The sibling page hands its data in
     from here, which means that screen renders once empty before the request
     lands; this one shows a loader until it has an answer. */
  return <AssetRegisterAccessClient />
}
