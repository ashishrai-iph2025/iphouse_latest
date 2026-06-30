'use client'

import { Link } from 'react-router-dom'

interface BreadcrumbItem {
  label: string
  href?: string
}

interface Props {
  title:        string
  description?: string
  breadcrumb:   BreadcrumbItem[]
  actions?:     React.ReactNode
  backHref?:    string
  backLabel?:   string
}

export default function AdminPageHeader({ title, description, breadcrumb, actions, backHref, backLabel = 'Configuration' }: Props) {
  return (
    <div className="mb-6">

      {/* Back button */}
      {backHref && (
        <div className="mb-3">
          <Link
            to={backHref}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-[#14254A] transition-colors"
          >
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back to {backLabel}
          </Link>
        </div>
      )}

      {/* Row 1: breadcrumb left | title + description right */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">

        <nav className="flex items-center flex-wrap gap-1 text-xs">
          <Link to="/admin/home"
            className="flex items-center gap-1 text-gray-400 hover:text-[#14254A] transition-colors font-medium">
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path d="M3 12l2-2m0 0l7-7 7 7m-9 2v6a1 1 0 001 1h4a1 1 0 001-1v-6" />
            </svg>
            Home
          </Link>
          {breadcrumb.map((item, i) => {
            const isLast = i === breadcrumb.length - 1
            return (
              <span key={i} className="flex items-center gap-1">
                <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                  className="text-gray-300 flex-shrink-0">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {!isLast && item.href ? (
                  <Link to={item.href} className="text-gray-400 hover:text-[#14254A] transition-colors font-medium">
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

        <div className="sm:text-right">
          <h1 className="text-xl font-bold text-[#14254A]">{title}</h1>
          {description && <p className="text-brand-muted text-sm mt-0.5">{description}</p>}
        </div>

      </div>

      {/* Row 2: actions aligned right, below */}
      {actions && (
        <div className="flex items-center justify-end gap-2 mt-3">
          {actions}
        </div>
      )}

    </div>
  )
}
