'use client'

// Shared presentation for portal notifications, used by the bell, the full
// list page and the detail page so a source never looks different in one place
// than another.

import type { ReactNode } from 'react'

export interface PortalNotification {
  id: number
  event_type: string
  title: string
  message: string
  actor_login_id?: number
  actor_name: string
  actor_username: string
  client_user_id: number
  client_name: string
  link: string
  metadata: string | null
  created_at: string
  is_read: number
  read_at?: string | null
}

/** Scope the server applied to this viewer's feed. */
export type Scope = 'all' | 'company' | 'self'

export interface SourceMeta {
  label: string
  chip: string
  bg: string
  fg: string
  icon: ReactNode
  /** Where the action was performed — shown on the detail page. */
  page: string
}

export const SOURCE_META: Record<string, SourceMeta> = {
  url_upload: {
    label: 'URL Upload',
    page: 'Submit URLs for Take-down',
    chip: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
    bg: 'bg-blue-50 dark:bg-blue-500/10', fg: 'text-blue-600 dark:text-blue-300',
    icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1m-4-8-4-4m0 0L8 8m4-4v12" /></svg>,
  },
  approval_action: {
    label: 'Approval Review',
    page: 'Approval Review',
    chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    bg: 'bg-emerald-50 dark:bg-emerald-500/10', fg: 'text-emerald-600 dark:text-emerald-300',
    icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /></svg>,
  },
  download_request: {
    label: 'Download Request',
    page: 'Download Request',
    chip: 'bg-orange-50 text-[#c2691f] dark:bg-orange-500/15 dark:text-[#FC934C]',
    bg: 'bg-orange-50 dark:bg-orange-500/10', fg: 'text-[#FC934C]',
    icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1m-4-4-4 4m0 0-4-4m4 4V4" /></svg>,
  },
  data_sharing: {
    label: 'Data Sharing',
    page: 'Data Sharing',
    chip: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
    bg: 'bg-violet-50 dark:bg-violet-500/10', fg: 'text-violet-600 dark:text-violet-300',
    icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5M7 3h8l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /></svg>,
  },
  download_ready: {
    label: 'Download Ready',
    page: 'Download Request',
    chip: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
    bg: 'bg-teal-50 dark:bg-teal-500/10', fg: 'text-teal-600 dark:text-teal-300',
    icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>,
  },
}

export const FALLBACK_SOURCE: SourceMeta = {
  label: 'Activity',
  page: 'Portal',
  chip: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-white/60',
  bg: 'bg-gray-100 dark:bg-white/10', fg: 'text-gray-500 dark:text-white/60',
  icon: <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 8h.01M12 11v5" /></svg>,
}

export const sourceOf = (type: string): SourceMeta => SOURCE_META[type] ?? FALLBACK_SOURCE

export function parseMeta(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try { return JSON.parse(raw) ?? {} } catch { return {} }
}

/** MySQL hands back UTC as "YYYY-MM-DD HH:MM:SS" with no zone marker. */
export function toDate(v: string | null | undefined): Date | null {
  const s = String(v ?? '')
  if (!s) return null
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime()) ? null : d
}

export function relativeTime(v: string): string {
  const d = toDate(v)
  if (!d) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

export const exactTime = (v: string | null | undefined) =>
  toDate(v)?.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) ?? '—'

/** Human labels for the metadata keys the triggers record. */
export const META_LABELS: Record<string, string> = {
  platform:         'Platform',
  assetName:        'Asset',
  urlCount:         'URLs affected',
  decision:         'Decision',
  comment:          'Reviewer comment',
  startDate:        'From date',
  endDate:          'To date',
  fileName:         'File name',
  fileSize:         'File size',
  requestId:        'Request reference',
  status:           'Status',
  impersonatedBy:   'Performed by IP House staff',
  impersonatorName: 'Staff member',
}

/** Order metadata rows predictably; unknown keys keep insertion order at the end. */
export const META_ORDER = [
  'status', 'decision', 'platform', 'assetName', 'urlCount', 'startDate', 'endDate',
  'requestId',
  'fileName', 'fileSize', 'comment', 'impersonatorName', 'impersonatedBy',
]

export function formatMetaValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (key === 'fileSize') {
    const n = Number(value)
    if (!isFinite(n)) return String(value)
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return value.toLocaleString()
  return String(value)
}

/** Sorted [key, value] pairs for rendering a metadata table. */
export function orderedMeta(meta: Record<string, any>): [string, any][] {
  const keys = Object.keys(meta)
  keys.sort((a, b) => {
    const ia = META_ORDER.indexOf(a)
    const ib = META_ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return 0
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
  return keys.map(k => [k, meta[k]])
}
