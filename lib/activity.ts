import { execute, query } from './db'

// Ensure tables and columns exist — run once per process, non-fatal
let _schemaReady = false
export async function ensureActivityTables() { return ensureSchema() }
async function ensureSchema() {
  if (_schemaReady) return
  try {
    // Create user_activity_log if missing
    await execute(`
      CREATE TABLE IF NOT EXISTS user_activity_log (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id    INT UNSIGNED NOT NULL,
        page_url   VARCHAR(500) DEFAULT '',
        action     VARCHAR(64)  DEFAULT 'view',
        ip_address VARCHAR(45)  DEFAULT '',
        user_agent VARCHAR(500) DEFAULT '',
        metadata   TEXT         NULL DEFAULT NULL,
        created_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
        KEY idx_user_activity (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    // Create dcp_login if missing
    await execute(`
      CREATE TABLE IF NOT EXISTS dcp_login (
        id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        userId    INT UNSIGNED NOT NULL,
        loginId   INT UNSIGNED DEFAULT NULL,
        loginTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_userId  (userId),
        KEY idx_loginId (loginId)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    // Create user_dashboard_access if missing
    await execute(`
      CREATE TABLE IF NOT EXISTS user_dashboard_access (
        id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        login_id       INT UNSIGNED NOT NULL,
        user_id        INT UNSIGNED NOT NULL,
        report_id      VARCHAR(128) NOT NULL,
        dashboard_name VARCHAR(255) DEFAULT '',
        workspace_id   VARCHAR(128) DEFAULT '',
        accessed_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_uda_login  (login_id),
        KEY idx_uda_report (report_id),
        KEY idx_uda_user   (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    // Add metadata column if table existed without it (MySQL 5.7 compatible)
    const cols = await query<{ Field: string }>(`SHOW COLUMNS FROM user_activity_log LIKE 'metadata'`)
    if (cols.length === 0) {
      await execute(`ALTER TABLE user_activity_log ADD COLUMN metadata TEXT NULL DEFAULT NULL`)
    }
  } catch { /* non-fatal */ }
  _schemaReady = true
}

export type ActivityAction =
  | 'login'
  | 'logout'
  | 'password_changed'
  | 'password_reset'
  | 'dashboard_accessed'
  | 'module_visited'
  | 'search_performed'
  | 'ip_tracking'
  | 'download_requested'
  | 'infringement_accessed'
  | 'view'

export interface ActivityMeta {
  dashboardId?:   string
  dashboardName?: string
  moduleName?:    string
  query?:         string
  [key: string]:  string | number | undefined
}

/**
 * Fire-and-forget activity log insert.
 * loginId   = dcp_user_login.loginId  (what user_activity_log.user_id stores)
 * action    = event type
 * pageUrl   = resource identifier
 * ip        = client IP
 * ua        = user-agent string
 * meta      = optional JSON payload
 */
export function logActivity(
  loginId:  number,
  action:   ActivityAction,
  pageUrl:  string,
  ip:       string,
  ua:       string,
  meta?:    ActivityMeta,
): void {
  ensureSchema().then(() =>
    execute(
      `INSERT INTO user_activity_log
         (user_id, page_url, action, ip_address, user_agent, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [loginId, pageUrl.slice(0, 500), action, ip.slice(0, 45), ua.slice(0, 500),
       meta ? JSON.stringify(meta) : null]
    )
  ).catch(() => { /* never throw — tracking must not break main flow */ })
}

/** Extract client IP from a Next.js Request */
export function getIP(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

/** Extract user-agent from a Next.js Request */
export function getUA(req: Request): string {
  return req.headers.get('user-agent') || ''
}
