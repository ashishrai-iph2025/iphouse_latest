/**
 * Client-side rate limiting to prevent brute force attacks
 * Uses localStorage to track attempts
 */

interface RateLimitEntry {
  attempts: number
  firstAttemptTime: number
  lastAttemptTime: number
  locked: boolean
  lockedUntil: number | null
}

const STORAGE_KEY_PREFIX = 'rate_limit_'

/**
 * Get rate limit data for a specific action and identifier
 */
function getRateLimitData(
  action: string,
  identifier: string
): RateLimitEntry {
  const key = `${STORAGE_KEY_PREFIX}${action}_${identifier}`

  try {
    const stored = localStorage.getItem(key)
    if (!stored) {
      return {
        attempts: 0,
        firstAttemptTime: Date.now(),
        lastAttemptTime: Date.now(),
        locked: false,
        lockedUntil: null,
      }
    }
    return JSON.parse(stored) as RateLimitEntry
  } catch {
    // If localStorage fails, return default
    return {
      attempts: 0,
      firstAttemptTime: Date.now(),
      lastAttemptTime: Date.now(),
      locked: false,
      lockedUntil: null,
    }
  }
}

/**
 * Save rate limit data
 */
function saveRateLimitData(
  action: string,
  identifier: string,
  data: RateLimitEntry
): void {
  const key = `${STORAGE_KEY_PREFIX}${action}_${identifier}`
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

/**
 * Clear rate limit data
 */
export function clearRateLimit(action: string, identifier: string): void {
  const key = `${STORAGE_KEY_PREFIX}${action}_${identifier}`
  try {
    localStorage.removeItem(key)
  } catch {
    // Silently fail
  }
}

interface RateLimitConfig {
  maxAttempts: number
  windowSeconds: number
  lockoutSeconds: number
}

const RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
  login: {
    maxAttempts: 5,
    windowSeconds: 300, // 5 minutes
    lockoutSeconds: 900, // 15 minutes
  },
  passwordReset: {
    maxAttempts: 3,
    windowSeconds: 600, // 10 minutes
    lockoutSeconds: 1800, // 30 minutes
  },
  register: {
    maxAttempts: 10,
    windowSeconds: 3600, // 1 hour
    lockoutSeconds: 3600, // 1 hour
  },
}

interface RateLimitCheckResult {
  allowed: boolean
  attemptsRemaining: number
  lockedUntilSeconds: number | null
  message: string
}

/**
 * Check if an action is rate limited
 * Returns: { allowed, attemptsRemaining, lockedUntilSeconds, message }
 */
export function checkRateLimit(
  action: string,
  identifier: string
): RateLimitCheckResult {
  const config = RATE_LIMIT_CONFIGS[action]

  if (!config) {
    return {
      allowed: true,
      attemptsRemaining: config?.maxAttempts ?? 0,
      lockedUntilSeconds: null,
      message: 'Rate limit check passed',
    }
  }

  const data = getRateLimitData(action, identifier)
  const now = Date.now()

  // Check if currently locked
  if (data.locked && data.lockedUntil && data.lockedUntil > now) {
    const secondsRemaining = Math.ceil((data.lockedUntil - now) / 1000)
    return {
      allowed: false,
      attemptsRemaining: 0,
      lockedUntilSeconds: secondsRemaining,
      message: `Too many attempts. Try again in ${secondsRemaining} seconds.`,
    }
  }

  // Unlock if lockout period has passed
  if (data.locked && data.lockedUntil && data.lockedUntil <= now) {
    data.locked = false
    data.lockedUntil = null
    data.attempts = 0
    data.firstAttemptTime = now
  }

  // Reset attempts if window has passed
  if (now - data.firstAttemptTime > config.windowSeconds * 1000) {
    data.attempts = 0
    data.firstAttemptTime = now
    data.lastAttemptTime = now
  }

  // Increment attempt count
  data.attempts += 1
  data.lastAttemptTime = now

  // Check if max attempts exceeded
  if (data.attempts > config.maxAttempts) {
    data.locked = true
    data.lockedUntil = now + config.lockoutSeconds * 1000

    saveRateLimitData(action, identifier, data)

    return {
      allowed: false,
      attemptsRemaining: 0,
      lockedUntilSeconds: config.lockoutSeconds,
      message: `Too many attempts. Account locked for ${config.lockoutSeconds / 60} minutes.`,
    }
  }

  saveRateLimitData(action, identifier, data)

  const attemptsRemaining = Math.max(0, config.maxAttempts - data.attempts)

  return {
    allowed: true,
    attemptsRemaining,
    lockedUntilSeconds: null,
    message: attemptsRemaining === 0 ? 'Last attempt' : `${attemptsRemaining} attempts remaining`,
  }
}

/**
 * Record an attempt and check if allowed (called BEFORE making the request)
 */
export function recordAttempt(
  action: string,
  identifier: string
): RateLimitCheckResult {
  return checkRateLimit(action, identifier)
}
