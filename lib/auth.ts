import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { queryOne, execute } from './db'
import { tempTokenStore } from './tempTokenStore'
import { loginToMarkscan } from './api'
import { logActivity, ensureActivityTables } from './activity'

// Ensure tracking tables exist before any login attempt writes to them
ensureActivityTables().catch(() => {})

// Throttle last_seen_at updates — one DB write per loginId per 60 seconds
const lastSeenThrottle = new Map<number, number>()

export interface DBLoginRow {
  loginId: number
  userId: number
  first_name: string
  last_name: string
  login_username: string
  login_password: string
  login_type: number
  twofa_secret: string | null
  is_active: number
  name: string
  email: string
  role: number | null
  IsSecure: number
  api_user_name: string | null
  api_password: string | null
}

interface SuperAdminRow {
  id: number
  name: string
  email: string
  password_hash: string
  is_active: number
}

function verifyPassword(input: string, stored: string): boolean {
  if (stored.length === 32) {
    // legacy MD5
    const md5 = require('crypto').createHash('md5').update(input).digest('hex')
    return md5 === stored
  }
  return bcrypt.compareSync(input, stored)
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      id: 'credentials',
      name: 'IP House',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
        // Used for client-selection flow
        loginId:  { label: 'LoginId',  type: 'text' },
      },
      async authorize(credentials, req) {
        if (!credentials?.username || !credentials?.password) return null

        // Ensure tracking tables exist before any insert — idempotent, cached after first call
        await ensureActivityTables()

        const ip = (req?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim()
              || (req?.headers?.['x-real-ip'] as string)
              || 'unknown'
        const ua = (req?.headers?.['user-agent'] as string) || ''

        // Client-selection flow: password is a temp token, loginId is set
        if (credentials.loginId) {
          const entry = tempTokenStore.get(credentials.password)
          if (
            !entry ||
            entry.exp < Date.now() ||
            entry.username !== credentials.username ||
            entry.loginId !== Number(credentials.loginId)
          ) return null
          tempTokenStore.delete(credentials.password)

          const row = await queryOne<DBLoginRow>(
            `SELECT l.loginId, l.userId, l.first_name, l.last_name,
                    l.login_username, l.login_password, l.login_type,
                    l.twofa_secret, l.is_active,
                    u.name, u.email, u.IsSecure, u.role
             FROM dcp_user_login AS l
             INNER JOIN dcp_user AS u ON u.userId = l.userId
             WHERE l.loginId = ? AND l.is_active = 1 AND u.deleted = 0`,
            [entry.loginId]
          )
          if (!row) return null

          try {
            await execute('INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, NOW())', [row.userId, row.loginId])
          } catch { /* non-fatal */ }
          execute('UPDATE dcp_user_login SET last_seen_at = NOW() WHERE loginId = ?', [row.loginId]).catch(() => {})
          logActivity(row.loginId, 'login', 'auth/login', ip, ua, { method: 'select' })

          return {
            id:             String(row.loginId),
            loginId:        row.loginId,
            userId:         row.userId,
            name:           row.name,
            email:          row.email,
            role:           row.role,
            loginType:      row.login_type,
            loginUsername:  row.login_username,
            loginFirstName: row.first_name,
            loginLastName:  row.last_name,
            apiToken:       entry.apiToken,
          }
        }

        // ── Layer 1: Super Admin table (role = 2, isolated credentials) ──
        try {
          const superAdmin = await queryOne<SuperAdminRow>(
            `SELECT id, name, email, password_hash, is_active
             FROM dcp_super_admin
             WHERE email = ? AND is_active = 1
             LIMIT 1`,
            [credentials.username]
          )
          if (superAdmin) {
            if (!bcrypt.compareSync(credentials.password, superAdmin.password_hash)) return null
            execute('UPDATE dcp_super_admin SET last_login = NOW() WHERE id = ?', [superAdmin.id]).catch(() => {})
            execute('INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (0, ?, NOW())', [superAdmin.id]).catch(() => {})
            return {
              id:            `sa-${superAdmin.id}`,
              loginId:       superAdmin.id,
              userId:        superAdmin.id,
              name:          superAdmin.name,
              email:         superAdmin.email,
              role:          2,
              loginType:     2,
              loginUsername: superAdmin.email,
              apiToken:      null,
            }
          }
        } catch (saErr) {
          console.error('[auth] dcp_super_admin lookup failed:', saErr)
          // fall through to regular auth
        }

        // ── Layer 2 & 3: Admin (role=1) and Client (role=0/null) ─────────
        const sql = `
          SELECT
            l.loginId, l.userId, l.first_name, l.last_name,
            l.login_username, l.login_password, l.login_type,
            l.twofa_secret, l.is_active,
            u.name, u.email, u.IsSecure, u.role,
            u.api_user_name, u.api_password
          FROM dcp_user_login AS l
          INNER JOIN dcp_user AS u ON u.userId = l.userId
          WHERE l.login_username = ?
            AND l.is_active = 1
            AND u.deleted = 0
          LIMIT 1
        `
        const row = await queryOne<DBLoginRow>(sql, [credentials.username])
        if (!row) return null

        if (!verifyPassword(credentials.password, row.login_password)) return null

        let apiToken: string | null = null
        if (row.api_user_name && row.api_password) {
          apiToken = await loginToMarkscan(row.api_user_name, row.api_password)
        }

        try {
          await execute('INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, NOW())', [row.userId, row.loginId])
        } catch { /* non-fatal */ }
        execute('UPDATE dcp_user_login SET last_seen_at = NOW() WHERE loginId = ?', [row.loginId]).catch(() => {})
        logActivity(row.loginId, 'login', 'auth/login', ip, ua, { method: 'password' })

        return {
          id:             String(row.loginId),
          loginId:        row.loginId,
          userId:         row.userId,
          name:           row.name,
          email:          row.email,
          role:           row.role,
          loginType:      row.login_type,
          loginUsername:  row.login_username,
          loginFirstName: row.first_name,
          loginLastName:  row.last_name,
          apiToken,
        }
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.loginId        = (user as any).loginId
        token.userId         = (user as any).userId
        token.role           = (user as any).role
        token.loginType      = (user as any).loginType
        token.loginUsername  = (user as any).loginUsername
        token.loginFirstName = (user as any).loginFirstName ?? null
        token.loginLastName  = (user as any).loginLastName  ?? null
        token.apiToken       = (user as any).apiToken ?? null
      }

      // On session refresh (not sign-in): update last_seen_at + check force-logout
      if (!user && token.loginId && token.role !== 2) {
        const loginId = token.loginId as number
        const now     = Date.now()
        const last    = lastSeenThrottle.get(loginId) ?? 0

        if (now - last > 60_000) {
          lastSeenThrottle.set(loginId, now)
          // Heartbeat — non-fatal if column doesn't exist yet
          execute('UPDATE dcp_user_login SET last_seen_at = NOW() WHERE loginId = ?', [loginId]).catch(() => {})

          // Force-logout check — only invalidate if we get a clean, confirmed result
          try {
            const row = await queryOne<{ force_logout_at: string | null }>(
              'SELECT force_logout_at FROM dcp_user_login WHERE loginId = ? LIMIT 1',
              [loginId]
            )
            if (row && row.force_logout_at !== undefined && row.force_logout_at !== null) {
              const forceAt  = Math.floor(new Date(row.force_logout_at).getTime() / 1000)
              const tokenIat = token.iat as number | undefined
              if (tokenIat && forceAt > 0 && forceAt > tokenIat) {
                lastSeenThrottle.delete(loginId)
                return null as any
              }
            }
          } catch {
            // Column missing or DB error — never invalidate on uncertainty, always return token
          }
        }
      }

      return token
    },

    async session({ session, token }) {
      session.user = {
        ...session.user,
        loginId:        token.loginId        as number,
        userId:         token.userId         as number,
        role:           token.role           as number | null,
        loginType:      token.loginType      as number,
        loginUsername:  token.loginUsername  as string,
        loginFirstName: token.loginFirstName as string | null,
        loginLastName:  token.loginLastName  as string | null,
        apiToken:       token.apiToken       as string | null,
      } as any
      return session
    },
  },

  pages: {
    signIn: '/login',
    error:  '/login',
  },

  session: {
    strategy: 'jwt',
    maxAge:   1800, // 30 minutes – matches PHP idle timeout
  },

  secret: process.env.NEXTAUTH_SECRET,
}
