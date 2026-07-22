/**
 * Input validation utilities for security
 */

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate username format
 * Requirements: 3-100 chars, alphanumeric + dots, underscores, hyphens
 */
export function validateUsername(username: string): ValidationResult {
  const errors: string[] = []

  if (!username || username.trim().length === 0) {
    errors.push('Username is required')
  } else if (username.length < 3) {
    errors.push('Username must be at least 3 characters')
  } else if (username.length > 100) {
    errors.push('Username must be less than 100 characters')
  } else if (!/^[a-zA-Z0-9._@-]+$/.test(username)) {
    errors.push('Username can only contain letters, numbers, dots, underscores, hyphens, and @')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Validate email format
 */
export function validateEmail(email: string): ValidationResult {
  const errors: string[] = []

  if (!email || email.trim().length === 0) {
    errors.push('Email is required')
  } else if (email.length > 255) {
    errors.push('Email is too long')
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('Invalid email format')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Validate password strength
 * Basic: just checks length for login
 * Strict: enforces complexity (for registration/password change)
 */
export function validatePassword(
  password: string,
  strict = false
): ValidationResult {
  const errors: string[] = []

  if (!password) {
    errors.push('Password is required')
  } else if (password.length < 6) {
    errors.push('Password must be at least 6 characters')
  } else if (password.length > 256) {
    errors.push('Password is too long')
  }

  if (strict) {
    if (password.length < 12) {
      errors.push('Password must be at least 12 characters')
    }
    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain uppercase letter')
    }
    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain lowercase letter')
    }
    if (!/[0-9]/.test(password)) {
      errors.push('Password must contain number')
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      errors.push('Password must contain special character')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Sanitize user input to prevent XSS
 */
export function sanitizeInput(input: string): string {
  if (!input) return ''

  return input
    .trim()
    .replace(/[<>]/g, '') // Remove angle brackets
    .slice(0, 255) // Limit length
}

/**
 * Check if input contains suspicious patterns
 */
export function detectSuspiciousInput(input: string): boolean {
  const suspiciousPatterns = [
    /<script[^>]*>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi, // onclick=, onload= etc
    /union.*select/gi,
    /drop.*table/gi,
    /insert.*into/gi,
    /--/g, // SQL comments
  ]

  return suspiciousPatterns.some((pattern) => pattern.test(input))
}

/**
 * Validate OTP (one-time password)
 */
export function validateOTP(otp: string): ValidationResult {
  const errors: string[] = []

  if (!otp || otp.trim().length === 0) {
    errors.push('OTP is required')
  } else if (!/^\d{4,8}$/.test(otp)) {
    errors.push('OTP must be 4-8 digits')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Comprehensive login form validation
 */
export function validateLoginForm(
  username: string,
  password: string
): ValidationResult {
  const errors: string[] = []

  const usernameValidation = validateUsername(username)
  const passwordValidation = validatePassword(password)

  errors.push(...usernameValidation.errors)
  errors.push(...passwordValidation.errors)

  // Check for suspicious patterns
  if (detectSuspiciousInput(username)) {
    errors.push('Username contains suspicious characters')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
