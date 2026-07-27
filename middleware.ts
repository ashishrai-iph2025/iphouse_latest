import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const response = NextResponse.next()

  // Prevent clickjacking attacks
  response.headers.set('X-Frame-Options', 'DENY')

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff')

  // Enable XSS protection
  response.headers.set('X-XSS-Protection', '1; mode=block')

  // HSTS - Force HTTPS for 1 year (including subdomains)
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload'
  )

  // Content Security Policy - restrict resource loading (no unsafe-inline)
  // NOTE: If you need inline styles, use CSS-in-JS or extract to <style> tags with nonce.
  //       If you need inline scripts, extract to separate <script> tags or use nonce.
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none';"
  )

  // Referrer Policy - limit referrer information
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  // Permissions Policy - disable unnecessary APIs
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  )

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/auth|logo1.png).*)',
  ],
}
