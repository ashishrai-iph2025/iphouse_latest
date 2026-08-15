'use client'

// Renders children into <body>.
//
// Needed for any `position: fixed` overlay inside a page: the page wrappers use
// the `.fade-in` class, and that animation is declared with `fill-mode: both`
// (app/globals.css), so its final `transform: translateY(0)` stays applied for
// good. A transformed ancestor becomes the containing block for `fixed`
// descendants, which pins the overlay to the content box instead of the
// viewport. Portalling out of that subtree is the fix.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export default function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  if (!mounted) return null
  return createPortal(children, document.body)
}
