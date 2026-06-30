import crypto from 'crypto'

const KEY = process.env.ENCRYPTION_KEY ?? ''

// ── API Credentials: fixed key+IV (matches PHP ManageApiCredentials.php) ──────
// openssl_encrypt($value, 'AES-256-CBC', key, 0, iv) → base64 (no IV prepended)
const API_KEY = Buffer.from(process.env.API_CRED_KEY ?? '12345678901234567890123456789012')
const API_IV  = Buffer.from(process.env.API_CRED_IV  ?? '1234567890123456')

export function encryptApiPassword(plain: string): string {
  if (!plain) return ''
  const c = crypto.createCipheriv('aes-256-cbc', API_KEY, API_IV)
  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64')
}

export function decryptApiPassword(encoded: unknown): string {
  if (!encoded) return ''
  const str = Buffer.isBuffer(encoded) ? (encoded as Buffer).toString('utf8') : String(encoded)
  if (!str.trim()) return ''
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', API_KEY, API_IV)
    return Buffer.concat([d.update(str, 'base64'), d.final()]).toString('utf8')
  } catch {
    return str // fallback: value was stored as plain text
  }
}

/**
 * Matches PHP:
 *   $iv     = openssl_random_pseudo_bytes(16)
 *   $cipher = openssl_encrypt($plain, "AES-256-CBC", $key, 0, $iv)  // returns base64
 *   return base64_encode($iv . $cipher)                               // raw_iv + base64_cipher
 */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(KEY), iv)
  const base64Cipher = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
  // Concatenate raw IV bytes + base64 cipher string bytes, then base64-encode the whole thing
  const combined = Buffer.concat([iv, Buffer.from(base64Cipher, 'utf8')])
  return combined.toString('base64')
}

/**
 * Matches PHP:
 *   $data   = base64_decode($encrypted)
 *   $iv     = substr($data, 0, 16)
 *   $cipher = substr($data, 16)
 *   return openssl_decrypt($cipher, "AES-256-CBC", $key, 0, $iv)
 */
export function decrypt(encoded: string): string {
  try {
    const combined = Buffer.from(encoded, 'base64')
    const iv = combined.subarray(0, 16)
    const base64Cipher = combined.subarray(16).toString('utf8')
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(KEY), iv)
    return Buffer.concat([decipher.update(base64Cipher, 'base64'), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}
