// Drop-in compat shim: replaces next/navigation with React Router equivalents.
// Import from '@/lib/router' wherever you'd import from 'next/navigation'.

export {
  useParams,
  useNavigate,
  Navigate,
} from 'react-router-dom'

import {
  useNavigate,
  useLocation,
  useSearchParams as useRRSearchParams,
} from 'react-router-dom'

export function useRouter() {
  const navigate = useNavigate()
  return {
    push:    (url: string) => navigate(url),
    replace: (url: string) => navigate(url, { replace: true }),
    back:    ()            => navigate(-1),
    refresh: ()            => window.location.reload(),
    prefetch: (_url: string) => {},
  }
}

export function usePathname(): string {
  return useLocation().pathname
}

// Returns URLSearchParams directly (same API as Next.js useSearchParams).
export function useSearchParams(): URLSearchParams {
  const [sp] = useRRSearchParams()
  return sp
}

// Server-side redirect/notFound are no-ops on the client.
export function redirect(_url: string): never {
  window.location.replace(_url)
  throw new Error('redirect')
}

export function notFound(): never {
  throw new Error('not-found')
}
