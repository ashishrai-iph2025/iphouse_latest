'use client'

import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'

interface Option { key: string; label: string }

interface Props {
  options:      Option[]
  values:       string[]
  onChange:     (vals: string[]) => void
  placeholder?: string
  disabled?:    boolean
  dark?:        boolean
  invalid?:     boolean
}

export default function MultiSearchableSelect({
  options, values, onChange,
  placeholder = 'Select…', disabled = false, dark: darkProp, invalid = false,
}: Props) {
  const [open,  setOpen]  = useState(false)
  const [query, setQuery] = useState('')
  const [rect,  setRect]  = useState<DOMRect | null>(null)

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

  const valSet  = new Set(values)
  const normalizedQuery = query.trim().toLowerCase()
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean)
  const filtered = queryTokens.length
    ? options.filter(o => {
        const haystack = `${String(o.label ?? '').toLowerCase()} ${String(o.key ?? '').toLowerCase()}`
        return queryTokens.every(token => haystack.includes(token))
      })
    : options

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

  function openDrop() {
    if (disabled) return
    setRect(triggerRef.current?.getBoundingClientRect() ?? null)
    setOpen(true)
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  function toggleItem(key: string) {
    if (valSet.has(key)) onChange(values.filter(v => v !== key))
    else                  onChange([...values, key])
  }

  const triggerLabel =
    values.length === 0 ? null
    : values.length === 1 ? (options.find(o => o.key === values[0])?.label ?? values[0])
    : `${values.length} assets selected`

  const borderColor = (focused: boolean) =>
    invalid   ? '#ef4444'
    : focused  ? (dark ? 'rgba(249,115,22,0.5)' : '#3b82f6')
    : dark     ? 'rgba(255,255,255,0.09)'
    : '#e5e7eb'

  const shadowColor = (focused: boolean) =>
    invalid   ? 'rgba(239,68,68,0.12)'
    : focused  ? (dark ? 'rgba(249,115,22,0.1)' : 'rgba(59,130,246,0.1)')
    : 'none'

  const dropdown = open && rect ? createPortal(
    <div
      ref={dropRef}
      style={{
        position: 'fixed', top: rect.bottom + 4, left: rect.left, width: rect.width,
        zIndex: 9999,
        background:   dark ? '#1b2d42' : '#fff',
        border:       dark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #e5e7eb',
        borderRadius: '0.75rem',
        boxShadow:    '0 10px 40px rgba(0,0,0,0.15)',
        overflow:     'hidden',
      }}
    >
      {/* Search + actions */}
      <div style={{
        padding: '8px',
        borderBottom: dark ? '1px solid rgba(255,255,255,0.07)' : '1px solid #f3f4f6',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: dark ? 'rgba(255,255,255,0.08)' : '#f9fafb',
          border:     dark ? '1px solid rgba(255,255,255,0.1)' : 'none',
          borderRadius: 8, padding: '6px 12px',
        }}>
          <svg style={{ width: 14, height: 14, flexShrink: 0, color: dark ? 'rgba(255,255,255,0.4)' : '#9ca3af' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            ref={inputRef} autoComplete="off" type="text"
            value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search assets…"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 14,
              color: dark ? '#fff' : '#374151',
            }}
          />
          {query && (
            <button type="button" onClick={() => setQuery('')}
              style={{ color: dark ? 'rgba(255,255,255,0.4)' : '#9ca3af', lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>
              <svg style={{ width: 12, height: 12 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        {filtered.length > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 2px' }}>
            <button type="button" onClick={() => onChange(filtered.map(o => o.key))}
              style={{ fontSize: 12, color: '#14254A', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>
              Select all{query ? ' matching' : ''}
            </button>
            <button type="button" onClick={() => onChange([])}
              style={{ fontSize: 12, color: '#9ca3af', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Option list */}
      <ul style={{ maxHeight: 240, overflowY: 'auto', padding: '4px 0', margin: 0, listStyle: 'none' }}>
        {filtered.length === 0 ? (
          <li style={{ padding: '16px 12px', textAlign: 'center', fontSize: 14, color: dark ? 'rgba(255,255,255,0.3)' : '#9ca3af' }}>
            No results
          </li>
        ) : filtered.map(o => {
          const checked = valSet.has(o.key)
          return (
            <li key={o.key}>
              <button
                type="button"
                onClick={() => toggleItem(o.key)}
                style={{
                  width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 14,
                  border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                  background: checked ? (dark ? 'rgba(20,37,74,0.3)' : '#eff6ff') : 'transparent',
                  color: checked ? (dark ? '#fff' : '#14254A') : (dark ? 'rgba(255,255,255,0.78)' : '#374151'),
                  fontWeight: checked ? 600 : 400,
                }}
                onMouseEnter={e => { if (!checked) (e.currentTarget as HTMLElement).style.background = dark ? 'rgba(255,255,255,0.06)' : '#f9fafb' }}
                onMouseLeave={e => { if (!checked) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <span style={{
                  width: 16, height: 16, flexShrink: 0, borderRadius: 4,
                  border: checked ? 'none' : `2px solid ${dark ? 'rgba(255,255,255,0.3)' : '#d1d5db'}`,
                  background: checked ? '#14254A' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.1s',
                }}>
                  {checked && (
                    <svg style={{ width: 10, height: 10, color: '#fff' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {/* Footer */}
      <div style={{
        padding: '8px 12px',
        borderTop: dark ? '1px solid rgba(255,255,255,0.07)' : '1px solid #f3f4f6',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 12, color: dark ? 'rgba(255,255,255,0.4)' : '#9ca3af' }}>
          {values.length} of {options.length} selected
        </span>
        <button type="button" onClick={() => { setOpen(false); setQuery('') }}
          style={{ fontSize: 12, fontWeight: 700, padding: '4px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#14254A', color: '#fff' }}>
          Done
        </button>
      </div>
    </div>,
    document.body
  ) : null

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        ref={triggerRef} type="button" onClick={open ? () => { setOpen(false); setQuery('') } : openDrop}
        disabled={disabled}
        style={dark ? {
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderRadius: '0.75rem', padding: '10px 12px', fontSize: 14, height: 44,
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, transition: 'all 0.15s',
          background: 'rgba(255,255,255,0.065)',
          border: `1px solid ${borderColor(open)}`,
          boxShadow: open || invalid ? `0 0 0 3px ${shadowColor(open)}` : 'none',
        } : {
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderRadius: '0.75rem', padding: '10px 12px', fontSize: 14,
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, transition: 'all 0.15s',
          background: '#fff',
          border: `1px solid ${borderColor(open)}`,
          boxShadow: open || invalid ? `0 0 0 3px ${shadowColor(open)}` : 'none',
        }}
      >
        <span style={{
          color: dark
            ? (triggerLabel ? 'rgba(255,255,255,0.85)' : (invalid ? '#f87171' : 'rgba(255,255,255,0.22)'))
            : (triggerLabel ? '#1f2937' : (invalid ? '#dc2626' : '#9ca3af')),
          fontWeight: triggerLabel ? 500 : 400,
          fontSize: dark ? '0.865rem' : 14,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {triggerLabel ?? placeholder}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {values.length > 0 && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
              background: '#14254A', color: '#fff', lineHeight: '18px',
            }}>
              {values.length}
            </span>
          )}
          <svg
            style={{ width: 16, height: 16, transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none', color: dark ? 'rgba(255,255,255,0.3)' : '#9ca3af' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {dropdown}
    </div>
  )
}
