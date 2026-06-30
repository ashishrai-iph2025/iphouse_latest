// Markscan API helpers (server-side only)
import { apiFetch } from './fetchWithoutSSL'
export { PLATFORM_PAGE_MAP } from './platformMap'

const BASE = process.env.MARKSCAN_API_BASE || 'https://api.markscan.co.in'

// ─── Endpoint maps (mirrors PHP fetch_infringement.php) ───────────────────────

export const INFRINGEMENT_ENDPOINTS: Record<string, string> = {
  'facebook': `${BASE}/Facebook/Paged`,
  'internet': `${BASE}/Internet/Paged`,
  'youtube': `${BASE}/YouTube/Paged`,
  'instagram': `${BASE}/Instagram/Paged`,
  'twitter': `${BASE}/Twitter/Paged`,
  'telegram': `${BASE}/Telegram/Paged`,
  'tiktok': `${BASE}/UGCPlatform/Paged`,
  'chomikuj': `${BASE}/UGCPlatform/Paged`,
  'vk': `${BASE}/UGCPlatform/Paged`,
  'ok': `${BASE}/UGCPlatform/Paged`,
  'sharechat': `${BASE}/UGCPlatform/Paged`,
  'dailymotion': `${BASE}/UGCPlatform/Paged`,
  'bilibili': `${BASE}/UGCPlatform/Paged`,
  'ugc and other social media': `${BASE}/UGCPlatform/Paged`,
  'i-tunes': `${BASE}/GetInfringements/ItunesApiUrls`,
  'play store': `${BASE}/GetInfringements/GooglePlaystoreAPIurls`,
  'third party app': `${BASE}/GetInfringements/ThirdPartyAppAPIurls`,
  'third party mobile app': `${BASE}/GetInfringements/ThirdPartyMobileAppAPIurls`,
  'torrent': `${BASE}/GetInfringements/Internet/Test`,
}

// UGC platforms need a "platform" field in the body
const UGC_PLATFORM_MAP: Record<string, string> = {
  'tiktok': 'tiktok',
  'chomikuj': 'chomikuj',
  'vk': 'vk',
  'ok': 'ok',
  'sharechat': 'sharechat',
  'dailymotion': 'dailymotion',
  'bilibili': 'bilibili',
  'ugc and other social media': 'UGC And Other Social Media',
}


// ─── Token generation ─────────────────────────────────────────────────────────

export async function loginToMarkscan(
  apiUsername: string,
  apiPassword: string
): Promise<string | null> {
  try {
    const res = await apiFetch(`${BASE}/Login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: apiUsername, password: apiPassword }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    // Response is application/json returning a plain JSON string e.g. "eyJ..."
    const raw = await res.json()
    const token = typeof raw === 'string' ? raw.trim() : String(raw).trim()
    return token.length > 20 ? token : null
  } catch {
    return null
  }
}

// ─── Infringement fetch ───────────────────────────────────────────────────────

interface FetchOptions {
  token: string
  platform: string
  startDate?: string
  endDate?: string
  assetName?: string
  page?: number
  perPage?: number
}

export async function fetchInfringements(opts: FetchOptions) {
  const key = opts.platform.toLowerCase()
  const url = INFRINGEMENT_ENDPOINTS[key]
  if (!url) throw new Error(`Unknown platform: ${opts.platform}`)

  const body: Record<string, unknown> = {}
  if (UGC_PLATFORM_MAP[key]) body['platform'] = UGC_PLATFORM_MAP[key]
  if (opts.startDate) body['startDate'] = opts.startDate
  if (opts.endDate) body['endDate'] = opts.endDate
  if (opts.assetName) body['assetName'] = opts.assetName
  body['pageNo'] = opts.page ?? 0

  const res = await apiFetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`)
  }

  return res.json()
}

// ─── Enforcement ─────────────────────────────────────────────────────────────

export async function sendToEnforcementQc(
  token: string,
  payload: {
    platform: string
    assetName: string
    urlids: (string | number)[]
    comment: string
    isSourceURL?: boolean
  }
) {
  const res = await apiFetch(`${BASE}/SendtoEnforcementQc`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) }
}

export async function markAsInvalid(
  token: string,
  payload: {
    platform: string
    assetName: string
    urlids: (string | number)[]
    comment: string
    isSourceURL?: boolean
  }
) {
  const res = await apiFetch(`${BASE}/MarkAsInvalid`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) }
}

// ─── Download ─────────────────────────────────────────────────────────────────

export async function getDownloadUrl(token: string, downloadId: string): Promise<string | null> {
  const res = await apiFetch(`${BASE}/DownloadDataExtraction/${downloadId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) return null
  return (await res.text()).trim().replace(/^["']|["']$/g, '')
}

// ─── Discovery search ─────────────────────────────────────────────────────────

export async function searchByUrl(token: string, url: string, platform: string, isSrcUrl: boolean) {
  const res = await apiFetch(`${BASE}/SearchandRetriveapi`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': '*/*',
    },
    body: JSON.stringify({ url, platform, isSrcUrl }),
    signal: AbortSignal.timeout(30_000),
  })
  return res.ok ? res.json() : null
}

// ─── Master data ───────────────────────────────────────────────────────────────

/** Extract first array from any API response shape */
function extractArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    // Try common wrapper keys first
    const obj = data as Record<string, unknown>
    for (const key of ['data', 'items', 'result', 'results', 'list', 'records',
      'platforms', 'assets', 'rows', 'Data', 'Items', 'Result']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[]
    }
    // Fallback: return first array value found
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)) return val
    }
  }
  return []
}

export async function getAllPlatforms(token: string): Promise<unknown[]> {
  try {
    const res = await apiFetch(`${BASE}/GetAllPlatforms`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      console.error('[getAllPlatforms] API error', res.status, await res.text().catch(() => ''))
      return []
    }
    const data = await res.json()
    console.log('[getAllPlatforms] raw response:', JSON.stringify(data).slice(0, 300))
    return extractArray(data)
  } catch (err) {
    console.error('[getAllPlatforms] exception:', err)
    return []
  }
}

export async function getAllAssets(token: string): Promise<unknown[]> {
  try {
    const res = await apiFetch(`${BASE}/GetAllAssets`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      console.error('[getAllAssets] API error', res.status, await res.text().catch(() => ''))
      return []
    }
    const data = await res.json()
    console.log('[getAllAssets] raw response:', JSON.stringify(data).slice(0, 300))
    return extractArray(data)
  } catch (err) {
    console.error('[getAllAssets] exception:', err)
    return []
  }
}
