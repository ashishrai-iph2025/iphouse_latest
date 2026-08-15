'use client'

// Shared raw-data export used by every War Room visual. Each chart/card hands
// over the exact series it renders, so the downloaded file always matches what
// is on screen (including any active cross-filters).

export interface CsvColumn<T = any> {
  key: string
  label: string
  /** Optional accessor when the value isn't a plain property of the row. */
  get?: (row: T) => unknown
}

/** Excel treats a leading =/+/-/@ as a formula; prefix those so a cell that
    starts with one is stored as text rather than executed on open. */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /["\n,;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const head = columns.map(c => escapeCell(c.label)).join(',')
  const body = rows.map(row =>
    columns.map(c => escapeCell(c.get ? c.get(row) : (row as any)?.[c.key])).join(',')
  )
  return [head, ...body].join('\r\n')
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'export'
}

/** Build the CSV and hand it to the browser as a download. The BOM keeps
    non-ASCII asset/channel names readable when the file is opened in Excel. */
export function downloadCsv<T>(fileName: string, columns: CsvColumn<T>[], rows: T[]): void {
  const csv = toCsv(columns, rows)
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `${safeFileName(fileName)}_${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke on the next tick so Safari has actually started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
