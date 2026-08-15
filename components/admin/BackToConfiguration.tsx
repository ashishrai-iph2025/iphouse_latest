'use client'

// "Back to Configuration" — the single way out of a Configuration sub-page.
//
// Every page reachable from /admin/configuration needs one, and they had drifted
// into two shapes: a bare "← Configuration" text link on some pages and this
// chevron + full label on others. One component keeps them identical, so the
// control sits in the same place and reads the same wherever you land.

import { Link } from 'react-router-dom'

export default function BackToConfiguration({ className = '' }: { className?: string }) {
  return (
    <div className={`mb-3 ${className}`}>
      <Link
        to="/admin/configuration"
        className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-2.5 py-1.5 -ml-2.5 transition-colors
          text-gray-500 hover:text-[#14254A] hover:bg-[#14254A]/[0.06]
          dark:text-white/50 dark:hover:text-white dark:hover:bg-white/10"
      >
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to Configuration
      </Link>
    </div>
  )
}
