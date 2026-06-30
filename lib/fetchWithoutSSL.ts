// SSL-disabled fetch wrapper for Markscan API (self-signed cert).
// NODE_TLS_REJECT_UNAUTHORIZED is read per-connection by Node's undici engine,
// so setting it here before each call reliably disables cert verification.

export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  return fetch(url, init)
}
