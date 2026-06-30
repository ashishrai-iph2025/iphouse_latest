import type { Session } from 'next-auth'
import { queryOne } from './db'
import { loginToMarkscan } from './api'
import { getCachedApiToken, setCachedApiToken } from './apiTokenCache'

/**
 * Returns the Markscan API token for the session user.
 * Priority: cache → session JWT → fresh login from DB creds
 */
export async function resolveApiToken(session: Session): Promise<string | null> {
  const userId = (session.user as any)?.userId as number | undefined
  if (!userId) return null

  // 1. Try cache
  const cached = getCachedApiToken(userId)
  if (cached) return cached

  // 2. Try session JWT (set during authorize())
  const fromSession = (session.user as any)?.apiToken as string | null
  if (fromSession && !fromSession.startsWith('dummy_')) {
    setCachedApiToken(userId, fromSession)
    return fromSession
  }

  // 3. Fresh login from DB credentials
  const user = await queryOne<{ api_user_name: string | null; api_password: string | null }>(
    'SELECT api_user_name, api_password FROM dcp_user WHERE userId = ? AND deleted = 0',
    [userId]
  )
  if (!user || !user.api_user_name || !user.api_password) return null

  const token = await loginToMarkscan(user.api_user_name, user.api_password)
  if (token) setCachedApiToken(userId, token)
  return token
}
