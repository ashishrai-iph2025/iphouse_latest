'use client'

// Searchable single-select.
//
// The list is PORTALLED to <body> and positioned with fixed coordinates, so it
// escapes the `overflow` of whatever card it sits in. Three things follow from
// that and are the reason this is not a <select>:
//
//   · it can be WIDER than its trigger. A slicer in a 244px filter rail cannot
//     show "Alianza Contra la Piratería" — but the list it opens can, and a name
//     you have to guess at from its first twenty characters is not a choice,
//   · it can open UPWARDS when the trigger is near the bottom of the window,
//     instead of running off the screen,
//   · its height is whatever the viewport has room for, rather than a constant
//     that cuts the last row in half and looks broken.
//
// Keyboard: ↑ ↓ to move, Home/End to jump, Enter to choose, Escape to close.

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface Option {
  key: string
  label: string
  /* How much is behind this option in the scope on screen, where the caller
     knows. Optional: a picker whose list IS the data (clients, platforms) has
     nothing useful to put here, and an omitted count renders nothing rather
     than a misleading zero.

     It exists because a list can only be complete or only be relevant, not
     both. The Asset list is the client's whole catalogue — 1,572 titles, so the
     one being looked for can always be found — and most of them have nothing in
     the chosen month. Without the number the reader discovers that by picking
     one and watching the page empty. */
  count?: number
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

/** Room a dropdown wants below the trigger before it decides to open upwards. */
const PREFERRED_HEIGHT = 260
const MIN_HEIGHT = 176
const MAX_HEIGHT = 440
/** A trigger narrower than this gets a wider list — see the note above. */
const MIN_WIDTH = 288
const MAX_WIDTH = 460
const EDGE = 12
/** Options above which the list is worth searching rather than scanning. */
const SEARCH_FROM = 7

interface Pos {
  left: number; width: number; maxHeight: number
  top?: number; bottom?: number
}

export default function SearchableSelect({
  options, value, onChange, placeholder = 'Select…', emptyLabel = '— All —', disabled = false, dark: darkProp,
}: Props) {
  const [open,   setOpen]   = useState(false)
  const [query,  setQuery]  = useState('')
  const [pos,    setPos]    = useState<Pos | null>(null)
  const [active, setActive] = useState(0)

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
  const listRef    = useRef<HTMLUListElement>(null)

  const selected = options.find(o => o.key === value)

  /* Every token has to match somewhere in the label or the key, so "star plus"
     finds "Star Plus HD" and a partial id still finds its row. */
  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return options
    return options.filter(o => {
      const hay = `${String(o.label ?? '').toLowerCase()} ${String(o.key ?? '').toLowerCase()}`
      return tokens.every(t => hay.includes(t))
    })
  }, [options, query])

  /* The clear row is part of the list, not a thing beside it — so ↑ from the
     first option lands on "All" like any other row. */
  const rows = useMemo(
    () => [{ key: '', label: emptyLabel, clear: true }, ...filtered.map(o => ({ ...o, clear: false }))],
    [filtered, emptyLabel])

  const measure = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - EDGE
    const above = r.top - EDGE
    // Upwards only when below genuinely cannot hold the list AND above is
    // roomier — flipping for a few pixels' gain just makes the list jump about.
    const up = below < PREFERRED_HEIGHT && above > below
    const space = up ? above : below
    const maxHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, space))

    const width = Math.min(
      Math.max(r.width, MIN_WIDTH),
      Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - EDGE * 2)))
    // Aligned to the trigger, pulled back when that would hang off the edge.
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - EDGE - width))

    setPos(up
      ? { left, width, maxHeight, bottom: window.innerHeight - r.top + 4 }
      : { left, width, maxHeight, top: r.bottom + 4 })
  }, [])

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
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, measure])

  // A new search is a new list, so the highlight goes back to the top of it.
  useEffect(() => { setActive(query ? 1 : 0) }, [query])

  // Keep the highlighted row on screen when it is moved by the keyboard.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  function toggle() {
    if (disabled) return
    if (open) { setOpen(false); setQuery(''); return }
    measure()
    setOpen(true)
    // The highlight opens on the current value, so Enter re-picks it and ↓ moves
    // on from where the reader already is.
    const at = rows.findIndex(r => r.key === value)
    setActive(at >= 0 ? at : 0)
    setTimeout(() => inputRef.current?.focus(), 30)
  }

  function select(key: string) { onChange(key); setOpen(false); setQuery('') }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); setQuery(''); triggerRef.current?.focus(); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (rows[active]) select(rows[active].key)
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(rows.length - 1, a + 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(0, a - 1)); return }
    if (e.key === 'Home')      { e.preventDefault(); setActive(0); return }
    if (e.key === 'End')       { e.preventDefault(); setActive(rows.length - 1) }
  }

  /* One highlight, and it is solid.
     The row under the cursor — or under the keyboard — fills with brand orange
     and its text goes white. A tinted background plus a coloured label plus a
     bold weight, which is what this used to do, gives three weak signals where
     one strong one reads instantly and never leaves you wondering which row
     Enter will take. Selection is stated separately, by the check. */
  const ink = {
    text:   dark ? 'rgba(255,255,255,0.86)' : '#14254A',
    muted:  dark ? 'rgba(255,255,255,0.38)' : '#9ca3af',
    // One step back from muted, for a count of zero: still legible, but it must
    // not compete with the counts that mean something.
    faint:  dark ? 'rgba(255,255,255,0.26)' : '#c3c8d0',
    check:  dark ? 'rgba(255,255,255,0.55)' : '#14254A',
    hot:    '#FC934C',
    hotInk: '#ffffff',
    line:   dark ? 'rgba(255,255,255,0.08)' : '#f1f2f4',
  }

  /* A search box over seven options is furniture. It appears once the list is
     long enough that scanning it stops being the faster way to find a row. */
  const showSearch = options.length > SEARCH_FROM

  // ── Dropdown (portal — escapes overflow:hidden ancestors) ──────────────────
  const dropdown = open && pos ? createPortal(
    <div
      ref={dropRef}
      role="listbox"
      style={{
        position: 'fixed',
        top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width,
        maxHeight: pos.maxHeight,
        zIndex: 9999,
        display: 'flex', flexDirection: 'column',
        background: dark ? '#1b2d42' : '#fff',
        border: dark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #e5e7eb',
        borderRadius: '0.75rem',
        boxShadow: '0 12px 44px rgba(20,37,74,0.18)',
        overflow: 'hidden',
      }}
      onKeyDown={onKeyDown}
    >
      {/* Search box */}
      {showSearch && (
      <div style={{ padding: 8, borderBottom: `1px solid ${ink.line}`, flexShrink: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: dark ? 'rgba(255,255,255,0.08)' : '#f9fafb',
          border: dark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #eef0f3',
          borderRadius: 8, padding: '6px 10px',
        }}>
          <svg style={{ width: 14, height: 14, flexShrink: 0, color: ink.muted }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            autoComplete="off"
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={`Search ${options.length.toLocaleString()}…`}
            style={{
              flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
              fontSize: 13.5, color: dark ? '#fff' : '#374151',
            }}
          />
          {query && (
            <button type="button" onClick={() => { setQuery(''); inputRef.current?.focus() }}
              title="Clear the search" style={{ color: ink.muted, lineHeight: 1 }}>
              <svg style={{ width: 12, height: 12 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      )}

      {/* Options. The list takes the slack, so the search box and the footer
          stay put while only this scrolls. */}
      <ul ref={listRef}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, margin: 0, listStyle: 'none' }}>
        {rows.map((o, i) => {
          const on = o.key === value
          const hot = i === active
          return (
            <li key={o.key || '__clear'} role="option" aria-selected={on}>
              <button type="button" onClick={() => select(o.key)}
                onMouseEnter={() => setActive(i)}
                title={o.clear ? undefined : o.label}
                style={{
                  width: '100%', textAlign: 'left', padding: '9px 12px', fontSize: 14,
                  border: 'none', cursor: 'pointer', borderRadius: 8,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  background: hot ? ink.hot : 'transparent',
                  color: hot ? ink.hotInk : ink.text,
                  fontWeight: on ? 600 : 400,
                  transition: 'background 0.12s',
                }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {o.label}
                </span>
                {/* Tabular figures and a fixed slot, so the counts form a column
                    the eye can run down instead of ragged text after each name.
                    A zero is DIMMED rather than hidden: "nothing in this window"
                    is the answer to a question the reader would otherwise have
                    to spend a click on. */}
                {o.count !== undefined && !o.clear && (
                  <span style={{
                    flexShrink: 0, fontSize: 12, fontVariantNumeric: 'tabular-nums',
                    color: hot ? ink.hotInk : (o.count > 0 ? ink.muted : ink.faint),
                    opacity: o.count > 0 ? 1 : 0.75,
                  }}>
                    {o.count.toLocaleString()}
                  </span>
                )}
                {/* The check says what is CHOSEN. The fill says what is under the
                    cursor. They are different questions and answering both with
                    colour is what made the old list hard to read. */}
                {on && (
                  <svg style={{ width: 15, height: 15, flexShrink: 0, color: hot ? ink.hotInk : ink.check }}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.6}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            </li>
          )
        })}
        {filtered.length === 0 && (
          <li style={{ padding: '18px 12px', textAlign: 'center', fontSize: 13, color: ink.muted }}>
            Nothing matches “{query}”
          </li>
        )}
      </ul>

      {/* How much of the list is being shown — a filter that silently hides 400
          of 420 options reads as a short list rather than a narrow search. */}
      {query && filtered.length > 0 && (
        <div style={{
          flexShrink: 0, padding: '5px 12px', borderTop: `1px solid ${ink.line}`,
          fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
          color: ink.muted,
        }}>
          {filtered.length.toLocaleString()} of {options.length.toLocaleString()}
        </div>
      )}
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
        onKeyDown={e => {
          // Opening straight onto the list, without a trip through the mouse.
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { e.preventDefault(); toggle() }
        }}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={selected ? selected.label : undefined}
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
