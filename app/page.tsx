import { redirect } from '@/lib/router'

// Root "/" redirects to "/login"
export default function HomePage() {
  redirect('/login')
}
