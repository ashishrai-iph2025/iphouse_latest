// ─── Auth / User ──────────────────────────────────────────────────────────────

export interface User {
  userId: number
  name: string
  email: string
  role: number | null       // 1 = admin, null/other = client
  isSecure: number
  twoFaSecret?: string | null
  userLogo?: string
  companyLogo?: string
  apiUserName?: string
  apiPassword?: string
  deleted: number
}

export interface LoginRow {
  loginId: number
  userId: number
  firstName: string
  lastName: string
  loginUsername: string
  loginPassword: string
  loginType: number         // 0 = email OTP, 1 = authenticator, 2 = password
  twoFaSecret?: string | null
  isActive: number
}

export interface Module {
  moduleId: number
  moduleName: string
  moduleIcon: string
  link: string
  noLinkMsg: string
  active: number
  default: number
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface AuthSession {
  userId: number
  loginId: number
  name: string
  email: string
  role: number | null
  loginUsername: string
  apiToken?: string
  userLogo?: string
  companyLogo?: string
}

// ─── Infringement / API ───────────────────────────────────────────────────────

export type Platform =
  | 'facebook'
  | 'internet'
  | 'youtube'
  | 'instagram'
  | 'twitter'
  | 'telegram'
  | 'tiktok'
  | 'vk'
  | 'ok'
  | 'sharechat'
  | 'dailymotion'
  | 'bilibili'
  | 'chomikuj'
  | 'ugc and other social media'
  | 'i-tunes'
  | 'play store'
  | 'third party app'
  | 'third party mobile app'

export interface InfringementItem {
  [key: string]: unknown
  urlId?: string | number
  url?: string
  title?: string
  status?: string
  platform?: string
  assetName?: string
  uploadDate?: string
  detectedDate?: string
  removalStatus?: string
  views?: number
}

export interface InfringementResponse {
  success: boolean
  data?: {
    items: InfringementItem[]
    total: number
    page: number
    per_page: number
  }
  error?: string
  redirect?: string
}

export interface FetchParams {
  platform: Platform
  startDate?: string
  endDate?: string
  assetName?: string
  page?: number
  perPage?: number
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export interface Client {
  userId: number
  name: string
  email: string
  userLogo?: string
  companyLogo?: string
  deleted: number
  role: number | null
  apiUserName?: string
  apiPassword?: string
}

export interface Dashboard {
  dashboardId: number
  userId: number
  title: string
  embedUrl?: string
  active: number
  createdAt: string
}

export interface ApiCredential {
  credentialId: number
  userId: number
  apiUserName: string
  apiPassword: string
  createdAt: string
}

export interface EmailCredential {
  credId: number
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPass: string
  smtpFrom: string
  isActive: number
}

export interface Notification {
  notificationId: number
  userId: number
  message: string
  type: string
  isRead: number
  createdAt: string
}

// ─── Download / Upload ────────────────────────────────────────────────────────

export interface DownloadRequest {
  requestId: string
  platform: Platform
  assetName: string
  startDate: string
  endDate: string
  status: string
  createdAt: string
  downloadUrl?: string
}

export interface UploadUrlPayload {
  assetName: string
  platform: Platform
  urls: string[]
  officialUrl?: string
  remarks?: string
  clientEmail?: string
  userEmail?: string
}

// ─── Enforce ──────────────────────────────────────────────────────────────────

export type EnforceAction = 'approved' | 'rejected'

export interface EnforcePayload {
  actionType: EnforceAction
  platform: Platform
  assetName: string
  urlids: (string | number)[]
  comment: string
  isSourceURL?: boolean
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  perPage: number
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}
