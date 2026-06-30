// Server-side in-memory cache for Markscan API tokens (keyed by userId)
// Tokens are valid ~1h from Markscan; we cache for 55 min.

interface Entry { token: string; exp: number }

const cache = new Map<number, Entry>()

const TTL_MS = 55 * 60 * 1000   // 55 minutes

export function getCachedApiToken(userId: number): string | null {
  const entry = cache.get(userId)
  if (!entry || entry.exp < Date.now()) {
    cache.delete(userId)
    return null
  }
  return entry.token
}

export function setCachedApiToken(userId: number, token: string): void {
  cache.set(userId, { token, exp: Date.now() + TTL_MS })
}

export function clearCachedApiToken(userId: number): void {
  cache.delete(userId)
}
