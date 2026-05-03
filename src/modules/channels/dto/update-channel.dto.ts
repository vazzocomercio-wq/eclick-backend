export interface UpdateChannelDto {
  name?: string
  status?: 'pending' | 'active' | 'paused' | 'error' | 'disconnected'
  credentials?: Record<string, unknown>
  webhook_url?: string | null
  webhook_secret?: string | null
  phone_number?: string | null
  external_id?: string | null
  error_message?: string | null
  config?: Record<string, unknown>
}
