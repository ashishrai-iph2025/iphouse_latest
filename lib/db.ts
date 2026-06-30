import mysql from 'mysql2/promise'

// Persist pool on global to survive Next.js hot-module reloads in dev mode.
const g = global as typeof global & { _dbPool?: mysql.Pool }

function createPool(): mysql.Pool {
  const isProd = process.env.USE_PRODUCTION_DB === 'true'
  const host   = isProd ? process.env.DB_HOST_PROD : process.env.DB_HOST_LOCAL
  const port   = isProd ? process.env.DB_PORT_PROD : process.env.DB_PORT_LOCAL
  const user   = isProd ? process.env.DB_USER_PROD : process.env.DB_USER_LOCAL
  const pass   = isProd ? process.env.DB_PASS_PROD : process.env.DB_PASS_LOCAL
  const name   = isProd ? process.env.DB_NAME_PROD : process.env.DB_NAME_LOCAL
  console.log(`[db] Connecting to ${isProd ? 'PRODUCTION' : 'LOCAL'} database: ${host}/${name}`)
  return mysql.createPool({
    host:                  host     || 'localhost',
    port:                  Number(port || 3306),
    user:                  user     || 'root',
    password:              pass     || '',
    database:              name     || 'dashboard',
    waitForConnections:    true,
    connectionLimit:       3,
    queueLimit:            0,
    timezone:              '+05:30',
    connectTimeout:        10000,
    enableKeepAlive:       true,
    keepAliveInitialDelay: 10000,
  })
}

export function getPool(): mysql.Pool {
  if (!g._dbPool) g._dbPool = createPool()
  return g._dbPool
}

// Reset and recreate the pool (used when connections are exhausted)
async function resetPool(): Promise<mysql.Pool> {
  if (g._dbPool) {
    try { await g._dbPool.end() } catch { /* ignore errors during cleanup */ }
    g._dbPool = undefined
  }
  g._dbPool = createPool()
  return g._dbPool
}

function isFatalConnectionError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code
    // ER_CON_COUNT_ERROR = too many connections, ECONNREFUSED = server down
    return code === 'ER_CON_COUNT_ERROR' || code === 'ECONNREFUSED' || code === 'PROTOCOL_CONNECTION_LOST'
  }
  return false
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runQuery<T>(fn: (db: mysql.Pool) => Promise<T>): Promise<T> {
  try {
    return await fn(getPool())
  } catch (err) {
    if (isFatalConnectionError(err)) {
      // Pool is broken — rebuild it and retry once
      const fresh = await resetPool()
      try {
        return await fn(fresh)
      } catch (retryErr) {
        throw new Error('Database unavailable. Please try again shortly.')
      }
    }
    throw err
  }
}

export async function query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return runQuery(async db => { const [rows] = await db.query(sql, params as any); return rows as T[] })
}

export async function queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return (rows[0] as T) ?? null
}

export async function execute(sql: string, params?: unknown[]): Promise<mysql.ResultSetHeader> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return runQuery(async db => { const [result] = await db.query(sql, params as any); return result as mysql.ResultSetHeader })
}
