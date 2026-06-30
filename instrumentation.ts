// Runs once when the Next.js server starts, before any routes are loaded.
export async function register() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}
