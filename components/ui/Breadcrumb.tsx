'use client'

import { Link } from 'react-router-dom'

interface Item {
  label: string
  href?: string
}

export default function Breadcrumb({ items }: { items: Item[] }) {
  return (
    <nav className="flex items-center flex-wrap gap-1 text-xs mb-5">
      <Link to="/dashboard"
        className="flex items-center gap-1 text-gray-400 hover:text-[#14254A] transition-colors font-medium">
        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path d="M3 12l2-2m0 0l7-7 7 7m-9 2v6a1 1 0 001 1h4a1 1 0 001-1v-6" />
        </svg>
        Home
      </Link>
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span key={i} className="flex items-center gap-1">
            <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
              className="text-gray-300 flex-shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            {!isLast && item.href ? (
              <Link to={item.href}
                className="text-gray-400 hover:text-[#14254A] transition-colors font-medium">
                {item.label}
              </Link>
            ) : (
              <span className={isLast ? 'text-[#14254A] font-semibold' : 'text-gray-400 font-medium'}>
                {item.label}
              </span>
            )}
          </span>
        )
      })}
    </nav>
  )
}
