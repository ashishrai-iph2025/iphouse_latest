'use client'

import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'

interface Option {
  key: string
  label: string
}

interface Props {
  options:      Option[]
  value:        string
  onChange:     (val: string) => void
  placeholder?: string
  emptyLabel?:  string
  disabled?:    boolean
  dark?:        boolean
}

export default function SearchableSelect({
  options, value, onChange, placeholder = 'Select…', emptyLabel = '— All —', disabled = false, dark: darkProp,
}: Props) {
  const [open,  setOpen]  = useState(false)
  const [query, setQuery] = useState('')
  const [rect,  setRect]  = useState<DOMRect | null>(null)

  // Auto-detect the global dark theme (`.dark` on <html>) so every consumer gets
  // themed dropdowns without passing a prop. An explicit `dark` prop still wins.
  const [autoDark, setAutoDark] = useState(false)
  useEffect(() => {
    const check = () => setAutoDark(document.documentElement.classList.contains('dark'))
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  const dark = darkProp ?? autoDark

  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropRef    = useRef<HTMLDivElement>(null)
  const inputRef   = useRef<HTMLInputElement>(null)

  const selected = options.find(o => o.key === value)
  const filtered = query.trim()
    ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
    : options

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      const t = e.target as Node
      if (
        triggerRef.current && !triggerRef.current.contains(t) &&
        dropRef.current   && !dropRef.current.contains(t)
      ) { setOpen(false); setQuery('') }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Reposition on scroll/resize while open
  useEffect(() => {
    if (!open) return
    function update() {
      if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect())
    }
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open])

  function toggle() {
    if (disabled) return
    if (!open) {
      setRect(triggerRef.current?.getBoundingClientRect() ?? null)
      setOpen(true)
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      setOpen(false)
      setQuery('')
    }
  }

  function select(key: string) { onChange(key); setOpen(false); setQuery('') }

  // ── Dropdown (portal — escapes overflow:hidden ancestors) ──────────────────
  const dropdown = open && rect ? createPortal(
    <div
      ref={dropRef}
      style={{
        position: 'fixed',
        top:      rect.bottom + 4,
        left:     rect.left,
        width:    rect.width,
        zIndex:   9999,
        background: dark ? '#1b2d42' : '#fff',
        border:   dark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #e5e7eb',
        borderRadius: '0.75rem',
        boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
        overflow: 'hidden',
      }}
    >
      {/* Search box */}
      <div style={{
        padding: '8px',
        borderBottom: dark ? '1px solid rgba(255,255,255,0.07)' : '1px solid #f3f4f6',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          background: dark ? 'rgba(255,255,255,0.08)' : '#f9fafb',
          border: dark ? '1px solid rgba(255,255,255,0.1)' : 'none',
          borderRadius: '8px', padding: '6px 12px',
        }}>
          <svg style={{ width: 14, height: 14, flexShrink: 0, color: dark ? 'rgba(255,255,255,0.4)' : '#9ca3af' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            autoComplete="off"
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search…"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 14,
              color: dark ? '#fff' : '#374151',
            }}
          />
          {query && (
            <button type="button" onClick={() => setQuery('')}
              style={{ color: dark ? 'rgba(255,255,255,0.4)' : '#9ca3af', lineHeight: 1 }}>
              <svg style={{ width: 12, height: 12 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Options */}
      <ul style={{ maxHeight: 208, overflowY: 'auto', padding: '4px 0', margin: 0, listStyle: 'none' }}>
        {/* Clear option */}
        <li>
          <button type="button" onClick={() => select('')} style={{
            width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 14, border: 'none', cursor: 'pointer',
            background: !value ? (dark ? 'rgba(249,115,22,0.18)' : '#eff6ff') : 'transparent',
            color: !value ? (dark ? '#F97316' : '#1d4ed8') : (dark ? 'rgba(255,255,255,0.4)' : '#9ca3af'),
            fontWeight: !value ? 600 : 400,
          }}>
            {emptyLabel}
          </button>
        </li>
        {filtered.length === 0 ? (
          <li style={{ padding: '16px 12px', textAlign: 'center', fontSize: 14, color: dark ? 'rgba(255,255,255,0.3)' : '#9ca3af' }}>
            No results
          </li>
        ) : filtered.map(o => (
          <li key={o.key}>
            <button type="button" onClick={() => select(o.key)} style={{
              width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 14, border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              background: value === o.key ? (dark ? 'rgba(249,115,22,0.18)' : '#eff6ff') : 'transparent',
              color: value === o.key ? (dark ? '#fff' : '#1d4ed8') : (dark ? 'rgba(255,255,255,0.78)' : '#374151'),
              fontWeight: value === o.key ? 600 : 400,
            }}
            onMouseEnter={e => { if (value !== o.key) (e.currentTarget as HTMLElement).style.background = dark ? 'rgba(249,115,22,0.12)' : '#f9fafb' }}
            onMouseLeave={e => { if (value !== o.key) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              {value === o.key && (
                <svg style={{ width: 14, height: 14, flexShrink: 0, color: dark ? '#F97316' : '#1d4ed8' }}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>,
    document.body
  ) : null

  // ── Trigger button ─────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        style={dark ? {
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderRadius: '0.75rem', padding: '10px 12px', fontSize: 14, height: 44, cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1, transition: 'all 0.15s',
          background: 'rgba(255,255,255,0.065)',
          border: open ? '1px solid rgba(249,115,22,0.5)' : '1px solid rgba(255,255,255,0.09)',
          boxShadow: open ? '0 0 0 3px rgba(249,115,22,0.1)' : 'none',
        } : {
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderRadius: '0.75rem', padding: '10px 12px', fontSize: 14, cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1, transition: 'all 0.15s', background: '#fff',
          border: open ? '1px solid #3b82f6' : '1px solid #e5e7eb',
          boxShadow: open ? '0 0 0 3px rgba(59,130,246,0.1)' : 'none',
        }}
      >
        <span style={{
          color: dark
            ? (selected ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.22)')
            : (selected ? '#1f2937' : '#9ca3af'),
          fontWeight: selected ? 500 : 400,
          fontSize: dark ? '0.865rem' : 14,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {selected ? selected.label : placeholder}
        </span>
        <svg
          style={{
            width: 16, height: 16, flexShrink: 0, transition: 'transform 0.15s',
            transform: open ? 'rotate(180deg)' : 'none',
            color: dark ? 'rgba(255,255,255,0.3)' : '#9ca3af',
          }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {dropdown}
    </div>
  )
}
