// Shared in-memory store for client-selection temp tokens
export const tempTokenStore = new Map<string, {
  loginId:  number
  username: string
  exp:      number
  apiToken: string | null
}>()
