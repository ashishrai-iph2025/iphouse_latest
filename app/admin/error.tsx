'use client'

import { useEffect } from 'react'
import { Link } from 'react-router-dom'

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[AdminError]', error)
  }, [error])

  const isDbError =
    error.message?.includes('Database') ||
    error.message?.includes('ECONNREFUSED') ||
    error.message?.includes('unavailable') ||
    error.message?.includes('ER_')

  return (
    <div className="flex items-center justify-center min-h-[60vh] px-4">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-8 max-w-md w-full text-center">
        <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 00-3.42 0z" />
          </svg>
        </div>
        <h2 className="text-lg font-bold text-gray-800 mb-2">
          {isDbError ? 'Database Unavailable' : 'Something Went Wrong'}
        </h2>
        <p className="text-sm text-gray-500 mb-6">
          {isDbError
            ? 'Unable to connect to the database. Please wait a moment and try again.'
            : 'An unexpected error occurred while loading this page.'}
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="px-5 py-2 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ background: '#14254A' }}
          >
            Try again
          </button>
          <Link
            href="/admin/home"
            className="px-5 py-2 rounded-xl text-sm font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50 no-underline"
          >
            Go to Home
          </Link>
        </div>
      </div>
    </div>
  )
}
