// Server-side cache for master data (platforms & assets) synced from Markscan API

export interface MasterPlatform {
  [key: string]: unknown
  name?: string
  platformName?: string
  id?: string | number
}

export interface MasterAsset {
  [key: string]: unknown
  name?: string
  assetName?: string
  id?: string | number
}

interface Cache {
  platforms: MasterPlatform[]
  assets:    MasterAsset[]
  syncedAt:  number | null
}

const cache: Cache = {
  platforms: [],
  assets:    [],
  syncedAt:  null,
}

export function getMasterPlatforms(): MasterPlatform[] { return cache.platforms }
export function getMasterAssets():    MasterAsset[]    { return cache.assets }
export function getMasterSyncedAt():  number | null    { return cache.syncedAt }

export function setMasterData(platforms: MasterPlatform[], assets: MasterAsset[]): void {
  cache.platforms = platforms
  cache.assets    = assets
  cache.syncedAt  = Date.now()
}
