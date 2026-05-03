/**
 * Body do POST /channels.
 *
 * channel_type='whatsapp_free' SEMPRE entra com status='pending', mesmo se
 * `credentials` vier preenchido (Bug #5 do Active — frontend pode mandar
 * lixo herdado, worker é quem decide quando promover pra 'active').
 */
export interface CreateChannelDto {
  channel_type: 'whatsapp' | 'whatsapp_free' | 'email' | 'instagram' | 'tiktok'
  name: string
  credentials?: Record<string, unknown>
  webhook_url?: string | null
  webhook_secret?: string | null
  phone_number?: string | null
  external_id?: string | null
  config?: Record<string, unknown>
}
