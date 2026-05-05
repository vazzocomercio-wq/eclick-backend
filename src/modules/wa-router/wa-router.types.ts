/**
 * Tipos compartilhados do WA Router.
 *
 * Purpose enumera os contextos em que o produto envia WhatsApp. Cada org
 * pode rotear cada purpose pra um canal específico (Baileys ou Meta/Z-API)
 * via communication_channel_assignments. Quando não há assignment, o
 * resolver aplica fallback automático.
 */

export type WaPurpose =
  | 'internal_alert'         // IH alerts, ads-ai alerts, pricing signals → equipe interna
  | 'manager_verification'   // código WA pra cadastrar gestor IH
  | 'customer_journey'       // pós-venda automatizada
  | 'customer_campaign'      // broadcast marketing
  | 'auth_2fa'               // futuro

export type WaChannelKind = 'baileys' | 'cloud_api'

export type ResolvedChannel =
  | { kind: 'baileys';   channelId: string;  name?: string }
  | { kind: 'cloud_api'; configId:  string;  name?: string }

export interface ChannelAssignment {
  id:                  string
  organization_id:     string
  purpose:             WaPurpose
  baileys_channel_id:  string | null
  whatsapp_config_id:  string | null
  notes:               string | null
  created_at:          string
  updated_at:          string
}

/** Resultado padronizado do envio. Permite caller logar/decidir sem
 * conhecer o backend que enviou. */
export interface SendResult {
  success:     boolean
  message_id?: string
  channel?:    WaChannelKind
  error?:      string
}
