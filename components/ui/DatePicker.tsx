'use client'

import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  format, parse, isValid,
  startOfMonth, endOfMonth, eachDayOfInterval,
  getDay, addMonths, subMonths,
  isToday, isSameDay, setMonth, setYear, getMonth, getYear,
} from 'date-fns'

interface DatePickerProps {
  value:         string                    // YYYY-MM-DD or ''
  onChange:      (val: string) => void
  placeholder?:  string
  min?:          string                    // YYYY-MM-DD
  max?:          string                    // YYYY-MM-DD
  accentColor?:  string
  disabled?:     boolean
}

const DAYS   = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function parseYMD(s: string): Date | null {
  if (!s) return null
  const d = parse(s, 'yyyy-MM-dd', new Date())
  return isValid(d) ? d : null
}

// Year range: 10 years back to 5 years ahead
const THIS_YEAR = new Date().getFullYear()
const YEARS = Array.from({ length: 16 }, (_, i) => THIS_YEAR - 10 + i)

export default function DatePicker({
  value,
  onChange,
  placeholder  = 'Select date',
  min,
  max,
  accentColor  = '#14254A',
  disabled     = false,
}: DatePickerProps) {
  const selected = parseYMD(value)
  const [open,        setOpen]        = useState(false)
  const [view,        setView]        = useState<Date>(selected ?? new Date())
  const [dropPos,     setDropPos]     = useState<{ top: number; left: number; width: number } | null>(null)
  const [monthOpen,   setMonthOpen]   = useState(false)
  const [yearOpen,    setYearOpen]    = useState(false)
  const [mounted,     setMounted]     = useState(false)

  const ref         = useRef<HTMLDivElement>(null)
  const calendarRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    const d = parseYMD(value)
    if (d) setView(d)
  }, [value])

  useEffect(() => {
    if (!open) { setMonthOpen(false); setYearOpen(false); return }
    function handler(e: MouseEvent) {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !calendarRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open) return
    function reposition() {
      if (!ref.current) return
      const r    = ref.current.getBoundingClientRect()
      const top  = r.bottom + 6
      setDropPos({ top: top + 340 > window.innerHeight ? r.top - 340 - 6 : top, left: r.left, width: r.width })
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition) }
  }, [open])

  function openCalendar() {
    if (disabled || !ref.current) return
    const r   = ref.current.getBoundingClientRect()
    const top = r.bottom + 6
    setDropPos({ top: top + 340 > window.innerHeight ? r.top - 340 - 6 : top, left: r.left, width: r.width })
    setOpen(o => !o)
  }

  function isDisabled(day: Date) {
    const minD = parseYMD(min || '')
    const maxD = parseYMD(max || '')
    if (minD && day < minD) return true
    if (maxD && day > maxD) return true
    return false
  }

  function selectDay(day: Date) {
    if (isDisabled(day)) return
    onChange(format(day, 'yyyy-MM-dd'))
    setOpen(false)
  }

  function clear(e: React.MouseEvent) { e.stopPropagation(); onChange('') }

  const displayValue  = selected ? format(selected, 'dd MMM yyyy') : ''
  const daysInMonth   = eachDayOfInterval({ start: startOfMonth(view), end: endOfMonth(view) })
  const startOffset   = getDay(startOfMonth(view))

  const currentMonth = getMonth(view)
  const currentYear  = getYear(view)

  return (
    <div ref={ref} className="relative">
      {/* ── Trigger ─────────────────────────────────────────────────────── */}
      <button
        type="button"
        disabled={disabled}
        onClick={openCalendar}
        className={`
          w-full flex items-center gap-2 border rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-white/5 text-left
          focus:outline-none focus:ring-2 focus:border-transparent transition-colors
          ${disabled ? 'opacity-50 cursor-not-allowed border-gray-200' : 'border-gray-200 hover:border-gray-300 cursor-pointer'}
          ${open ? 'ring-2 border-transparent' : ''}
        `}
        style={open ? { '--tw-ring-color': accentColor } as React.CSSProperties : {}}
      >
        <svg className="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className={`flex-1 ${displayValue ? 'text-gray-800' : 'text-gray-400'}`}>
          {displayValue || placeholder}
        </span>
        {displayValue && !disabled && (
          <span onClick={clear} className="text-gray-300 hover:text-gray-500 text-base leading-none transition-colors select-none">×</span>
        )}
      </button>

      {/* ── Calendar portal ─────────────────────────────────────────────── */}
      {open && mounted && dropPos && createPortal(
        <div
          ref={calendarRef}
          className="fixed z-[9999] w-72 bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden"
          style={{ top: dropPos.top, left: dropPos.left }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5" style={{ background: accentColor }}>
            <button type="button"
              onClick={() => { setView(d => subMonths(d, 1)); setMonthOpen(false); setYearOpen(false) }}
              className="w-7 h-7 rounded-lg hover:bg-white/20 flex items-center justify-center transition-colors text-white font-bold text-lg leading-none">
              ‹
            </button>

            {/* Month + Year selectors */}
            <div className="flex items-center gap-1">
              {/* Month pill */}
              <div className="relative">
                <button type="button"
                  onClick={() => { setMonthOpen(o => !o); setYearOpen(false) }}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-white/20 text-white text-sm font-semibold transition-colors">
                  {MONTHS[currentMonth]}
                  <svg className={`w-3 h-3 transition-transform ${monthOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {monthOpen && (
                  <div className="absolute top-full left-0 mt-1 bg-white rounded-xl shadow-xl border border-gray-100 z-10 overflow-hidden"
                    style={{ minWidth: 110 }}>
                    <ul className="py-1 max-h-48 overflow-y-auto">
                      {MONTHS.map((m, i) => (
                        <li key={m}>
                          <button type="button"
                            onClick={() => { setView(d => setMonth(d, i)); setMonthOpen(false) }}
                            className={`w-full text-left px-3 py-1.5 text-sm transition-colors
                              ${i === currentMonth ? 'font-bold text-white' : 'text-gray-700 hover:bg-gray-50'}`}
                            style={i === currentMonth ? { background: accentColor } : {}}>
                            {m}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Year pill */}
              <div className="relative">
                <button type="button"
                  onClick={() => { setYearOpen(o => !o); setMonthOpen(false) }}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-white/20 text-white text-sm font-semibold transition-colors">
                  {currentYear}
                  <svg className={`w-3 h-3 transition-transform ${yearOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {yearOpen && (
                  <div className="absolute top-full left-0 mt-1 bg-white rounded-xl shadow-xl border border-gray-100 z-10 overflow-hidden"
                    style={{ minWidth: 90 }}>
                    <ul className="py-1 max-h-48 overflow-y-auto">
                      {YEARS.map(y => (
                        <li key={y}>
                          <button type="button"
                            onClick={() => { setView(d => setYear(d, y)); setYearOpen(false) }}
                            className={`w-full text-left px-3 py-1.5 text-sm transition-colors
                              ${y === currentYear ? 'font-bold text-white' : 'text-gray-700 hover:bg-gray-50'}`}
                            style={y === currentYear ? { background: accentColor } : {}}>
                            {y}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            <button type="button"
              onClick={() => { setView(d => addMonths(d, 1)); setMonthOpen(false); setYearOpen(false) }}
              className="w-7 h-7 rounded-lg hover:bg-white/20 flex items-center justify-center transition-colors text-white font-bold text-lg leading-none">
              ›
            </button>
          </div>

          {/* Day labels */}
          <div className="grid grid-cols-7 px-3 pt-3 pb-1">
            {DAYS.map(d => (
              <div key={d} className="text-center text-[10px] font-bold text-gray-400 uppercase tracking-wide">{d}</div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 px-3 pb-2 gap-y-0.5">
            {Array.from({ length: startOffset }).map((_, i) => <div key={`pad-${i}`} />)}
            {daysInMonth.map(day => {
              const isSel = selected ? isSameDay(day, selected) : false
              const today = isToday(day)
              const dis   = isDisabled(day)
              return (
                <button key={day.toISOString()} type="button" disabled={dis} onClick={() => selectDay(day)}
                  className={`h-8 w-8 mx-auto rounded-lg text-xs font-medium transition-all
                    ${isSel ? 'text-white shadow-sm' : 'text-gray-700'}
                    ${dis ? 'opacity-30 cursor-not-allowed' : 'hover:bg-gray-100 cursor-pointer'}`}
                  style={isSel ? { background: accentColor } : today && !isSel ? { color: accentColor, fontWeight: 700 } : {}}>
                  {format(day, 'd')}
                </button>
              )
            })}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-100 px-3 py-2 flex gap-2">
            <button type="button"
              onClick={() => { const t = new Date(); if (!isDisabled(t)) selectDay(t) }}
              className="flex-1 text-xs font-semibold py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
              Today
            </button>
            <button type="button" onClick={() => setOpen(false)}
              className="flex-1 text-xs font-semibold py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
              Close
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
