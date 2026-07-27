// Fetch wrapper for Markscan API with proper certificate handling.
//
// Production: Must use valid certificates. Self-signed certs should be added
// to Node's CA bundle via NODE_EXTRA_CA_CERTS environment variable.
//
// Development: Can set ALLOW_INSECURE_SSL_DEV_ONLY=true to disable verification
// (NEVER use in production — enables MITM attacks).

export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // Only allow SSL verification bypass in development with explicit opt-in
  if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_INSECURE_SSL_DEV_ONLY === 'true') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  } else if (process.env.NODE_ENV === 'production' && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error(
      'SSL verification cannot be disabled in production. ' +
      'Add self-signed certificates to NODE_EXTRA_CA_CERTS environment variable instead.'
    )
  }
  return fetch(url, init)
}
