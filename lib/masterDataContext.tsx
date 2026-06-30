'use client'

import { createContext, useContext, useEffect, useState } from 'react'

export interface MasterOption { key: string; label: string }

interface MasterDataCtx {
  platforms: MasterOption[]
  assets:    MasterOption[]
  loading:   boolean
}

const MasterDataContext = createContext<MasterDataCtx>({
  platforms: [], assets: [], loading: true,
})

export function MasterDataProvider({ children }: { children: React.ReactNode }) {
  const [platforms, setPlatforms] = useState<MasterOption[]>([])
  const [assets,    setAssets]    = useState<MasterOption[]>([])
  const [loading,   setLoading]   = useState(true)

  useEffect(() => {
    fetch('/api/master-data', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!d.success) return
        if (d.platforms?.length) {
          setPlatforms(d.platforms.map((p: any) => {
            const name = typeof p === 'string' ? p
              : (p.platformName ?? p.platform_name ?? p.name ?? p.platform ?? p.PlatformName ?? '')
            return { key: String(name), label: String(name) }
          }).filter((p: any) => p.key))
        }
        if (d.assets?.length) {
          setAssets(d.assets.map((a: any) => {
            const name = typeof a === 'string' ? a
              : (a.assetName ?? a.asset_name ?? a.name ?? a.AssetName ?? '')
            return { key: String(name), label: String(name) }
          }).filter((a: any) => a.key))
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <MasterDataContext.Provider value={{ platforms, assets, loading }}>
      {children}
    </MasterDataContext.Provider>
  )
}

export function useMasterData() {
  return useContext(MasterDataContext)
}
